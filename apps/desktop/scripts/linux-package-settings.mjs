/** Resolve file-owned Linux packaging settings before a packaging run starts. */

/**
 * Validate the workspace tarball worker limit without touching the network.
 * @param {NodeJS.ProcessEnv} environment File-owned Linux packaging settings.
 * @returns {{packConcurrency: number}} Worker limit, defaulting to four when omitted.
 */
export function resolveLinuxPackageSettings(environment) {
  const value = environment.DSH_DESKTOP_LINUX_PACK_CONCURRENCY ?? '4'
  if (!/^[1-8]$/u.test(value)) {
    throw new Error('desktop package: DSH_DESKTOP_LINUX_PACK_CONCURRENCY must be an integer from 1 to 8')
  }
  return { packConcurrency: Number(value) }
}
