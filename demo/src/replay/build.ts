/**
 * Builds the static replay page: docs/index.html (plus the fonts next to it).
 *
 * The page is the console's own page with four additions: a Content-Security-Policy for a page that
 * loads nothing, the recording as a data block, replay.cjs, which answers the console's API from that
 * recording, and the words of a replay in the HTML itself. Those words matter to whoever does not run
 * the page's scripts: a link preview (X, Slack) reads the head, a search crawler or an AI agent that
 * fetches the page as text reads the body, and the console's own text says "this page needs the access
 * token that npm run sandbox prints", which is wrong for a recording. Open docs/index.html in a browser
 * (no server needed), or serve docs/ as GitHub Pages.
 *
 *   npm run replay:build -w @valet/demo
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FONT_WEIGHTS } from "../console/assets.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const consoleDir = join(here, "..", "console");

/** The player's banner: its words are the page's first sentence, in the HTML and again once the player runs. */
const { BANNER } = createRequire(import.meta.url)("./replay.cjs") as { BANNER: { label: string; text: string } };

/** Where the replay is hosted. A link preview needs the address of its picture in full. */
export const PAGE_URL = "https://195440.github.io/valet/";
/** The picture a link preview shows, by path under docs/. 1200 x 600 is the 2:1 that X's large card shows uncropped. */
export const CARD_IMAGE = "img/og-card.png";
export const CARD_SIZE = { width: 1200, height: 600 } as const;
const CARD_TITLE = "Valet: a valet key for AI agents on NEAR";
const CARD_DESCRIPTION =
  "Replay of a recorded Valet console session: an AI agent pays, the vault decides. Caps and a kill switch are enforced on-chain, an oracle checks every receiver. Built at NEAR HACKATHON.";
const CARD_ALT = "Valet: give an AI agent a wallet without giving it your keys. An on-chain spending guard for AI agents on NEAR. Replay the console in your browser.";

export const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const escapeText = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttribute = (text: string): string => escapeText(text).replaceAll('"', "&quot;");

/** What a link preview and a search engine read. They do not run scripts: they read the head. */
function cardTags(): string {
  const image = PAGE_URL + CARD_IMAGE;
  const meta = (kind: "name" | "property", key: string, value: string): string => `<meta ${kind}="${key}" content="${escapeAttribute(value)}">`;
  return [
    meta("name", "description", CARD_DESCRIPTION),
    meta("property", "og:type", "website"),
    meta("property", "og:site_name", "Valet"),
    meta("property", "og:title", CARD_TITLE),
    meta("property", "og:description", CARD_DESCRIPTION),
    meta("property", "og:url", PAGE_URL),
    meta("property", "og:image", image),
    meta("property", "og:image:width", String(CARD_SIZE.width)),
    meta("property", "og:image:height", String(CARD_SIZE.height)),
    meta("property", "og:image:alt", CARD_ALT),
    meta("name", "twitter:card", "summary_large_image"),
    meta("name", "twitter:title", CARD_TITLE),
    meta("name", "twitter:description", CARD_DESCRIPTION),
    meta("name", "twitter:image", image),
    meta("name", "twitter:image:alt", CARD_ALT),
  ].join("\n");
}

/** Replaces the one place the console page has `find` in, or says that the console page is no longer what this build knows. */
function swapOnce(page: string, find: string | RegExp, replacement: string, what: string): string {
  const count = typeof find === "string" ? page.split(find).length - 1 : (page.match(new RegExp(find.source, "g")) ?? []).length;
  if (count !== 1) throw new Error(`the console page changed: the build finds ${count} of ${what}, not one`);
  return page.replace(find, () => replacement);
}

const CONSOLE_NOSCRIPT = `<noscript><p class="pad">The Valet console needs JavaScript. It loads no outside scripts and talks only to the sandbox on this machine.</p></noscript>`;
const REPLAY_NOSCRIPT = `<noscript><p class="pad">This replay needs JavaScript to play the recorded session. It loads no outside scripts and talks to no server.</p></noscript>`;
/** The console shows this when the address has no token. A replay never does, but a reader without scripts sees the text. */
const REPLAY_GATE = `<div id="gate" hidden>
  <h3>This is a replay</h3>
  <p class="muted mt10">No access token is needed here: the page replays one recorded session of the console and never talks to a vault. To use the live console, run <code>npm run sandbox</code> and open the link it prints.</p>
</div>`;

/** The replay page as text. Pure: the same inputs always give the same page. */
export function buildReplayHtml(consolePage: string, recordingJson: string, replayScript: string): string {
  if (replayScript.includes("</script")) throw new Error("replay.cjs must not contain a closing script tag");
  let page = consolePage.replaceAll(' nonce="__NONCE__"', "");
  if (page.includes("__NONCE__")) throw new Error("the console page has a nonce placeholder this build does not know");
  // The console page asks the sandbox for its fonts at /fonts/...; the replay keeps them next to itself.
  // Without the preload hints: a page opened from disk (file://) cannot make the cross-origin request they ask for.
  page = page.replace(/<link rel="preload"[^>]*>\n/g, "").replaceAll('"/fonts/', '"fonts/');
  if (page.includes('"/fonts/')) throw new Error("the console page asks for a font at a path this build does not rewrite");

  const scripts = page.match(/<script>/g) ?? [];
  if (scripts.length !== 1) throw new Error(`expected one script in the console page, found ${scripts.length}`);
  const data = JSON.stringify(JSON.parse(recordingJson)).replaceAll("<", "\\u003c");
  page = page.replace("<script>", () => `<script type="application/json" id="valet-recording">${data}</script>\n<script>\n${replayScript.trimEnd()}\n</script>\n<script>`);

  page = page.replace('<meta charset="utf-8">', () => `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
  page = swapOnce(page, "<title>Valet console</title>", `<title>Valet console (replay)</title>\n${cardTags()}`, "the title");
  if (!page.includes("Content-Security-Policy") || !page.includes("(replay)")) throw new Error("the console page changed: the build no longer finds its head");

  // The words of a replay, for a reader without scripts: first in the body, then where the console speaks of a token or of "live".
  page = swapOnce(page, "<body>\n", `<body>\n<div class="rp-banner" role="note"><b>${escapeText(BANNER.label)}</b><span>${escapeText(BANNER.text)}</span></div>\n`, "the start of the body");
  page = swapOnce(page, CONSOLE_NOSCRIPT, REPLAY_NOSCRIPT, "the note for a browser without scripts");
  page = swapOnce(page, /<div id="gate" hidden>[\s\S]*?<\/div>/, REPLAY_GATE, "the gate for a missing token");
  page = swapOnce(page, "<b>live</b>", "<b>replay</b>", 'the "live" tag');
  return page;
}

/** Everything the replay needs on disk, by path relative to docs/. */
export function replayFiles(): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const html = buildReplayHtml(
    readFileSync(join(consoleDir, "index.html"), "utf8"),
    readFileSync(join(here, "recording.json"), "utf8"),
    readFileSync(join(here, "replay.cjs"), "utf8"),
  );
  files.set("index.html", Buffer.from(html));
  for (const weight of FONT_WEIGHTS) files.set(`fonts/ibm-plex-mono-${weight}.woff2`, readFileSync(join(consoleDir, "fonts", `ibm-plex-mono-${weight}.woff2`)));
  files.set("fonts/OFL.txt", readFileSync(join(consoleDir, "fonts", "OFL.txt")));
  // Without this file GitHub Pages would run the folder through Jekyll first.
  files.set(".nojekyll", Buffer.alloc(0));
  return files;
}

export function writeReplay(docsDir = join(repoRoot, "docs")): string[] {
  const written: string[] = [];
  for (const [path, body] of replayFiles()) {
    const target = join(docsDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
    written.push(path);
  }
  return written;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!existsSync(join(here, "recording.json"))) {
    console.error("there is no recording yet: run `npm run replay:record` against a fresh sandbox first");
    process.exit(1);
  }
  const written = writeReplay();
  console.log(`wrote docs/${written.join(", docs/")}`);
}
