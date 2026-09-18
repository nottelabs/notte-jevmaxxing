// One run, start to finish, as a stream of events. The loop is jev_ultrafast/agent.py:
// page -> indexed elements -> operation + target -> execution. Nothing survives the run,
// so it fits one serverless invocation that holds the browser connection while it streams.
import { NotteClient } from "notte-sdk";
import { Browser, Page, StalePage, VIEWPORT } from "./browser";
import { Decision, HistoryEntry, MAX_STEPS, actionSpace, choose, fieldContext, fieldText } from "./model";

/** Session stops still in flight, for the route to hand to `after()`. */
export const stopping = new Set<Promise<unknown>>();

export type RunEvent =
  | { type: "session"; viewer_url: string | null; session_id: string }
  | { type: "state"; state: RunState }
  | { type: "error"; error: string };

export type RunState = {
  status: "ready" | "predicted" | "done" | "blocked";
  page: Page;
  elements: ReturnType<typeof actionSpace>["elements"];
  decision: Decision | null;
  decisions: number;
  history: HistoryEntry[];
  elapsed_ms: number;
  max_steps: number;
};

export async function* run(url: string, goal: string, signal: AbortSignal): AsyncGenerator<RunEvent> {
  const client = new NotteClient({ apiKey: process.env.NOTTE_API_KEY });
  // No proxies: pages load about 4x faster. Sites that block datacenter IPs need proxies: true.
  const session = client.Session({ proxies: false, idle_timeout_minutes: 5, max_duration_minutes: 30, ...VIEWPORT } as any);
  await session.start();
  let browser: Browser | undefined;
  try {
    // The viewer can be embedded from here on, while the agent connects and the page loads.
    const connecting = session.cdpUrl().then((cdpUrl) => Browser.connect(cdpUrl));
    connecting.catch(() => {}); // reported below
    const started = (session as any).response ?? (await session.status());
    yield { type: "session", viewer_url: started.viewer_url ?? null, session_id: started.session_id };

    browser = await connecting;
    await browser.open(url);
    let observed = await browser.observe();
    let page = observed.page;
    const history: HistoryEntry[] = [];
    let decisions = 0;
    let status = "ready" as RunState["status"];
    let startedAt = 0;
    const elapsed = () => Math.round(performance.now() - startedAt);
    const state = (decision: Decision | null = null): RunEvent => ({
      type: "state",
      state: { status, page, elements: actionSpace(page.actions).elements, decision, decisions, history, elapsed_ms: startedAt ? elapsed() : 0, max_steps: MAX_STEPS },
    });
    const reobserve = async () => {
      observed = await browser!.observe();
      page = observed.page;
      status = "ready";
    };
    yield state();

    while (!signal.aborted && status !== "done" && status !== "blocked") {
      if (!startedAt) startedAt = performance.now(); // the first prediction starts the run timer, as in jev
      if (decisions >= MAX_STEPS * 2) throw new Error("Reached the model-call budget");

      // The page was read a moment ago: check it is still that page while the model decides, not before.
      const [fresh, decision] = await Promise.all([browser.fresh(page), choose(page, goal, history, signal)]);
      decisions++;
      page.screenshot = await observed.shot; // requested with the snapshot, long arrived
      if (!fresh) {
        await reobserve(); // the decision was made on a page that no longer exists
        continue;
      }
      status = "predicted";
      yield state(decision);
      if (signal.aborted) break;

      // The decision is consumed once, before any mutation or model call. A retry cannot double-click.
      const selected = decision.choice;
      if (selected === "DONE" || selected === "BLOCKED") {
        if (!(await browser.fresh(page))) {
          await reobserve();
          continue;
        }
        status = selected === "DONE" ? "done" : "blocked";
        yield state(decision);
        break;
      }
      const action = page.actions.find((a) => a.id === selected)!;
      if (history.length >= MAX_STEPS) throw new Error(`Stopped at the ${MAX_STEPS}-action budget`);
      let text: string | undefined;
      let helper: { model: string; latency_ms: number } | undefined;
      try {
        if (action.kind === "fill") {
          // Same idea: the text is written while the page is checked. act() checks once more before any input.
          const [stillFresh, written] = await Promise.all([browser.fresh(page), fieldText(fieldContext(goal, action, page, history), signal)]);
          if (!stillFresh) throw new StalePage("Page changed before text generation. Choose again.");
          ({ text, helper } = written);
        }
        await browser.act(action, page, text);
      } catch (error) {
        if (!(error instanceof StalePage)) throw error;
        await reobserve(); // nothing was executed
        continue;
      }
      // Record execution before observing. A stale post-action observation must not erase the action.
      const entry: HistoryEntry = {
        step: history.length + 1,
        action: action.label,
        kind: action.kind,
        choice: selected,
        probability: decision.probabilities[selected],
        confidence: decision.confidence,
        latency_ms: decision.latency_ms,
        text: text ?? null,
        text_helper: helper?.model ?? null,
        text_latency_ms: helper?.latency_ms ?? 0,
        operation: decision.operation,
        target: decision.target,
        page_changed: null,
        url: page.url,
        executed_ms: elapsed(),
      };
      history.push(entry);
      const before = page.fingerprint;
      await reobserve();
      Object.assign(entry, { page_changed: page.fingerprint !== before, url: page.url, elapsed_ms: elapsed() });
      const repeated = history.slice(-3);
      if (repeated.length === 3 && repeated.every((h) => h.page_changed === false && h.kind !== "wait")) status = "blocked";
      yield state();
    }
  } finally {
    browser?.close();
    // Stopping takes several seconds; the response has ended by then. The caller keeps the invocation alive for it.
    const stop: Promise<unknown> = session.stop().catch(() => {}).finally(() => stopping.delete(stop));
    stopping.add(stop);
  }
}
