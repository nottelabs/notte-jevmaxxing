"use client";
import { useEffect, useRef, useState } from "react";
import { COOLDOWN_MS, initialPosition, material, MATCH_MS, squareName, type Side } from "@/lib/chess/engine";
import { PROVIDERS, type GameEvent, type Player, type Provider, type Result, type Snapshot } from "@/lib/chess/types";
import { PieceIcon } from "./piece";
import "./chess.css";

const names = { jev: "Jev", cerebras: "Cerebras" };
type Config = { configured: boolean; password_required: boolean; models: Record<Provider, string> };
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
function initialSnapshot(white: Provider, config: Config | null): Snapshot {
  return { at: 0, position: initialPosition(), threatened: [], players: PROVIDERS.map((provider) => ({ provider, side: provider === white ? "white" : "black", model: config?.models[provider] ?? "Loading model…", thinking: false, decisions: 0, latencyMs: 0, moves: 0, stale: 0, captured: [] })) };
}

export default function Chess() {
  const [config, setConfig] = useState<Config | null>(null);
  const [white, setWhite] = useState<Provider>("jev");
  const [password, setPassword] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [phase, setPhase] = useState<"idle" | "connecting" | "countdown" | "playing" | "done">("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [time, setTime] = useState(0);
  const [countdown, setCountdown] = useState(3);
  const [recording, setRecording] = useState<GameEvent[]>([]);
  const [replayAt, setReplayAt] = useState<number | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [sound, setSound] = useState(false);
  const [lastAction, setLastAction] = useState<Extract<GameEvent, { type: "state" }> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const began = useRef(0);
  const audio = useRef<AudioContext | null>(null);
  const soundRef = useRef(sound);
  const busy = ["connecting", "countdown", "playing"].includes(phase);
  useEffect(() => { soundRef.current = sound; }, [sound]);
  useEffect(() => {
    const stop = new AbortController();
    fetch("/api/chess", { signal: stop.signal }).then((r) => { if (!r.ok) throw Error("Could not load match configuration."); return r.json(); }).then(setConfig).catch((e) => { if (!stop.signal.aborted) setError(e.message); });
    return () => { stop.abort(); abortRef.current?.abort(); void audio.current?.close(); };
  }, []);
  useEffect(() => {
    if (phase !== "playing" && phase !== "countdown") return;
    const timer = setInterval(() => {
      const elapsed = performance.now() - began.current;
      if (phase === "countdown") setCountdown(Math.max(1, Math.ceil((3000 - elapsed) / 1000)));
      else setTime(Math.min(MATCH_MS, elapsed));
    }, 50);
    return () => clearInterval(timer);
  }, [phase]);
  const duration = recording.at(-1)?.snapshot.at ?? 0;
  useEffect(() => {
    if (!replaying) return;
    const start = performance.now(), from = replayAt ?? 0;
    const timer = setInterval(() => {
      const next = Math.min(duration, from + performance.now() - start);
      setReplayAt(next);
      if (next >= duration) setReplaying(false);
    }, 50);
    return () => clearInterval(timer);
    // Start from the current scrub position; changing playback time must not reset the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replaying, duration]);

  function beep(capture: boolean) {
    if (!soundRef.current || !audio.current) return;
    const context = audio.current, oscillator = context.createOscillator(), gain = context.createGain();
    oscillator.type = "triangle"; oscillator.frequency.setValueAtTime(capture ? 440 : 220, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(capture ? 100 : 160, context.currentTime + .1);
    gain.gain.setValueAtTime(.035, context.currentTime); gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + .12);
    oscillator.connect(gain); gain.connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + .13);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  }
  async function start() {
    if (abortRef.current) return;
    const stop = new AbortController(); abortRef.current = stop;
    if (sound) { audio.current ??= new AudioContext(); void audio.current.resume(); }
    setPhase("connecting"); setSnapshot(initialSnapshot(white, config)); setError(""); setResult(null); setRecording([]); setReplayAt(null); setReplaying(false); setLastAction(null); setTime(0); setCountdown(3);
    const events: GameEvent[] = [];
    let complete = false;
    const accept = (event: GameEvent) => {
      events.push(event); setSnapshot(event.snapshot);
      if (event.type === "countdown" || event.type === "start") { began.current = performance.now(); setPhase(event.type === "start" ? "playing" : "countdown"); }
      if (event.type === "state" && event.action) { setLastAction(event); beep(Boolean(event.action.captured)); }
      if (event.type === "finish") { complete = true; setResult(event.result); setTime(event.snapshot.at); setPhase("done"); }
    };
    try {
      const response = await fetch("/api/chess", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ white, password }), signal: stop.signal });
      if (!response.ok) throw Error((await response.json()).error || "Could not start the match.");
      if (!response.body) throw Error("Match stream unavailable.");
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += value; const lines = buffer.split("\n"); buffer = lines.pop()!;
        for (const line of lines) if (line.trim()) accept(JSON.parse(line));
      }
      if (buffer.trim()) accept(JSON.parse(buffer));
      if (!complete) throw Error("Match connection ended early.");
    } catch (e) {
      const stopped = stop.signal.aborted;
      const outcome: Result = { reason: stopped ? "stopped" : "error", winner: null, message: stopped ? "Match stopped." : (e as Error).message };
      setResult(outcome); if (!stopped) setError(outcome.message);
      const latest = events.at(-1)?.snapshot;
      if (latest) { const final = { ...latest, players: latest.players.map((p) => ({ ...p, thinking: false })) }; setSnapshot(final); setTime(final.at); events.push({ type: "finish", snapshot: final, result: outcome }); }
    } finally { stop.abort(); abortRef.current = null; setRecording(events); setPhase("done"); }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, rules: { cooldown_ms: COOLDOWN_MS, duration_ms: MATCH_MS }, events: recording }, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "notte-no-turns-chess.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const playbackEvent = replayAt === null ? null : recording.findLast((e) => e.snapshot.at <= replayAt);
  const shown = playbackEvent?.snapshot ?? snapshot ?? initialSnapshot(white, config);
  const shownTime = replayAt ?? (phase === "playing" ? Math.max(time, shown.at) : shown.at);
  const actionEvent = replayAt === null ? lastAction : recording.findLast((e) => e.type === "state" && e.action && e.snapshot.at <= replayAt) as typeof lastAction;
  const action = actionEvent?.action;
  const recentCapture = action?.captured && shownTime - actionEvent!.snapshot.at < 1000;
  const replayFinished = replayAt !== null && replayAt >= duration;
  const outcomeVisible = replayAt === null ? phase === "done" : replayFinished;
  const playerPanel = (player: Player) => <section className={`chess-player ${player.provider}`} aria-label={`${names[player.provider]} statistics`}>
    <div className="player-title"><h2>{names[player.provider]}</h2><span className={`side-dot ${player.side}`} title={`${player.side} pieces`} /></div>
    <div className="chess-model">{player.model}</div>
    <div className="player-state"><span className={player.thinking ? "thinking-dot" : ""} />{outcomeVisible && result?.winner === player.provider ? "Winner" : player.thinking ? "Thinking…" : outcomeVisible ? "Finished" : phase === "idle" ? "Ready" : "Watching"}</div>
    <dl><div><dt>Avg. decision</dt><dd>{player.decisions ? `${Math.round(player.latencyMs / player.decisions)}` : "—"}<small>{player.decisions ? " ms" : ""}</small></dd></div><div><dt>Moves played</dt><dd>{player.moves}</dd></div><div><dt>Captured material</dt><dd>{player.captured.reduce((total, k) => total + material[k], 0)}<small> pts</small></dd></div></dl>
    <div className="captured-pieces" aria-label={`Captured: ${player.captured.join(", ") || "none"}`}>{player.captured.map((kind, i) => <PieceIcon key={i} kind={kind} side={player.side === "white" ? "black" : "white"} />)}</div>
    <div className="stale-decisions">{player.decisions} decisions · {player.stale} stale</div>
  </section>;

  return <main className="chess-app">
    <header className="chess-header"><a href="https://notte.cc" className="chess-brand">notte</a><h1>No turns.</h1><span className="chess-matchup">Jev vs Cerebras</span><a href="/race" className="other-demo">Wikipedia race</a></header>
    <div className="chess-toolbar"><span className="game-rule">Capture the king. <span>2s piece cooldown.</span></span><div className="chess-buttons">
      <button type="button" disabled={busy} onClick={() => { setWhite(white === "jev" ? "cerebras" : "jev"); setSnapshot(null); setResult(null); setRecording([]); setReplayAt(null); setReplaying(false); setLastAction(null); setPhase("idle"); }}>Swap sides</button>
      <button type="button" aria-pressed={sound} onClick={() => { if (!sound) { audio.current ??= new AudioContext(); void audio.current.resume(); } setSound(!sound); }}>Sound {sound ? "on" : "off"}</button>
      {busy ? <button type="button" className="chess-primary" onClick={() => abortRef.current?.abort()}>Stop match</button> : <button type="button" className="chess-primary" disabled={!config?.configured} onClick={start}>{phase === "done" ? "Play again" : "Start match"}</button>}
    </div></div>
    {config?.password_required && <label className="chess-password">Match password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} autoComplete="current-password" /></label>}
    {(error || config && !config.configured) && <p className="chess-error" role="alert">{error || "Configure TypeSafe and Cerebras keys to play."}</p>}
    <div className="chess-arena">
      {playerPanel(shown.players[0])}
      <section className="board-column" aria-label="Shared chessboard">
        <div className="board-heading"><span>{replayAt !== null ? "Replay" : phase === "playing" ? "Live" : phase === "connecting" ? "Connecting…" : outcomeVisible ? result?.reason === "king" ? "King captured" : result?.reason === "draw" ? "Draw" : "Interrupted" : "Both sides move freely"}</span><time>{seconds(shownTime)} <span>/ 120s</span></time></div>
        <div className="chess-board" role="img" aria-label={`Chessboard. ${shown.position.pieces.length} pieces remaining. ${shown.position.recent.at(-1) ?? "Starting position."}`}>
          {Array.from({ length: 64 }, (_, square) => <div key={square} className={`board-square ${(Math.floor(square / 8) + square % 8) % 2 ? "dark" : "light"} ${action && (action.move.from === square || action.move.to === square) ? "last-move" : ""}`}>{square % 8 === 0 && <span className="rank-label">{8 - Math.floor(square / 8)}</span>}{square >= 56 && <span className="file-label">{"abcdefgh"[square % 8]}</span>}</div>)}
          {shown.position.pieces.map((p) => {
            const remaining = Math.max(0, p.readyAt - shownTime);
            return <div key={p.id} title={`${p.side} ${p.kind} ${squareName(p.square)}${remaining ? ` · ${(remaining / 1000).toFixed(1)}s cooldown` : ""}`} className={`board-piece ${remaining ? "cooling" : ""} ${shown.threatened.includes(p.id) ? "king-threat" : ""}`} style={{ left: `${p.square % 8 * 12.5}%`, top: `${Math.floor(p.square / 8) * 12.5}%` }}>
              <PieceIcon kind={p.kind} side={p.side} />{remaining > 0 && <><span className="cooldown-number">{(remaining / 1000).toFixed(1)}</span><span className="cooldown-track"><span style={{ width: `${remaining / COOLDOWN_MS * 100}%` }} /></span></>}
            </div>;
          })}
          {phase === "countdown" && <div className="board-overlay countdown" role="status">{countdown}</div>}
          {outcomeVisible && result && <div className="board-overlay result"><strong>{result.winner ? `${names[result.winner]} wins.` : result.reason === "draw" ? "Both kings survive." : "Match interrupted."}</strong><span>{result.message}</span></div>}
          {recentCapture && <div className={`capture-flash ${action!.provider}`} key={`${actionEvent!.snapshot.at}-${action!.move.id}`}>{action!.streak >= 3 ? "TRIPLE CAPTURE" : action!.streak === 2 ? "DOUBLE CAPTURE" : `${action!.captured!.kind.toUpperCase()} TAKEN`}</div>}
        </div>
        <div className="board-caption" aria-live="polite">{shown.threatened.length ? "King under threat" : ""}<span>{action?.notation ?? "White starts at the bottom. Neither side waits."}</span></div>
      </section>
      {playerPanel(shown.players[1])}
    </div>
    <footer className="chess-footer">
      <details><summary>Rules & match events</summary><div className="chess-details"><p>Capture the king; there is no check or checkmate. Moves resolve instantly, then that piece rests for 2 seconds. Pawns promote to queens. No castling or en passant. Both kings surviving 120 seconds is a draw.</p><p>Both models receive the same board format and available moves. Stale choices are discarded. Average decision is API round-trip time, not pure inference. This is a live matchup, not a general benchmark.</p><ol>{(replayAt === null ? recording : recording.filter((e) => e.snapshot.at <= replayAt)).filter((e) => e.type === "state" && e.action).map((e, i) => <li key={i}>{seconds(e.snapshot.at)} · {e.type === "state" && e.action?.notation}</li>)}</ol></div></details>
      {recording.length > 0 && !busy && <div className="replay-controls"><button type="button" onClick={() => { if (replaying) { setReplaying(false); return; } if (replayAt === null || replayAt >= duration) setReplayAt(0); setReplaying(true); }}>{replaying ? "Pause" : "Replay"}</button><input aria-label="Replay position" type="range" min={0} max={Math.max(1, duration)} value={replayAt ?? duration} onChange={(e) => { setReplaying(false); setReplayAt(Number(e.target.value)); }} /><button type="button" onClick={download}>Download match</button></div>}
    </footer>
  </main>;
}
