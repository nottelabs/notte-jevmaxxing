import { test } from "node:test";
import assert from "node:assert/strict";
import { articleUrl } from "../lib/wiki";
import { runRace, type RaceDeps } from "../lib/race";
import { chooseLink, raceState } from "../lib/race-model";
import { MAX_HOPS, winnerOf, type WikiPage, type RaceEvent, type Lane } from "../lib/race-types";

const page = (title: string): WikiPage => ({ title, url: articleUrl(title), text: title, links: [{ id: "1", title: "Target", url: articleUrl("Target") }], total_links: 1 });

test("article inputs normalize titles and reject off-site URLs and non-article namespaces", () => {
  assert.equal(articleUrl("Ice cream"), articleUrl("https://en.wikipedia.org/wiki/Ice_cream#History"));
  assert.equal(articleUrl("Star Trek: Voyager"), "https://en.wikipedia.org/wiki/Star_Trek%3A_Voyager");
  for (const value of [null, "", "Main Page", "Category:Physics", "Special:Random", "https://evil.test/wiki/Coffee", "https://en.wikipedia.org@evil.test/wiki/Coffee", "http://en.wikipedia.org/wiki/Coffee", "https://en.wikipedia.org/w/index.php", "https://en.wikipedia.org/wiki/Category%3APhysics"]) {
    assert.throws(() => articleUrl(value), Error, String(value));
  }
});

test("visited options include clicked redirect aliases as well as landed article titles", () => {
  const p = { ...page("Ratchet (device)"), links: [
    { id: "1", title: "Ratchet (disambiguation)", url: articleUrl("Ratchet (disambiguation)") },
    { id: "2", title: "Ratchet (device)", url: articleUrl("Ratchet (device)") },
    { id: "3", title: "Gear", url: articleUrl("Gear") },
  ] };
  const history = [page("Ratchet (device)"), { ...page("Ratchet"), link: "Ratchet (disambiguation)" }, page("Ratchet (device)")];
  const state = raceState(p, page("Hoberman sphere"), history);
  assert.deepEqual(state.visited, ["Ratchet (device)", "Ratchet", "Ratchet (disambiguation)"]);
  assert.deepEqual(state.links.map((link) => link.already_visited), [true, true, false]);
  // History is information for both contestants, not a provider-specific link filter.
  assert.deepEqual(state.links.map((link) => link.id), p.links.map((link) => link.id));
});

function harness() {
  let opened = 0, closed = 0, clock = 0;
  const events: RaceEvent[] = [];
  const deps: RaceDeps = {
    now: () => clock,
    openDriver: async () => {
      opened++;
      return {
        open: async (url) => { await new Promise((r) => setTimeout(r, 2)); return page(url === articleUrl("Target") ? "Target" : "Start"); },
        follow: async () => { clock += 10; return page("Target"); },
        close: async () => { closed++; },
      };
    },
    choose: async (_racer, p) => {
      assert.equal(opened, 2);
      assert.equal(events.filter((e) => e.type === "lane" && e.lane.status === "ready").length, 2);
      assert.ok(events.some((e) => e.type === "start"));
      clock += 5;
      return { link: p.links[0], model: "test-model", latency_ms: 5 };
    },
  };
  return { deps, events, emit: (e: RaceEvent) => events.push(e), closed: () => closed };
}

test("both lanes are ready before decisions; server arrival determines winner and releases both sessions", async () => {
  const h = harness();
  await runRace(articleUrl("Start"), articleUrl("Target"), new AbortController().signal, h.emit, h.deps);
  assert.equal(h.closed(), 2);
  const finished = h.events.filter((e) => e.type === "lane" && e.lane.status === "finished");
  assert.equal(finished.length, 2);
  assert.equal(h.events.at(-1)?.type, "finish");
  for (const e of finished) if (e.type === "lane") { assert.equal(e.lane.path.length, 2); assert.equal(e.lane.path[1].title, "Target"); }
});

test("one failed setup still releases the slower successfully created browser", async () => {
  const h = harness();
  const open = h.deps.openDriver;
  let calls = 0;
  h.deps.openDriver = async (signal) => { if (++calls === 1) throw Error("setup failed"); await new Promise((r) => setTimeout(r, 10)); return open(signal); };
  await assert.rejects(runRace(articleUrl("Start"), articleUrl("Target"), new AbortController().signal, h.emit, h.deps), /setup failed/);
  assert.equal(h.closed(), 1);
  assert.ok(!h.events.some((e) => e.type === "start"));
});

test("provider failure does not prevent the other contestant from finishing", async () => {
  const h = harness();
  const choose = h.deps.choose;
  h.deps.choose = async (...args) => { if (args[0] === "jev") throw Error("provider offline"); return choose(...args); };
  await runRace(articleUrl("Start"), articleUrl("Target"), new AbortController().signal, h.emit, h.deps);
  assert.deepEqual(h.events.at(-1), { type: "finish", winner: "cerebras" });
  assert.equal(h.closed(), 2);
});

test("cancel during a decision never clicks and releases both sessions", async () => {
  const h = harness();
  const stop = new AbortController();
  const open = h.deps.openDriver;
  h.deps.openDriver = async (signal) => ({ ...await open(signal), follow: async () => { assert.fail("No click after abort"); } });
  h.deps.choose = async (_racer, p) => { stop.abort(); return { link: p.links[0], model: "test", latency_ms: 1 }; };
  await runRace(articleUrl("Start"), articleUrl("Target"), stop.signal, h.emit, h.deps);
  assert.equal(h.closed(), 2);
  assert.deepEqual(h.events.at(-1), { type: "finish", winner: null });
});

test("redirect aliases cannot create a zero-hop race", async () => {
  const h = harness();
  const open = h.deps.openDriver;
  h.deps.openDriver = async (signal) => ({ ...await open(signal), open: async () => page("Same article") });
  await assert.rejects(runRace(articleUrl("Start"), articleUrl("Target"), new AbortController().signal, h.emit, h.deps), /same article/);
  assert.equal(h.closed(), 2);
});

test("winner uses verified finish time rather than fewest clicks or model speed", () => {
  const lane = (racer: Lane["racer"], status: Lane["status"], elapsed_ms: number) => ({ racer, status, elapsed_ms } as Lane);
  assert.equal(winnerOf([lane("jev", "finished", 300), lane("cerebras", "finished", 200)]), "cerebras");
  assert.equal(winnerOf([lane("jev", "error", 100), lane("cerebras", "limited", 200)]), null);
  assert.equal(winnerOf([lane("jev", "finished", 200), lane("cerebras", "finished", 200)]), "tie");
});

test("hop budget stops looping contestants without declaring success", async () => {
  const h = harness();
  const open = h.deps.openDriver;
  h.deps.openDriver = async (signal) => ({ ...await open(signal), follow: async () => page("Wrong article") });
  await runRace(articleUrl("Start"), articleUrl("Target"), new AbortController().signal, h.emit, h.deps);
  const limited = h.events.filter((e) => e.type === "lane" && e.lane.status === "limited");
  assert.equal(limited.length, 2);
  for (const e of limited) if (e.type === "lane") assert.equal(e.lane.path.length, MAX_HOPS + 1);
  assert.deepEqual(h.events.at(-1), { type: "finish", winner: null });
  assert.equal(h.closed(), 2);
});

test("a failed navigation is never counted as a completed hop or finish", async () => {
  const h = harness();
  const open = h.deps.openDriver;
  h.deps.openDriver = async (signal) => ({ ...await open(signal), follow: async () => { throw Error("navigation failed"); } });
  await runRace(articleUrl("Start"), articleUrl("Target"), new AbortController().signal, h.emit, h.deps);
  const errors = h.events.filter((e) => e.type === "lane" && e.lane.status === "error");
  assert.equal(errors.length, 2);
  for (const e of errors) if (e.type === "lane") assert.equal(e.lane.path.length, 1);
  assert.deepEqual(h.events.at(-1), { type: "finish", winner: null });
  assert.equal(h.closed(), 2);
});

test("both adapters accept a valid offered choice and preserve returned model IDs", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ model: "pinned-model-version", answers: { link: { choice: "1" } }, choices: [{ message: { content: '{"link":"1"}' } }] });
    for (const racer of ["jev", "cerebras"] as const) {
      const result = await chooseLink(racer, page("Start"), page("Target"), [], new AbortController().signal);
      assert.equal(result.link.title, "Target");
      assert.equal(result.model, "pinned-model-version");
    }
  } finally { globalThis.fetch = original; }
});

test("both provider adapters receive the same state and reject invented link IDs", async () => {
  const original = globalThis.fetch;
  const bodies: Record<string, any>[] = [];
  try {
    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options!.body as string));
      return Response.json({ model: "test", answers: { link: { choice: "999" } }, choices: [{ message: { content: '{"link":"999"}' } }] });
    };
    for (const racer of ["jev", "cerebras"] as const) await assert.rejects(chooseLink(racer, page("Start"), page("Target"), [page("Earlier article"), page("Start")], new AbortController().signal), /outside the offered/);
    assert.deepEqual(bodies[0].state, JSON.parse(bodies[1].messages[1].content));
    assert.deepEqual(bodies[0].state.visited, ["Earlier article", "Start"]);
    assert.match(bodies[0].questions.link.instructions, /Wikipedia article "Target"/);
    assert.match(bodies[0].questions.link.instructions, /`visited`/);
    assert.equal(bodies[0].questions.link.instructions, bodies[1].messages[0].content);
    assert.deepEqual(Object.keys(bodies[0].questions.link.criteria), bodies[1].response_format.json_schema.schema.properties.link.enum);
    for (const link of bodies[0].state.links) {
      assert.deepEqual(bodies[0].questions.link.criteria[link.id], { title: link.title, already_visited: link.already_visited });
    }
  } finally { globalThis.fetch = original; }
});
