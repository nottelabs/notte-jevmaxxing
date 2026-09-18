// Local debugging: one Flights run with stale events explained. Run: JEV_DEBUG=1 npx tsx --env-file=.env.local scripts/debug-run.mts
import { run } from "../lib/agent";
let n = 0;
for await (const e of run("https://www.google.com/travel/flights?hl=en", "Find one-way flights from Zurich to London on September 20, 2026, for one adult in economy. Stop when matching flight options are visible.", new AbortController().signal)) {
  if (e.type !== "state") continue;
  const h = e.state.history;
  if (h.length > n) { n = h.length; console.error(`${String(h[n - 1].elapsed_ms).padStart(6)} ms  ${h[n - 1].kind.padEnd(6)} ${h[n - 1].action.slice(0, 60)}`); }
  if (e.state.status === "done") console.error("done", e.state.decisions, "decisions", JSON.stringify(e.state.timing));
}
process.exit(0);
