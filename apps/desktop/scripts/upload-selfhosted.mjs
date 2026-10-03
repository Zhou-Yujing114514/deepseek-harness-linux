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
import { cp, link, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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

/** Build the ssh options shared by mkdir, rsync, scp, ls, and rm. */
function sshOptions() {
  const options = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new']
  const port = process.env.DSH_SELFHOST_SSH_PORT?.trim()
  const key = process.env.DSH_SELFHOST_SSH_KEY?.trim()
  if (port !== undefined && port !== '') options.push('-p', port)
  if (key !== undefined && key !== '') options.push('-i', key)
  return options
}

function sshPassword() {
  const value = process.env.DSH_SELFHOST_SSH_PASSWORD?.trim()
  return value === undefined || value === '' ? undefined : value
}

/** Run one command on the remote host, through sshpass when a password is the only credential. */
async function remote(command) {
  const argv = ['ssh', ...sshOptions(), requiredAmbient('DSH_SELFHOST_SSH_TARGET'), command]
  const password = sshPassword()
  if (password === undefined) return run(argv[0], argv.slice(1), { maxBuffer: 1 << 24 })
  return run('sshpass', ['-p', password, ...argv], { maxBuffer: 1 << 24 })
}

/** Put one large artifact beside its manifests without duplicating disk usage. */
async function stageFile(source, destination) {
  await link(source, destination).catch(() => cp(source, destination))
}

/** Push one staged directory to the remote document root. */
async function upload(localDirectory, remoteRoot) {
  const target = requiredAmbient('DSH_SELFHOST_SSH_TARGET')
  const options = sshOptions()
  const password = sshPassword()
  await remote(`mkdir -p ${JSON.stringify(remoteRoot)}`)
  const rsyncAvailable = await run('rsync', ['--version'], { maxBuffer: 1 << 20 }).then(() => true, () => false)
  // rsync needs a shell string for ssh; keep that path for key authentication only.
  if (rsyncAvailable && password === undefined) {
    await run('rsync', ['-az', '--itemize-changes', '-e', ['ssh', ...options].join(' '),
      `${localDirectory}/`, `${target}:${remoteRoot}/`], { maxBuffer: 1 << 24 })
    return 'rsync'
  }
  const argv = ['-r', ...options, `${localDirectory}/.`, `${target}:${remoteRoot}/`]
  if (password === undefined) await run('scp', argv, { maxBuffer: 1 << 24 })
  else await run('sshpass', ['-p', password, 'scp', ...argv], { maxBuffer: 1 << 24 })
  return 'scp'
}

/** Delete superseded artifacts of the same architecture so the server keeps current versions. */
async function prune(remoteRoot, arch, keep) {
  const listing = await remote(`ls -1 ${JSON.stringify(remoteRoot)}`)
  const pattern = new RegExp(`^deepseek-harness-.*-linux-${arch}\\.`)
  const stale = listing.stdout.split('\n').map(line => line.trim())
    .filter(line => line !== '' && pattern.test(line) && !keep.includes(line))
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

  const base = `deepseek-harness-${version}-linux-${arch}`
  const size = await fileSize(join(artifactsRoot, `${base}.AppImage`))
  const digest = await sha512(join(artifactsRoot, `${base}.AppImage`))
  process.stdout.write(`desktop self-hosted upload: ${target} ${version} (${size} bytes)\n`)

  const suffix = arch === 'x64' ? '' : `-${arch}`
  const manifest = channelManifest(version, `${base}.AppImage`, digest, size)
  const metadata = {
    [`nightly-linux${suffix}.yml`]: manifest,
    [`latest-linux${suffix}.yml`]: manifest,
  }

  const stage = join(paths.root, 'selfhost')
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })
  const staged = []
  for (const name of [`${base}.AppImage`, `${base}.AppImage.blockmap`, `${base}.deb`, `${base}.tar.gz`]) {
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
