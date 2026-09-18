"use client";
// Task -> Start streams one run from /api/run; each step shows the ranked action space over the live Notte viewer.
import { useEffect, useRef, useState } from "react";
import type { RunEvent, RunState } from "@/lib/agent";

const TASK =
  "On https://www.google.com/travel/flights?hl=en find one-way flights from Zurich to London on September 20, 2026, for one adult in economy. Stop when matching flight options are visible.";
const pct = (p: number) => `${(p * 100).toFixed(p < 0.01 ? 1 : 0)}%`;
// jev only clicks and types, so it needs a start page: the first URL in the prompt, else Google.
const startUrl = (task: string) => task.match(/https?:\/\/[^\s"'<>]+/)?.[0].replace(/[.,;:!?)]+$/, "") || "https://www.google.com";

export default function Home() {
  const [goal, setGoal] = useState(TASK);
  const [state, setState] = useState<RunState | null>(null);
  const [frames, setFrames] = useState<RunState[]>([]); // one per Jev decision, for replay; memory only
  const [view, setView] = useState<number | null>(null); // frame index, or null to follow the live run
  const [viewer, setViewer] = useState<string | null>(null);
  const [status, setStatus] = useState("ready");
  const [running, setRunning] = useState(false);
  const [seconds, setSeconds] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const picked = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!running) return;
    // Wall-clock timer from the Start click, including opening the Notte browser; frozen when the run ends.
    const started = performance.now();
    const tick = setInterval(() => setSeconds((performance.now() - started) / 1000), 100);
    return () => clearInterval(tick);
  }, [running]);

  const shown = view == null ? state : frames[view];
  const decision = shown?.decision ?? null;
  const target = decision?.target?.split(":")[0];
  useEffect(() => {
    // Braces matter: newer Chromium returns a Promise from scrollIntoView, and React would call it as a cleanup.
    picked.current?.scrollIntoView({ block: "nearest" });
  }, [shown, target]);

  async function start() {
    if (running) {
      abort.current?.abort();
      return;
    }
    let password = sessionStorage.getItem("run-password") ?? "";
    const { password_required } = await fetch("/api/run").then((r) => r.json());
    if (password_required && !password) password = prompt("Password") ?? "";
    setFrames([]);
    setView(null);
    setState(null);
    setSeconds(0);
    setRunning(true);
    setStatus("starting a Notte session…");
    abort.current = new AbortController();
    let last: RunState | null = null;
    try {
      const response = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: startUrl(goal), goal, password }),
        signal: abort.current.signal,
      });
      if (!response.ok) {
        if (response.status === 401) sessionStorage.removeItem("run-password");
        throw Error((await response.json()).error || "Request failed");
      }
      sessionStorage.setItem("run-password", password);
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      for (let buffer = ""; ; ) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines.filter(Boolean)) {
          const event: RunEvent = JSON.parse(line);
          if (event.type === "error") throw Error(event.error);
          if (event.type === "session") {
            // The live viewer streams the browser from here on, while the agent connects.
            setViewer(event.viewer_url && `${event.viewer_url}&mode=embed-minimal&interactive=0&theme=dark`);
            setStatus("opening the page…");
            continue;
          }
          const next = (last = event.state);
          setState(next);
          if (next.status === "predicted") setFrames((f) => [...f, next]);
          setStatus(next.status === "predicted" ? "executing…" : next.status === "ready" ? "choosing…" : next.status);
        }
      }
      setStatus(last?.status === "done" ? "done" : last?.status === "blocked" ? "blocked: no supported next action" : "stopped");
    } catch (error) {
      setStatus(abort.current.signal.aborted ? "stopped" : `error: ${(error as Error).message}`);
    } finally {
      setRunning(false);
    }
  }

  function clear() {
    setState(null);
    setFrames([]);
    setView(null);
    setViewer(null);
    setSeconds(null);
    setStatus("ready");
  }

  const page = shown?.page;
  const boxes = new Map<number, { rect: any; node: number }>();
  for (const a of page?.actions ?? []) if (a.rect && !boxes.has(a.node!)) boxes.set(a.node!, a as any);
  const probability = (e: any): number =>
    decision?.target_probabilities?.[e.index] ??
    Math.max(-1, ...(e.options ?? []).map((o: any) => decision?.target_probabilities?.[o.index] ?? -1));
  const elements = [...(shown?.elements ?? [])];
  if (decision) elements.sort((a, b) => probability(b) - probability(a));
  const n = frames.length;
  const at = view == null ? n : view + 1;

  return (
    <main>
      <form className="task" id="task" onSubmit={(e) => (e.preventDefault(), start())}>
        <span className="label">task</span>
        <textarea id="goal" rows={2} required placeholder="What should the browser do?" value={goal} disabled={running} onChange={(e) => setGoal(e.target.value)} />
      </form>

      <section className="window">
        <div className="browser">
          <div className="bar">
            <a className="brand" href="https://notte.cc" target="_blank" rel="noreferrer">notte browser</a>
            <span id="page-url">{page?.url}</span>
          </div>
          <div className="viewport">
            {!viewer && <p id="empty">Enter a task and press Start.</p>}
            {viewer && <iframe id="viewer" title="Notte live viewer" allow="clipboard-read; clipboard-write" src={viewer} />}
            {/* Live, the Notte viewer streams the page. A replayed step covers it with that step's own screenshot. */}
            {view != null && page?.screenshot && <img id="shot" alt="Replayed step" src={`data:image/jpeg;base64,${page.screenshot}`} />}
            <div id="targets">
              {/* Once the session stops the viewer becomes Notte's replay player, which the live boxes no longer match. */}
              {page &&
                (running || view != null) &&
                [...boxes.values()].map((a, i) => (
                  <div
                    key={i}
                    className={`t ${String(i + 1) === target ? "on" : ""}`}
                    style={{ left: `${(100 * a.rect.x) / page.w}%`, top: `${(100 * a.rect.y) / page.h}%`, width: `${(100 * a.rect.w) / page.w}%`, height: `${(100 * a.rect.h) / page.h}%` }}
                  >
                    <span>{i + 1}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
        <aside>
          <div className="controls">
            <button id="start" form="task" type="submit">{running ? "Stop ■" : "Start ↗"}</button>
            {!running && state && <button id="clear" type="button" onClick={clear}>clear</button>}
            {seconds != null && <span id="timer" className={running ? "" : "done"}>{seconds.toFixed(1)}s</span>}
          </div>
          <p id="status">{status}</p>
          <div className="label">
            action space{" "}
            <span id="op">
              {shown && (decision ? `→ ${decision.operation} ${pct(decision.operation_probabilities?.[decision.operation] ?? 0)}` : `${shown.elements.length} elements`)}
            </span>
          </div>
          <div id="actions">
            {elements.map((e: any) => {
              const v = probability(e);
              const on = e.index === target;
              return (
                <div key={e.index} ref={on ? picked : undefined} className={`a ${on ? "on" : ""}`}>
                  <span className="i">{e.index}</span>
                  <span className="l">
                    {e.label}
                    <small>{e.role} · {e.operations.join(" / ")}</small>
                    {v >= 0 && <i style={{ "--p": `${v * 100}%` } as React.CSSProperties} />}
                  </span>
                  <span className="p">{v >= 0 ? pct(v) : ""}</span>
                </div>
              );
            })}
          </div>
          {n > 0 && (
            <div id="replay" className="replay">
              {/* Live view already shows the latest decision, so ← from live goes to the one before it. */}
              <button id="prev" type="button" aria-label="Previous step" disabled={at <= 1} onClick={() => setView(Math.max(0, (view ?? n - 1) - 1))}>←</button>
              <span id="step">step {at} / {n}</span>
              <button id="next" type="button" aria-label="Next step" disabled={view == null || at >= n} onClick={() => setView(view! + 1 >= n - 1 ? null : view! + 1)}>→</button>
            </div>
          )}
        </aside>
      </section>

      <section className="window trace">
        <div className="label">trace</div>
        <div id="trace">
          {state &&
            (state.history.length ? (
              state.history.map((h) => (
                <div className="r" key={h.step}>
                  <span className="n">{String(h.step).padStart(2, "0")}</span>
                  <span>{h.action}{h.text && <> <b>“{h.text}”</b></>}</span>
                  <span className="m">{h.latency_ms} ms · {pct(h.probability)}</span>
                </div>
              ))
            ) : (
              <p className="m">No actions yet.</p>
            ))}
        </div>
      </section>
    </main>
  );
}
