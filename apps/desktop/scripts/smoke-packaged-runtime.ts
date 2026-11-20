/** Validate the assembled application, including native Office conversion outside ASAR. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { desktopArtifactOutput, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { desktopNodeRuntime } from '../src/node-environment.ts'
import { readDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { verifyWindowsCode } from './windows-runtime-signature.mjs'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { resolveDesktopPackageTarget } from './package-target.ts'

const paths = resolveDesktopTargetBuildPaths()
const { values } = parseArgs({
  options: {
    unsigned: { type: 'boolean', default: false },
    'skip-notarization': { type: 'boolean', default: false },
  },
  allowPositionals: false,
})
const target = resolveDesktopBuildTarget()
const packaged = resolveDesktopPackageTarget(target)
const windows = packaged.platform === 'win32'
const linux = packaged.platform === 'linux'
// Unsigned builds are valid on Windows and macOS alike; a macOS build that skips notarization
// lands in its own directory. Never read the signed artifacts for either mode.
const output = desktopArtifactOutput(paths, { unsigned: values.unsigned, skipNotarization: values['skip-notarization'] })
const artifacts = output.directory
// electron-builder treats x64 as the default architecture, so only non-x64 targets carry an
// architecture segment in the unpacked directory name. Older Linux builds also fall back to
// `linux-unpacked`, so keep an existence check before committing to a directory.
const linuxArchDir = join(artifacts, packaged.arch === 'x64' ? 'linux-unpacked' : `linux-${packaged.arch}-unpacked`)
const linuxDir = existsSync(linuxArchDir) ? linuxArchDir : join(artifacts, 'linux-unpacked')
const application = windows ? join(artifacts, 'win-unpacked')
  : linux ? linuxDir
    : join(artifacts, target === 'mac-arm64' ? 'mac-arm64' : 'mac', 'DeepSeek Harness.app', 'Contents')
const resources = join(application, windows || linux ? 'resources' : 'Resources')
const executable = windows ? join(application, 'DeepSeek Harness.exe')
  : linux ? join(application, 'deepseek-harness')
    : join(application, 'MacOS', 'DeepSeek Harness')
const descriptor = await verifyDesktopRuntime(paths.dsh, readDesktopRuntime(paths.dsh).release.version, packaged)
if (windows && !values.unsigned) await verifyWindowsCode(application)
// Linux ships an unpacked tree because a standalone Node cannot read ASAR, so its integrity check
// reads the packaged bytes instead of archive records.
const appRoot = join(resources, linux ? 'app' : 'app.asar')
const resourcesRuntime = join(resources, 'runtime')
if (linux) await verifyDesktopRuntime(join(appRoot, 'dsh'), descriptor.release.version, packaged)
// The packaged Linux app bundles no LibreOffice Kit native modules, so its Office checks cannot
// pass. Skipping them here keeps every other packaged-runtime failure fatal (fork Linux target).
await smokePreparedRuntime(join(appRoot, 'dsh'),
  desktopNodeRuntime(packaged.platform, executable, join(resourcesRuntime, 'primary-runtime')),
  resourcesRuntime, descriptor, linux)
