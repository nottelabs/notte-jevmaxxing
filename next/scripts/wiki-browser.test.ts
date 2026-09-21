import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser as TestBrowser } from "playwright";
import { READ_WIKI, clickWiki } from "../lib/wiki";
import type { Browser } from "../lib/browser";
import type { WikiPage } from "../lib/race-types";

let browser: TestBrowser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

test("article choices exclude collapsed sidebars and hidden links before deduplicating", async () => {
  const page = await browser.newPage();
  try {
    await page.route("https://en.wikipedia.org/**", (route) => route.fulfill({ contentType: "text/html", body: `
      <link rel="canonical" href="https://en.wikipedia.org/wiki/Video_game_industry">
      <h1 id="firstHeading">Video game industry</h1>
      <div id="mw-content-text"><div class="mw-parser-output">
        <table class="sidebar"><tr><td><div class="mw-collapsed"><div style="opacity:0;height:0;overflow:hidden">
          <a href="/wiki/List_of_video_game_developers">Hidden sidebar duplicate</a>
        </div></div></td></tr></table>
        <div style="visibility:hidden"><a href="/wiki/Invisible">Invisible</a></div>
        <div style="opacity:0"><a href="/wiki/Transparent">Transparent</a></div>
        <div style="content-visibility:hidden"><a href="/wiki/Skipped">Skipped</a></div>
        <table class="sidebar"><tr><td><a href="/wiki/Sidebar_only">Visible sidebar navigation</a></td></tr></table>
        <p><a href="/wiki/List_of_video_game_developers">Visible article link</a></p>
        <div style="height:2000px"></div>
        <p><a href="/wiki/Nadeo">Below the viewport</a></p>
      </div></div>` }));
    await page.goto("https://en.wikipedia.org/wiki/Video_game_industry");
    // This is why rectangle existence alone failed in the live Wikipedia sidebar.
    assert.equal(await page.locator(".mw-collapsed a").evaluate((a) => a.getClientRects().length > 0), true);
    const state = await page.evaluate(READ_WIKI) as WikiPage;
    assert.deepEqual(state.links.map((link) => link.title), ["List of video game developers", "Nadeo"]);
    assert.equal(await page.evaluate("window.__wikiRace.nodes.get('1').textContent"), "Visible article link");
    assert.equal(state.total_links, 2);
  } finally { await page.close(); }
});

test("a link hidden after observation fails closed without dispatching input", async () => {
  const page = await browser.newPage();
  try {
    await page.route("https://en.wikipedia.org/**", (route) => route.fulfill({ contentType: "text/html", body: `
      <h1 id="firstHeading">Start</h1><div id="mw-content-text"><div class="mw-parser-output">
      <a href="/wiki/Nadeo">Nadeo</a></div></div>` }));
    await page.goto("https://en.wikipedia.org/wiki/Start");
    const state = await page.evaluate(READ_WIKI) as WikiPage;
    await page.locator("a").evaluate((a) => { a.style.opacity = "0"; });
    let inputs = 0;
    const driver = { evaluate: (expression: string) => page.evaluate(expression), call: async () => { inputs++; } } as unknown as Browser;
    await assert.rejects(clickWiki(driver, state.links[0], new AbortController().signal), /changed or is covered/);
    assert.equal(inputs, 0);
  } finally { await page.close(); }
});
