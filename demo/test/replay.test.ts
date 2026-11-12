import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CARD_IMAGE, CARD_SIZE, CSP, PAGE_URL, buildReplayHtml, replayFiles } from "../src/replay/build.js";

const require = createRequire(import.meta.url);
const { createEngine, matches, BANNER } = require("../src/replay/replay.cjs") as {
  createEngine: (recording: unknown, options?: { sleep?: (ms: number) => Promise<void> }) => Engine;
  matches: (step: unknown, method: string, path: string, body: unknown) => boolean;
  BANNER: { label: string; text: string; linkText: string; linkHref: string };
};

interface Reply {
  status: number;
  body: any;
}
interface Engine {
  handle(method: string, path: string, body: unknown): Promise<Reply>;
  progress(): { next: number; total: number; working: boolean; workingIndex: number | null; asking: boolean };
  steps: any[];
}

const here = dirname(fileURLToPath(import.meta.url));
const replayDir = join(here, "..", "src", "replay");
const docsDir = join(here, "..", "..", "docs");
const instant = async (): Promise<void> => {};
const state = (seq: number, over: Record<string, unknown> = {}): any => ({ network: "sandbox", busy: false, asks: [], pending: [], scenarios: [], accounts: [], seq, events: [], ...over });
const event = (seq: number, text: string): any => ({ kind: "note", text, seq, ts: "2026-11-11T12:00:00.000Z" });

/** A recording of four steps: a payment, a question to a person (two steps), and an owner action. */
function tiny(): any {
  const step = (label: string, request: any, extra: Record<string, unknown>): any => ({ label, chapter: "1 / 1", title: label, note: "", target: { css: "#x" }, dwellMs: 0, workMs: 0, ...request, ...extra });
  return {
    format: 1,
    recordedAt: "2026-11-11T12:00:00.000Z",
    source: "test",
    initial: state(0),
    steps: [
      step("pay", { request: { method: "POST", path: "/api/scenario", body: { id: "vendor" } } }, { response: { status: 200, body: { ok: true, status: "paid" } }, after: state(1, { events: [event(1, "paid")] }) }),
      step("ask", { request: { method: "POST", path: "/api/scenario", body: { id: "stranger" } } }, {
        hold: true,
        asks: [{ id: "q1", receiver: "fresh.near", amountNear: "0.2", secondsLeft: 120 }],
        response: { status: 200, body: { ok: true, status: "queued" } },
        after: state(3, { events: [event(2, "asked"), event(3, "queued")], pending: [{ id: "7" }] }),
      }),
      step("answer", { request: { method: "POST", path: "/api/answer", body: { approve: true, id: "q1" } } }, { response: { status: 200, body: { ok: true } } }),
      step("approve", { request: { method: "POST", path: "/api/owner", body: { action: "approve", arg: "7" } } }, { response: { status: 200, body: { ok: true } }, after: state(4, { events: [event(4, "approved")] }) }),
    ],
  };
}

const post = (engine: Engine, path: string, body: unknown): Promise<Reply> => engine.handle("POST", path, body);
const get = (engine: Engine, since = 0): Promise<Reply> => engine.handle("GET", `/api/state?since=${since}`, null);
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("the replay engine", () => {
  it("answers the state before anything happened", async () => {
    const engine = createEngine(tiny(), { sleep: instant });
    const reply = await get(engine);
    assert.equal(reply.status, 200);
    assert.equal(reply.body.seq, 0);
    assert.deepEqual(reply.body.events, []);
    assert.equal(engine.progress().next, 0);
  });

  it("plays the steps in the order they were recorded, and a state read with `since` gets only what is new", async () => {
    const engine = createEngine(tiny(), { sleep: instant });
    const paid = await post(engine, "/api/scenario", { id: "vendor" });
    assert.deepEqual(paid, { status: 200, body: { ok: true, status: "paid" } });
    assert.deepEqual((await get(engine, 0)).body.events.map((e: any) => e.seq), [1]);
    assert.deepEqual((await get(engine, 1)).body.events, []);
    assert.equal((await get(engine, 1)).body.seq, 1);
  });

  it("refuses anything but the next recorded step, says what the next one is, and stays where it was", async () => {
    const engine = createEngine(tiny(), { sleep: instant });
    const wrong = await post(engine, "/api/scenario", { id: "thief" });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.ok, false);
    assert.match(wrong.body.error, /Next in the recording: "pay"/);
    assert.match(wrong.body.error, /npm run sandbox/);
    assert.equal(engine.progress().next, 0);
    assert.deepEqual((await get(engine)).body.events, []);
    // Right endpoint, wrong body: a different scenario, a different owner action.
    assert.equal((await post(engine, "/api/owner", { action: "pause" })).status, 409);
    assert.equal((await post(engine, "/api/pay", { receiver: "a.near", amount_near: "1" })).status, 409);
  });

  it("holds the call that waits for a person until the question is answered, and only with the recorded answer", async () => {
    const engine = createEngine(tiny(), { sleep: instant });
    await post(engine, "/api/scenario", { id: "vendor" });

    let finished: Reply | null = null;
    const held = post(engine, "/api/scenario", { id: "stranger" }).then((r) => (finished = r));
    await settle();
    assert.equal(finished, null, "the call must not return before the answer");
    assert.equal(engine.progress().asking, true);
    const during = (await get(engine, 1)).body;
    assert.equal(during.busy, true);
    assert.equal(during.asks.length, 1);
    assert.equal(during.asks[0].id, "q1");
    assert.deepEqual(during.events, [], "nothing has happened yet that the feed should show");

    // The recording has the answer Yes under the id q1: No, or another id, is not what was recorded.
    assert.equal((await post(engine, "/api/answer", { id: "q1", approve: false })).status, 409);
    assert.equal((await post(engine, "/api/answer", { id: "q9", approve: true })).status, 409);
    assert.equal(finished, null);

    const answered = await post(engine, "/api/answer", { id: "q1", approve: true });
    assert.deepEqual(answered, { status: 200, body: { ok: true } });
    assert.equal((await held).status, 200);
    assert.deepEqual(finished, { status: 200, body: { ok: true, status: "queued" } });
    const after = (await get(engine, 1)).body;
    assert.equal(after.busy, false);
    assert.deepEqual(after.asks, []);
    assert.deepEqual(after.events.map((e: any) => e.seq), [2, 3]);
    assert.equal(after.pending[0].id, "7");
  });

  it("is busy while a call is in flight, and takes one thing at a time", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const engine = createEngine(tiny(), { sleep: () => gate });
    const running = post(engine, "/api/scenario", { id: "vendor" });
    await settle();
    assert.equal(engine.progress().working, true);
    assert.equal((await get(engine)).body.busy, true);
    const second = await post(engine, "/api/scenario", { id: "stranger" });
    assert.equal(second.status, 409);
    assert.match(second.body.error, /One thing at a time/);
    release();
    assert.equal((await running).status, 200);
    assert.equal(engine.progress().working, false);
    assert.equal((await get(engine)).body.busy, false);
  });

  it("says when the recording has ended, and does not know other endpoints", async () => {
    const engine = createEngine(tiny(), { sleep: instant });
    await post(engine, "/api/scenario", { id: "vendor" });
    const held = post(engine, "/api/scenario", { id: "stranger" });
    await settle();
    await post(engine, "/api/answer", { id: "q1", approve: true });
    await held;
    await post(engine, "/api/owner", { action: "approve", arg: "7" });
    const over = await post(engine, "/api/scenario", { id: "vendor" });
    assert.equal(over.status, 409);
    assert.match(over.body.error, /recording has ended/);
    assert.equal(engine.progress().next, engine.progress().total);
    assert.equal((await engine.handle("GET", "/api/other", null)).status, 404);
    assert.equal((await engine.handle("POST", "/api/state", {})).status, 404);
  });

  it("compares request bodies as text, so the id 7 and the text \"7\" are the same", () => {
    const step = { request: { method: "POST", path: "/api/owner", body: { action: "approve", arg: "7" } } };
    assert.equal(matches(step, "POST", "/api/owner", { action: "approve", arg: 7 }), true);
    assert.equal(matches(step, "POST", "/api/owner", { action: "approve", arg: "8" }), false);
    assert.equal(matches(step, "POST", "/api/owner", null), false);
    assert.equal(matches(step, "GET", "/api/owner", { action: "approve", arg: "7" }), false);
  });
});

describe("the recording", () => {
  const recordingPath = join(replayDir, "recording.json");
  const recording = existsSync(recordingPath) ? JSON.parse(readFileSync(recordingPath, "utf8")) : null;

  it("exists and is the story: eleven steps, every call answered", () => {
    assert.ok(recording, "run `npm run replay:record` against a fresh sandbox");
    assert.equal(recording.format, 1);
    assert.equal(recording.steps.length, 11);
    for (const step of recording.steps) {
      assert.equal(step.response.status, 200, step.label);
      assert.ok(step.title && step.note && step.chapter, step.label);
    }
    assert.equal(recording.initial.seq, 0);
    assert.deepEqual(recording.initial.events, []);
  });

  it("plays through the engine from the first step to the last, ending in the recorded state", async () => {
    const engine = createEngine(recording, { sleep: instant });
    let lastAsk: any = null;
    for (const [i, step] of recording.steps.entries()) {
      const pending = post(engine, step.request.path, step.request.body);
      await settle();
      if (step.hold) {
        const asking = (await get(engine, 0)).body.asks;
        assert.equal(asking.length, 1, "the question is open while the call waits");
        lastAsk = asking[0];
        assert.equal(recording.steps[i + 1].request.body.id, lastAsk.id, "the next step answers that very question");
        continue; // the next step is the answer; the held call returns together with it
      }
      const reply = await pending;
      assert.equal(reply.status, 200, step.label);
      assert.deepEqual(reply.body, step.response.body, step.label);
    }
    const end = (await get(engine, 0)).body;
    const total = recording.steps.reduce((n: number, s: any) => n + (s.after?.events.length ?? 0), 0);
    assert.equal(end.events.length, total);
    assert.equal(end.seq, recording.steps.at(-1).after.seq);
    assert.equal(end.vault.paused, false, "the last step unpauses the vault");
    assert.equal(end.busy, false);
    assert.equal(engine.progress().next, engine.progress().total);
  });

  it("tells the story it claims: the vendor paid, the stranger asked and approved, the thief got nothing", () => {
    const events = recording.steps.flatMap((s: any) => s.after?.events ?? []);
    const payments = events.filter((e: any) => e.kind === "payment");
    assert.deepEqual(
      payments.map((e: any) => `${e.status}:${e.stage}`),
      ["paid:chain", "refused:oracle", "queued:chain", "refused:oracle", "blocked:chain", "blocked:chain"],
    );
    const thief = events.find((e: any) => e.kind === "thief");
    assert.equal(thief.accepted, 0);
    assert.ok(thief.results.length >= 5);
    assert.ok(events.some((e: any) => e.kind === "owner" && e.action === "approve" && e.ok));
  });

  it("holds nothing that belongs to the machine it was recorded on", () => {
    const text = readFileSync(recordingPath, "utf8");
    assert.doesNotMatch(text, /\/Users\/|\/home\/|hackathon\/|\.tools|\.valet/);
    assert.doesNotMatch(text, /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/, "a secret key is 88 characters of base58");
  });
});

describe("the replay page", () => {
  const html = existsSync(join(docsDir, "index.html")) ? readFileSync(join(docsDir, "index.html"), "utf8") : "";

  it("is what the builder makes from the console page, the recording and the player (rebuild with `npm run replay:build`)", () => {
    for (const [path, body] of replayFiles()) {
      const file = join(docsDir, path);
      assert.ok(existsSync(file), `docs/${path} is missing`);
      assert.ok(readFileSync(file).equals(body), `docs/${path} is out of date`);
    }
  });

  it("loads nothing from outside: a strict policy, only its own fonts, no links to other sites in the markup", () => {
    assert.ok(html.includes(`content="${CSP}"`));
    assert.equal((html.match(/Content-Security-Policy/g) ?? []).length, 1);
    assert.doesNotMatch(html, /__NONCE__/);
    const markup = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
    const urls = [...markup.matchAll(/\b(?:href|src)="([^"]*)"/g)].map((m) => m[1]!);
    assert.ok(urls.length > 0);
    for (const url of urls) assert.match(url, /^(fonts\/ibm-plex-mono-(400|500|600)\.woff2|data:image\/svg\+xml,)/, url);
    for (const weight of [400, 500, 600]) assert.ok(existsSync(join(docsDir, "fonts", `ibm-plex-mono-${weight}.woff2`)));
    assert.ok(existsSync(join(docsDir, "fonts", "OFL.txt")));
    assert.ok(existsSync(join(docsDir, ".nojekyll")));
  });

  it("carries the console, the recording and the player, in that order of dependence", () => {
    assert.equal((html.match(/<script/g) ?? []).length, 3);
    const data = html.indexOf('<script type="application/json" id="valet-recording">');
    const player = html.indexOf("function createEngine");
    const consolePage = html.indexOf("const ICONS = {");
    assert.ok(data > 0 && data < player && player < consolePage, "the player must be in place before the console's own script runs");
    assert.match(html, /<title>Valet console \(replay\)<\/title>/);
  });

  it("tells a reader without scripts what it is: a link card in the head, the banner first in the body, and no talk of a token", () => {
    const head = html.slice(0, html.indexOf("</head>"));
    const meta = (key: string): string | undefined => new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)">`).exec(head)?.[1];
    const description = meta("description") ?? "";
    assert.match(description, /^Replay of a recorded Valet console session/);
    assert.ok(description.length <= 200, "a link preview cuts a description at about 200 characters");
    assert.equal(meta("og:url"), PAGE_URL);
    assert.equal(meta("og:image"), PAGE_URL + CARD_IMAGE);
    assert.equal(meta("og:image:width"), String(CARD_SIZE.width));
    assert.equal(meta("og:image:height"), String(CARD_SIZE.height));
    assert.equal(meta("twitter:card"), "summary_large_image");
    assert.equal(meta("twitter:image"), meta("og:image"));
    for (const key of ["og:title", "og:description", "og:image:alt", "twitter:title", "twitter:description", "twitter:image:alt"]) assert.ok(meta(key), `missing ${key}`);

    // The banner is the first thing in the body and before any script, with the player's own words.
    const body = html.slice(html.indexOf("<body>"));
    assert.ok(body.startsWith(`<body>\n<div class="rp-banner" role="note"><b>${BANNER.label}</b><span>${BANNER.text}</span></div>\n`));
    assert.ok(html.indexOf(BANNER.text) < html.indexOf("<script"));

    // What a text-only reader gets from the rest of the page: a replay, not a console that wants a token.
    const text = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ");
    assert.match(text, /This is a replay/);
    assert.doesNotMatch(text, /needs the access token|Open the console from the sandbox|talks only to the sandbox/);
    assert.doesNotMatch(html, /<b>live<\/b>/);
  });

  it("has the picture its link card names: a PNG of exactly the size it says, small, and with nothing of the machine in it", () => {
    const file = join(docsDir, CARD_IMAGE);
    assert.ok(existsSync(file), `docs/${CARD_IMAGE} is missing`);
    const png = readFileSync(file);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "a PNG");
    assert.equal(png.readUInt32BE(16), CARD_SIZE.width);
    assert.equal(png.readUInt32BE(20), CARD_SIZE.height);
    assert.ok(png.length < 300_000, `${png.length} bytes is more than a preview needs`);
    assert.doesNotMatch(png.toString("latin1"), /\/Users\/|\/home\/|hackathon\/|\.tools/);
  });

  it("builds the same page from the same inputs, and refuses a console page it does not understand", () => {
    const page = readFileSync(join(here, "..", "src", "console", "index.html"), "utf8");
    const recording = readFileSync(join(replayDir, "recording.json"), "utf8");
    const player = readFileSync(join(replayDir, "replay.cjs"), "utf8");
    assert.equal(buildReplayHtml(page, recording, player), buildReplayHtml(page, recording, player));
    assert.throws(() => buildReplayHtml(page.replace('<script nonce="__NONCE__">', '<script nonce="__NONCE__"></script><script nonce="__NONCE__">'), recording, player), /one script/);
    assert.throws(() => buildReplayHtml(page, recording, player + "\n</script>"), /closing script tag/);
    assert.throws(() => buildReplayHtml(page + ' <i nonce="__NONCE__">__NONCE__</i>', recording, player), /nonce placeholder/);
    // The words it swaps for a replay's: if the console page no longer has them, the build says so instead of shipping a page that talks of a token.
    assert.throws(() => buildReplayHtml(page.replace("<b>live</b>", "<b>on</b>"), recording, player), /the "live" tag/);
    assert.throws(() => buildReplayHtml(page.replace('<div id="gate" hidden>', '<div id="gate">'), recording, player), /gate for a missing token/);
    assert.throws(() => buildReplayHtml(page.replace("The Valet console needs JavaScript.", "Needs JS."), recording, player), /note for a browser without scripts/);
  });
});
