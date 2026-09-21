import type { Kind, Move, Piece, Position, Side } from "./engine";
export type Provider = "jev" | "cerebras";
export const PROVIDERS: Provider[] = ["jev", "cerebras"];
export type Player = { provider: Provider; side: Side; model: string; thinking: boolean; decisions: number; latencyMs: number; moves: number; stale: number; captured: Kind[] };
export type Snapshot = { at: number; position: Position; players: Player[]; threatened: string[] };
export type Result = { reason: "king" | "draw" | "stopped" | "error"; winner: Provider | null; message: string };
export type GameEvent =
  | { type: "countdown"; snapshot: Snapshot }
  | { type: "start"; snapshot: Snapshot }
  | { type: "state"; snapshot: Snapshot; action?: { provider: Provider; notation: string; captured: Piece | null; move: Move; streak: number } }
  | { type: "finish"; snapshot: Snapshot; result: Result };
