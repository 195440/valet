import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConsoleAsset } from "./server.js";

const here = dirname(fileURLToPath(import.meta.url));

export const FONT_WEIGHTS = [400, 500, 600] as const;

/**
 * The fonts the console uses: IBM Plex Mono, under the SIL Open Font License (`fonts/OFL.txt`),
 * converted to WOFF2 with every glyph kept. They are served from this machine, so the page loads
 * nothing from the internet.
 */
export function consoleFonts(): Record<string, ConsoleAsset> {
  const assets: Record<string, ConsoleAsset> = {};
  for (const weight of FONT_WEIGHTS) {
    assets[`/fonts/ibm-plex-mono-${weight}.woff2`] = {
      type: "font/woff2",
      body: readFileSync(join(here, "fonts", `ibm-plex-mono-${weight}.woff2`)),
    };
  }
  return assets;
}
