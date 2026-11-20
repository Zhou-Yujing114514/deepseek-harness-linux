/** Node runtime selection for the Desktop Host and the shell launchers it exposes. */

import { delimiter, join } from 'node:path'

/** Node runtime that hosts the Desktop Host process. */
export interface DesktopNodeRuntime {
  /** Absolute executable that runs the Host entry. */
  readonly executable: string
  /**
   * Whether the executable is Electron, which reaches Node only through `ELECTRON_RUN_AS_NODE`.
   * A standalone Node runs the entry directly and must not be marked as Electron, because package
   * scripts read that marker to select prebuilt native binaries.
   */
  readonly electron: boolean
  /**
   * Electron's resources directory, stated only by a standalone runtime. An Electron process already
   * exposes it as `process.resourcesPath`; a standalone Node has no such concept, so the shell passes
   * the packaged installation's resources root along and the Host republishes it for children that
   * locate bundled packages relative to it (dsh-market's host lookup).
   */
  readonly resourcesPath?: string
}

/**
 * Select the Node runtime that hosts the Desktop payload.
 * macOS and Windows host it in the shipped Electron's Node mode. Linux hosts it in the standalone
 * Node the primary runtime carries, because Electron links the build host's glib into its process
 * and the payload's libvips then resolves glib symbols from it, crashing the first image decode
 * (electron/electron#46323).
 * @param platform - Platform of the prepared payload.
 * @param electron - Electron executable of the prepared payload.
 * @param primaryRuntime - Prepared primary-runtime directory.
 * @returns Host runtime executable and whether it is Electron.
 */
export function desktopNodeRuntime(
  platform: NodeJS.Platform, electron: string, primaryRuntime: string,
): DesktopNodeRuntime {
  if (platform !== 'linux') return { executable: electron, electron: true }
  return { executable: join(primaryRuntime, 'dependencies', 'node', 'bin', 'node'), electron: false }
}

/**
 * Build the environment of a child process that runs under one Desktop Node runtime.
 * @param runtime - Host runtime selected for the payload.
 * @param bin - Directory containing the node shell launcher, when package scripts may run under it.
 * @param environment - Caller environment preserved for plugin execution.
 * @returns Environment for a Node child process.
 */
export function desktopNodeEnvironment(
  runtime: DesktopNodeRuntime, bin: string | undefined, environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    ...(runtime.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    // The shell launcher defaults to Electron, so a scrubbed environment keeps the Node mode the
    // primary targets rely on; only a standalone runtime states that it is not Electron.
    ...(runtime.electron ? {} : { DSH_DESKTOP_NODE_ELECTRON: '0' }),
    // A standalone runtime has no `process.resourcesPath` of its own; hand the packaged resources
    // root to the Host so it can publish one (an Electron runtime already has the real thing, and
    // its value always wins over anything inherited).
    ...(runtime.electron || runtime.resourcesPath === undefined ? {} : { DSH_DESKTOP_RESOURCES_PATH: runtime.resourcesPath }),
    ...(bin === undefined ? {} : {
      DSH_DESKTOP_NODE_EXECUTABLE: runtime.executable,
      PATH: `${bin}${delimiter}${environment.PATH ?? ''}`,
    }),
  }
}
