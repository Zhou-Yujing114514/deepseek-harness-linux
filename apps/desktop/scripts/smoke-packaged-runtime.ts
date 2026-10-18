/** Validate the assembled application, including native Office conversion outside ASAR. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { desktopArtifactOutput, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { readDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { verifyWindowsCode } from './windows-runtime-signature.mjs'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { resolveDesktopPackageTarget } from './package-target.ts'
import type { DesktopUpdateTarget } from './desktop-auto-update-environment.mjs'

const paths = resolveDesktopTargetBuildPaths()
const { values } = parseArgs({
  options: {
    unsigned: { type: 'boolean', default: false },
    'skip-notarization': { type: 'boolean', default: false },
  },
  allowPositionals: false,
})
// This fork adds Linux targets; the official build-target type only covers macOS and Windows.
const target = resolveDesktopBuildTarget() as DesktopUpdateTarget
const windows = target === 'win-x64'
const linux = target === 'linux-x64' || target === 'linux-arm64'
// Unsigned builds are valid on Windows and macOS alike; a macOS build that skips notarization
// lands in its own directory. Never read the signed artifacts for either mode.
const output = desktopArtifactOutput(paths, { unsigned: values.unsigned, skipNotarization: values['skip-notarization'] })
const artifacts = output.directory
const linuxArch = target === 'linux-x64' ? 'x64' : 'arm64'
const linuxDir = existsSync(join(artifacts, `linux-${linuxArch}-unpacked`))
  ? join(artifacts, `linux-${linuxArch}-unpacked`)
  : join(artifacts, 'linux-unpacked')
const application = windows ? join(artifacts, 'win-unpacked')
  : linux ? linuxDir
    : join(artifacts, target === 'mac-arm64' ? 'mac-arm64' : 'mac', 'DeepSeek Harness.app', 'Contents')
const resources = join(application, windows || linux ? 'resources' : 'Resources')
const executable = windows ? join(application, 'DeepSeek Harness.exe')
  : linux ? join(application, 'deepseek-harness')
    : join(application, 'MacOS', 'DeepSeek Harness')
const descriptor = await verifyDesktopRuntime(paths.dsh, readDesktopRuntime(paths.dsh).release.version,
  resolveDesktopPackageTarget(target))
if (windows && !values.unsigned) await verifyWindowsCode(application)
await smokePreparedRuntime(join(resources, 'app.asar', 'dsh'), executable, join(resources, 'runtime'), descriptor)
