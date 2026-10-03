/** Resolve the Desktop auto-update channel and its Tencent COS destination. */

import { valid } from 'semver'

/** Environment variable that selects the Desktop update deployment. */
export const DESKTOP_AUTO_UPDATE_ENV = 'DSH_DESKTOP_AUTO_UPDATE_ENV'

const UPDATE_ENVIRONMENTS = {
  test: {
    originEnvName: 'DOWNLOAD_TEST_ORIGIN',
    fixedOrigin: undefined,
    bucketEnvName: 'DOWNLOAD_TEST_COS_BUCKET',
    secretIdEnvName: 'DOWNLOAD_TEST_COS_SECRET_ID',
    secretKeyEnvName: 'DOWNLOAD_TEST_COS_SECRET_KEY',
  },
  production: {
    originEnvName: undefined,
    fixedOrigin: 'https://download.deepseek.com',
    bucketEnvName: 'DOWNLOAD_PROD_COS_BUCKET',
    secretIdEnvName: 'DOWNLOAD_PROD_COS_SECRET_ID',
    secretKeyEnvName: 'DOWNLOAD_PROD_COS_SECRET_KEY',
  },
  // A self-hosted deployment publishes to an operator-controlled web server instead of Tencent COS.
  // There is no bucket or credential pair: binaries and channel metadata share one flat directory,
  // and `upload-selfhosted.mjs` pushes that directory to the server over SSH.
  selfhosted: {
    originEnvName: 'DOWNLOAD_SELFHOST_ORIGIN',
    prefixEnvName: 'DOWNLOAD_SELFHOST_PREFIX',
    fixedOrigin: undefined,
    bucketEnvName: undefined,
    secretIdEnvName: undefined,
    secretKeyEnvName: undefined,
  },
}

const UPDATE_TARGETS = new Set(['mac-arm64', 'mac-x64', 'win-x64', 'linux-x64', 'linux-arm64'])

/**
 * Resolve the update deployment, defaulting local release work to test.
 * @param {NodeJS.ProcessEnv} env - Packaging or upload environment.
 * @returns {'test' | 'production' | 'selfhosted'} Validated deployment name.
 */
export function resolveDesktopAutoUpdateEnvironment(env) {
  const value = env[DESKTOP_AUTO_UPDATE_ENV]?.trim() || 'test'
  if (value !== 'test' && value !== 'production' && value !== 'selfhosted') {
    throw new Error(`desktop auto-update: ${DESKTOP_AUTO_UPDATE_ENV} must be "test", "production", or "selfhosted"`)
  }
  return value
}

/**
 * Resolve one supported platform and architecture to its update directory.
 * @param {NodeJS.Platform} platform - Target Node.js platform.
 * @param {string} arch - Target Node.js architecture.
 * @returns {'mac-arm64' | 'mac-x64' | 'win-x64' | 'linux-x64' | 'linux-arm64'} Update target directory.
 */
export function resolveDesktopAutoUpdateTarget(platform, arch) {
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : platform
  const target = `${os}-${arch}`
  if (!UPDATE_TARGETS.has(target)) {
    throw new Error(`desktop auto-update: unsupported target ${target}`)
  }
  return target
}

/**
 * Return the local completion record filename for one packaged target.
 * @param {'mac-arm64' | 'mac-x64' | 'win-x64' | 'linux-x64' | 'linux-arm64'} target - Supported release target.
 * @returns {string} Filename stored beside electron-builder artifacts.
 */
export function desktopBuildRecordFilename(target) {
  if (!UPDATE_TARGETS.has(target)) {
    throw new Error(`desktop auto-update: unsupported target ${target}`)
  }
  return `${target}-release.json`
}

/**
 * Return the electron-builder channel metadata filename for an application version.
 * @param {string} version - Desktop semantic version.
 * @param {NodeJS.Platform} platform - Target platform.
 * @param {string} [arch] - Target architecture; Linux manifests are suffixed unless it is x64.
 * @returns {string} Channel metadata filename emitted for the target.
 */
export function desktopUpdateMetadataFilename(version, platform, arch) {
  if (valid(version) === null) {
    throw new Error(`desktop auto-update: invalid Desktop version ${JSON.stringify(version)}`)
  }
  if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') {
    throw new Error(`desktop auto-update: unsupported metadata platform ${platform}`)
  }
  // electron-builder names a Linux manifest after its architecture, and electron-updater requests
  // the same name, so a non-x64 Linux build must not look for the x64 file.
  const osSuffix = platform === 'darwin' ? '-mac' : platform === 'linux' ? '-linux' : ''
  const archSuffix = platform === 'linux' && arch !== undefined && arch !== '' && arch !== 'x64' ? `-${arch}` : ''
  return `nightly${osSuffix}${archSuffix}.yml`
}

/**
 * Read one required release setting without accepting whitespace-only values.
 * @param {NodeJS.ProcessEnv} env - Packaging or upload environment.
 * @param {string} name - Environment variable to read.
 * @returns {string} Trimmed setting.
 */
function requiredEnvironmentValue(env, name) {
  const value = env[name]?.trim()
  if (value === undefined || value === '') {
    throw new Error(`desktop auto-update: ${name} must be set to a non-empty value`)
  }
  return value
}

/**
 * Normalize an HTTPS origin and reject paths or credentials.
 * @param {string} value - Candidate origin.
 * @param {string} name - Environment variable used in diagnostics.
 * @returns {string} Normalized HTTPS origin without a trailing slash.
 */
function httpsOrigin(value, name) {
  let parsed
  try {
    parsed = new URL(value)
  }
  catch {
    throw new Error(`desktop auto-update: ${name} must be an absolute HTTPS origin`)
  }
  if (parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== '') {
    throw new Error(`desktop auto-update: ${name} must be an absolute HTTPS origin without a path, credentials, query, or fragment`)
  }
  return parsed.origin
}

/**
 * Resolve the public updater URL and object prefixes for one release target.
 * @param {NodeJS.ProcessEnv} env - Packaging or upload environment.
 * @param {NodeJS.Platform} platform - Target Node.js platform.
 * @param {string} arch - Target Node.js architecture.
 * @returns {{ environment: 'test' | 'production' | 'selfhosted', target: 'mac-arm64' | 'mac-x64' | 'win-x64' | 'linux-x64' | 'linux-arm64', origin: string, publicUrl: string, keyPrefix: string, binaryKeyPrefix: string }} Resolved updater configuration.
 * @throws {Error} When the test deployment lacks a valid HTTPS origin or a 32-character lowercase hexadecimal release ID.
 */
export function resolveDesktopAutoUpdateConfig(env, platform, arch) {
  const environment = resolveDesktopAutoUpdateEnvironment(env)
  const target = resolveDesktopAutoUpdateTarget(platform, arch)
  const deployment = UPDATE_ENVIRONMENTS[environment]
  let origin = deployment.fixedOrigin
  if (origin === undefined) {
    const { originEnvName } = deployment
    if (originEnvName === undefined) throw new Error('desktop auto-update: selected deployment has no origin')
    origin = httpsOrigin(requiredEnvironmentValue(env, originEnvName), originEnvName)
  }
  let releasePrefix = 'dsh-desk'
  if (environment === 'test') {
    const releaseId = requiredEnvironmentValue(env, 'DOWNLOAD_TEST_RELEASE_ID')
    if (!/^[a-f0-9]{32}$/u.test(releaseId)) {
      throw new Error('desktop auto-update: DOWNLOAD_TEST_RELEASE_ID must contain 32 lowercase hexadecimal characters')
    }
    releasePrefix += `/${releaseId}`
  }
  else if (environment === 'selfhosted') {
    releasePrefix = selfHostedPrefix(env, deployment.prefixEnvName)
  }
  // A self-hosted origin serves one flat directory shared by every architecture. electron-builder
  // and electron-updater both suffix Linux manifests with a non-x64 architecture, so x64 and arm64
  // coexist there without per-target subdirectories.
  const flat = environment === 'selfhosted'
  const keyPrefix = flat ? releasePrefix : `${releasePrefix}/feeds/${target}`
  return {
    environment,
    target,
    origin,
    keyPrefix,
    binaryKeyPrefix: flat ? releasePrefix : `${releasePrefix}/bin/${target}`,
    publicUrl: `${origin}/${keyPrefix}/`,
  }
}

/**
 * Normalize the directory a self-hosted origin serves the release from.
 * @param {NodeJS.ProcessEnv} env - Packaging or upload environment.
 * @param {string | undefined} name - Environment variable holding the directory prefix.
 * @returns {string} Prefix without leading or trailing slashes, defaulting to `dsh`.
 */
function selfHostedPrefix(env, name) {
  if (name === undefined) throw new Error('desktop auto-update: selected deployment has no prefix')
  const value = (env[name] ?? '').trim() || 'dsh'
  if (value.includes('\\')
    || value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`desktop auto-update: ${name} must be a relative directory path without empty, ".", or ".." segments`)
  }
  return value
}

/**
 * Resolve the public updater URL and private COS destination for one upload target.
 * @param {NodeJS.ProcessEnv} env - Upload environment.
 * @param {NodeJS.Platform} platform - Target Node.js platform.
 * @param {string} arch - Target Node.js architecture.
 * @returns {{ environment: 'test' | 'production', target: 'mac-arm64' | 'mac-x64' | 'win-x64' | 'linux-x64' | 'linux-arm64', origin: string, publicUrl: string, keyPrefix: string, binaryKeyPrefix: string, bucket: string, secretIdEnvName: string, secretKeyEnvName: string }} Resolved upload configuration.
 * @throws {Error} When the selected deployment lacks a bucket or valid updater configuration.
 */
export function resolveDesktopUploadConfig(env, platform, arch) {
  const update = resolveDesktopAutoUpdateConfig(env, platform, arch)
  const deployment = UPDATE_ENVIRONMENTS[update.environment]
  const { bucketEnvName } = deployment
  if (bucketEnvName === undefined) {
    throw new Error(`desktop auto-update: the ${update.environment} deployment stores nothing in Tencent COS; publish it with upload-selfhosted.mjs instead`)
  }
  return {
    ...update,
    bucket: requiredEnvironmentValue(env, deployment.bucketEnvName),
    secretIdEnvName: deployment.secretIdEnvName,
    secretKeyEnvName: deployment.secretKeyEnvName,
  }
}
