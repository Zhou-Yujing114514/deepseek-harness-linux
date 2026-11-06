/** Optional XWayland launcher (see linux-launch-compat.mjs). */

/** The only flag this helper adds. */
export const COMPAT_FLAG: '--ozone-platform=x11'

/**
 * Classify the graphical session from its environment.
 * @param env - Environment variables.
 */
export function detectSession(env: NodeJS.ProcessEnv): 'wayland' | 'x11' | 'unknown'

/** Launch advice for the current session. */
export interface LaunchAdvice {
  session: 'wayland' | 'x11' | 'unknown'
  needsFlag: boolean
  command: string
  notes: string[]
}

/**
 * Decide what to tell the user for this session.
 * @param env - Environment variables.
 * @param executable - AppImage or binary path shown in the suggested command.
 * @param extraArgs - Arguments the user already wants to pass.
 */
export function resolveLaunchAdvice(
  env: NodeJS.ProcessEnv,
  executable: string,
  extraArgs?: readonly string[],
): LaunchAdvice

/** CLI entry point. */
export function main(argv: string[]): Promise<void>
