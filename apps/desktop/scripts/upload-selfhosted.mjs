/**
 * Publish packaged Linux artifacts to a self-hosted web server.
 *
 * The selfhosted deployment has no COS bucket, so the channel manifests that
 * `desktop-upload-plan.ts` writes for Tencent COS are built here instead. Every
 * architecture shares one flat remote directory: electron-builder and
 * electron-updater both suffix Linux manifests with a non-x64 architecture, so
 * `nightly-linux.yml` (x64) and `nightly-linux-arm64.yml` (arm64) never collide.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, link, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseArgs } from 'node:util'
import { valid } from 'semver'
import { dump } from 'js-yaml'
import { desktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { loadDesktopPackageEnvironment } from './desktop-package-environment.mjs'
import { resolveDesktopAutoUpdateConfig } from './desktop-auto-update-environment.mjs'

const run = promisify(execFile)
const TARGETS = {
  'linux-x64': { arch: 'x64' },
  'linux-arm64': { arch: 'arm64' },
}
/**
 * Concurrent scp streams, and how large a single artifact has to grow before it is split.
 * A lone scp stream crosses a high-latency link at a few tens of kB/s: ssh's channel window
 * never grows large enough to fill the pipe, so the transfer is latency-bound rather than
 * bandwidth-bound. Several streams each carry their own window, which is what keeps a
 * gigabyte-scale publish inside the job budget instead of running for hours.
 */
const PARALLEL_STREAMS = 10
const CHUNK_BYTES = 12 * 1024 * 1024
const CHUNK_THRESHOLD = 24 * 1024 * 1024
/**
 * electron-builder spells the architecture differently per target: AppImage uses x86_64,
 * deb uses amd64, and tar.gz keeps x64. Map every spelling back to the Node.js architecture.
 */
const ARCHITECTURE_SPELLINGS = new Map([
  ['x86_64', 'x64'], ['x64', 'x64'], ['amd64', 'x64'],
  ['arm64', 'arm64'], ['aarch64', 'arm64'], ['armv7l', 'arm64'],
])

/**
 * Find the packaged artifacts of one version and architecture.
 * @param {string} artifactsRoot Directory electron-builder wrote its artifacts to.
 * @param {string} version Semantic version the completion record declared.
 * @param {string} arch Target architecture.
 * @returns {Promise<{ appImage: string, others: string[] }>} AppImage plus any other install formats.
 */
async function discoverArtifacts(artifactsRoot, version, arch) {
  const escaped = version.replaceAll('.', String.raw`\.`)
  const pattern = new RegExp(`^deepseek-harness-${escaped}-linux-([A-Za-z0-9_]+)\\.(AppImage|deb|tar\\.gz)$`, 'u')
  const appImages = []
  const others = []
  for (const name of await readdir(artifactsRoot)) {
    const match = pattern.exec(name)
    if (match === null || ARCHITECTURE_SPELLINGS.get(match[1]) !== arch) continue
    if (match[2] === 'AppImage') appImages.push(name)
    else others.push(name)
  }
  if (appImages.length !== 1) {
    throw new Error(`desktop self-hosted upload: expected exactly one ${arch} AppImage for ${version} in ${artifactsRoot}, found ${appImages.length}`)
  }
  return { appImage: appImages[0], others: others.sort() }
}

/** Read a required ambient setting; transport secrets never come from the dotenv file. */
function requiredAmbient(name) {
  const value = process.env[name]?.trim()
  if (value === undefined || value === '') {
    throw new Error(`desktop self-hosted upload: ${name} must be set to a non-empty value`)
  }
  return value
}

/** Hash one file the way electron-updater verifies it. */
async function sha512(path) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('base64')
}

async function fileSize(path) {
  const details = await stat(path)
  if (!details.isFile() || details.size === 0) {
    throw new Error(`desktop self-hosted upload: missing or empty artifact ${path}`)
  }
  return details.size
}

/** Render one channel manifest matching the electron-builder generic provider schema. */
function channelManifest(version, filename, digest, size) {
  return `${dump({
    version,
    files: [{ url: filename, sha512: digest, size }],
    path: filename,
    sha512: digest,
    releaseDate: new Date().toISOString(),
  })}`
}

/**
 * Build the ssh options shared by mkdir, rsync, scp, ls, and rm.
 * @param {string} command Transport the options feed: "scp" spells the port "-P", every
 *   other ssh-family command spells it "-p" (scp would read "-p" as "preserve timestamps").
 * @returns {string[]} Argument list for ssh, scp, or an rsync `-e` shell string.
 */
function sshOptions(command = 'ssh') {
  // BatchMode suppresses every interactive prompt, which also starves sshpass: the password
  // it types on the pty never reaches ssh. Keep it for key-only authentication, where a
  // stray prompt would hang the publish step forever.
  const batch = sshPassword() === undefined ? ['-o', 'BatchMode=yes'] : []
  const options = [...batch, '-o', 'StrictHostKeyChecking=accept-new']
  const port = process.env.DSH_SELFHOST_SSH_PORT?.trim()
  const key = process.env.DSH_SELFHOST_SSH_KEY?.trim()
  if (port !== undefined && port !== '') options.push(command === 'scp' ? '-P' : '-p', port)
  if (key !== undefined && key !== '') options.push('-i', key)
  return options
}

function sshPassword() {
  const value = process.env.DSH_SELFHOST_SSH_PASSWORD?.trim()
  return value === undefined || value === '' ? undefined : value
}

/**
 * Repeat an idempotent remote step when the server drops the connection mid-transfer.
 * Cheap tunnels reset under load; a publish should survive one reset instead of throwing away
 * a twenty-minute build.
 * @param {string} label Human-readable step name for the retry notice.
 * @param {() => Promise<T>} operation Step to run; must be safe to repeat.
 * @param {number} attempts Total tries before the failure is fatal.
 * @returns {Promise<T>} Result of the first successful attempt.
 * @template T
 */
async function withRetry(label, operation, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (attempt >= attempts) throw error
      const delay = attempt * 5000
      process.stderr.write(`desktop self-hosted upload: ${label} failed (${error.message}); retry ${attempt}/${attempts - 1} in ${delay}ms\n`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}

/** Run one command on the remote host, through sshpass when a password is the only credential. */
function remote(command) {
  const argv = ['ssh', ...sshOptions(), requiredAmbient('DSH_SELFHOST_SSH_TARGET'), command]
  const password = sshPassword()
  const argv0 = password === undefined ? argv[0] : 'sshpass'
  const args = password === undefined ? argv.slice(1) : ['-p', password, ...argv]
  return withRetry(`ssh ${command.slice(0, 40)}`, () => run(argv0, args, { maxBuffer: 1 << 24 }))
}

/** Put one large artifact beside its manifests without duplicating disk usage. */
async function stageFile(source, destination) {
  await link(source, destination).catch(() => cp(source, destination))
}

/**
 * Send every file in the queue, several at a time, each through its own scp process.
 * @param {{ local: string, remote: string }[]} transfers Files still to send.
 * @returns {Promise<void>} Resolves once either all files arrived or at least one gave up.
 */
async function transferAll(transfers) {
  const target = requiredAmbient('DSH_SELFHOST_SSH_TARGET')
  const password = sshPassword()
  const queue = transfers.slice()
  const failures = []
  const worker = async () => {
    for (;;) {
      const item = queue.shift()
      if (item === undefined) return
      const argv = [...sshOptions('scp'), item.local, `${target}:${item.remote}`]
      const argv0 = password === undefined ? 'scp' : 'sshpass'
      const args = password === undefined ? argv : ['-p', password, 'scp', ...argv]
      try {
        await withRetry(`scp ${basename(item.remote)}`, () => run(argv0, args, { maxBuffer: 1 << 24 }))
      } catch (error) {
        failures.push(`${basename(item.remote)}: ${error.message}`)
      }
    }
  }
  const streams = Math.min(PARALLEL_STREAMS, Math.max(transfers.length, 1))
  await Promise.all(Array.from({ length: streams }, worker))
  if (failures.length > 0) {
    throw new Error(`desktop self-hosted upload: ${failures.length} transfer(s) failed: ${failures.join('; ')}`)
  }
}

/** Push one staged directory to the remote document root, splitting large artifacts across streams. */
async function upload(localDirectory, remoteRoot) {
  await remote(`mkdir -p ${JSON.stringify(remoteRoot)}`)
  // Chunks land beside the document root, never inside it: a partially reassembled
  // AppImage must not be visible to a client that polls mid-publish.
  const chunkRoot = `${remoteRoot}-upload`
  await remote(`rm -rf ${JSON.stringify(chunkRoot)} && mkdir -p ${JSON.stringify(chunkRoot)}`)

  const entries = (await readdir(localDirectory, { withFileTypes: true })).filter(entry => entry.isFile())
  const localChunkRoot = join(dirname(localDirectory), '.upload-chunks')
  await rm(localChunkRoot, { recursive: true, force: true })

  // A publish that runs out of job time is retried by re-running the workflow, so skip
  // artifacts that already arrived whole. Manifests are always resent: they are tiny, and
  // they are what flips the feed over to the version just uploaded.
  const present = new Map()
  for (const line of (await remote(`ls -l ${JSON.stringify(remoteRoot)}`)).stdout.split('\n')) {
    const columns = line.trim().split(/\s+/u)
    if (columns.length < 9) continue
    present.set(columns.at(-1), Number(columns[4]))
  }

  const transfers = []
  const assemblies = []
  for (const [index, entry] of entries.entries()) {
    const name = entry.name
    const local = join(localDirectory, name)
    const size = (await stat(local)).size
    if (!name.endsWith('.yml') && present.get(name) === size) {
      process.stdout.write(`desktop self-hosted upload: ${name} already published, skipping\n`)
      continue
    }
    if (size <= CHUNK_THRESHOLD) {
      transfers.push({ local, remote: `${remoteRoot}/${name}` })
      continue
    }
    await mkdir(localChunkRoot, { recursive: true })
    const prefix = `part-${index}-`
    await run('split', ['-b', String(CHUNK_BYTES), '-d', '-a', '3', local, join(localChunkRoot, prefix)], { maxBuffer: 1 << 24 })
    const pieces = (await readdir(localChunkRoot)).filter(candidate => candidate.startsWith(prefix)).sort()
    if (pieces.length === 0) throw new Error(`desktop self-hosted upload: split produced no pieces for ${name}`)
    const remotePieces = pieces.map(piece => `${chunkRoot}/${piece}`)
    pieces.forEach((piece, position) => {
      transfers.push({ local: join(localChunkRoot, piece), remote: remotePieces[position] })
    })
    assemblies.push({ name, size, remoteFile: `${remoteRoot}/${name}`, remotePieces })
  }

  await transferAll(transfers)
  await rm(localChunkRoot, { recursive: true, force: true })

  for (const item of assemblies) {
    const quoted = item.remotePieces.map(piece => JSON.stringify(piece)).join(' ')
    await remote(`cat ${quoted} > ${JSON.stringify(item.remoteFile)} && rm -f ${quoted}`)
    const listing = await remote(`stat -c %s ${JSON.stringify(item.remoteFile)}`)
    const arrived = Number(listing.stdout.trim())
    if (arrived !== item.size) {
      throw new Error(`desktop self-hosted upload: ${item.name} reassembled to ${arrived} bytes, expected ${item.size}`)
    }
  }
  await remote(`rm -rf ${JSON.stringify(chunkRoot)}`)
  return `scp (${PARALLEL_STREAMS} streams)`
}

/** Delete superseded artifacts of the same architecture so the server keeps current versions. */
async function prune(remoteRoot, arch, keep) {
  const listing = await remote(`ls -1 ${JSON.stringify(remoteRoot)}`)
  const pattern = /^deepseek-harness-.*-linux-([A-Za-z0-9_]+)\./u
  const stale = listing.stdout.split('\n').map(line => line.trim())
    .filter(line => line !== '' && !keep.includes(line))
    .filter(line => {
      const match = pattern.exec(line)
      return match !== null && ARCHITECTURE_SPELLINGS.get(match[1]) === arch
    })
  if (stale.length === 0) return []
  const quoted = stale.map(name => JSON.stringify(join(remoteRoot, name))).join(' ')
  await remote(`rm -f ${quoted}`)
  return stale
}

/** Confirm the published manifests answer over the public origin. */
async function verify(publicUrl, filenames) {
  const results = []
  for (const name of filenames) {
    const url = new URL(name, publicUrl).href
    const response = await fetch(url, { redirect: 'follow' })
    const body = await response.text()
    if (!response.ok) throw new Error(`desktop self-hosted upload: ${url} answered ${response.status}`)
    results.push({ url, status: response.status, bytes: body.length })
  }
  return results
}

/**
 * Stage, publish, and verify one packaged Linux target on a self-hosted server.
 * @param {string[]} argv Command-line arguments.
 * @returns {Promise<void>} Resolves after staging, and after upload unless staging only.
 */
export async function uploadSelfHostedTarget(argv) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: {
    'stage-only': { type: 'boolean' },
    prune: { type: 'boolean' },
    verify: { type: 'boolean' },
  } })
  const target = positionals[0]
  if (target === undefined || positionals.length !== 1 || TARGETS[target] === undefined) {
    throw new Error('desktop self-hosted upload: expected one target, linux-x64 or linux-arm64')
  }
  const { arch } = TARGETS[target]
  const environment = loadDesktopPackageEnvironment('linux')
  const update = resolveDesktopAutoUpdateConfig(environment, 'linux', arch)
  if (update.environment !== 'selfhosted') {
    throw new Error(`desktop self-hosted upload: DSH_DESKTOP_AUTO_UPDATE_ENV is ${update.environment}; set it to "selfhosted"`)
  }
  const paths = desktopTargetBuildPaths(target)
  const artifactsRoot = paths.artifacts
  const record = JSON.parse(await readFile(join(artifactsRoot, `${target}-release.json`), 'utf8'))
  const version = record.version
  if (valid(version) === null) {
    throw new Error(`desktop self-hosted upload: completion record holds the invalid version ${JSON.stringify(version)}`)
  }
  if (record.target !== target || record.publicUrl !== update.publicUrl) {
    throw new Error(`desktop self-hosted upload: ${target} was packaged for ${record.publicUrl}, not ${update.publicUrl}`)
  }

  const { appImage, others } = await discoverArtifacts(artifactsRoot, version, arch)
  const size = await fileSize(join(artifactsRoot, appImage))
  const digest = await sha512(join(artifactsRoot, appImage))
  process.stdout.write(`desktop self-hosted upload: ${target} ${version} ${appImage} (${size} bytes)\n`)

  const suffix = arch === 'x64' ? '' : `-${arch}`
  const manifest = channelManifest(version, appImage, digest, size)
  const metadata = {
    [`nightly-linux${suffix}.yml`]: manifest,
    [`latest-linux${suffix}.yml`]: manifest,
  }

  const stage = join(paths.root, 'selfhost')
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })
  const staged = []
  for (const name of [appImage, `${appImage}.blockmap`, ...others]) {
    if ((await stat(join(artifactsRoot, name)).catch(() => undefined))?.isFile() === true) {
      await stageFile(join(artifactsRoot, name), join(stage, name))
      staged.push(name)
    }
  }
  for (const [name, contents] of Object.entries(metadata)) {
    await writeFile(join(stage, name), contents)
    staged.push(name)
  }
  process.stdout.write(`desktop self-hosted upload: staged ${staged.join(', ')}\n`)
  process.stdout.write(`desktop self-hosted upload: feed ${update.publicUrl}\n`)

  if (values['stage-only'] === true) return
  const remoteRoot = requiredAmbient('DSH_SELFHOST_REMOTE_ROOT').replace(/\/+$/u, '')
  const transport = await upload(stage, remoteRoot)
  process.stdout.write(`desktop self-hosted upload: ${transport} -> ${remoteRoot}\n`)
  if (values.prune === true) {
    const removed = await prune(remoteRoot, arch, staged)
    if (removed.length > 0) process.stdout.write(`desktop self-hosted upload: pruned ${removed.join(', ')}\n`)
  }
  if (values.verify === true) {
    for (const entry of await verify(update.publicUrl, Object.keys(metadata))) {
      process.stdout.write(`desktop self-hosted upload: ${entry.status} ${entry.url} (${entry.bytes} bytes)\n`)
    }
  }
  process.stdout.write(`desktop self-hosted upload: ${target} ${version} is live at ${update.publicUrl}\n`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  uploadSelfHostedTarget(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
