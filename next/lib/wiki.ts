import { setTimeout as delay } from "node:timers/promises";
import { Browser } from "./browser";
import { MAX_LINKS, type WikiPage, type WikiLink } from "./race-types";

// Article titles may contain colons; exclude namespaces, not every colon.
const NAMESPACE = /^(?:media|special|talk|user|user talk|wikipedia|wikipedia talk|wp|wt|file|file talk|image|image talk|mediawiki|mediawiki talk|template|template talk|help|help talk|category|category talk|portal|portal talk|draft|draft talk|timedtext|timedtext talk|module|module talk|gadget|gadget talk|gadget definition|gadget definition talk|topic):/i;

export function articleUrl(input: unknown): string {
  if (typeof input !== "string" || !input.trim() || input.length > 500) throw new Error("Enter an English Wikipedia article title or URL.");
  let title = input.trim();
  if (/^https?:/i.test(title)) {
    const url = new URL(title);
    if (url.protocol !== "https:" || url.hostname !== "en.wikipedia.org" || url.port || url.username || url.password || !url.pathname.startsWith("/wiki/")) {
      throw new Error("Use an https://en.wikipedia.org/wiki/ article URL.");
    }
    title = decodeURIComponent(url.pathname.slice(6));
  }
  title = title.replace(/_/g, " ").trim().normalize("NFC");
  if (!title || title.length > 250 || NAMESPACE.test(title) || /[<>\[\]{}|#\u0000-\u001f]/.test(title) || title === "." || title === ".." || title === "Main Page") {
    throw new Error("Choose a regular Wikipedia article, not a special page or namespace.");
  }
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

// The entire rendered article is available to both contestants. No search, sidebar,
// external links, hidden links, or target-aware filtering. First 250 unique links in DOM order.
export const READ_WIKI = `(() => {
  if (location.hostname !== 'en.wikipedia.org' || !location.pathname.startsWith('/wiki/')) return null;
  const root = document.querySelector('#mw-content-text .mw-parser-output');
  const heading = document.querySelector('#firstHeading');
  const config = window.mw?.config;
  if (!root || !heading || root.querySelector('.noarticletext') ||
      (config && (config.get('wgNamespaceNumber') !== 0 || config.get('wgArticleId') === 0))) return null;
  const canonical = document.querySelector('link[rel="canonical"]')?.href || location.href;
  const own = new URL(canonical); own.hash = ''; own.search = '';
  const links = [], seen = new Set(), nodes = new Map();
  const excluded = ${NAMESPACE.toString()};
  for (const a of root.querySelectorAll('a[href]')) {
    const u = new URL(a.href, location.href);
    if (u.origin !== 'https://en.wikipedia.org' || !u.pathname.startsWith('/wiki/') || u.search ||
        a.classList.contains('new') || a.closest('.sidebar, .navbox, .reflist, .mw-editsection, .metadata') ||
        !a.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) ||
        ![...a.getClientRects()].some(r => r.width > 0 && r.height > 0)) continue;
    let title;
    try { title = decodeURIComponent(u.pathname.slice(6)).replaceAll('_', ' '); } catch { continue; }
    u.hash = '';
    if (!title || excluded.test(title) || title === 'Main Page' || u.href === own.href || seen.has(u.href)) continue;
    seen.add(u.href);
    if (links.length >= ${MAX_LINKS}) continue;
    const id = String(links.length + 1);
    links.push({id, title, url: u.href}); nodes.set(id, a);
  }
  window.__wikiRace = {url: location.href, nodes};
  return {title: heading.textContent.trim(), url: own.href, text: root.innerText.slice(0, 6000), links, total_links: seen.size};
})()`;

export async function readWiki(browser: Browser, signal: AbortSignal, previous?: string): Promise<WikiPage> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const ready = await browser.evaluate("document.readyState === 'complete'").catch(() => false);
    if (ready) {
      const page = await browser.evaluate(READ_WIKI).catch(() => null) as WikiPage | null;
      if (page && (!previous || page.url !== previous)) return page;
    }
    await delay(100, undefined, { signal });
  }
  throw new Error(previous ? "The selected link did not reach a new article." : "Wikipedia did not load a valid article. Check the title and try again.");
}

export async function clickWiki(browser: Browser, link: WikiLink, signal: AbortSignal) {
  signal.throwIfAborted();
  const point = await browser.evaluate(`(() => {
    const state = window.__wikiRace, a = state?.nodes.get(${JSON.stringify(link.id)});
    if (state?.url !== location.href || !a?.isConnected ||
        !a.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})) return null;
    const url = new URL(a.href); url.hash = '';
    if (url.href !== ${JSON.stringify(link.url)}) return null;
    a.scrollIntoView({block: 'center', behavior: 'instant'});
    const r = a.getClientRects()[0];
    if (!r) return null;
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    if (!a.contains(document.elementFromPoint(x, y))) return null;
    a.removeAttribute('target');
    return {x, y};
  })()`);
  if (!point) throw new Error("The chosen link changed or is covered. Race stopped without clicking.");
  signal.throwIfAborted();
  await browser.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
  await browser.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
}
