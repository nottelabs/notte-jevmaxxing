// Task → Start runs choose/execute in a loop on the Notte browser; each step shows the ranked action space.
const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="demo-token"]').content;
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pct = (p) => `${(p * 100).toFixed(p < 0.01 ? 1 : 0)}%`;
let state = null, running = false, started = 0, tick = null;
// jev only clicks and types, so it needs a start page: the first URL in the prompt, else Google.
const startUrl = (task) => task.match(/https?:\/\/[^\s"'<>]+/)?.[0].replace(/[.,;:!?)]+$/, "") || "https://www.google.com";

async function call(name, body = {}) {
  const r = await fetch(`/api/${name}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Demo-Token": token }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw Error(data.error || "Request failed");
  state = data;
  if (name === "predict" && data.decision) frames.push(data);
  render();
}

function draw(s) {
  const page = s?.page;
  if (!page) return;
  const d = s.decision || (s.status === "done" ? s.decisions?.at(-1) : null);
  const picked = d?.target?.split(":")[0];
  $("empty").hidden = true;
  $("shot").hidden = false;
  $("shot").src = `data:image/jpeg;base64,${page.screenshot}`;
  $("page-url").textContent = page.url;
  $("op").textContent = d ? `→ ${d.operation} ${pct(d.operation_probabilities?.[d.operation] ?? 0)}` : `${s.elements.length} elements`;

  const seen = new Map();
  for (const a of page.actions) if (a.rect && !seen.has(a.node)) seen.set(a.node, a);
  $("targets").innerHTML = [...seen.values()].map((a, i) =>
    `<div class="t ${String(i + 1) === picked ? "on" : ""}" style="left:${100 * a.rect.x / page.w}%;top:${100 * a.rect.y / page.h}%;width:${100 * a.rect.w / page.w}%;height:${100 * a.rect.h / page.h}%"><span>${i + 1}</span></div>`).join("");

  const p = (e) => d?.target_probabilities?.[e.index] ?? Math.max(-1, ...(e.options || []).map((o) => d?.target_probabilities?.[o.index] ?? -1));
  const els = [...s.elements];
  if (d) els.sort((a, b) => p(b) - p(a));
  $("actions").innerHTML = els.map((e) => {
    const v = p(e);
    return `<div class="a ${e.index === picked ? "on" : ""}"><span class="i">${esc(e.index)}</span><span class="l">${esc(e.label)}<small>${esc(e.role)} · ${esc(e.operations.join(" / "))}</small>${v >= 0 ? `<i style="--p:${v * 100}%"></i>` : ""}</span><span class="p">${v >= 0 ? pct(v) : ""}</span></div>`;
  }).join("");
  if (picked) document.querySelector(".a.on")?.scrollIntoView({ block: "nearest" });
}

// Replay: one frame per Jev decision, kept in memory only; a new Start or Clear drops it.
let frames = [], view = null; // view = frame index, or null to follow the live run

function render() {
  const f = view == null ? state : frames[view];
  draw(f);
  const n = frames.length, at = view == null ? n : view + 1;
  $("replay").hidden = n === 0;
  $("step").textContent = `step ${at} / ${n}`;
  $("prev").disabled = at <= 1;
  $("next").disabled = view == null || at >= n;
  if (!state?.history) return;
  $("trace").innerHTML = state.history.length
    ? state.history.map((h) => `<div class="r"><span class="n">${String(h.step).padStart(2, "0")}</span><span>${esc(h.action)}${h.text ? ` <b>“${esc(h.text)}”</b>` : ""}</span><span class="m">${h.latency_ms} ms · ${pct(h.probability)}</span></div>`).join("")
    : '<p class="m">No actions yet.</p>';
}

function setRunning(on, status) {
  running = on;
  $("start").textContent = on ? "Stop ■" : "Start ↗";
  $("goal").disabled = on;
  $("clear").hidden = on || !state?.page;
  if (status) $("status").textContent = status;
  // Wall-clock timer from the Start click, including opening the Notte browser; frozen when the run ends.
  clearInterval(tick);
  if (on) {
    started = performance.now();
    $("timer").hidden = false;
    tick = setInterval(() => ($("timer").textContent = `${((performance.now() - started) / 1000).toFixed(1)}s`), 100);
  }
  $("timer").classList.toggle("done", !on);
}

// Live view already shows the latest decision, so ← from live goes to the one before it.
$("prev").addEventListener("click", () => { view = Math.max(0, (view ?? frames.length - 1) - 1); render(); });
$("next").addEventListener("click", () => { view = view + 1 >= frames.length - 1 ? null : view + 1; render(); });

$("clear").addEventListener("click", () => {
  state = null;
  frames = []; view = null; $("replay").hidden = true;
  $("shot").hidden = true;
  $("shot").removeAttribute("src");
  $("empty").hidden = false;
  $("targets").innerHTML = $("actions").innerHTML = $("op").textContent = "";
  $("trace").innerHTML = "";
  $("page-url").textContent = "";
  $("status").textContent = "ready";
  $("timer").hidden = $("clear").hidden = true;
});

$("task").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (running) { running = false; $("status").textContent = "stopping after this step…"; return; }
  frames = []; view = null; $("replay").hidden = true;
  setRunning(true, "opening a tab in the Notte browser…");
  try {
    await call("reset", { scenario: startUrl($("goal").value), goal: $("goal").value });
    for (let i = 0; running && i < state.max_steps * 2; i++) {
      $("status").textContent = "choosing…";
      await call("predict");
      if (!running || ["done", "blocked"].includes(state.status)) break;
      $("status").textContent = "executing…";
      await call("act", { fingerprint: state.page.fingerprint });
      if (["done", "blocked"].includes(state.status)) break;
    }
    setRunning(false, state?.status === "done" ? "done" : state?.status === "blocked" ? "blocked: no supported next action" : "stopped");
  } catch (error) {
    setRunning(false, `error: ${error.message}`);
  }
});
