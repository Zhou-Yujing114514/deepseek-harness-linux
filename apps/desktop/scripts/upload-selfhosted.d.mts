/**
 * Parse `find -printf '%s\t%f\n'` output into a file name -> size map.
 * @param stdout - Raw output of the remote listing command.
 * @returns File name -> size in bytes, for every line carrying a whole-number size.
 */
export function parseRemoteListing(stdout: string): Map<string, number>

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
