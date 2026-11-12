/** One message per line, as the MCP stdio transport defines it. */

/** A client has no reason to send more than this in one message; drop it instead of buffering. */
export const MAX_LINE_BYTES = 1_000_000;

export function readLines(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  options: { maxLine?: number; onOverflow?: () => void; onEnd?: () => void } = {},
): void {
  const maxLine = options.maxLine ?? MAX_LINE_BYTES;
  let buffer = "";
  let skipping = false;
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string | Buffer) => {
    buffer += chunk.toString();
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (skipping) {
        // The tail of an oversized message: throw it away, then carry on with the next line.
        skipping = false;
      } else {
        onLine(line);
      }
    }
    if (buffer.length > maxLine) {
      buffer = "";
      if (!skipping) options.onOverflow?.();
      skipping = true;
    }
  });
  stream.on("end", () => {
    if (buffer.trim() && !skipping) onLine(buffer);
    options.onEnd?.();
  });
}
