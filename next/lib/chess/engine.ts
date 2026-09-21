export type Side = "white" | "black";
export type Kind = "pawn" | "knight" | "bishop" | "rook" | "queen" | "king";
export type Piece = { id: string; side: Side; kind: Kind; square: number; readyAt: number; moved: boolean };
export type Move = { id: string; piece: string; from: number; to: number };
export type Position = { pieces: Piece[]; winner: Side | null; recent: string[] };
export const COOLDOWN_MS = 2000;
export const MATCH_MS = 120_000;
export const other = (side: Side): Side => side === "white" ? "black" : "white";
export const squareName = (square: number) => `${"abcdefgh"[square % 8]}${8 - Math.floor(square / 8)}`;
export const material: Record<Kind, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };

export function initialPosition(): Position {
  const back: Kind[] = ["rook", "knight", "bishop", "queen", "king", "bishop", "knight", "rook"];
  return { winner: null, recent: [], pieces: (["black", "white"] as Side[]).flatMap((side) =>
    [0, 1].flatMap((rank) => back.map((kind, file) => {
      const row = side === "black" ? rank : 7 - rank;
      return { id: `${side}-${rank}-${file}`, side, kind: rank ? "pawn" : kind, square: row * 8 + file, readyAt: 0, moved: false };
    }))) };
}

// No check restrictions: the king is a capturable piece, as in the arcade variant.
export function moves(position: Position, side: Side, now: number, ignoreCooldown = false): Move[] {
  if (position.winner) return [];
  const occupied = new Map(position.pieces.map((p) => [p.square, p]));
  const result: Move[] = [];
  for (const p of position.pieces) {
    if (p.side !== side || (!ignoreCooldown && p.readyAt > now)) continue;
    const row = Math.floor(p.square / 8), col = p.square % 8;
    const add = (r: number, c: number) => {
      if (r < 0 || r > 7 || c < 0 || c > 7) return false;
      const to = r * 8 + c, target = occupied.get(to);
      if (target?.side === side) return false;
      result.push({ id: `${p.id}:${p.square}:${to}`, piece: p.id, from: p.square, to });
      return !target;
    };
    if (p.kind === "pawn") {
      const direction = side === "white" ? -1 : 1;
      const next = row + direction;
      if (next >= 0 && next < 8) {
        if (!occupied.has(next * 8 + col)) {
          add(next, col);
          if (!p.moved && row === (side === "white" ? 6 : 1) && !occupied.has((row + 2 * direction) * 8 + col)) add(row + 2 * direction, col);
        }
        for (const dc of [-1, 1]) if (col + dc >= 0 && col + dc < 8 && occupied.get(next * 8 + col + dc)?.side === other(side)) add(next, col + dc);
      }
    } else if (p.kind === "knight") {
      for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) add(row + dr, col + dc);
    } else {
      const directions = p.kind === "rook" ? [[1,0],[-1,0],[0,1],[0,-1]] : p.kind === "bishop" ? [[1,1],[1,-1],[-1,1],[-1,-1]] : [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
      for (const [dr, dc] of directions) for (let distance = 1; distance <= (p.kind === "king" ? 1 : 7); distance++) if (!add(row + dr * distance, col + dc * distance)) break;
    }
  }
  return result;
}

export function applyMove(position: Position, side: Side, move: Move, now: number) {
  if (!moves(position, side, now).some((m) => m.id === move.id && m.piece === move.piece && m.from === move.from && m.to === move.to)) return null;
  const piece = position.pieces.find((p) => p.id === move.piece)!;
  const captured = position.pieces.find((p) => p.square === move.to);
  if (captured) position.pieces = position.pieces.filter((p) => p.id !== captured.id);
  const notation = `${side} ${piece.kind} ${squareName(move.from)}${captured ? " × " : " → "}${squareName(move.to)}`;
  piece.square = move.to;
  piece.readyAt = now + COOLDOWN_MS;
  piece.moved = true;
  if (piece.kind === "pawn" && (move.to < 8 || move.to >= 56)) piece.kind = "queen";
  if (captured?.kind === "king") position.winner = side;
  position.recent = [...position.recent, notation].slice(-8);
  return { notation, captured: captured ? { ...captured } : null };
}

export function threatenedKings(position: Position, now: number): string[] {
  return position.pieces.filter((p) => p.kind === "king" && moves(position, other(p.side), now).some((m) => m.to === p.square)).map((p) => p.id);
}
