"use strict";
/* The Assistant: a Claude agent that designs FMUs using the same tools as the Studio buttons.
   It calls the Anthropic API straight from the browser with the visitor's own API key. */

const AGENT = {
  api: "https://api.anthropic.com/v1/messages",
  models: [
    ["claude-sonnet-5-5", "Sonnet 5.5 (recommended)"],
    ["claude-opus-5-5", "Opus 5.5 (most capable)"],
    ["claude-haiku-5-5", "Haiku 5.5 (cheapest)"],
  ],
  maxRounds: 30,          // tool-use rounds per request
  maxTokens: 16000,
  keyStore: "pythonfmu3.anthropicKey",
  modelStore: "pythonfmu3.agentModel",
};

const A = { key: "", messages: [], running: false, abort: null };

const store = {
  get(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};

const SYSTEM_PROMPT = `You are the assistant inside PythonFMU3 Studio, a browser app for building FMI 3.0 FMUs (Functional Mock-up Units) from Python with the PythonFMU3 library. You help the user design, write, fix and test models. Python runs in the user's browser (Pyodide, Python 3.13, NumPy available; no other third-party packages).

Work like an engineer: understand the physics or logic, choose sensible variables, units and parameter values, write the model, then check and test it with your tools. A model is not done until run_checks reports no errors and a simulation gives plausible results. If something fails, read the error, fix the code and try again. Prefer small, clear models with good descriptions.

## Tools
- write_file saves a .py file in the user's workspace and opens it in their editor; it returns the checks. Use a new descriptive snake_case file name for a new model. Only overwrite an existing file when the user asked you to change it; read it first.
- run_checks loads the model and returns its variables and problems.
- simulate runs the model with the Python preview simulator and returns a summary per variable (initial, final, min, max and samples). Use it to sanity-check behaviour, e.g. a step response settles, energy decays, values stay in range.
- build_fmu packages the model as an .fmu. Build when the user wants the FMU, or at the end of a new design.
- list_templates and read_template give working example models. Read one that is close to what you need before writing an unfamiliar kind of model (e.g. thermostat for Boolean outputs, signal_generator for Int32 parameters, surrogate for NumPy, bouncing_ball for events).

## PythonFMU3 essentials
\`\`\`python
from pythonfmu3 import Fmi3Slave, Fmi3Causality, Fmi3Variability, Fmi3Initial, Float64, Int32, Boolean, String, Unit

class Tank(Fmi3Slave):              # Co-Simulation
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.author = "..."         # metadata must be set in __init__, not as class attributes
        self.description = "..."
        # 1. create every attribute first ...
        self.time = 0.0
        self.q_in = 0.0
        self.area = 2.0
        self.level = 1.0
        # 2. ... then register it (the variable name is the attribute name)
        self.register_units([Unit(name="m", m=1), Unit(name="m3/s", m=3, s=-1), Unit(name="m2", m=2)])
        self.register_variable(Float64("time", causality=Fmi3Causality.independent, variability=Fmi3Variability.continuous))
        self.register_variable(Float64("q_in", causality=Fmi3Causality.input, start=0.0, unit="m3/s"))
        self.register_variable(Float64("area", causality=Fmi3Causality.parameter, variability=Fmi3Variability.tunable, start=2.0, unit="m2"))
        self.register_variable(Float64("level", causality=Fmi3Causality.output, unit="m"))

    def do_step(self, current_time, step_size):
        self.level += self.q_in / self.area * step_size
        self.time = current_time + step_size
        return True                 # False stops the simulation
\`\`\`
Rules the checks enforce:
- Always register a Float64 "time" with causality=independent and variability=continuous, and keep self.time updated.
- Create the attribute before register_variable, otherwise inputs and parameters get no setter and importers can't set them.
- Only Float64 may be continuous. Int32, Int64, UInt64, Boolean and String variables need variability=discrete (or fixed/tunable for parameters).
- Parameters: causality=parameter with variability=fixed (set before the run) or tunable (can change during it). Give inputs and parameters a start value.
- Outputs are computed; give them initial values in __init__ that are consistent with the inputs.
- Don't start names with "_".
- Units: register Unit objects with SI base exponents (kg, m, s, A, K, mol, cd, rad), optional factor/offset (degC is Unit(name="degC", K=1, offset=273.15)), then pass unit="name".
- Exactly one model class per file.

Model Exchange (continuous states solved by the importer): inherit Fmi3SlaveBase and ModelExchange (add CoSimulation too to support both). For each state register the state (e.g. "x", output or local, continuous, initial=Fmi3Initial.exact, start=...) and its derivative ("derx", local, continuous, derivative=<value reference of x>). Value references are assigned 0, 1, 2 ... in registration order, so with time first, x is 1. Implement get_continuous_state_derivatives() returning the derivatives in the same order the states were registered. For events, pass has_event_indicator=True when registering a variable, implement get_event_indicators() and update_discrete_states() returning Fmi3UpdateDiscreteStatesResult (see the bouncing_ball template). Co-Simulation models are simpler: integrate inside do_step (use sub-steps or RK4 for stiff or fast dynamics).

## Replying
Keep replies short: what you built or changed, key assumptions (units, parameter values), and the test result. Don't paste the whole file in the chat; it is already in the editor. Use plain text with short lists; code only for small snippets.`;

const TOOLS = [
  { name: "list_files", description: "List the .py models and built .fmu files in the user's workspace.",
    input_schema: { type: "object", properties: {} } },
  { name: "read_file", description: "Read a .py file from the workspace.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "Create or overwrite a .py model file, open it in the editor and return the checks (variables and problems).",
    input_schema: { type: "object", properties: {
      path: { type: "string", description: "Workspace-relative file name ending in .py, e.g. heat_exchanger.py" },
      content: { type: "string", description: "The complete file content" } }, required: ["path", "content"] } },
  { name: "run_checks", description: "Load a model and return its interfaces, variables and any problems.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "simulate", description: "Simulate a model with the Python preview simulator and return a per-variable summary. Also shows the plot in the Simulate tab.",
    input_schema: { type: "object", properties: {
      path: { type: "string" },
      stop_time: { type: "number", description: "Default 10" },
      step_size: { type: "number", description: "Output interval, default stop_time/500" },
      interface: { type: "string", enum: ["cs", "me"], description: "Only for models with both interfaces" },
      start_values: { type: "object", description: "Values for parameters and inputs, e.g. {\"q_in\": 0.1}", additionalProperties: true } },
      required: ["path"] } },
  { name: "build_fmu", description: "Build the model into an .fmu file in the workspace's build/ folder.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "list_templates", description: "List the example models that come with the Studio.",
    input_schema: { type: "object", properties: {} } },
  { name: "read_template", description: "Read the source of an example model.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
];
TOOLS[TOOLS.length - 1].cache_control = { type: "ephemeral" };

/* ---------- tools ---------- */

const trim = (text, n) => (text && text.length > n ? "…" + text.slice(-n) : text);

function failure(r) {
  return { ok: false, error: r.error, traceback: trim(r.traceback, 3000), stdout: trim(r.stdout, 1000) || undefined };
}

function summarizeAnalysis(a) {
  return {
    ok: true,
    className: a.className,
    interfaces: a.interfaces,
    eventIndicators: a.eventIndicators,
    variables: a.variables.map((v) => [v.vr, v.name, v.type, v.causality, v.variability,
      v.start !== null && v.start !== undefined ? `start=${JSON.stringify(v.start)}` : "", v.unit ? `unit=${v.unit}` : ""]
      .filter((x) => x !== "" && x !== null && x !== undefined).join(" ")),
    problems: a.checks.filter((c) => c.level !== "ok").map((c) => `${c.level}: ${c.title}: ${c.detail}`),
  };
}

function summarizeSimulation(res, stdout) {
  const t = res.time, n = t.length;
  const idx = [...new Set(Array.from({ length: 11 }, (_, i) => Math.round((i * (n - 1)) / 10)))];
  const variables = {};
  for (const [name, ys] of Object.entries(res.series).slice(0, 24)) {
    const nums = ys.filter((y) => typeof y === "number" && Number.isFinite(y));
    if (!nums.length) { variables[name] = { note: "not numeric or not finite", final: ys[ys.length - 1] }; continue; }
    variables[name] = {
      initial: ys[0], final: ys[ys.length - 1],
      min: Math.min(...nums), max: Math.max(...nums),
      samples: idx.map((i) => ys[i]),
      ...(nums.length < ys.length ? { nonFinite: ys.length - nums.length } : {}),
    };
  }
  return { ok: true, interface: res.interface, points: n, endTime: t[n - 1], sampleTimes: idx.map((i) => t[i]),
           events: res.events.length, firstEvents: res.events.slice(0, 5), variables,
           stdout: trim(stdout, 1000) || undefined };
}

async function refreshEditor(path) {
  if (S.path === path) {
    if (dirty()) return;      // the user is typing in it: leave their text alone
    const r = await rpc("read", { path });
    if (r.ok) { S.saved = r.result.content; $("#code").value = r.result.content; updateGutter(); updateDirty(); await analyze(); }
    await loadFiles(path);
  } else if (!dirty()) {
    await loadFiles(path);
  } else {
    await loadFiles();
  }
}

const toolImpl = {
  async list_files() {
    const r = await rpc("files");
    return r.ok ? { ok: true, files: r.result.map((f) => `${f.path} (${f.size} bytes)`) } : failure(r);
  },
  async read_file({ path }) {
    const r = await rpc("read", { path });
    return r.ok ? { ok: true, path: r.result.path, content: r.result.content } : failure(r);
  },
  async write_file({ path, content }) {
    if (!/\.py$/.test(path || "")) return { ok: false, error: "path must end in .py" };
    const w = await rpc("write", { path, content });
    if (!w.ok) return failure(w);
    await refreshEditor(w.result.path);
    const r = await rpc("analyze", { path: w.result.path });
    return r.ok ? { saved: w.result.path, ...summarizeAnalysis(r.result) } : { saved: w.result.path, ...failure(r) };
  },
  async run_checks({ path }) {
    const r = await rpc("analyze", { path });
    return r.ok ? summarizeAnalysis(r.result) : failure(r);
  },
  async simulate({ path, stop_time, step_size, interface: iface, start_values }) {
    const stopTime = Number(stop_time) > 0 ? Number(stop_time) : 10;
    const stepSize = Number(step_size) > 0 ? Number(step_size) : stopTime / 500;
    if (stopTime / stepSize > 200000) return { ok: false, error: "Too many output points: increase step_size" };
    const r = await rpc("simulate", { path, simulator: "python", interface: iface, stopTime, stepSize, startValues: start_values || {} });
    if (!r.ok) return failure(r);
    if (S.path !== path && !dirty()) await loadFiles(path);
    if (S.path === path) {
      S.sim.result = r.result; S.sim.stdout = r.stdout; S.sim.values = { ...(start_values || {}) };
      $("#sim-stop").value = stopTime; $("#sim-step").value = stepSize;
      renderResults();
    }
    return summarizeSimulation(r.result, r.stdout);
  },
  async build_fmu({ path }) {
    const r = await rpc("build", { path });
    if (!r.ok) return failure(r);
    await loadFiles();
    return { ok: true, fmu: r.result.fmu, size: r.result.size, platforms: r.result.platforms };
  },
  async list_templates() {
    const r = await rpc("templates");
    return r.ok ? { ok: true, templates: r.result.map((t) => `${t.id}: ${t.title} (${t.interface}) – ${t.description}`) } : failure(r);
  },
  async read_template({ id }) {
    const r = await rpc("template_source", { id });
    return r.ok ? { ok: true, ...r.result } : failure(r);
  },
};

function stepLabel(name, input) {
  const p = input && input.path ? input.path : "";
  return {
    list_files: "Listing files", read_file: `Reading ${p}`, write_file: `Writing ${p}`, run_checks: `Checking ${p}`,
    simulate: `Simulating ${p} for ${input && input.stop_time || 10} s`, build_fmu: `Building ${p}`,
    list_templates: "Looking at the templates", read_template: `Reading the ${input && input.id} template`,
  }[name] || name;
}

function stepOutcome(name, out) {
  if (!out.ok) return { kind: "bad", text: (out.error || "failed").split("\n")[0] };
  if (name === "write_file" || name === "run_checks") {
    const errors = out.problems.filter((p) => p.startsWith("error")).length;
    const warnings = out.problems.length - errors;
    if (errors) return { kind: "bad", text: `${errors} error${errors > 1 ? "s" : ""}${warnings ? `, ${warnings} warning${warnings > 1 ? "s" : ""}` : ""}` };
    return { kind: warnings ? "warn" : "ok", text: `${out.variables.length} variables${warnings ? `, ${warnings} warning${warnings > 1 ? "s" : ""}` : ", no problems"}` };
  }
  if (name === "simulate") return { kind: "ok", text: `${out.points} points${out.events ? `, ${out.events} events` : ""}` };
  if (name === "build_fmu") return { kind: "ok", text: `${out.fmu} · ${(out.size / 1e6).toFixed(2)} MB` };
  return { kind: "ok", text: "" };
}

/* ---------- the agent loop ---------- */

async function callClaude(signal) {
  let res;
  try {
    res = await fetch(AGENT.api, {
      method: "POST", signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": A.key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: $("#agent-model").value, max_tokens: AGENT.maxTokens,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: TOOLS, messages: A.messages,
      }),
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new Error("Couldn't reach the Anthropic API. Check your connection and try again.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body.error && body.error.message) || res.statusText;
    if (res.status === 401) { forgetKey(); throw new Error("The API key was rejected. Paste a valid key to continue."); }
    if (res.status === 429) throw new Error("Rate limited by the API: wait a moment and try again. " + msg);
    if (res.status === 529 || res.status >= 500) throw new Error("The API is busy or unavailable right now. Try again shortly.");
    throw new Error(msg);
  }
  return body;
}

function pushUser(blocks) {
  const last = A.messages[A.messages.length - 1];
  if (last && last.role === "user") last.content.push(...blocks);
  else A.messages.push({ role: "user", content: blocks });
}

async function send(text) {
  if (A.running || !text.trim()) return;
  if (!A.key) { showKeyForm(); return; }
  if (dirty()) await save();
  const before = A.messages.length;
  const blocks = [{ type: "text", text }];
  if (S.path) blocks.push({ type: "text", text: `(The editor has ${S.path} open.)` });
  pushUser(blocks);
  addBubble("user", text);
  setRunning(true);
  const thinking = addThinking();
  A.abort = new AbortController();
  try {
    for (let round = 0; round < AGENT.maxRounds; round++) {
      const reply = await callClaude(A.abort.signal);
      A.messages.push({ role: "assistant", content: reply.content });
      for (const b of reply.content) if (b.type === "text" && b.text.trim()) addBubble("assistant", b.text, thinking);
      const calls = reply.content.filter((b) => b.type === "tool_use");
      if (!calls.length) {
        if (reply.stop_reason === "max_tokens") addNote("The reply was cut off. Ask the assistant to continue.");
        return;
      }
      const results = [];
      for (const call of calls) {
        const step = addStep(stepLabel(call.name, call.input), thinking);
        let out;
        try {
          out = toolImpl[call.name] ? await toolImpl[call.name](call.input || {}) : { ok: false, error: `unknown tool ${call.name}` };
        } catch (err) {
          out = { ok: false, error: String(err && err.message || err) };
        }
        finishStep(step, stepOutcome(call.name, out), call, out);
        results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(out), ...(out.ok === false ? { is_error: true } : {}) });
      }
      pushUser(results);
      if (A.abort.signal.aborted) throw new DOMException("stopped", "AbortError");
    }
    addNote(`Stopped after ${AGENT.maxRounds} steps. Send another message to let it carry on.`);
  } catch (err) {
    if (err.name === "AbortError") addNote("Stopped.");
    else addNote(err.message, "bad");
    // Undo a request that never got an answer, so the conversation stays valid.
    if (A.messages.length === before + 1 && A.messages[before].role === "user" && before === A.messages.length - 1) {
      A.messages.length = before;
      if (!$("#agent-input").value) $("#agent-input").value = text;
    }
  } finally {
    thinking.remove();
    setRunning(false);
    A.abort = null;
  }
}

/* ---------- UI ---------- */

const log = () => $("#agent-log");

function scrollDown() { const l = log(); l.scrollTop = l.scrollHeight; }

function insert(node, before) {
  if (before && before.parentNode === log()) log().insertBefore(node, before); else log().append(node);
  $("#agent-empty").hidden = true;
  scrollDown();
  return node;
}

/* Minimal, safe formatting: ``` code blocks, `code`, **bold**, and "- " lists. Text only, no HTML. */
function inline(text) {
  const out = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[0][0] === "`" ? el("code", { text: m[0].slice(1, -1) }) : el("strong", { text: m[0].slice(2, -2) }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function formatText(text) {
  const nodes = [];
  const parts = text.split(/```[a-zA-Z0-9]*\n?/);
  parts.forEach((part, i) => {
    if (i % 2) { nodes.push(el("pre", { text: part.replace(/\n$/, "") })); return; }
    let list = null;
    for (const para of part.split(/\n{2,}/)) {
      const lines = para.split("\n").filter((l) => l.trim());
      if (!lines.length) continue;
      if (lines.every((l) => /^\s*([-*]|\d+\.)\s/.test(l))) {
        list = el(/^\s*\d/.test(lines[0]) ? "ol" : "ul", {});
        for (const l of lines) list.append(el("li", {}, inline(l.replace(/^\s*([-*]|\d+\.)\s/, ""))));
        nodes.push(list);
      } else {
        const p = el("p", {});
        lines.forEach((l, j) => { if (j) p.append(el("br")); p.append(...inline(l)); });
        nodes.push(p);
      }
    }
  });
  return nodes;
}

function addBubble(role, text, before) {
  return insert(el("div", { class: `msg ${role}` }, role === "user" ? el("p", { text }) : formatText(text)), before);
}

function addThinking() {
  return insert(el("div", { class: "msg thinking", role: "status" }, el("span", { class: "dots", "aria-hidden": "true" }), "Working…"));
}

function addNote(text, kind) {
  return insert(el("div", { class: `agent-note ${kind || ""}`, text }), log().querySelector(".thinking"));
}

function addStep(label, before) {
  return insert(el("div", { class: "step running" }, el("span", { class: "step-icon", "aria-hidden": "true" }), el("span", { class: "step-label", text: label }), el("span", { class: "step-out" })), before);
}

function finishStep(step, outcome, call, out) {
  step.classList.remove("running");
  step.classList.add(outcome.kind);
  step.querySelector(".step-out").textContent = outcome.text;
  if (out.ok && call.name === "simulate") step.append(el("button", { type: "button", class: "linkish", onClick: () => show("simulate") }, "View plot"));
  if (out.ok && call.name === "build_fmu") step.append(el("button", { type: "button", class: "linkish", onClick: () => downloadFile(out.fmu) }, "Download"));
  if (call.name === "write_file" && out.saved) step.append(el("button", { type: "button", class: "linkish", onClick: () => { show("editor"); if (S.path !== out.saved) loadFiles(out.saved); } }, "Open"));
  if (!out.ok && out.traceback) step.append(el("details", {}, el("summary", { text: "Details" }), el("pre", { text: out.traceback })));
}

function setRunning(on) {
  A.running = on;
  $("#agent-send").hidden = on;
  $("#agent-stop").hidden = !on;
  $("#agent-input").disabled = false;
}

function updateKeyState() {
  const has = Boolean(A.key);
  $("#agent-key-form").hidden = has;
  $("#agent-chat").hidden = !has;
  $("#agent-key-status").textContent = has ? "API key set" : "";
  $("#agent-forget").hidden = !has;
}

function showKeyForm() { A.key = ""; updateKeyState(); $("#agent-key").focus(); }

function forgetKey() { A.key = ""; store.set(AGENT.keyStore, ""); updateKeyState(); }

function newChat() {
  if (A.running) return;
  A.messages = [];
  log().replaceChildren();
  $("#agent-empty").hidden = false;
  $("#agent-input").focus();
}

function setupAgent() {
  const sel = $("#agent-model");
  sel.replaceChildren(...AGENT.models.map(([id, label]) => el("option", { value: id, text: label })));
  const savedModel = store.get(AGENT.modelStore);
  if (AGENT.models.some(([id]) => id === savedModel)) sel.value = savedModel;
  sel.addEventListener("change", () => store.set(AGENT.modelStore, sel.value));

  A.key = store.get(AGENT.keyStore);
  updateKeyState();
  $("#agent-key-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const key = $("#agent-key").value.trim();
    if (!key) return;
    A.key = key;
    $("#agent-key").value = "";
    if ($("#agent-remember").checked) store.set(AGENT.keyStore, key);
    updateKeyState();
    $("#agent-input").focus();
  });
  $("#agent-forget").addEventListener("click", forgetKey);
  $("#agent-new").addEventListener("click", newChat);

  const input = $("#agent-input");
  const submit = () => { const t = input.value; input.value = ""; send(t); };
  $("#agent-form").addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
  $("#agent-stop").addEventListener("click", () => A.abort && A.abort.abort());
  for (const b of document.querySelectorAll(".agent-suggest")) b.addEventListener("click", () => { input.value = b.textContent; input.focus(); });
}

setupAgent();
