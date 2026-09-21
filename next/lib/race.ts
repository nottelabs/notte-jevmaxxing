import { NotteClient } from "notte-sdk";
import { Browser, VIEWPORT } from "./browser";
import { chooseLink, raceModels } from "./race-model";
import { articleUrl, clickWiki, readWiki } from "./wiki";
import { MAX_HOPS, RACE_MS, RACERS, winnerOf, type Lane, type RaceEvent, type WikiPage } from "./race-types";

type Driver = {
  viewer_url?: string;
  open: (url: string, signal: AbortSignal) => Promise<WikiPage>;
  follow: (link: WikiPage["links"][number], previous: string, signal: AbortSignal) => Promise<WikiPage>;
  close: () => Promise<void>;
};

async function openDriver(signal: AbortSignal): Promise<Driver> {
  signal.throwIfAborted();
  const client = new NotteClient({ apiKey: process.env.NOTTE_API_KEY });
  const session = client.Session({ proxies: false, idle_timeout_minutes: 3, max_duration_minutes: 5, ...VIEWPORT } as never);
  let browser: Browser | undefined;
  let started = false;
  const disconnect = () => browser?.close();
  const close = async () => {
    signal.removeEventListener("abort", disconnect);
    browser?.close();
    if (started) await session.stop();
  };
  try {
    await session.start();
    started = true;
    signal.throwIfAborted();
    browser = await Browser.connect(await session.cdpUrl());
    signal.addEventListener("abort", disconnect, { once: true });
    signal.throwIfAborted();
    const status = await session.status();
    return {
      viewer_url: status.viewer_url ?? undefined,
      open: async (url, signal) => { signal.throwIfAborted(); await browser!.open(url); return readWiki(browser!, signal); },
      follow: async (link, previous, signal) => { await clickWiki(browser!, link, signal); return readWiki(browser!, signal, previous); },
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

export type RaceDeps = { openDriver: (signal: AbortSignal) => Promise<Driver>; choose: typeof chooseLink; now: () => number };
const defaults: RaceDeps = { openDriver, choose: chooseLink, now: () => performance.now() };

export async function runRace(startUrl: string, targetUrl: string, signal: AbortSignal, emit: (event: RaceEvent) => void, deps: RaceDeps = defaults) {
  const lanes = RACERS.map((racer): Lane => ({ racer, model: raceModels()[racer], status: "preparing", path: [], elapsed_ms: 0, model_ms: 0, decisions: 0 }));
  const drivers: Driver[] = [];
  const controller = new AbortController();
  const active = AbortSignal.any([signal, controller.signal]);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const publish = (lane: Lane) => emit({ type: "lane", lane: { ...lane, path: [...lane.path] } });
  try {
    lanes.forEach(publish);
    // Each lane resolves redirects and verifies both articles before the shared start.
    // allSettled ensures a slower setup cannot leak a browser after another lane fails.
    const setups = await Promise.allSettled(lanes.map(async (lane) => {
      const driver = await deps.openDriver(active);
      drivers.push(driver);
      lane.viewer_url = driver.viewer_url;
      publish(lane);
      const target = await driver.open(targetUrl, active);
      const page = await driver.open(startUrl, active);
      if (articleUrl(page.url) === articleUrl(target.url)) throw new Error("Start and target resolve to the same article. Choose different articles.");
      lane.status = "ready";
      lane.path = [{ title: page.title, url: page.url, elapsed_ms: 0, decision_ms: 0 }];
      publish(lane);
      return { driver, page, target };
    }));
    const failed = setups.find((s) => s.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    const prepared = setups.map((s) => (s as PromiseFulfilledResult<{ driver: Driver; page: WikiPage; target: WikiPage }>).value);
    if (articleUrl(prepared[0].page.url) !== articleUrl(prepared[1].page.url) || articleUrl(prepared[0].target.url) !== articleUrl(prepared[1].target.url)) throw new Error("The browsers resolved different articles. Please retry.");
    active.throwIfAborted();
    const startedAt = deps.now();
    const elapsed = () => Math.round(deps.now() - startedAt);
    deadline = setTimeout(() => { timedOut = true; controller.abort(); }, RACE_MS);
    emit({ type: "start", start: prepared[0].page, target: prepared[0].target });

    await Promise.all(lanes.map(async (lane, index) => {
      let { page } = prepared[index];
      const { driver, target } = prepared[index];
      lane.status = "racing";
      publish(lane);
      try {
        for (let hop = 0; hop < MAX_HOPS; hop++) {
          active.throwIfAborted();
          const decision = await deps.choose(lane.racer, page, target, lane.path, active);
          lane.model = decision.model;
          lane.model_ms += decision.latency_ms;
          lane.decisions++;
          lane.message = `Following ${decision.link.title}`;
          lane.elapsed_ms = elapsed();
          publish(lane);
          active.throwIfAborted();
          page = await driver.follow(decision.link, page.url, active);
          active.throwIfAborted();
          lane.elapsed_ms = elapsed();
          lane.path.push({ title: page.title, url: page.url, elapsed_ms: lane.elapsed_ms, decision_ms: decision.latency_ms, link: decision.link.title });
          lane.message = undefined;
          if (articleUrl(page.url) === articleUrl(target.url)) {
            lane.status = "finished";
            publish(lane);
            return;
          }
          publish(lane);
        }
        lane.status = "limited";
        lane.message = `Reached the ${MAX_HOPS}-click limit.`;
      } catch (error) {
        lane.status = timedOut ? "limited" : active.aborted ? "stopped" : "error";
        lane.message = timedOut ? "Reached the 2-minute limit." : active.aborted ? "Race stopped." : error instanceof Error ? error.message : "This browser could not continue.";
      }
      lane.elapsed_ms = elapsed();
      publish(lane);
    }));
    emit({ type: "finish", winner: winnerOf(lanes) });
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(deadline);
    const closed = await Promise.allSettled(drivers.map((driver) => driver.close()));
    if (closed.some((r) => r.status === "rejected")) console.error("A Wikipedia race session could not be stopped; the five-minute session limit remains active.");
  }
}
