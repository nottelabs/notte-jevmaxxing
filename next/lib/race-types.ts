export type Racer = "jev" | "cerebras";
export const RACERS: Racer[] = ["jev", "cerebras"];
export const MAX_HOPS = 20;
export const RACE_MS = 120_000;
export const MAX_LINKS = 250;
export type Article = { title: string; url: string };
export type WikiLink = Article & { id: string };
export type WikiPage = Article & { text: string; links: WikiLink[]; total_links: number };
export type RaceStep = Article & { elapsed_ms: number; decision_ms: number; link?: string };
export type Lane = {
  racer: Racer;
  model: string;
  status: "preparing" | "ready" | "racing" | "finished" | "limited" | "error" | "stopped";
  viewer_url?: string;
  path: RaceStep[];
  elapsed_ms: number;
  model_ms: number;
  decisions: number;
  message?: string;
};
export type RaceEvent =
  | { type: "lane"; lane: Lane }
  | { type: "start"; start: Article; target: Article }
  | { type: "finish"; winner: Racer | "tie" | null }
  | { type: "error"; error: string };

export function winnerOf(lanes: Lane[]): Racer | "tie" | null {
  const finishers = lanes.filter((lane) => lane.status === "finished").sort((a, b) => a.elapsed_ms - b.elapsed_ms);
  if (!finishers.length) return null;
  if (finishers.length > 1 && finishers[0].elapsed_ms === finishers[1].elapsed_ms) return "tie";
  return finishers[0].racer;
}
