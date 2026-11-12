const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
const paint = (code: number) => (text: string) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);

export const green = paint(32);
export const red = paint(31);
export const yellow = paint(33);
export const cyan = paint(36);
export const dim = paint(2);
export const bold = paint(1);

export function banner(text: string): void {
  console.log(`\n${bold(cyan(text))}`);
}

/** Slow the story down for screen recordings: VALET_DEMO_PACE_MS=1500 npm run demo */
const paceMs = Number(process.env.VALET_DEMO_PACE_MS ?? 0);
export const pause = (): Promise<void> =>
  paceMs > 0 ? new Promise((resolve) => setTimeout(resolve, paceMs)) : Promise.resolve();

export async function step(n: number, total: number, title: string): Promise<void> {
  await pause();
  console.log(`\n${bold(`[${n}/${total}] ${title}`)}`);
}

export function line(text = ""): void {
  console.log(`  ${text}`);
}

export function sub(text: string): void {
  console.log(`      ${dim(text)}`);
}

export const ok = (text: string) => green(`✔ ${text}`);
export const warn = (text: string) => yellow(`! ${text}`);
export const bad = (text: string) => red(`✘ ${text}`);

/** Fixed-width table without dependencies (the last column is not padded). */
export function table(rows: string[][]): void {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  const last = widths.length - 1;
  rows.forEach((row, index) => {
    console.log(`  ${row.map((cell, i) => (i === last ? cell : cell.padEnd(widths[i]!))).join("  ")}`);
    if (index === 0) console.log(`  ${widths.map((w) => "─".repeat(w)).join("  ")}`);
  });
}
