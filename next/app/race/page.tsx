"use client";

import { useEffect, useRef, useState } from "react";
import { RACERS, MAX_HOPS, type Lane, type RaceEvent, type Racer } from "@/lib/race-types";
import "./race.css";

const NAMES = { jev: "Jev", cerebras: "Cerebras" };
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
type Config = { password_required: boolean; configured: boolean; models: Record<Racer, string> };

function viewerUrl(raw: string) {
  const url = new URL(raw);
  url.searchParams.set("mode", "embed-minimal");
  url.searchParams.set("interactive", "0");
  url.searchParams.set("theme", "dark");
  return url.href;
}

export default function WikiRace() {
  const [start, setStart] = useState("Coffee");
  const [target, setTarget] = useState("Volcano");
  const [config, setConfig] = useState<Config | null>(null);
  const [password, setPassword] = useState("");
  const [lanes, setLanes] = useState<Partial<Record<Racer, Lane>>>({});
  const [phase, setPhase] = useState<"idle" | "preparing" | "ready" | "countdown" | "racing" | "finishing" | "done">("idle");
  const [startToken, setStartToken] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [countdown, setCountdown] = useState(3);
  const [viewerLoaded, setViewerLoaded] = useState<Partial<Record<Racer, boolean>>>({});
  const [winner, setWinner] = useState<Racer | "tie" | null>(null);
  const [error, setError] = useState("");
  const [clock, setClock] = useState(0);
  const [route, setRoute] = useState<{ start: string; target: string } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const began = useRef(0);
  const busy = !["idle", "done"].includes(phase);

  useEffect(() => {
    const cancel = new AbortController();
    fetch("/api/race", { signal: cancel.signal }).then((r) => {
      if (!r.ok) throw Error("Could not load race configuration. Reload to try again.");
      return r.json();
    }).then(setConfig).catch((e) => { if (!cancel.signal.aborted) setError(e.message); });
    return () => { cancel.abort(); controller.current?.abort(); };
  }, []);

  useEffect(() => {
    if (phase !== "racing") return;
    const timer = setInterval(() => setClock(performance.now() - began.current), 100);
    return () => clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "countdown") return;
    setCountdown(3);
    const timer = setInterval(() => setCountdown((value) => Math.max(1, value - 1)), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  async function startPreparedRace() {
    if (!startToken || starting || !controller.current) return;
    const active = controller.current;
    setStarting(true); setError("");
    try {
      const response = await fetch("/api/race/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: startToken }), signal: active.signal });
      if (!response.ok) throw Error((await response.json()).error || "Could not start the race. Try again.");
    } catch (error) {
      if (!active.signal.aborted) setError((error as Error).message);
    } finally { setStarting(false); }
  }

  async function race(e: React.FormEvent) {
    e.preventDefault();
    if (controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setStartToken(null); setStarting(false); setViewerLoaded({});
    setLanes({}); setWinner(null); setError(""); setClock(0); setRoute(null); setPhase("preparing");
    let complete = false;
    const accept = (event: RaceEvent) => {
      if (event.type === "error") throw Error(event.error);
      if (event.type === "lane") setLanes((old) => ({ ...old, [event.lane.racer]: event.lane }));
      if (event.type === "prepared") {
        setStartToken(event.token);
        setRoute({ start: event.start.title, target: event.target.title });
        setPhase("ready");
      }
      if (event.type === "countdown") { setStartToken(null); setPhase("countdown"); }
      if (event.type === "start") {
        began.current = performance.now();
        setRoute({ start: event.start.title, target: event.target.title });
        setPhase("racing");
      }
      if (event.type === "finish") { complete = true; setWinner(event.winner); setPhase("finishing"); }
    };
    try {
      const response = await fetch("/api/race", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ start, target, password, manual_start: true }), signal: abort.signal });
      if (!response.ok) throw Error((await response.json()).error || "Could not start the race.");
      if (!response.body) throw Error("The race stream is unavailable. Try again.");
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) if (line.trim()) accept(JSON.parse(line));
      }
      if (buffer.trim()) accept(JSON.parse(buffer));
      if (!complete) throw Error("The race connection ended before a result. Try again.");
    } catch (e) {
      setError(abort.signal.aborted ? "Race stopped. Both browsers are being released." : (e as Error).message);
      abort.abort();
      setLanes((old) => Object.fromEntries(Object.entries(old).map(([key, lane]) => [key, ["preparing", "ready", "racing"].includes(lane.status) ? { ...lane, status: "stopped" } : lane])));
    } finally {
      controller.current = null;
      setStartToken(null);
      setPhase("done");
    }
  }

  function download() {
    const blob = new Blob([JSON.stringify({ route, winner, lanes, rules: { max_hops: MAX_HOPS, time_limit_seconds: 120, links: "First 250 unique article links in document order", winner: "Lowest server-measured finish time from a shared start" } }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "notte-wikipedia-race.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const failed = Object.values(lanes).some((lane) => lane.status === "error");
  const announcement = phase === "preparing" ? "Preparing both browsers. They will wait for you at the starting line." : phase === "ready" ? "Wait until both viewers show the starting article, then press Start race. You have 90 seconds." : phase === "countdown" ? `Starting in ${countdown}…` : phase === "racing" ? "Race on. First to reach the target wins." : winner === "tie" ? "A tie at the recorded millisecond." : winner ? `${NAMES[winner]} wins this race.` : phase === "done" && !error ? failed ? "The race ended with errors. See each racer for details." : "Neither racer reached the target this time." : "";

  return <main className="wiki-race">
    <header className="race-header">
      <a className="race-brand" href="https://notte.cc">notte</a>
      <h1>The Wikipedia race.</h1>
      <a href="/">Open Jevmaxxing</a>
    </header>
    <form className="race-form" onSubmit={race}>
      <label>Starting article<input value={start} onChange={(e) => setStart(e.target.value)} disabled={busy} required maxLength={500} autoComplete="off" /></label>
      <span className="route-arrow" aria-hidden="true"><svg viewBox="0 0 32 24"><path d="M2 12h27M20 3l9 9-9 9" /></svg></span>
      <label>Target article<input value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy} required maxLength={500} autoComplete="off" /></label>
      {phase === "ready" ? <button type="button" className="race-start" disabled={starting || !RACERS.every((racer) => viewerLoaded[racer])} onClick={startPreparedRace}>{starting ? "Starting…" : "Start race"}</button> : busy ? <button type="button" className="race-start" disabled={phase === "finishing"} onClick={() => controller.current?.abort()}>{phase === "finishing" ? "Finishing…" : "Stop race"}</button> : <button type="submit" className="race-start" disabled={!config?.configured}>Prepare browsers</button>}
      {config?.password_required && <label className="race-password">Race password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required disabled={busy} /></label>}
    </form>

    {config && !config.configured && <p className="race-notice">Race setup is incomplete. Add the Notte, TypeSafe, and Cerebras API keys on the server to enable live races.</p>}
    {error && <p className="race-error" role="alert">{error}</p>}
    {(announcement || route) && <div className="race-announcement" role="status"><span>{announcement}{phase === "ready" && <button type="button" className="race-cancel" onClick={() => controller.current?.abort()}>Cancel</button>}</span>{route && <span className="race-route">{route.start} → {route.target}</span>}</div>}
    <div className="race-lanes">
      {RACERS.map((racer) => {
        const lane = lanes[racer];
        const live = lane?.status === "racing";
        const time = live ? Math.max(clock, lane.elapsed_ms) : lane?.elapsed_ms ?? 0;
        const current = lane?.path.at(-1);
        return <section key={racer} className={`race-lane ${racer} ${winner === racer ? "race-winner" : ""}`} aria-label={`${NAMES[racer]} browser`}>
          <div className="lane-heading"><div><h2>{NAMES[racer]}</h2><span className="lane-model">{lane?.model ?? config?.models[racer] ?? "Loading model…"}</span></div><span className="lane-status">{winner === racer ? "Winner" : lane?.status ?? "Ready"}</span></div>
          <div className="lane-stats"><div><strong>{seconds(time)}</strong><span>race time</span></div><div><strong>{Math.max(0, (lane?.path.length ?? 1) - 1)}<small> / {MAX_HOPS}</small></strong><span>links followed</span></div><div><strong>{lane?.decisions ? `${Math.round(lane.model_ms / lane.decisions)} ms` : "n/a"}</strong><span>avg. decision</span></div></div>
          <div className="lane-address">{current?.title ?? (phase === "preparing" ? "Preparing Wikipedia…" : "Waiting at the starting line")}</div>
          {lane?.status === "error" && lane.message && <p className="lane-failure" role="alert">{lane.message}</p>}
          <div className="viewport lane-viewport">{lane?.viewer_url ? <iframe title={`${NAMES[racer]} live Wikipedia browser`} src={viewerUrl(lane.viewer_url)} onLoad={() => setViewerLoaded((old) => ({ ...old, [racer]: true }))} /> : <div className="lane-empty"><span className="wiki-letter" aria-hidden="true">W</span><p>{phase === "preparing" ? "Opening a Notte browser…" : "A whole encyclopedia between here and there."}</p></div>}</div>
          <details className="lane-trail"><summary>Article trail <span>{Math.max(0, (lane?.path.length ?? 1) - 1)} links</span></summary><div className="trail-content">{lane?.message && lane.status !== "error" && <p className="lane-message">{lane.message}</p>}
            <ol>{lane?.path.map((step, i) => <li key={`${i}-${step.url}`}><span className="hop-number">{String(i).padStart(2, "0")}</span><a href={step.url} target="_blank" rel="noreferrer">{step.title}</a><time>{i ? seconds(step.elapsed_ms) : "Start"}</time></li>)}</ol>
            {!lane?.path.length && <p className="trail-empty">Every article visited will appear here.</p>}
          </div></details>
        </section>;
      })}
    </div>
    <footer className="race-footer"><details><summary>How the race works</summary><div className="race-rules"><p>Prepare browsers loads the starting article in both sessions. Once both viewers show it, press Start race for a three-second countdown. The shared server timer begins after the countdown. Each model sees the same kind of article text, visited history, and up to 250 unique article links in document order. No search, URL typing, external links, or back button. The executor scrolls to and clicks the chosen link.</p><p>First verified arrival wins. Both racers can finish, with a limit of {MAX_HOPS} clicks or 2 minutes each. Setup is excluded; model calls, browser actions, and page loading are included. Average decision time includes successful model responses only. This is one live race, not a general model benchmark.</p></div></details>{phase === "done" && Object.keys(lanes).length > 0 && <button type="button" onClick={download}>Download race data</button>}</footer>
  </main>;
}
