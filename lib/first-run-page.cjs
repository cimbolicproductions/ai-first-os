"use strict";

/**
 * Three windows, once. One idea each. Everything is already filled in, so a person
 * can press Enter three times and be ready for a first task.
 */
function buildIntroHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI-first OS</title>
<link rel="icon" href="/brand/logo.png">
<style>
  :root { --bg:#0b0b0d; --text:#f5f5f7; --muted:#98989f; --line:#2c2c2e; --hover:#1c1c1e; --go:#34c759; }
  @media (prefers-color-scheme: light) { :root { --bg:#fbfbfd; --text:#1d1d1f; --muted:#6e6e73; --line:#d2d2d7; --hover:#f0f0f3; } }
  * { box-sizing:border-box; margin:0; padding:0; }
  [hidden] { display:none !important; }
  html, body { height:100%; }
  body { background:var(--bg); color:var(--text); font:17px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif; -webkit-font-smoothing:antialiased; }
  .window { min-height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:48px 24px; animation:rise .5s cubic-bezier(.2,.7,.2,1); }
  @keyframes rise { from { opacity:0; transform:translateY(10px); } }
  @media (prefers-reduced-motion: reduce) { .window { animation:none !important; } }
  .column { width:100%; max-width:480px; }
  h1 { font-size:clamp(34px,6vw,52px); font-weight:600; letter-spacing:-.022em; text-align:center; }
  h2 { font-size:clamp(24px,4vw,30px); font-weight:600; letter-spacing:-.016em; line-height:1.2; text-align:center; margin-bottom:36px; }
  .mark { display:block; width:112px; height:112px; margin:0 auto 28px; border-radius:26px; }
  .spin { display:block; width:56px; height:56px; margin:0 auto; border-radius:14px; }
  .list { border-top:1px solid var(--line); }
  .row { display:flex; align-items:center; justify-content:space-between; gap:16px; width:100%; min-height:58px; padding:12px 10px; background:none; border:0; border-bottom:1px solid var(--line); color:inherit; font:inherit; text-align:left; }
  button.row { cursor:pointer; }
  button.row:hover:not(:disabled) { background:var(--hover); }
  button.row:disabled { color:var(--muted); cursor:default; }
  .row:focus-visible, select:focus-visible, .go:focus-visible, .link:focus-visible, .sign:focus-visible { outline:2px solid var(--text); outline-offset:2px; }
  .detail { color:var(--muted); font-size:15px; display:flex; align-items:center; gap:10px; white-space:nowrap; }
  .check { width:20px; text-align:center; font-weight:600; visibility:hidden; }
  .row[aria-checked="true"] .check { visibility:visible; }
  .dot { width:7px; height:7px; border-radius:50%; background:var(--muted); }
  .dot.on { background:var(--go); }
  .sign { font:inherit; font-size:15px; font-weight:600; color:var(--bg); background:var(--text); border:0; border-radius:8px; padding:6px 12px; cursor:pointer; }
  .picks { margin-top:28px; display:grid; gap:14px; }
  label { display:flex; align-items:center; justify-content:space-between; gap:16px; }
  select { font:inherit; color:inherit; background:var(--hover); border:1px solid var(--line); border-radius:8px; padding:7px 10px; max-width:60%; }
  .foot { text-align:center; margin-top:40px; }
  .go { font:inherit; font-weight:600; color:var(--bg); background:var(--text); border:0; border-radius:980px; padding:12px 34px; cursor:pointer; }
  .go:disabled { opacity:.45; cursor:default; }
  .hint { color:var(--muted); font-size:14px; text-align:center; margin-top:18px; min-height:20px; }
  .link { background:none; border:0; color:var(--muted); font:inherit; font-size:14px; cursor:pointer; text-decoration:underline; text-underline-offset:3px; }
  #more { margin-top:18px; display:grid; gap:14px; }
  .moreToggle { text-align:center; margin-top:22px; }
</style>
</head>
<body>
<main class="window" id="w1">
  <picture>
    <source srcset="/brand/logo.png" media="(prefers-reduced-motion: reduce)">
    <img class="mark" src="/brand/loading.gif" alt="">
  </picture>
  <h1>Welcome to AI-first OS</h1>
  <div class="foot"><button class="go" id="next1" autofocus>Continue</button></div>
</main>

<main class="window" id="w2" hidden>
  <div class="column">
    <h2>Which one do you want to orchestrate all other agents?</h2>
    <div class="list" id="orchestrators" role="radiogroup" aria-label="Orchestrator"></div>
    <div class="foot"><button class="go" id="next2">Continue</button></div>
    <p class="hint">You can change this any time.</p>
  </div>
</main>

<main class="window" id="w3" hidden>
  <div class="column">
    <h2>Sign in to the rest.</h2>
    <div class="list" id="agents"></div>
    <div class="picks">
      <label>Your best coding agent <select id="coder"></select></label>
      <label>Model <select id="model"></select></label>
    </div>
    <div class="moreToggle"><button class="link" id="moreBtn" aria-expanded="false">Where your notes live</button></div>
    <div id="more" hidden>
      <label id="obsidianRow" hidden>Keep notes in Obsidian <input type="checkbox" id="obsidian"></label>
      <label>Skills folder <select id="skills"></select></label>
    </div>
    <div class="foot"><button class="go" id="finish">Start</button><img class="spin" id="finishSpin" src="/brand/loading.gif" alt="" hidden></div>
    <p class="hint" id="hint3" role="status"></p>
  </div>
</main>

<script>
(() => {
  const $ = id => document.getElementById(id);
  let model = null, orchestrator = null, coderTouched = false, step = 1, signingIn = false;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function show(n) {
    step = n;
    [1,2,3].forEach(i => { $("w" + i).hidden = i !== n; });
    const first = n === 2 ? $("orchestrators").querySelector('[aria-checked="true"]') : n === 3 ? $("finish") : $("next1");
    if (first) first.focus();
  }

  function renderOrchestrators() {
    const box = $("orchestrators");
    box.replaceChildren();
    model.orchestrators.forEach(o => {
      const b = el("button", "row");
      b.type = "button";
      b.disabled = !o.pickable;
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(o.id === orchestrator));
      b.append(el("span", "", o.label));
      const right = el("span", "detail", o.suggested ? "Suggested" : o.detail);
      right.append(el("span", "check", "✓"));
      b.append(right);
      b.onclick = () => { orchestrator = o.id; renderOrchestrators(); box.querySelector('[aria-checked="true"]').focus(); };
      box.append(b);
    });
  }

  function renderAgents() {
    const box = $("agents");
    box.replaceChildren();
    model.agents.filter(a => a.id !== orchestrator).forEach(a => {
      const row = el("div", "row");
      row.append(el("span", "", a.label));
      const right = el("span", "detail");
      if (a.canSignIn) {
        const b = el("button", "sign", "Sign in");
        b.onclick = async () => {
          b.disabled = true;
          b.textContent = "Waiting…";
          signingIn = true;
          await fetch("/api/intro/signin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: a.id }) });
        };
        right.append(b);
      } else {
        const dot = el("span", "dot" + (a.state === "signed-in" ? " on" : ""));
        right.append(dot, document.createTextNode(a.stateText));
      }
      row.append(right);
      box.append(row);
    });
    if (!model.agents.length) box.append(el("div", "row", "No agents found yet."));
  }

  function fill(select, items, value) {
    select.replaceChildren(...items.map(i => { const o = el("option", "", i.label); o.value = i.id ?? ""; return o; }));
    if (value !== undefined && [...select.options].some(o => o.value === (value ?? ""))) select.value = value ?? "";
  }

  function renderPicks() {
    const coder = $("coder");
    const previous = coder.value;
    const items = model.coders.length ? model.coders : [{ id: model.suggestedCoder, label: "Decide later" }];
    fill(coder, items, coderTouched ? previous : model.suggestedCoder);
    renderModels();
  }

  function renderModels() {
    const found = model.coders.find(c => c.id === $("coder").value);
    const models = found ? found.models : [{ id: null, label: "Recommended" }];
    const select = $("model");
    const before = select.value;
    fill(select, models, before);
    select.closest("label").hidden = models.length < 2;
  }

  async function load() {
    const res = await fetch("/api/intro/state");
    model = await res.json();
    if (!orchestrator) orchestrator = model.suggestedOrchestrator;
    renderOrchestrators();
    renderAgents();
    renderPicks();
    $("obsidianRow").hidden = !model.obsidian;
    if ($("skills").options.length !== model.skills.length) fill($("skills"), model.skills);
  }

  $("next1").onclick = async () => {
    $("next1").disabled = true;
    await firstLoad;
    show(2);
  };
  $("next2").onclick = () => { renderAgents(); show(3); };
  $("coder").onchange = () => { coderTouched = true; renderModels(); };
  $("moreBtn").onclick = e => {
    const open = $("more").hidden;
    $("more").hidden = !open;
    e.target.setAttribute("aria-expanded", String(open));
  };
  window.addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target.tagName !== "SELECT") {
      if (step === 2 && e.target.getAttribute("role") !== "radio") $("next2").click();
    }
    if (step === 2 && ["ArrowDown","ArrowUp"].includes(e.key)) {
      e.preventDefault();
      const options = model.orchestrators.filter(o => o.pickable);
      const at = options.findIndex(o => o.id === orchestrator);
      orchestrator = options[(at + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length].id;
      renderOrchestrators();
      $("orchestrators").querySelector('[aria-checked="true"]').focus();
    }
  });

  $("finish").onclick = async () => {
    $("finish").hidden = true;
    $("finishSpin").hidden = false;
    $("hint3").textContent = "Setting up…";
    try {
      const res = await fetch("/api/intro/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orchestrator,
          coder: model.coders.length ? $("coder").value : null,
          model: $("model").value || null,
          obsidian: $("obsidian").checked,
          skills: $("skills").value,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      location.replace("/");
    } catch {
      $("finish").hidden = false;
      $("finishSpin").hidden = true;
      $("hint3").textContent = "That did not work. Try again.";
    }
  };

  const firstLoad = load();
  setInterval(() => { if (step === 3 && signingIn) load(); }, 5000);
})();
</script>
</body>
</html>`;
}

module.exports = { buildIntroHtml };
