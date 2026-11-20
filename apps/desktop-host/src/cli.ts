/** Public dsh commands using the immutable runtime carried by the Desktop installation. */

import { existsSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { runCli } from '@deepseek-ai/dsh/lib/bin.js'
import { installOfficeEngineResolution, runtimeArchivePath } from './office-engine.ts'

/**
 * Run the ordinary CLI with Desktop's bundled package manager and reserved-profile plugin access.
 * @param runtimeDir - Prepared or ASAR-contained production DSH package tree.
 * @param supportDir - Physical Desktop runtime directory containing the primary-runtime payload and Node launchers.
 * @returns Completion of the selected CLI command; profile plugins own their process lifetime.
 */
export async function runDesktopCli(runtimeDir: string, supportDir: string): Promise<void> {
  installOfficeEngineResolution(runtimeDir)
  await runCli({
    manageDesktopProfile: true,
    packageManager: {
      command: process.execPath,
      args: ['--expose-internals', join(supportDir, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
        PATH: `${join(supportDir, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
      },
    },
  })
}

/**
 * Resolve the Desktop runtime directory beside a payload that is not inside an ASAR archive.
 * The prepared payload sits next to its runtime (`targets/linux-x64/dsh` beside `targets/linux-x64/runtime`),
 * while the packaged Linux tree disables ASAR and nests the payload one level deeper
 * (`resources/app/dsh`, with the runtime still at `resources/runtime`), so both are probed.
 * @param runtimeDir - dsh payload directory.
 * @returns Physical Desktop runtime directory containing the primary-runtime payload and Node launchers.
 */
function supportDirBesidePayload(runtimeDir: string): string {
  const beside = join(runtimeDir, '..', 'runtime')
  if (existsSync(join(beside, 'primary-runtime'))) return beside
  return join(runtimeDir, '..', '..', 'runtime')
}

if (import.meta.main) {
  if (process.platform === 'win32') {
    const { installWindowsCliSignals } = await import('./windows-cli-signals.ts')
    await installWindowsCliSignals()
  }
  const runtimeDir = resolve(import.meta.dirname, '../../../..')
  const archive = runtimeArchivePath(runtimeDir)
  // An ASAR build keeps the payload at resources/app.asar/dsh, so the runtime sits beside the archive.
  const supportDir = archive === undefined ? supportDirBesidePayload(runtimeDir) : join(dirname(archive), 'runtime')
  await runDesktopCli(runtimeDir, supportDir)
}
