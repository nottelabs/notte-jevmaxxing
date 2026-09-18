// Freshness/execution regressions on a real Notte browser, ported from jev-ultrafast's scripts/check_guards.py.
// No model calls or external websites. Run: npm run guards
import assert from "node:assert/strict";
import { NotteClient } from "notte-sdk";
import { Action, Browser, Page, VIEWPORT } from "../lib/browser";

const HTML = `<!doctype html><title>Guard checks</title>
<style>body{margin:30px}button{width:180px;height:50px}#outside{position:absolute;top:3000px}</style>
<p id="context">Cart total: $10</p>
<button id="target" onclick="window.clicks=(window.clicks||0)+1">Continue</button>
<label>City<input id="field" value="Zurich"></label>
<label><input id="toggle" type="checkbox">Refundable</label>
<select aria-label="Category"><option>All</option><option>Design</option></select>
<p id="outside">Unrelated offscreen text</p>`;

const FORM = `
  <form><p id="price">Total $10</p>
  <button type="button" id="buy">Buy</button>
  <label>Search <input id="query" role="combobox" aria-controls="suggestions"></label>
  <div role="listbox" id="suggestions"></div>
  <label><input id="check" type="checkbox">Enabled</label>
  <label><input id="radio" type="radio">Choice</label>
  <input id="readonly" aria-label="Read only" readonly>
  <input id="secret" type="password" value="never expose this">
  <button id="off" disabled>Disabled</button>
  <select id="category" aria-label="Category">
    <option>All</option><option>Design</option><option disabled>Unavailable</option>
  </select></form><aside id="unrelated">News</aside>`;

const session = new NotteClient({ apiKey: process.env.NOTTE_API_KEY }).Session({ proxies: false, ...VIEWPORT } as any);
await session.start();
const passed: string[] = [];
let browser: Browser | undefined;
try {
  browser = await Browser.connect(await session.cdpUrl());
  const b = browser;
  const observe = async () => (await b.observe(false)).page;
  const find = (page: Page, test: (a: Action) => boolean) => page.actions.find(test)!;
  await b.open("data:text/html," + encodeURIComponent(HTML));

  let page = await observe();
  let action = find(page, (a) => a.label === "Continue");
  await b.evaluate("document.querySelector('#target').style.transform='translateX(200px)'");
  assert(await b.fresh(page), "Movement should use fresh geometry, not another model call");
  await b.act(action, page);
  assert.equal(await b.evaluate("window.clicks"), 1);
  passed.push("moving target clicked at its current location");

  await b.evaluate("document.querySelector('#outside').textContent='Updated outside the viewport'");
  assert(await b.fresh(page));
  passed.push("unrelated offscreen text does not invalidate");

  const mutations = {
    "visible context": "document.querySelector('#context').textContent='Cart total: $100'",
    "accessible label": "document.querySelector('#target').setAttribute('aria-label','Delete account')",
    "field property": "document.querySelector('#field').value='London'",
    "checkbox property": "document.querySelector('#toggle').checked=true",
    "disabled target": "document.querySelector('#target').disabled=true",
    "read-only field": "document.querySelector('#field').readOnly=true",
    "hidden target": "document.querySelector('#target').style.display='none'",
    "replaced node": "document.querySelector('#target').outerHTML=document.querySelector('#target').outerHTML",
    "dropdown option": "document.querySelector('select').options[1].text='Coastal'",
  };
  for (const [label, expression] of Object.entries(mutations)) {
    await b.evaluate("document.querySelector('#target').style.display='block'; document.querySelector('#target').disabled=false");
    page = await observe();
    await b.evaluate(expression);
    assert(!(await b.fresh(page)), label);
    passed.push(label + " invalidates");
  }

  await b.evaluate("document.querySelector('#target').disabled=false; document.querySelector('#target').style.display='block'");
  page = await observe();
  action = find(page, (a) => a.label === "Delete account");
  // A textless overlay does not alter the model's semantic state, but must block a click.
  await b.evaluate(
    "const cover=document.createElement('div'); cover.style.cssText='position:fixed;inset:0;z-index:9999;background:white'; document.body.append(cover)",
  );
  assert(await b.fresh(page));
  await assert.rejects(b.act(action, page), "Covered target was clicked");
  assert.equal(await b.evaluate("window.clicks"), 1);
  passed.push("overlay blocked before input");

  await b.evaluate("document.body.innerHTML=" + JSON.stringify(FORM));
  page = await observe();
  let buy = find(page, (a) => a.label === "Buy");
  await b.evaluate("document.querySelector('#unrelated').textContent='New unrelated news'");
  assert(await b.fresh(page, buy));
  assert(!(await b.fresh(page)));
  passed.push("click guard accepts unrelated visible updates; terminal guard rejects them");
  const specific = {
    "nearby price": "document.querySelector('#price').textContent='Total $100'",
    "form value": "document.querySelector('#query').value='changed'",
    "form toggle": "document.querySelector('#check').checked=true",
    "target replacement": "document.querySelector('#buy').outerHTML=document.querySelector('#buy').outerHTML",
  };
  for (const [label, expression] of Object.entries(specific)) {
    page = await observe();
    buy = find(page, (a) => a.label === "Buy");
    await b.evaluate(expression);
    assert(!(await b.fresh(page, buy)), label);
    passed.push(label + " invalidates action-specific guard");
  }

  page = await observe();
  const actions = page.actions;
  const kinds = (test: (a: Action) => boolean) => [...new Set(actions.filter(test).map((a) => a.kind))];
  for (const role of ["checkbox", "radio"]) assert.deepEqual(kinds((a) => a.role === role), ["click"]);
  assert.deepEqual(kinds((a) => a.label === "Read only"), ["click"]);
  assert(!actions.some((a) => a.label === "Disabled" || a.value === "never expose this"));
  assert.deepEqual(actions.filter((a) => a.kind === "select").map((a) => a.value), ["Design"]);
  passed.push("native controls expose only supported operations and safe values");

  await b.act(find(page, (a) => a.kind === "select"), page);
  assert.equal(await b.evaluate("document.querySelector('#category').value"), "Design");
  passed.push("native dropdown selects an observed option");

  await b.evaluate(
    "document.querySelector('#query').addEventListener('input',()=>setTimeout(()=>{document.querySelector('#suggestions').innerHTML='<div role=option>Generated</div>'},60))",
  );
  page = await observe();
  const field = find(page, (a) => a.kind === "fill");
  await b.act(field, page, "Generated");
  page = await observe();
  assert.equal(await b.evaluate("document.querySelector('#query').value"), "Generated");
  assert(page.actions.some((a) => a.role === "option"));
  passed.push("real text input waits for asynchronous combobox suggestions");

  // Typing replaces what the field held (select-all must reach a Linux browser as Ctrl+A).
  page = await observe();
  await b.act(find(page, (a) => a.kind === "fill"), page, "Replaced");
  assert.equal(await b.evaluate("document.querySelector('#query').value"), "Replaced");
  passed.push("typing replaces the previous field value");

  await b.call("Page.navigate", { url: "about:blank" });
  assert(!(await b.fresh(page, field)));
  passed.push("navigation invalidates the old document");

  console.log(passed.join("\n"));
  console.log(`PASS: ${passed.length} browser guard checks; no model calls`);
} finally {
  browser?.close();
  await session.stop();
}
