/**
 * The page shows text that an AI agent, an oracle and a stranger's contract can influence (a memo,
 * an account id, a reason). These checks keep it from ever treating that text as markup or code,
 * and keep it self-contained. The real browser run is in the e2e suite and the README's screenshots.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FONT_WEIGHTS, consoleFonts } from "../src/console/assets.js";

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "console", "index.html"), "utf8");
const script = /<script nonce="__NONCE__">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
/** The page's own tags, without the code and the stylesheet (their text can contain `once =` or `style=`). */
const markup = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");

describe("the console page", () => {
  it("has one script and one style, both taking the server's nonce, and nothing inline besides", () => {
    assert.ok(script.length > 1000, "found the script");
    assert.equal((html.match(/<script\b/g) ?? []).length, 1);
    assert.equal((html.match(/<style\b/g) ?? []).length, 1);
    assert.equal((html.match(/__NONCE__/g) ?? []).length, 2);
    assert.ok(!/<script[^>]*\bsrc=/i.test(html), "no external script");
    assert.ok(!/<link[^>]*rel=["']?stylesheet/i.test(html), "no external stylesheet");
    assert.ok(!/\sstyle\s*=/i.test(markup), "no style attributes: the policy would drop them");
    assert.ok(!/\son[a-z]+\s*=/i.test(markup), "no inline event handlers: the policy would drop them");
  });

  it("keeps the title the end-to-end suite looks for, and every element the script reaches for", () => {
    assert.match(html, /<title>Valet console<\/title>/);
    // A typo in an id would only show as a blank page in a browser, so look every one up here.
    const ids = new Set([...script.matchAll(/\$\("([A-Za-z][\w-]*)"\)/g)].map((m) => m[1]!));
    for (const id of ["allowForm", "allowInput", "allowTags", "denyForm", "denyInput", "denyTags"]) ids.add(id);
    assert.ok(ids.size > 30, "found the ids the script uses");
    const missing = [...ids].filter((id) => !new RegExp(`\\sid="${id}"`).test(markup));
    assert.deepEqual(missing, []);
  });

  it("asks only for fonts the sandbox serves, and for no other file", () => {
    const fonts = consoleFonts();
    assert.deepEqual(Object.keys(fonts).sort(), FONT_WEIGHTS.map((w) => `/fonts/ibm-plex-mono-${w}.woff2`).sort());
    for (const [path, font] of Object.entries(fonts)) {
      assert.equal(font.type, "font/woff2", path);
      assert.equal(Buffer.from(font.body.subarray(0, 4)).toString("latin1"), "wOF2", `${path} is a WOFF2 file`);
      assert.ok(font.body.length > 10_000, `${path} is a whole font, not a stub`);
    }
    // Every url() in the style is a font from the server or a picture written into the page; every hint likewise.
    const urls = [...html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]!).filter((u) => !u.startsWith("data:"));
    assert.equal(urls.length, FONT_WEIGHTS.length, "one font file per weight, nothing else");
    for (const url of urls) assert.ok(url in fonts, `${url} is served by the sandbox`);
    const hints = [...html.matchAll(/<link[^>]*rel="preload"[^>]*href="([^"]+)"/g)].map((m) => m[1]!);
    assert.ok(hints.length >= 1);
    for (const hint of hints) assert.ok(hint in fonts, `${hint} is served by the sandbox`);
    assert.ok(!/@import/.test(html), "no style is fetched from anywhere");
  });

  it("makes no request to any other site", () => {
    const outside = [...html.matchAll(/(?:src|href|action)=["'](https?:)?\/\/[^"']+["']/gi)].map((m) => m[0]);
    assert.deepEqual(outside, []);
    assert.ok(!/fetch\(\s*["'`]https?:/.test(script));
    assert.ok(!/new WebSocket|EventSource|XMLHttpRequest|navigator\.sendBeacon/.test(script));
    const fetched = [...script.matchAll(/api\(\s*["'`]([^"'`]+)/g)].map((m) => m[1]);
    assert.ok(fetched.length >= 5);
    assert.ok(fetched.every((path) => path!.startsWith("/api/")), `only the sandbox's own API: ${fetched.join(", ")}`);
  });

  it("puts text in the page with textContent and text nodes, never as HTML or code", () => {
    for (const forbidden of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function\b/, /\bFunction\s*\(/, /setTimeout\(\s*["'`]/, /setInterval\(\s*["'`]/, /DOMParser/, /createContextualFragment/, /srcdoc/]) {
      assert.ok(!forbidden.test(script), `the script must not use ${forbidden}`);
    }
    assert.match(script, /\.textContent\s*=/);
    // The element builder only ever sets attributes from our own markup, and `text` through textContent.
    assert.match(script, /k === "text"\) el\.textContent = v/);
  });

  it("never turns data into a link or an address the browser would follow", () => {
    assert.ok(!/createElement\(\s*["'`]a["'`]/.test(script), "no anchors are created");
    assert.ok(!/\bh\(\s*["'`]a["'`]/.test(script), "no anchors through the builder");
    assert.ok(!/location\s*(\.href)?\s*=/.test(script), "no navigation");
    assert.ok(!/window\.open/.test(script));
  });

  it("keeps the access token out of the address bar and of every URL it requests", () => {
    assert.match(script, /history\.replaceState\(null, "", location\.pathname\)/);
    assert.match(script, /"x-valet-token": token/);
    assert.ok(!/\?token=|&token=/.test(script));
  });
});
