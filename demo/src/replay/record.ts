/**
 * Records one session of the web console as the data behind the static replay page (docs/index.html).
 *
 * It needs a fresh `npm run sandbox` (the story assumes a vault nobody has used) and the console
 * link that the sandbox prints:
 *
 *   npm run sandbox                                              # terminal 1
 *   npm run replay:record -w @valet/demo -- "http://127.0.0.1:PORT/#token=..."   # terminal 2
 *
 * It plays the same story as the demo video, in the same order, through the console's own HTTP API,
 * so every response in the recording is something the real sandbox answered. Then it checks that
 * each step ended the way the story says, and writes demo/src/replay/recording.json. Rebuild the
 * page with `npm run replay:build -w @valet/demo`.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** What the page shows for one step, and what the recorder must see come back. */
export interface StepSpec {
  /** Names the step when the viewer does something else first. */
  label: string;
  chapter: string;
  title: string;
  note: string;
  request: { method: "POST"; path: string; body: Record<string, unknown> };
  /** The control the viewer should press: a CSS selector, and the text it must carry if several match. */
  target: { css: string; text?: string };
  /** How long the guided tour lingers on the result before the next step. */
  dwellMs: number;
  /** The answer the story expects, checked against the sandbox's reply. */
  expect: Record<string, unknown>;
}

const scenario = (id: string): StepSpec["request"] => ({ method: "POST", path: "/api/scenario", body: { id } });
const scenarioButton = (id: string): StepSpec["target"] => ({ css: `button.scenario[data-id="${id}"]` });

export const STORY: readonly StepSpec[] = [
  {
    label: "Pay the vendor",
    chapter: "1 / 6",
    title: "A normal invoice from a vendor the owner trusts",
    note: "Paid. The oracle's signed verdict was checked on-chain.",
    request: scenario("vendor"),
    target: scenarioButton("vendor"),
    dwellMs: 4200,
    expect: { ok: true, status: "paid" },
  },
  {
    label: "Poisoned invoice",
    chapter: "2 / 6",
    title: "A poisoned web page tells the agent to pay a lookalike account",
    note: "acme-vend0r is not acme-vendor. The oracle refuses before anything is signed.",
    request: scenario("lookalike"),
    target: scenarioButton("lookalike"),
    dwellMs: 5200,
    expect: { ok: true, status: "refused", stage: "oracle" },
  },
  {
    label: "A stranger asks for 0.2 NEAR",
    chapter: "3 / 6",
    title: "A stranger asks for 0.2 NEAR",
    note: "Not bad, not known: the oracle says warn. The agent cannot decide. A human is asked.",
    request: scenario("stranger"),
    target: scenarioButton("stranger"),
    dwellMs: 5200,
    expect: { ok: true, status: "queued" },
  },
  {
    label: "answer Yes to the question",
    chapter: "3 / 6",
    title: "Yes only queues the payment",
    note: "No NEAR has moved. The owner approves it, as a separate on-chain transaction.",
    request: { method: "POST", path: "/api/answer", body: { approve: true } },
    target: { css: "#askYes" },
    dwellMs: 2500,
    expect: { ok: true },
  },
  {
    label: "Approve the queued payment",
    chapter: "3 / 6",
    title: "The owner approves it",
    note: "Only now does the NEAR move: a separate on-chain transaction, signed by the owner and not by the agent.",
    request: { method: "POST", path: "/api/owner", body: { action: "approve" } },
    target: { css: "#queue .pending button", text: "Approve" },
    dwellMs: 4000,
    expect: { ok: true },
  },
  {
    label: "The 900% APY vault",
    chapter: "4 / 6",
    title: "An account that three people reported, with evidence",
    note: "Blocked by the shared registry. The reasons carry the reporters' evidence.",
    request: scenario("scam"),
    target: scenarioButton("scam"),
    dwellMs: 5200,
    expect: { ok: true, status: "refused", stage: "oracle" },
  },
  {
    label: "Pay 9 NEAR",
    chapter: "5 / 6",
    title: "Even a trusted vendor cannot take more than the cap",
    note: "The vault allows 5 NEAR per payment. The contract itself says no, whatever the oracle thinks.",
    request: scenario("overcap"),
    target: scenarioButton("overcap"),
    dwellMs: 5200,
    expect: { ok: true, status: "blocked", stage: "chain" },
  },
  {
    label: "The agent's key is stolen",
    chapter: "6 / 6",
    title: "The agent's key is stolen",
    note: "The thief skips Valet's software and goes straight at the chain with the key. Every attempt is refused, each with the real error. The attacker receives 0 NEAR.",
    request: scenario("thief"),
    target: scenarioButton("thief"),
    dwellMs: 9000,
    expect: { ok: true, accepted: 0 },
  },
  {
    label: "Pause the vault",
    chapter: "The kill switch",
    title: "The owner pulls the plug",
    note: "Pause the vault and even the allow-listed vendor is blocked.",
    request: { method: "POST", path: "/api/owner", body: { action: "pause" } },
    target: { css: "#pauseBtn" },
    dwellMs: 1800,
    expect: { ok: true },
  },
  {
    label: "Pay the vendor (while paused)",
    chapter: "The kill switch",
    title: "The same trusted vendor, now refused",
    note: "The contract is paused, so it pays nobody. The oracle's opinion no longer matters.",
    request: scenario("vendor"),
    target: scenarioButton("vendor"),
    dwellMs: 4800,
    expect: { ok: true, status: "blocked", stage: "chain" },
  },
  {
    label: "Unpause the vault",
    chapter: "The kill switch",
    title: "The owner switches it back on",
    note: "Nothing was lost, and nothing needed a redeploy.",
    request: { method: "POST", path: "/api/owner", body: { action: "unpause" } },
    target: { css: "#pauseBtn" },
    dwellMs: 1500,
    expect: { ok: true },
  },
];

// ---------------------------------------------------------------------------------------------

type Json = Record<string, any>;

export interface RecordedStep {
  label: string;
  chapter: string;
  title: string;
  note: string;
  request: StepSpec["request"];
  target: StepSpec["target"];
  dwellMs: number;
  /** How long the real call took, so the replay can make the viewer wait about as long. */
  workMs: number;
  /** The questions that were open while the call waited for a person (only the stranger story). */
  asks?: Json[];
  /** The call returns only after the question is answered; the next recorded step is that answer. */
  hold?: boolean;
  response: { status: number; body: Json };
  /** The vault's state after the step, as `GET /api/state` returned it; `events` holds only what is new. */
  after?: Json;
}

export interface Recording {
  format: 1;
  recordedAt: string;
  source: string;
  initial: Json;
  steps: RecordedStep[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function record(consoleLink: string): Promise<Recording> {
  const link = new URL(consoleLink);
  const token = new URLSearchParams(link.hash.slice(1)).get("token");
  if (!token) throw new Error("the link needs its #token=... part: copy it whole from the sandbox's output");
  const call = async (method: "GET" | "POST", path: string, body?: Json): Promise<{ status: number; body: Json; ms: number }> => {
    const started = Date.now();
    const res = await fetch(new URL(path, link.origin), {
      method,
      headers: { "x-valet-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Json, ms: Date.now() - started };
  };
  const state = async (since: number): Promise<Json> => {
    const res = await call("GET", `/api/state?since=${since}`);
    if (res.status !== 200) throw new Error(`GET /api/state answered ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body;
  };

  const initial = await state(0);
  if (initial.seq !== 0 || initial.events.length !== 0) {
    throw new Error("this sandbox has been used already (its feed is not empty): stop it, start a new one and record again");
  }
  let seen = 0;
  const steps: RecordedStep[] = [];

  const check = (spec: StepSpec, body: Json): void => {
    for (const [key, want] of Object.entries(spec.expect)) {
      if (body[key] !== want) throw new Error(`step "${spec.label}": expected ${key}=${JSON.stringify(want)}, the sandbox answered ${JSON.stringify(body)}`);
    }
  };
  const finish = async (spec: StepSpec, res: { status: number; body: Json }, workMs: number, extra: Partial<RecordedStep> = {}): Promise<RecordedStep> => {
    check(spec, res.body);
    const after = await state(seen);
    seen = after.seq as number;
    const { label, chapter, title, note, request, target, dwellMs } = spec;
    return { label, chapter, title, note, request, target, dwellMs, workMs, ...extra, response: { status: res.status, body: res.body }, after };
  };

  for (let i = 0; i < STORY.length; i++) {
    const spec = STORY[i]!;
    if (spec.request.path === "/api/answer") continue; // played together with the step before it

    if (STORY[i + 1]?.request.path === "/api/answer") {
      // The call waits for a person. Start it, wait for the question, answer it, then collect the result.
      const answerSpec = STORY[i + 1]!;
      const started = Date.now();
      const held = call(spec.request.method, spec.request.path, spec.request.body);
      let asks: Json[] = [];
      while (asks.length === 0) {
        await sleep(120);
        asks = (await state(seen)).asks as Json[];
      }
      const askMs = Date.now() - started;
      await sleep(400);
      const ask = asks[0]!;
      const answerBody = { ...answerSpec.request.body, id: ask.id as string };
      const answerStarted = Date.now();
      const answered = await call("POST", answerSpec.request.path, answerBody);
      check(answerSpec, answered.body);
      const done = await held;
      const settleMs = Date.now() - answerStarted;
      const first = await finish(spec, done, askMs, { asks, hold: true });
      steps.push(first);
      // The answer is a step of its own: it names the question it answers, and the held call's result lands with it.
      const { label, chapter, title, note, target, dwellMs } = answerSpec;
      steps.push({ label, chapter, title, note, request: { method: "POST", path: answerSpec.request.path, body: answerBody }, target, dwellMs, workMs: settleMs, response: { status: answered.status, body: answered.body } });
      continue;
    }

    let request = spec.request;
    if (spec.request.body.action === "approve") {
      const waiting = (await state(seen)).pending as Json[] | null;
      if (!waiting || waiting.length === 0) throw new Error(`step "${spec.label}": nothing is waiting in the queue`);
      request = { ...request, body: { ...request.body, arg: String(waiting[0]!.id) } };
    }
    const res = await call(request.method, request.path, request.body);
    steps.push(await finish({ ...spec, request }, res, res.ms));
    await sleep(300);
  }

  return {
    format: 1,
    recordedAt: new Date().toISOString(),
    source: "npm run sandbox: the real contracts, oracle and console API on a local NEAR chain (nearcore 2.14.0)",
    initial,
    steps,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const link = process.argv[2];
  if (!link) {
    console.error('usage: npm run replay:record -w @valet/demo -- "<the console link the sandbox printed, with #token=...>"');
    process.exit(2);
  }
  record(link)
    .then((recording) => {
      const out = join(here, "recording.json");
      writeFileSync(out, JSON.stringify(recording, null, 1) + "\n");
      console.log(`recorded ${recording.steps.length} steps to demo/src/replay/recording.json (${Math.round(JSON.stringify(recording).length / 1024)} KB)`);
    })
    .catch((e: unknown) => {
      console.error(String((e as Error)?.message ?? e));
      process.exit(1);
    });
}
