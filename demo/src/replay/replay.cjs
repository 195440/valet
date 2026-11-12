"use strict";
/*
 * The replay of the Valet console: what makes docs/index.html work without a server.
 *
 * The page is the real console page. Its `fetch` is replaced by an engine that answers the
 * console's API from a recording of one real session (recording.json: every state and every reply
 * is something the sandbox sent), and a bar at the bottom tells the story and can play it.
 *
 * Two halves in one file, so that the page can inline it and the tests can load it:
 *   createEngine(recording, { sleep })   the pure part: a stand-in for the console's HTTP API;
 *   startPlayer(recording)               the browser part: the fetch shim, the banner, the bar.
 * Loaded by Node (`require`) it only exports the engine. Loaded by a page it starts the player.
 * Plain JavaScript on purpose: the page inlines this file as it is, with no build step in between.
 */
(function () {
  // =========================================================================== the engine

  const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const AGENT_PATHS = new Set(["/api/scenario", "/api/pay"]);
  const POST_PATHS = new Set(["/api/scenario", "/api/pay", "/api/owner", "/api/answer"]);

  /** Does this request do what the step recorded? Compared as text, so 1 and "1" are the same. */
  function matches(step, method, path, body) {
    const want = step.request;
    if (want.method !== method || want.path !== path) return false;
    return Object.entries(want.body || {}).every(([key, value]) => body != null && String(body[key]) === String(value));
  }

  /** The viewer waits about as long as the real call took, but never for nothing and never for long. */
  const wait = (ms) => Math.min(Math.max(ms || 0, 500), 5000);

  function createEngine(recording, options) {
    const sleep = (options && options.sleep) || realSleep;
    const steps = recording.steps;
    const feed = []; // every event shown so far
    const listeners = [];
    let current = withoutEvents(recording.initial);
    let seq = recording.initial.seq;
    let next = 0; // the step the viewer may do now
    let working = null; // { index, agent, askOpen } while a call is in flight
    let held = null; // { index, resolve }: the call that waits for the answer to a question

    function withoutEvents(state) {
      const copy = { ...state };
      delete copy.events;
      return copy;
    }
    const notify = () => listeners.forEach((listener) => listener(progress()));
    function progress() {
      return {
        next,
        total: steps.length,
        working: working !== null,
        workingIndex: working ? working.index : null,
        asking: working !== null && working.askOpen,
      };
    }

    /** What `GET /api/state?since=N` answers right now. */
    function view(since) {
      const base = working ? { ...current, busy: working.agent, asks: working.askOpen ? steps[working.index].asks || [] : [] } : current;
      return { ...base, seq, events: feed.filter((e) => e.seq > since) };
    }

    function apply(step) {
      if (!step.after) return;
      for (const event of step.after.events || []) feed.push(event);
      seq = step.after.seq;
      current = withoutEvents(step.after);
    }

    const refuse = (error) => ({ status: 409, body: { ok: false, error } });

    async function handle(method, rawPath, body) {
      const url = new URL(rawPath, "http://replay.invalid");
      if (method === "GET" && url.pathname === "/api/state") {
        const since = Number(url.searchParams.get("since"));
        return { status: 200, body: view(Number.isFinite(since) ? since : 0) };
      }
      if (method !== "POST" || !POST_PATHS.has(url.pathname)) return { status: 404, body: { ok: false, error: "no such endpoint" } };

      const index = next;
      const step = steps[index];
      if (!step) return refuse("The recording has ended. Press Restart to watch it again.");
      const answering = held !== null && step.request.path === "/api/answer";
      if (working && !answering) return refuse("One thing at a time: the last action is still running.");
      if (!matches(step, "POST", url.pathname, body)) {
        return refuse(
          `This page replays one recorded session, so it only does what was recorded. Next in the recording: "${step.label}". To try anything else, run npm run sandbox on your machine.`,
        );
      }
      next += 1;

      if (answering) {
        // The person answered. The question closes now; the call that was waiting for it finishes a moment later.
        const waiting = held;
        held = null;
        working.askOpen = false;
        notify();
        sleep(wait(step.workMs)).then(() => {
          apply(steps[waiting.index]);
          working = null;
          notify();
          waiting.resolve(steps[waiting.index].response);
        });
        return step.response;
      }

      working = { index, agent: AGENT_PATHS.has(step.request.path), askOpen: false };
      notify();
      await sleep(wait(step.workMs));
      if (step.hold) {
        working.askOpen = true;
        notify();
        return new Promise((resolve) => {
          held = { index, resolve };
        });
      }
      apply(step);
      working = null;
      notify();
      return step.response;
    }

    return {
      handle,
      progress,
      subscribe: (listener) => listeners.push(listener),
      steps,
    };
  }

  // =========================================================================== the player

  /**
   * What the page says about itself, first of all. The build writes the label and the text into the
   * page's HTML as well, so that a reader without scripts (a link preview, a search crawler, an agent
   * that fetches the page as text) gets the same first sentence as a person. The player then adds the link.
   */
  const BANNER = {
    label: "Replay",
    text: "A recording of a real session: the vault, the oracle and the chain were real, and the AI agent's decisions are the buttons. Nothing on this page is live.",
    linkText: "Run it yourself ↗",
    linkHref: "https://github.com/195440/valet#try-it",
  };

  const CSS = `
.rp-banner { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; padding: 9px 24px; background: var(--block); color: var(--paper); font: 500 12px/1.5 var(--mono); }
.rp-banner b { padding: 1px 8px; border: 1px solid currentColor; letter-spacing: .14em; text-transform: uppercase; }
.rp-banner a { color: inherit; text-underline-offset: 3px; }
.rp-bar { position: fixed; z-index: 40; left: 0; right: 0; bottom: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px 24px; padding: 12px 24px 14px; background: var(--ink); color: var(--bg); border-top: 3px solid var(--sky); font: 400 13px/1.5 var(--mono); }
.rp-step { font-size: 11px; font-weight: 500; letter-spacing: .14em; text-transform: uppercase; color: var(--sky); }
.rp-title { margin: 2px 0 1px; font: 700 18px/1.2 var(--display); letter-spacing: -.02em; }
.rp-note { opacity: .86; }
.rp-next { margin-top: 5px; font-size: 12px; opacity: .72; }
.rp-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.rp-btn { appearance: none; padding: 9px 14px; border: 1px solid var(--bg); background: transparent; color: var(--bg); font: 500 12px/1 var(--mono); cursor: pointer; }
.rp-btn:hover:not(:disabled) { background: var(--bg); color: var(--ink); }
.rp-btn.primary { border-color: var(--sky); background: var(--sky); color: #1b1a16; }
.rp-btn.primary:hover:not(:disabled) { background: var(--bg); border-color: var(--bg); color: var(--ink); }
.rp-btn:disabled { opacity: .4; cursor: not-allowed; }
.rp-ring { position: fixed; z-index: 45; pointer-events: none; border: 3px solid var(--sky); box-shadow: 0 0 0 3px var(--ink), 0 0 18px var(--sky); animation: rp-pulse 1.4s ease-in-out infinite; }
@keyframes rp-pulse { 50% { opacity: .4; } }
#toast { z-index: 60; bottom: calc(var(--rp-bar, 140px) + 16px); }
.rp-note-modal { margin: 0; padding: 8px 12px; border: 1px dashed var(--line); }
@media (prefers-reduced-motion: reduce) { .rp-ring { animation: none; } }
@media (max-width: 760px) {
  .rp-banner { padding: 8px 14px; }
  .rp-bar { grid-template-columns: minmax(0, 1fr); padding: 10px 14px 12px; }
  .rp-title { font-size: 15px; }
  .rp-note { font-size: 12px; }
}
`;

  /** Runs while the page is still being read, before the console's own script asks for its first state. */
  function installShim(engine) {
    // The console's script reads its token from the address; a replay has no secret to give it.
    if (!new URLSearchParams(location.hash.slice(1)).get("token")) history.replaceState(null, "", location.pathname + location.search + "#token=replay");

    window.fetch = async function (input, init) {
      const raw = typeof input === "string" ? input : input.url;
      const url = new URL(raw, location.href);
      const method = ((init && init.method) || "GET").toUpperCase();
      let body = null;
      if (init && typeof init.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch (e) {
          body = null;
        }
      }
      const reply = await engine.handle(method, url.pathname + url.search, body);
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
    };
  }

  function startPlayer(recording) {
    const engine = createEngine(recording);
    installShim(engine);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => mountUi(engine));
    else mountUi(engine);
  }

  /** The banner, the bar and the ring: needs the page's elements, so it waits for them. */
  function mountUi(engine) {
    const steps = engine.steps;
    document.title = "Valet console (replay)";

    // ---------------------------------------------------------------- small DOM helpers (text only)
    const el = (tag, props, ...children) => {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(props || {})) {
        if (key === "text") node.textContent = value;
        else if (key === "onclick") node.addEventListener("click", value);
        else node.setAttribute(key, value);
      }
      for (const child of children) if (child) node.append(child);
      return node;
    };
    const link = (href, text) => el("a", { href, text, target: "_blank", rel: "noopener noreferrer" });
    const visible = (node) => Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length) && !node.closest("[hidden]");
    const findTarget = (step) =>
      Array.from(document.querySelectorAll(step.target.css)).find((node) => (!step.target.text || node.textContent.trim() === step.target.text) && visible(node) && !node.disabled) || null;
    const until = (check, timeoutMs) =>
      new Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
          const value = check();
          if (value) resolve(value);
          else if (Date.now() - started > timeoutMs) resolve(null);
          else setTimeout(tick, 100);
        };
        tick();
      });

    // ---------------------------------------------------------------- the page around the console
    const style = el("style");
    style.textContent = CSS;
    document.head.append(style);

    // The banner's words are in the page already (see BANNER). Here it gets its link; a page without one gets the whole banner.
    let banner = document.querySelector(".rp-banner");
    if (!banner) {
      banner = el("div", { class: "rp-banner", role: "note" }, el("b", { text: BANNER.label }), el("span", { text: BANNER.text }));
      document.body.prepend(banner);
    }
    banner.append(link(BANNER.linkHref, BANNER.linkText));
    const stepLabel = el("div", { class: "rp-step" });
    const title = el("div", { class: "rp-title" });
    const note = el("div", { class: "rp-note" });
    const upNext = el("div", { class: "rp-next" });
    const play = el("button", { class: "rp-btn primary", type: "button", text: "▶ Play" });
    const once = el("button", { class: "rp-btn", type: "button", text: "Do the next step" });
    const where = el("button", { class: "rp-btn", type: "button", text: "Show me the button" });
    const restart = el("button", { class: "rp-btn", type: "button", text: "↺ Restart", onclick: () => location.reload() });
    const bar = el(
      "section",
      { class: "rp-bar", "aria-label": "Replay controls" },
      el("div", { "aria-live": "polite" }, stepLabel, title, note, upNext),
      el("div", { class: "rp-actions" }, play, once, where, restart),
    );
    const ring = el("div", { class: "rp-ring", hidden: "" });
    document.body.append(bar, ring);

    // The console's short explanation says "live" next to it. Here it is a recording.
    const liveTag = document.querySelector(".termbar b");
    if (liveTag) liveTag.textContent = "replay";

    // The console's question to the human: this replay recorded the answer "Yes", so "No" has nothing to show.
    const askNo = document.getElementById("askNo");
    if (askNo) {
      askNo.disabled = true;
      askNo.title = "The recording has the answer Yes";
      askNo.parentElement.after(el("p", { class: "muted small rp-note-modal", text: "In this replay the recorded answer is Yes. Run npm run sandbox to answer No yourself." }));
    }

    // ---------------------------------------------------------------- what the bar says
    let playing = false;
    let busyTour = false;
    let quiet = false; // while the tour lets the viewer read a result, no ring points anywhere

    function paint() {
      const p = engine.progress();
      const shown = p.working ? p.workingIndex : p.next - 1;
      const upcoming = steps[p.next];
      if (shown < 0) {
        stepLabel.textContent = "Valet console, replayed";
        title.textContent = "The agent pays. The vault decides.";
        note.textContent = "Press Play to watch the session, or press the highlighted button to play the AI agent yourself.";
      } else {
        const step = steps[shown];
        const state = p.asking ? "   ·   waiting for the answer…" : p.working ? "   ·   running…" : "";
        stepLabel.textContent = (step.chapter || "") + "   ·   step " + (shown + 1) + " of " + steps.length + state;
        title.textContent = step.title;
        note.textContent = step.note;
      }
      upNext.textContent = upcoming ? "Up next: " + upcoming.title : "That was the whole recording. Watch it again, or run it on your own machine.";
      play.textContent = !upcoming ? "↺ Watch again" : playing ? "❚❚ Pause" : p.next === 0 ? "▶ Play" : "▶ Keep playing";
      once.disabled = !upcoming || busyTour || p.working;
      where.disabled = !upcoming || (p.working && !p.asking);
      document.documentElement.style.setProperty("--rp-bar", bar.offsetHeight + "px");
      document.body.style.paddingBottom = bar.offsetHeight + 24 + "px";
    }
    engine.subscribe(paint);
    window.addEventListener("resize", paint);

    // ---------------------------------------------------------------- the ring on what to press next
    // Between the sticky top bar and this bar: the part of the screen where a person looks.
    function reveal(target) {
      const r = target.getBoundingClientRect();
      const top = 96;
      const bottom = innerHeight - bar.offsetHeight - 24;
      if (r.top < top || r.bottom > bottom) window.scrollBy({ top: r.top + r.height / 2 - (top + bottom) / 2, behavior: "smooth" });
    }
    const nextTarget = () => {
      const p = engine.progress();
      // Idle, or waiting for the answer to the question: the control to press is the next step's.
      const step = (!p.working || p.asking) && steps[p.next];
      return step ? findTarget(step) : null;
    };
    function frame() {
      const target = quiet ? null : nextTarget();
      if (!target) {
        ring.hidden = true;
      } else {
        const r = target.getBoundingClientRect();
        ring.hidden = false;
        ring.style.left = r.left - 5 + "px";
        ring.style.top = r.top - 5 + "px";
        ring.style.width = r.width + 10 + "px";
        ring.style.height = r.height + 10 + "px";
      }
      requestAnimationFrame(frame);
    }
    where.addEventListener("click", () => {
      const target = nextTarget();
      if (target) reveal(target);
    });

    // ---------------------------------------------------------------- playing it for the viewer
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    async function doNext(lead) {
      const index = engine.progress().next;
      const step = steps[index];
      if (!step) return false;
      quiet = false;
      const target = await until(() => findTarget(step), 8000);
      if (!target) return false;
      reveal(target);
      await pause(lead + 700);
      target.click();
      const done = await until(() => {
        const p = engine.progress();
        return p.next > index && (!p.working || p.asking);
      }, 30000);
      return Boolean(done);
    }

    once.addEventListener("click", async () => {
      busyTour = true;
      paint();
      await doNext(400);
      busyTour = false;
      paint();
    });

    play.addEventListener("click", async () => {
      if (!steps[engine.progress().next]) {
        location.reload();
        return;
      }
      if (playing) {
        playing = false;
        paint();
        return;
      }
      playing = true;
      busyTour = true;
      paint();
      while (playing && steps[engine.progress().next]) {
        const index = engine.progress().next;
        const ok = await doNext(index === 0 ? 600 : 300);
        if (!ok) break;
        // Let the page's own polling draw the result, then let the viewer read it.
        quiet = true;
        await pause(1100 + (steps[index].dwellMs || 3000));
      }
      quiet = false;
      playing = false;
      busyTour = false;
      paint();
    });

    paint();
    requestAnimationFrame(frame);
  }

  // =========================================================================== start

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { createEngine, matches, BANNER };
  } else {
    startPlayer(JSON.parse(document.getElementById("valet-recording").textContent));
  }
})();
