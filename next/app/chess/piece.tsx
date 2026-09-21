import type { Kind, Side } from "@/lib/chess/engine";

export function PieceIcon({ kind, side }: { kind: Kind; side: Side }) {
  return <svg viewBox="0 0 48 48" aria-hidden="true" className={`piece-icon ${side}`}>
    <g fill="currentColor" stroke="var(--piece-edge)" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round">
      {kind === "pawn" && <><circle cx="24" cy="13" r="6" /><path d="M19 20h10l-2 7 5 9H16l5-9z" /></>}
      {kind === "rook" && <path d="M13 8h6v6h3V8h4v6h3V8h6v13l-5 3 2 12H16l2-12-5-3z" />}
      {kind === "knight" && <path d="m17 9 8 3 7 6 3 9-7 9H14l4-9 9-7-6-2-7 7-5-4 7-13 1-5 5 6z" />}
      {kind === "knight" && <circle cx="21" cy="16" r="1.2" fill="var(--piece-edge)" stroke="none" />}
      {kind === "bishop" && <><path d="M24 6c-3 4-10 9-10 14 0 5 5 7 10 7s10-2 10-7c0-5-7-10-10-14zM20 27h8l4 9H16z" /><path d="m27 12-5 8" fill="none" /></>}
      {kind === "queen" && <><path d="m12 15 5 7 7-11 7 11 5-7-5 21H17z" /><circle cx="11" cy="12" r="3" /><circle cx="24" cy="8" r="3" /><circle cx="37" cy="12" r="3" /></>}
      {kind === "king" && <><path d="M22 4h4v5h5v4h-5v6h-4v-6h-5V9h5zM24 21c-9-10-17 0-9 8l3 7h12l3-7c8-8 0-18-9-8z" /></>}
      <path d="M16 36h16l4 6H12z" />
    </g>
  </svg>;
}
