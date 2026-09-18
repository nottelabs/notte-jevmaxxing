// jev-ultrafast's browser (observe / fresh / act and its guards), ported from jev_ultrafast/browser.py,
// on a Notte session. The page scripts are jev's. What differs is the order of travel: commands that
// do not depend on each other share a round trip.
import { createHash } from "node:crypto";
import { Connection } from "./cdp";
import { READ_STATE } from "./snapshot";

export class StalePage extends Error {}

export type Action = {
  id: string;
  kind: "click" | "fill" | "select" | "scroll" | "wait";
  label: string;
  node?: number;
  value?: string;
  delta?: number;
  [key: string]: unknown;
};

export type Page = {
  url: string;
  title: string;
  text: string;
  w: number;
  h: number;
  actions: Action[];
  marker: unknown;
  page_key: unknown;
  guards: Record<string, unknown>;
  fingerprint: string;
  screenshot?: string;
  [key: string]: unknown;
};

export const VIEWPORT = { viewport_width: 1120, viewport_height: 780 };

const MARKER = `(() => { const state=${READ_STATE}; return state?.marker ?? null; })()`;

// Resolves true once the requested page has loaded; the tab's initial about:blank answers false and is asked again.
const LOADED = `new Promise(r => location.href === 'about:blank' ? setTimeout(() => r(false), 50)
  : document.readyState === 'complete' ? r(true) : addEventListener('load', () => r(true)))`;

// After typing into a combobox, wait for visible suggestions (200 ms cap); otherwise two frames or 50 ms.
const settle = (action: Action) => `(action => new Promise(resolve => {
  const field=window.__jevFast?.nodes.get(action.node);
  const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
  let frames=0, stopped=false;
  const finish=()=>{stopped=true;resolve()};
  setTimeout(finish,autocomplete ? 200 : 50);
  const ready=()=>{
    if (stopped) return;
    const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'')
      .split(/\\s+/).filter(Boolean);
    const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
    const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
    if (++frames>=2 && (!autocomplete || options.some(e=>{
      const r=e.getBoundingClientRect();
      return r.width && r.height && r.bottom>0 && r.top<innerHeight &&
        e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    }))) finish();
    else requestAnimationFrame(ready);
  };
  requestAnimationFrame(ready);
}))(${JSON.stringify(action)})`;

// Code-owned node IDs refer to actual observed elements, never model-generated selectors.
const target = (action: Action) => `(action => {
  const e=window.__jevFast?.nodes.get(action.node);
  if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
      !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
  if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
  const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
  if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return null;
  if (!e.contains(document.elementFromPoint(x,y))) return null;
  if (action.kind==='select') {
    if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value &&
        !o.disabled && !o.closest('optgroup[disabled]'))) return null;
    e.value=action.value;
    e.dispatchEvent(new Event('input',{bubbles:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
  }
  return {x,y};
})(${JSON.stringify(action)})`;

const guard = (node: number) =>
  `(() => { const c=window.__jevFast; return c ? [c.pageKey(),c.guard(c.nodes.get(${node}))] : null; })()`;

// Markers and guards are arrays: compare them by value, as jev's Python does.
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function fingerprint(state: Record<string, unknown>) {
  const content = Object.fromEntries(["url", "text", "actions", "scroll"].map((k) => [k, state[k]]));
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export class Browser {
  private afterInput: Action | null = null;

  private constructor(
    private cdp: Connection,
    private session: string,
  ) {}

  static async connect(cdpUrl: string) {
    const cdp = await Connection.open(cdpUrl);
    // Drive the session's own tab: it is the one the Notte live viewer streams.
    const pages = (await cdp.send("Target.getTargets")).targetInfos.filter((t: any) => t.type === "page");
    const targetId = pages[0]?.targetId ?? (await cdp.send("Target.createTarget", { url: "about:blank" })).targetId;
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    return new Browser(cdp, sessionId);
  }

  call(method: string, params: object = {}) {
    return this.cdp.send(method, params, this.session);
  }

  /** Runtime.evaluate by value; undefined when the document went away underneath it. */
  async evaluate(expression: string, awaitPromise = false) {
    const reply = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    return reply.exceptionDetails ? undefined : reply.result?.value;
  }

  async open(url: string) {
    // The viewport is already set by the Notte session; these ride along with the navigation.
    const sent = [
      this.call("Emulation.setDeviceMetricsOverride", { width: 1120, height: 780, deviceScaleFactor: 1, mobile: false }),
      this.call("Emulation.setFocusEmulationEnabled", { enabled: true }),
      this.call("Page.navigate", { url }),
    ];
    await Promise.all(sent);
    const deadline = Date.now() + 15_000;
    while (url !== "about:blank" && Date.now() < deadline) {
      // One awaited call instead of polling; a navigation underneath it just asks again.
      if ((await this.evaluate(LOADED, true).catch(() => undefined)) === true) break;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** The element table. The screenshot is only looked at by people, so it is a promise collected later. */
  async observe(screenshot = true): Promise<{ page: Page; shot: Promise<string | undefined> }> {
    let info: any;
    if (this.afterInput) {
      // jev waits for the page to settle, then reads it: two round trips. Chained in the page, it is one.
      const action = this.afterInput;
      this.afterInput = null;
      info = await this.evaluate(`(${settle(action)}).then(() => ${READ_STATE})`, true).catch(() => undefined);
    }
    for (let attempt = 0; info == null && attempt < 10; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 20));
      info = await this.evaluate(READ_STATE).catch(() => undefined);
    }
    if (info == null) throw new StalePage("Page did not settle");
    if (info.url.startsWith("data:")) info.url = info.url.split(",")[0];
    info.fingerprint = fingerprint(info);
    const shot = screenshot
      ? this.call("Page.captureScreenshot", { format: "jpeg", quality: 72 }).then(
          (r) => r.data as string,
          () => undefined,
        )
      : Promise.resolve(undefined);
    return { page: info as Page, shot };
  }

  /** Is the page still the one that was observed? For a click or select, only what that target depends on. */
  async fresh(page: Page, action?: Action) {
    if (action && (action.kind === "click" || action.kind === "select")) {
      if (!Number.isInteger(action.node)) return false;
      const current = await this.evaluate(guard(action.node!));
      return same(current, [page.page_key, page.guards[String(action.node)]]);
    }
    return same(await this.evaluate(MARKER), page.marker);
  }

  /** Never retried. Resolves only once Chrome has accepted every input event. */
  async act(action: Action, page: Page, text?: string) {
    const stale = () => new StalePage("Page changed since this decision. Observe again.");
    let point: { x: number; y: number } | null | undefined;
    if (action.kind === "click" || action.kind === "fill") {
      if (!Number.isInteger(action.node)) throw new Error("Invalid observed node");
      // Their target lookup only reads the page, so it travels with the freshness check.
      const [fresh, found] = await Promise.all([this.fresh(page, action), this.evaluate(target(action))]);
      if (!fresh) throw stale();
      point = found;
    } else {
      if (!(await this.fresh(page, action))) throw stale();
      if (action.kind === "select") {
        if (!Number.isInteger(action.node)) throw new Error("Invalid observed node");
        point = await this.evaluate(target(action)); // selects inside the page
        if (point == null) throw new Error("Dropdown execution was not confirmed; inspect before retrying.");
      }
    }
    if (action.kind === "wait") await new Promise((r) => setTimeout(r, 100));
    else if (action.kind === "scroll") {
      await this.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: 550, y: 650, deltaX: 0, deltaY: action.delta });
    } else if (action.kind !== "select") {
      if (point == null) throw new StalePage("Target changed or is covered. Observe again.");
      const mouse = { x: point.x, y: point.y, button: "left", clickCount: 1 };
      const inputs = [
        this.call("Input.dispatchMouseEvent", { type: "mousePressed", ...mouse }),
        this.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...mouse }),
      ];
      if (action.kind === "fill") {
        // The Notte browser runs on Linux: select-all is Ctrl+A whatever this server runs on.
        const key = { key: "a", code: "KeyA", modifiers: 2 };
        inputs.push(
          this.call("Input.dispatchKeyEvent", { type: "keyDown", ...key, commands: ["selectAll"] }),
          this.call("Input.dispatchKeyEvent", { type: "keyUp", ...key }),
          this.call("Input.insertText", { text }),
        );
      }
      await Promise.all(inputs); // sent back to back; Chrome runs a session's commands in order
    }
    this.afterInput = action.kind === "wait" ? null : action;
  }

  close() {
    this.cdp.close();
  }
}
