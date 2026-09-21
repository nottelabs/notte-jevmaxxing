import { setTimeout as delay } from "node:timers/promises";
import { applyMove, initialPosition, MATCH_MS, moves, threatenedKings, type Position } from "./engine";
import { chooseMove } from "./model";
import { PROVIDERS, type GameEvent, type Player, type Provider, type Result, type Snapshot } from "./types";
import { raceModels } from "../race-model";

export type MatchDeps = { choose: typeof chooseMove; now: () => number; countdownMs: number; durationMs: number; position: () => Position };
const defaults: MatchDeps = { choose: chooseMove, now: () => performance.now(), countdownMs: 3000, durationMs: MATCH_MS, position: initialPosition };

export async function runMatch(white: Provider, signal: AbortSignal, emit: (event: GameEvent) => void, overrides: Partial<MatchDeps> = {}) {
  const deps = { ...defaults, ...overrides };
  const position = deps.position();
  const players: Player[] = PROVIDERS.map((provider) => ({ provider, side: provider === white ? "white" : "black", model: raceModels()[provider], thinking: false, decisions: 0, latencyMs: 0, moves: 0, stale: 0, captured: [] }));
  const stop = new AbortController();
  let result: Result | undefined, startedAt: number | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  const elapsed = () => startedAt === undefined ? 0 : Math.max(0, Math.round(deps.now() - startedAt));
  const snapshot = (): Snapshot => ({ at: elapsed(), position: { ...position, pieces: position.pieces.map((p) => ({ ...p })), recent: [...position.recent] }, players: players.map((p) => ({ ...p, captured: [...p.captured] })), threatened: threatenedKings(position, elapsed()) });
  const finish = (value: Result) => { if (!result) { result = value; stop.abort(); } };
  const cancel = () => finish({ reason: "stopped", winner: null, message: "Match stopped." });
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    stop.signal.throwIfAborted();
    emit({ type: "countdown", snapshot: snapshot() });
    await delay(deps.countdownMs, undefined, { signal: stop.signal });
    startedAt = deps.now();
    deadline = setTimeout(() => finish({ reason: "draw", winner: null, message: "Draw. Both kings survived two minutes." }), deps.durationMs);
    emit({ type: "start", snapshot: snapshot() });
    await Promise.all(players.map(async (player) => {
      let lastCapture = -Infinity, streak = 0;
      try {
        while (!stop.signal.aborted) {
          const offered = moves(position, player.side, elapsed());
          if (!offered.length) { await delay(100, undefined, { signal: stop.signal }); continue; }
          player.thinking = true;
          emit({ type: "state", snapshot: snapshot() });
          const decision = await deps.choose(player.provider, structuredClone(position), player.side, offered, elapsed(), stop.signal);
          if (stop.signal.aborted) break;
          player.thinking = false;
          player.model = decision.model;
          player.decisions++;
          player.latencyMs += decision.latencyMs;
          if (decision.id === "wait") {
            emit({ type: "state", snapshot: snapshot() });
            await delay(200, undefined, { signal: stop.signal });
            continue;
          }
          const move = offered.find((m) => m.id === decision.id);
          const applied = move ? applyMove(position, player.side, move, elapsed()) : null;
          if (!applied || !move) { player.stale++; emit({ type: "state", snapshot: snapshot() }); continue; }
          player.moves++;
          if (applied.captured) {
            player.captured.push(applied.captured.kind);
            streak = elapsed() - lastCapture <= 3000 ? streak + 1 : 1;
            lastCapture = elapsed();
          }
          emit({ type: "state", snapshot: snapshot(), action: { provider: player.provider, ...applied, move, streak: applied.captured ? streak : 0 } });
          if (position.winner) finish({ reason: "king", winner: player.provider, message: `${player.provider === "jev" ? "Jev" : "Cerebras"} captured the king.` });
        }
      } catch (error) {
        if (!stop.signal.aborted) finish({ reason: "error", winner: null, message: error instanceof Error && error.name !== "TimeoutError" ? error.message : `${player.provider} timed out. Match interrupted.` });
      } finally { player.thinking = false; }
    }));
  } catch (error) {
    if (!result) finish({ reason: "error", winner: null, message: error instanceof Error ? error.message : "Match interrupted." });
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", cancel);
    stop.abort();
    players.forEach((p) => { p.thinking = false; });
    emit({ type: "finish", snapshot: snapshot(), result: result ?? { reason: "stopped", winner: null, message: "Match stopped." } });
  }
}
