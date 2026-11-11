/**
 * Parse `find -printf '%s\t%f\n'` output into a file name -> size map.
 * @param stdout - Raw output of the remote listing command.
 * @returns File name -> size in bytes, for every line carrying a whole-number size.
 */
export function parseRemoteListing(stdout: string): Map<string, number>

/**
 * Render one channel manifest matching the electron-builder generic provider schema.
 * @param version - Product version the manifest advertises.
 * @param filename - Artifact file name the client should download.
 * @param digest - Base64 sha512 of the artifact.
 * @param size - Byte length of the artifact.
 * @param blockMapSize - Byte length of the companion `.blockmap`; enables differential updates.
 * @returns YAML manifest text for the generic provider.
 */
export function channelManifest(
  version: string,
  filename: string,
  digest: string,
  size: number,
  blockMapSize?: number,
): string

/**
 * Read the block map length electron-builder appends to an AppImage.
 * @param tail - Compressed block map followed by its 4-byte big-endian length.
 * @returns Byte length of the compressed block map, or undefined when the tail is not one.
 */
export function parseEmbeddedBlockMap(tail: Buffer): number | undefined

/**
 * Read the `version:` field out of a rendered channel manifest.
 * @param contents - Manifest text, as produced by `channelManifest()`.
 * @returns The advertised version, or undefined when the text carries none.
 */
export function parseManifestVersion(contents: string): string | undefined

/**
 * Render the download page from the files that actually exist on the server.
 * Only packages of `version` appear; rollback releases, block maps and checksums are ignored.
 * @param version - Version the feeds currently advertise.
 * @param listing - Remote file name -> byte length.
 * @returns Complete index.html document.
 */
export function renderDownloadIndex(version: string, listing: Map<string, number>): string

/**
 * Cross-check the version advertised by every channel feed (nightly/latest for
 * x64 and arm64) before rendering the download page. The x64 nightly feed is
 * authoritative; missing feeds are tolerated, but any live feed that disagrees
 * makes the page contradictory and is rejected.
 * @param versions - Feed file name -> advertised version (undefined when absent).
 * @returns The one version every live feed agrees on.
 * @throws When the nightly feed is missing/invalid or a feed disagrees.
 */
export function reconcileFeedVersions(versions: Record<string, string | undefined>): string

/**
 * Find packages of `version` missing from the remote directory. A publish
 * cancelled halfway can leave only some of the six packages live.
 * @param version - Version the feeds advertise.
 * @param listing - Remote file name -> byte length.
 * @returns "arch format" labels for the missing packages (empty when complete).
 */
export function missingDownloadPackages(version: string, listing: Map<string, number>): string[]

/**
 * Read the remote document root and refuse the values that would publish somewhere else.
 * @returns Absolute remote directory, without a trailing slash.
 */
export function resolveRemoteRoot(): string

/**
 * Remove the SSH password from text that is about to be printed.
 * @param message - Text that may contain the password.
 * @returns The same text with every occurrence replaced.
 */
export function redact(message: string): string

/**
 * Push one staged directory to the remote document root, splitting large artifacts across streams.
 * @param localDirectory - Staged artifacts to publish.
 * @param remoteRoot - Directory under the remote document root that receives them.
 * @returns Description of the transport the run used.
 */
export function upload(localDirectory: string, remoteRoot: string): Promise<string>

/**
 * Publish packaged Linux artifacts to a self-hosted web server.
 * @param argv - Command arguments: one target name plus `--stage-only`, `--prune` and `--verify`.
 */
export function uploadSelfHostedTarget(argv: string[]): Promise<void>

/**
 * Regenerate index.html from the live remote directory after both architectures publish.
 * Reads the version from the x64 nightly feed and cross-checks all four feeds
 * (nightly/latest for x64 and arm64), refusing to publish a contradictory page.
 * Warns when some of the six packages of that version are missing.
 * @param argv - Command arguments (currently none).
 */
export function publishDownloadIndex(argv: string[]): Promise<void>
