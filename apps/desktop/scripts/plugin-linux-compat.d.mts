/** Linux plugin compatibility diagnosis (see plugin-linux-compat.mjs). */

/** Supported Linux Desktop targets. */
export const TARGETS: {
  'linux-x64': { platform: 'linux'; arch: 'x64'; libc: 'glibc' }
  'linux-arm64': { platform: 'linux'; arch: 'arm64'; libc: 'glibc' }
}

/**
 * Evaluate an npm `os` / `cpu` / `libc` field against one host value.
 * @param field - Manifest field value.
 * @param host - Platform, architecture, or libc of the running host.
 * @returns true/false, or undefined when the field is absent or invalid.
 */
export function matchesHostField(field: unknown, host: string): boolean | undefined

/** Platform-specific native binary package hint. */
export interface PlatformPackageHint {
  platform: string
  arch: string
  libc?: string
}

/**
 * Recognise a platform-specific native binary package name.
 * @param name - Dependency name.
 */
export function platformPackageHint(name: string): PlatformPackageHint | undefined

/** One diagnostic line about a plugin. */
export interface Finding {
  level: 'block' | 'warn'
  text: string
}

/** Host target used by the inspection. */
export interface CompatTarget {
  platform: string
  arch: string
  libc: string
}

/** Verdict and findings for one manifest. */
export interface ManifestVerdict {
  verdict: 'incompatible' | 'unverified' | 'compatible'
  findings: Finding[]
}

/**
 * Inspect a single plugin manifest without loading the plugin.
 * @param manifest - Parsed package.json.
 * @param target - Host target.
 * @param runtimeNode - Node version of the host runtime.
 */
export function inspectManifest(
  manifest: Record<string, unknown>,
  target: CompatTarget,
  runtimeNode: string | undefined,
): ManifestVerdict

/** One plugin's diagnostic result. */
export interface PluginResult {
  name: string
  version: string
  verdict: 'incompatible' | 'unverified' | 'compatible' | 'unknown'
  findings: Finding[]
}

/**
 * Render a plain-text Chinese report.
 * @param results - Plugin diagnostic results.
 * @param options - Report context.
 */
export function renderReport(
  results: readonly PluginResult[],
  options: { target: string; node?: string; profile: string },
): string

/**
 * Read the plugins a Desktop profile declares, then inspect each installed manifest.
 * @param profileDir - Profile directory holding package.json and node_modules.
 * @param target - Host target.
 * @param runtimeNode - Node version of the host runtime.
 */
export function inspectProfile(
  profileDir: string,
  target: CompatTarget,
  runtimeNode: string | undefined,
): Promise<PluginResult[]>

/**
 * Resolve the Desktop profile directory from an explicit path or DSH_HOME.
 * @param explicit - Explicit profile path, or undefined to use DSH_HOME.
 */
export function resolveProfileDir(explicit: string | undefined): string

/** CLI entry point. */
export function main(argv: string[]): Promise<void>
