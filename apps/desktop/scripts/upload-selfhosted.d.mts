/**
 * Parse `find -printf '%s\t%f\n'` output into a file name -> size map.
 * @param stdout - Raw output of the remote listing command.
 * @returns File name -> size in bytes, for every line carrying a whole-number size.
 */
export function parseRemoteListing(stdout: string): Map<string, number>

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
