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
 *
 * Concurrency stays deliberately modest. The receiving VPS sits behind a host that throttles
 * inbound traffic: short bursts run at megabytes per second, but sustained throughput settles
 * around 215 KB/s and connections are reset every few minutes. A wide fan-out trips the
 * throttle more often than it gains, because a reset stream loses whatever it had already
 * pushed. Five is a conservative middle ground rather than a measured optimum - the two
 * settings were never A/B tested on the same payload, so tune it per run with
 * DSH_SELFHOST_PARALLEL_STREAMS before assuming a lower or higher value is better.
 */
const PARALLEL_STREAMS = 5
const CHUNK_BYTES = 12 * 1024 * 1024
const CHUNK_THRESHOLD = 24 * 1024 * 1024
const PROGRESS_INTERVAL_MS = 30_000
/** Pieces older than this in the staging area belong to an abandoned publish. */
const STALE_PIECE_MINUTES = 720
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

/**
 * Read the remote document root and refuse the values that would publish somewhere else.
 * Trailing slashes are stripped for path building, and that is exactly what makes a root of
 * "/" collapse to an empty string: the chunk directory would turn into the relative
 * "-upload" and every artifact path would land at the filesystem root instead.
 * @returns {string} Absolute remote directory, without a trailing slash.
 */
export function resolveRemoteRoot() {
  const value = requiredAmbient('DSH_SELFHOST_REMOTE_ROOT').replace(/\/+$/u, '')
  if (value === '') {
    throw new Error('desktop self-hosted upload: DSH_SELFHOST_REMOTE_ROOT must not be the filesystem root')
  }
  if (!value.startsWith('/')) {
    throw new Error(`desktop self-hosted upload: DSH_SELFHOST_REMOTE_ROOT must be an absolute path, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Hash one file the way electron-updater verifies it. */
async function sha512(path) {
  return (await digestPair(path)).base64
}

/** Hash one file as base64 (for the manifest) and hex (to compare with the remote sha512sum). */
async function digestPair(path) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  const digest = hash.digest()
  return { base64: digest.toString('base64'), hex: digest.toString('hex') }
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
 * Child environment carrying the SSH password for `sshpass -e`.
 * Passing it this way keeps the secret out of argv. execFile echoes the full command back in
 * the error message of a failed run, so anything handed to `-p` ends up in the log verbatim.
 * @returns {NodeJS.ProcessEnv | undefined} Environment for the child, or undefined for key auth.
 */
function sshpassEnvironment() {
  const password = sshPassword()
  return password === undefined ? undefined : { ...process.env, SSHPASS: password }
}

/**
 * Remove the SSH password from text that is about to be printed.
 * A belt-and-braces measure: with `-e` the password should no longer reach an error message,
 * but any command that still echoes it must not make it into a log or a failure summary.
 * @param {string} message - Text that may contain the password.
 * @returns {string} The same text with every occurrence replaced.
 */
export function redact(message) {
  const password = sshPassword()
  return password === undefined ? message : message.split(password).join('***')
}

/**
 * Spawn options for one remote command, carrying the password environment when there is one.
 * @returns {{ maxBuffer: number, env?: NodeJS.ProcessEnv }} Options for execFile.
 */
function spawnOptions() {
  const env = sshpassEnvironment()
  return { maxBuffer: 1 << 24, ...(env === undefined ? {} : { env }) }
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
      process.stderr.write(`desktop self-hosted upload: ${label} failed (${redact(error.message)}); retry ${attempt}/${attempts - 1} in ${delay}ms\n`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}

/** Run one command on the remote host, through sshpass when a password is the only credential. */
function remote(command) {
  const argv = ['ssh', ...sshOptions(), requiredAmbient('DSH_SELFHOST_SSH_TARGET'), command]
  const password = sshPassword()
  const argv0 = password === undefined ? argv[0] : 'sshpass'
  // -e reads the password from SSHPASS instead of argv. With -p the secret is part of the
  // command line, and execFile reports the whole command line back in the error message of
  // every failed run, which puts the password straight into the log.
  const args = password === undefined ? argv.slice(1) : ['-e', ...argv]
  return withRetry(`ssh ${command.slice(0, 40)}`, () => run(argv0, args, spawnOptions()))
}

/** Put one large artifact beside its manifests without duplicating disk usage. */
async function stageFile(source, destination) {
  await link(source, destination).catch(() => cp(source, destination))
}

/** Concurrent streams for this run; the repository can tune it without editing the script. */
function resolveParallelStreams() {
  const raw = Number(process.env.DSH_SELFHOST_PARALLEL_STREAMS?.trim())
  return Number.isInteger(raw) && raw >= 1 && raw <= 16 ? raw : PARALLEL_STREAMS
}

/**
 * Send every file in the queue, several at a time, each through its own scp process.
 * @param {{ local: string, remote: string, size: number }[]} transfers Files still to send.
 * @returns {Promise<string>} A short description of the transport actually used.
 */
async function transferAll(transfers) {
  const target = requiredAmbient('DSH_SELFHOST_SSH_TARGET')
  const password = sshPassword()
  const queue = transfers.slice()
  const failures = []
  const totalBytes = transfers.reduce((sum, item) => sum + item.size, 0)
  const startedAt = Date.now()
  let doneBytes = 0
  let doneFiles = 0

  // scp prints nothing while it runs, and GitHub withholds a step's log until the step ends,
  // so a silent upload looks exactly like a hung one. Print the tally on a timer instead.
  const report = () => {
    const elapsed = Math.max((Date.now() - startedAt) / 1000, 1)
    const rate = doneBytes / elapsed
    const remaining = totalBytes - doneBytes
    const percent = totalBytes === 0 ? 100 : (doneBytes / totalBytes) * 100
    const eta = rate === 0 ? null : Math.round(remaining / rate / 60)
    process.stdout.write([
      `desktop self-hosted upload: progress ${doneFiles}/${transfers.length} pieces,`,
      `${(doneBytes / 1048576).toFixed(1)}/${(totalBytes / 1048576).toFixed(1)} MiB`,
      `(${percent.toFixed(1)}%),`,
      `${(rate / 1024).toFixed(0)} KB/s,`,
      eta === null ? 'measuring' : `${eta} min left`,
    ].join(' ') + '\n')
  }
  const timer = setInterval(report, PROGRESS_INTERVAL_MS)
  timer.unref?.()

  const worker = async () => {
    for (;;) {
      const item = queue.shift()
      if (item === undefined) return
      const argv = [...sshOptions('scp'), item.local, `${target}:${item.remote}`]
      const argv0 = password === undefined ? 'scp' : 'sshpass'
      const args = password === undefined ? argv : ['-e', 'scp', ...argv]
      try {
        await withRetry(`scp ${basename(item.remote)}`, () => run(argv0, args, spawnOptions()))
        doneBytes += item.size
        doneFiles += 1
      } catch (error) {
        failures.push(`${basename(item.remote)}: ${redact(error.message)}`)
      }
    }
  }
  const streams = Math.min(resolveParallelStreams(), Math.max(transfers.length, 1))
  try {
    await Promise.all(Array.from({ length: streams }, worker))
  } finally {
    clearInterval(timer)
    report()
  }
  if (failures.length > 0) {
    throw new Error(`desktop self-hosted upload: ${failures.length} transfer(s) failed: ${failures.join('; ')}`)
  }
  return `scp (${streams} streams)`
}

/** Parse `find -printf '%s\t%f\n'` output into a file name -> size map. */
export function parseRemoteListing(stdout) {
  const listing = new Map()
  for (const line of stdout.split('\n')) {
    // Split on the first tab only, so a file name that itself contains a tab survives intact.
    const separator = line.indexOf('\t')
    if (separator <= 0) continue
    const size = Number(line.slice(0, separator))
    if (Number.isInteger(size)) listing.set(line.slice(separator + 1), size)
  }
  return listing
}

/** Read a remote directory listing as a name -> size map. */
async function remoteListing(directory) {
  // Splitting `ls -l` on whitespace loses any name containing a space, and only the last
  // word would be left to compare sizes against. Print size and bare file name separated
  // by a tab instead. The script already relies on GNU coreutils and findutils elsewhere.
  const output = await remote(
    `find ${JSON.stringify(directory)} -maxdepth 1 -type f -printf '%s\\t%f\\n' 2>/dev/null || true`,
  )
  return parseRemoteListing(output.stdout)
}

/** Push one staged directory to the remote document root, splitting large artifacts across streams. */
export async function upload(localDirectory, remoteRoot) {
  await remote(`mkdir -p ${JSON.stringify(remoteRoot)}`)
  // Chunks land beside the document root, never inside it: a partially reassembled
  // AppImage must not be visible to a client that polls mid-publish. The staging area is
  // deliberately *not* cleared at the start. The receiving host throttles inbound traffic,
  // so a publish can be reset long before it finishes; keeping the pieces lets the next run
  // resume instead of resending a gigabyte from zero.
  const chunkRoot = `${remoteRoot}-upload`
  await remote(`mkdir -p ${JSON.stringify(chunkRoot)}`)

  const entries = (await readdir(localDirectory, { withFileTypes: true })).filter(entry => entry.isFile())
  const localChunkRoot = join(dirname(localDirectory), '.upload-chunks')
  await rm(localChunkRoot, { recursive: true, force: true })

  // A publish that runs out of job time is retried by re-running the workflow, so skip
  // artifacts that already arrived whole. Manifests are always resent: they are tiny, and
  // they are what flips the feed over to the version just uploaded.
  const present = await remoteListing(remoteRoot)
  const arrivedPieces = await remoteListing(chunkRoot)

  const transfers = []
  // Manifests are held back until every binary is whole. They are a few hundred bytes and
  // arrive in seconds, while the packages they point at take hours; publishing them first
  // would advertise a version whose download 404s for the rest of the transfer, and a client
  // that polls in that window would try to install something that does not exist yet.
  const manifests = []
  const assemblies = []
  for (const entry of entries) {
    const name = entry.name
    const local = join(localDirectory, name)
    const size = (await stat(local)).size
    if (name.endsWith('.yml')) {
      manifests.push({ local, remote: `${remoteRoot}/${name}`, size })
      continue
    }
    if (present.get(name) === size) {
      // Equal length is not equal content: a resumed publish, a truncated upload, or a
      // different build that happens to match in size would all pass a size check. Compare
      // digests before trusting a file that is already there.
      const { hex } = await digestPair(local)
      const published = await remote(
        `sha512sum -- ${JSON.stringify(`${remoteRoot}/${name}`)} | cut -d' ' -f1`,
      )
      if (published.stdout.trim() === hex) {
        process.stdout.write(`desktop self-hosted upload: ${name} already published, skipping\n`)
        continue
      }
      process.stdout.write(`desktop self-hosted upload: ${name} is present but differs, resending\n`)
    }
    if (size <= CHUNK_THRESHOLD) {
      transfers.push({ local, remote: `${remoteRoot}/${name}`, size })
      continue
    }
    await mkdir(localChunkRoot, { recursive: true })
    // Piece names carry the artifact name, so pieces of a previous version can never be
    // mistaken for pieces of this one. Every interior piece is exactly CHUNK_BYTES long,
    // so size alone would not tell two versions apart.
    const prefix = `${name}.part`
    await run('split', ['-b', String(CHUNK_BYTES), '-d', '-a', '3', local, join(localChunkRoot, prefix)], { maxBuffer: 1 << 24 })
    const pieces = (await readdir(localChunkRoot)).filter(candidate => candidate.startsWith(prefix)).sort()
    if (pieces.length === 0) throw new Error(`desktop self-hosted upload: split produced no pieces for ${name}`)
    const remotePieces = pieces.map(piece => `${chunkRoot}/${piece}`)
    let resumed = 0
    for (const [position, piece] of pieces.entries()) {
      const pieceSize = (await stat(join(localChunkRoot, piece))).size
      if (arrivedPieces.get(piece) === pieceSize) {
        resumed += 1
        continue
      }
      transfers.push({ local: join(localChunkRoot, piece), remote: remotePieces[position], size: pieceSize })
    }
    const { hex } = await digestPair(local)
    assemblies.push({ name, size, digest: hex, remoteFile: `${remoteRoot}/${name}`, remotePieces })
    process.stdout.write(`desktop self-hosted upload: ${name} -> ${pieces.length} pieces, ${resumed} already staged\n`)
  }

  const transport = await transferAll(transfers)
  await rm(localChunkRoot, { recursive: true, force: true })

  for (const item of assemblies) {
    const quoted = item.remotePieces.map(piece => JSON.stringify(piece)).join(' ')
    // Assemble beside the document root, never at the published path: a half-written file
    // must not be what a client following the feed can download. Repeating this is safe
    // because it rewrites the same staging file from the same pieces.
    const staging = `${chunkRoot}/${item.name}.assembling`
    await remote(`cat ${quoted} > ${JSON.stringify(staging)}`)
    const listing = await remote(`stat -c %s ${JSON.stringify(staging)}`)
    const arrived = Number(listing.stdout.trim())
    if (arrived !== item.size) {
      throw new Error(`desktop self-hosted upload: ${item.name} reassembled to ${arrived} bytes, expected ${item.size}`)
    }
    // A resumed piece reused in the wrong order would assemble into a file of the right
    // length and the wrong bytes, so compare the digest before the feed points at it.
    const remoteDigest = await remote(`sha512sum -- ${JSON.stringify(staging)} | cut -d' ' -f1`)
    if (remoteDigest.stdout.trim() !== item.digest) {
      await remote(`rm -f ${JSON.stringify(staging)}`)
      throw new Error(`desktop self-hosted upload: ${item.name} reassembled to the wrong digest; removed it, rerun to resend`)
    }
    // Only the verified file takes the published name. chunkRoot sits next to the document
    // root, so this renames within one filesystem instead of copying the artifact again.
    await remote(`mv -f ${JSON.stringify(staging)} ${JSON.stringify(item.remoteFile)}`)
    // Dropping the pieces is deliberately a separate step from the assembly above: kept out
    // of the retried command, a retry can always rebuild the staging file from them.
    await remote(`rm -f ${quoted}`)
  }
  // Sweep pieces an abandoned publish left behind; this run consumed its own already.
  await remote(`find ${JSON.stringify(chunkRoot)} -maxdepth 1 -type f -mmin +${STALE_PIECE_MINUTES} -delete 2>/dev/null || true`)
  if (manifests.length > 0) {
    await transferAll(manifests)
  }
  return transport
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
  const remoteRoot = resolveRemoteRoot()
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
    process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`)
    process.exitCode = 1
  })
}
