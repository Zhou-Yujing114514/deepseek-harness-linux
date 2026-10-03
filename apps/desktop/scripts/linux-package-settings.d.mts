/** Resolve file-owned Linux packaging settings before a packaging run starts. */

export interface LinuxPackageSettings {
  readonly packConcurrency: number
}

/**
 * Validate the workspace tarball worker limit without touching the network.
 * @param environment - File-owned Linux packaging settings.
 * @returns Worker limit, defaulting to four when omitted.
 */
export function resolveLinuxPackageSettings(environment: NodeJS.ProcessEnv): LinuxPackageSettings
