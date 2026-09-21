import { squareName, type Move, type Position, type Side } from "./engine";
import type { Provider } from "./types";
import { raceModels } from "../race-model";

export const INSTRUCTIONS = `You are playing real-time chess WITHOUT TURNS. Capture the enemy king before yours is captured. There is no check or checkmate: kings may move into danger. Moves are instant. Each moved piece has a 2000ms cooldown; other pieces can move immediately. Normal piece movement and blocking apply. Pawns auto-promote to queens; no castling or en passant. Your opponent keeps moving while you think. Choose exactly one offered move ID to execute NOW. Neither side has a turn: never wait for your opponent to move. Develop your pieces and attack. Use wait only for deliberate tactical timing, since your opponent can attack freely while you do nothing. Protect your king, capture enemy pieces, and develop an attack. Return only the chosen ID.`;
export function decisionState(position: Position, side: Side, offered: Move[], now: number) {
  return {
    your_side: side, goal: `Capture the ${side === "white" ? "black" : "white"} king`,
    board: position.pieces.map((p) => ({ id: p.id, side: p.side, kind: p.kind, square: squareName(p.square), cooldown_ms: Math.max(0, Math.round(p.readyAt - now)) })),
    recent_moves: [...position.recent],
    actions: [...offered.map((m) => ({ id: m.id, description: `Move ${side} ${position.pieces.find((p) => p.id === m.piece)!.kind} from ${squareName(m.from)} to ${squareName(m.to)}`, piece: position.pieces.find((p) => p.id === m.piece)!.kind, from: squareName(m.from), to: squareName(m.to), captures: position.pieces.find((p) => p.square === m.to)?.kind ?? null })), { id: "wait", description: "Take no action for 200ms while the opponent can keep attacking. Tactical timing only; do not wait for a turn." }],
  };
}
export async function chooseMove(provider: Provider, position: Position, side: Side, offered: Move[], now: number, signal: AbortSignal) {
  const model = raceModels()[provider], state = decisionState(position, side, offered, now);
  const jev = provider === "jev";
  const instructions = `Which action should your ${side} army execute now to capture the ${side === "white" ? "black" : "white"} king and keep your own king alive?\n${INSTRUCTIONS}`;
  const body = jev ? { model, state, questions: { move: { type: "choice", instructions, criteria: Object.fromEntries(state.actions.map(({ id, ...description }) => [id, description])) } } } : {
    model, max_completion_tokens: 2048, ...(model === "gpt-oss-120b" ? { reasoning_effort: "low" } : {}),
    messages: [{ role: "system", content: instructions }, { role: "user", content: JSON.stringify(state) }],
    response_format: { type: "json_schema", json_schema: { name: "chess_move", strict: true, schema: { type: "object", properties: { move: { type: "string", enum: state.actions.map((a) => a.id) } }, required: ["move"], additionalProperties: false } } },
  };
  const began = performance.now();
  const response = await fetch(jev ? "https://api.typesafe.ai/v1/systemone" : "https://api.cerebras.ai/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${jev ? process.env.TYPESAFE_API_KEY : process.env.CEREBRAS_API_KEY}` },
    body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) throw Error(`${jev ? "Jev" : "Cerebras"} returned HTTP ${response.status}. Match interrupted.`);
  const result = await response.json();
  let id: unknown;
  try { id = jev ? result.answers.move.choice : JSON.parse(result.choices[0].message.content).move; }
  catch { throw Error(`${provider} returned an unreadable move. Match interrupted.`); }
  if (!state.actions.some((a) => a.id === id)) throw Error(`${provider} returned a move outside the offered choices.`);
  return { id: id as string, model: typeof result.model === "string" ? result.model : model, latencyMs: Math.round(performance.now() - began) };
}
