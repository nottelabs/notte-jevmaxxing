import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { applyMove, initialPosition, moves, threatenedKings, type Piece, type Position, type Kind, type Side } from "../lib/chess/engine";
import { runMatch } from "../lib/chess/match";
import { chooseMove, decisionState } from "../lib/chess/model";
import type { GameEvent } from "../lib/chess/types";
const piece = (kind: Kind, side: Side, square: number, readyAt = 0): Piece => ({ id: `${side}-${kind}-${square}`, kind, side, square, readyAt, moved: false });
const position = (...pieces: Piece[]): Position => ({ pieces, recent: [], winner: null });
const move = (p: Position, from: number, to: number, now = 0) => { const side = p.pieces.find((p) => p.square === from)!.side; return moves(p, side, now).find((m) => m.from === from && m.to === to)!; };

test("standard position has 32 pieces and 20 opening moves for either side", () => {
  const p = initialPosition(); assert.equal(p.pieces.length, 32);
  assert.equal(moves(p, "white", 0).length, 20); assert.equal(moves(p, "black", 0).length, 20);
});
test("rook and bishop cannot jump blockers, wrap around, or capture allies", () => {
  const p = position(piece("rook", "white", 24), piece("pawn", "white", 26), piece("pawn", "black", 8));
  const destinations = moves(p, "white", 0).filter((m) => m.from === 24).map((m) => m.to);
  assert.ok(destinations.includes(25)); assert.ok(destinations.includes(8));
  for (const blocked of [0, 23, 26, 27]) assert.ok(!destinations.includes(blocked));
  const b = position(piece("bishop", "white", 27), piece("pawn", "black", 9));
  assert.ok(move(b, 27, 9)); assert.equal(move(b, 27, 0), undefined);
});
test("knights jump and kings may move into an attacked square", () => {
  const p = initialPosition(); assert.ok(move(p, 57, 40));
  const k = position(piece("king", "white", 60), piece("rook", "black", 3));
  assert.ok(move(k, 60, 59)); assert.equal(move(k, 60, 58), undefined);
});
test("pawn double moves require the starting rank and clear path; captures are diagonal only", () => {
  const p = position(piece("pawn", "white", 48), piece("rook", "black", 41));
  assert.ok(move(p, 48, 32)); assert.ok(move(p, 48, 41)); assert.equal(move(p, 48, 39), undefined);
  p.pieces.push(piece("pawn", "black", 40));
  assert.equal(move(p, 48, 40), undefined); assert.equal(move(p, 48, 32), undefined);
  const black = position(piece("pawn", "black", 8)); assert.ok(move(black, 8, 24));
});
test("cooldown blocks only the moved piece and expires exactly at its boundary", () => {
  const p = initialPosition(); const selected = move(p, 48, 40);
  assert.ok(applyMove(p, "white", selected, 0));
  assert.equal(move(p, 40, 32, 1999), undefined); assert.ok(move(p, 40, 32, 2000));
  assert.ok(move(p, 49, 41, 1));
});
test("pawns promote automatically, and a captured king ends all further moves", () => {
  const p = position(piece("pawn", "white", 8), piece("king", "black", 1));
  assert.ok(applyMove(p, "white", move(p, 8, 0), 0)); assert.equal(p.pieces.find((p) => p.square === 0)!.kind, "queen");
  const result = applyMove(p, "white", move(p, 0, 1, 2000), 2000);
  assert.equal(result?.captured?.kind, "king"); assert.equal(p.winner, "white"); assert.equal(moves(p, "black", 2000).length, 0);
});
test("captured or displaced selected pieces and newly blocked paths reject stale moves", () => {
  const p = position(piece("rook", "white", 56)); const chosen = move(p, 56, 0);
  p.pieces.push(piece("pawn", "black", 32)); assert.equal(applyMove(p, "white", chosen, 10), null);
  p.pieces = p.pieces.filter((p) => p.side === "white"); p.pieces[0].square = 57;
  assert.equal(applyMove(p, "white", chosen, 10), null);
  p.pieces = []; assert.equal(applyMove(p, "white", chosen, 10), null);
});
test("unrelated board changes do not discard a still-valid move; spoofed move payloads fail", () => {
  const p = position(piece("rook", "white", 56)); const selected = move(p, 56, 0);
  p.pieces.push(piece("pawn", "black", 15));
  assert.equal(applyMove(p, "white", { ...selected, to: 1 }, 10), null);
  assert.ok(applyMove(p, "white", selected, 10));
});
test("king threats respect readiness and no en passant is offered", () => {
  const p = position(piece("king", "white", 56), piece("rook", "black", 0, 100));
  assert.deepEqual(threatenedKings(p, 0), []); assert.deepEqual(threatenedKings(p, 100), [p.pieces[0].id]);
  const q = position(piece("pawn", "white", 27), piece("pawn", "black", 28)); assert.equal(move(q, 27, 20), undefined);
});
test("the fast model completes several moves while its opponent still thinks", async () => {
  const events: GameEvent[] = [];
  await runMatch("jev", new AbortController().signal, (e) => events.push(e), {
    countdownMs: 0, durationMs: 90,
    choose: async (provider, _p, _side, offered, _now, signal) => {
      await delay(provider === "jev" ? 3 : 200, undefined, { signal });
      return { id: offered[0].id, latencyMs: 3, model: "test" };
    },
  });
  const final = events.at(-1)!; assert.equal(final.type, "finish");
  assert.ok(final.snapshot.players[0].moves >= 2); assert.equal(final.snapshot.players[1].moves, 0);
  assert.ok(events.some((e) => e.type === "state" && e.action?.provider === "jev" && e.snapshot.players[1].thinking));
  if (final.type === "finish") assert.equal(final.result.reason, "draw");
});
test("a response arriving after cancellation never changes the board", async () => {
  const stop = new AbortController(), events: GameEvent[] = [];
  await runMatch("jev", stop.signal, (e) => events.push(e), { countdownMs: 0, choose: async (_provider, _p, _s, offered) => { stop.abort(); await delay(2); return { id: offered[0].id, latencyMs: 1, model: "test" }; } });
  assert.equal(events.filter((e) => e.type === "state" && e.action).length, 0);
  const final = events.at(-1)!; if (final.type === "finish") assert.equal(final.result.reason, "stopped");
});
test("provider failure interrupts the match instead of awarding a win", async () => {
  const events: GameEvent[] = [];
  await runMatch("cerebras", new AbortController().signal, (e) => events.push(e), { countdownMs: 0, choose: async () => { throw Error("provider offline"); } });
  const final = events.at(-1)!; assert.equal(final.snapshot.players[0].side, "black");
  if (final.type !== "finish") assert.fail();
  assert.equal(final.result.reason, "error"); assert.equal(final.result.winner, null);
});
test("king capture ends the match, aborts the opponent, and snapshots retain replay history", async () => {
  const events: GameEvent[] = [];
  await runMatch("jev", new AbortController().signal, (e) => events.push(e), {
    countdownMs: 0, position: () => position(piece("rook", "white", 56), piece("king", "white", 63), piece("king", "black", 0)),
    choose: async (provider, _p, _side, offered, _now, signal) => {
      if (provider === "cerebras") await delay(5000, undefined, { signal });
      return { id: offered.find((m) => m.to === 0)!.id, latencyMs: 1, model: "test" };
    },
  });
  assert.equal(events[0].snapshot.position.pieces.length, 3);
  const last = events.at(-1)!; assert.equal(last.snapshot.position.pieces.length, 2);
  if (last.type !== "finish") assert.fail(); assert.equal(last.result.winner, "jev");
  assert.ok(last.snapshot.players.every((p) => !p.thinking));
  const replay = initialPosition(); Object.assign(replay, structuredClone(events[0].snapshot.position));
  for (const event of events) if (event.type === "state" && event.action) applyMove(replay, event.snapshot.players.find((p) => p.provider === event.action!.provider)!.side, event.action.move, event.snapshot.at);
  assert.deepEqual(replay, last.snapshot.position);
});
test("both providers receive identical state and choices; invented IDs are rejected", async () => {
  const original = globalThis.fetch; const bodies: any[] = [];
  try {
    globalThis.fetch = async (_url, options) => { bodies.push(JSON.parse(options!.body as string)); return Response.json({ answers: { move: { choice: "invented" } }, choices: [{ message: { content: '{"move":"invented"}' } }] }); };
    const p = initialPosition(), offered = moves(p, "white", 0);
    for (const provider of ["jev", "cerebras"] as const) await assert.rejects(chooseMove(provider, p, "white", offered, 0, new AbortController().signal), /outside/);
    assert.deepEqual(bodies[0].state, JSON.parse(bodies[1].messages[1].content));
    assert.equal(bodies[0].questions.move.instructions, bodies[1].messages[0].content);
    assert.deepEqual(Object.keys(bodies[0].questions.move.criteria), bodies[1].response_format.json_schema.schema.properties.move.enum);
    assert.equal(decisionState(p, "white", offered, 0).actions.at(-1)!.id, "wait");
  } finally { globalThis.fetch = original; }
});

test("wait decisions do not move pieces or immediately spam new requests", async () => {
  let calls = 0;
  const events: GameEvent[] = [];
  await runMatch("jev", new AbortController().signal, (e) => events.push(e), { countdownMs: 0, durationMs: 40, choose: async () => { calls++; return { id: "wait", latencyMs: 1, model: "test" }; } });
  assert.equal(calls, 2); assert.ok(events.at(-1)!.snapshot.players.every((p) => p.moves === 0 && p.decisions === 1));
});
test("no available moves waits without calling a provider", async () => {
  await runMatch("jev", new AbortController().signal, () => {}, { countdownMs: 0, durationMs: 20, position: () => position(piece("pawn", "white", 0), piece("pawn", "black", 63)), choose: async () => { assert.fail("No request when no piece can move"); } });
});
test("cancelling the countdown starts no model request", async () => {
  const stop = new AbortController(); const events: GameEvent[] = [];
  await runMatch("jev", stop.signal, (e) => { events.push(e); if (e.type === "countdown") stop.abort(); }, { choose: async () => { assert.fail("Countdown must finish first"); } });
  assert.deepEqual(events.map((e) => e.type), ["countdown", "finish"]);
});
test("a move invalidated during inference is counted as stale", async () => {
  const authoritative = initialPosition(), events: GameEvent[] = [];
  let first = true;
  await runMatch("jev", new AbortController().signal, (e) => events.push(e), {
    countdownMs: 0, durationMs: 50, position: () => authoritative,
    choose: async (provider, _p, _side, offered, _now, signal) => {
      if (provider === "cerebras") { await delay(1000, undefined, { signal }); }
      if (first) { first = false; authoritative.pieces = authoritative.pieces.filter((p) => p.id !== offered[0].piece); return { id: offered[0].id, latencyMs: 1, model: "test" }; }
      return { id: "wait", latencyMs: 1, model: "test" };
    },
  });
  assert.equal(events.at(-1)!.snapshot.players[0].stale, 1); assert.equal(events.at(-1)!.snapshot.players[0].moves, 0);
});
