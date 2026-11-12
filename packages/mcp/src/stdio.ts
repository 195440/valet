/**
 * Over stdio, stdout belongs to the protocol: one stray line and the client sees garbage.
 * near-api-js is not shy about `console.log` ("Receipts: ..." after every transaction), so
 * reroute every write to stdout towards stderr, and hand back the only way left to write to the
 * real stdout. Call this once, before anything else can print.
 */
export function claimStdout(
  stdout: NodeJS.WriteStream = process.stdout,
  stderr: NodeJS.WriteStream = process.stderr,
): (line: string) => void {
  const protocolWrite = stdout.write.bind(stdout) as (chunk: string) => boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stdout.write = ((...args: any[]) => (stderr.write as (...a: any[]) => boolean)(...args)) as typeof stdout.write;
  return (line) => void protocolWrite(`${line}\n`);
}
