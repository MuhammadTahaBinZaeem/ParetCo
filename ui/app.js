/* ParetoCo Design Space Explorer - Application Logic
   Created on: Aug 15, 2026
   Authors: Lameea (UI), Alizay (engine integration)
*/
/* ════════════════════════════════════════════════════════════════
   ParetoCo Design Space Explorer — Application Logic
   ════════════════════════════════════════════════════════════════
   This UI is decoupled from the C++ engine. It reads/writes the
   same XML + config.cfg formats the engine consumes, so it can be
   plugged in once the engine binary is available.
   ════════════════════════════════════════════════════════════════ */

(() => {
  "use strict";

  // ═══════════════════════ STATE ═══════════════════════════════
  const state = {
    platform: { processors: [], interconnects: [] },
    applications: [],   // [{name, actors:[], channels:[]}]
    wcets: [],          // [{taskType, processor, mode, wcet}]
    constraints: [],    // [{appName, period, latency}]
    sysConstraints: { power: -1, utilization: -1, area: -1, cost: -1, procsUsed: -1 },
    dse: {
      model: "SDF_PR_ONLINE", search: "OPTIMIZE_IT", criteria: "POWER",
      threads: 0, timeout1: 0, timeout2: 0, lubyScale: 0, noGoodDepth: 75, thProp: "SSE"
    },
    presolver: {
      model: "NONE", search: "NONESEARCH", heuristic: "NONE",
      multiSearch: "NONESEARCH", timeout1: 0, timeout2: 0
    },
    output: { type: "ALL_OUT", freq: "LAST", metric: "NONE", logLevel: "INFO" },
    results: null
  };

  // ═══════════════════════ DOM REFS ════════════════════════════
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // Navigation
  const sidebar = $("#sidebar");
  const navItems = $$(".nav-item");
  const pages = $$(".page");
  const pageTitle = $("#page-title");

  // Buttons
  const btnImport = $("#btn-import-config");
  const btnLaunch = $("#btn-launch");
  const btnClearLog = $("#btn-clear-log");
  const menuToggle = $("#menu-toggle");

  // File inputs
  const fileConfig = $("#file-config");
  const filePlatform = $("#file-platform");
  const fileSdf = $("#file-sdf");
  const fileWcet = $("#file-wcet");
  const fileConstraints = $("#file-constraints");
  const fileResults = $("#file-results");

  // ═══════════════════════ NAVIGATION ══════════════════════════
  function switchPage(pageName) {
    pages.forEach(p => p.classList.remove("active"));
    navItems.forEach(n => n.classList.remove("active"));
    const page = $(`#page-${pageName}`);
    const nav = $(`[data-page="${pageName}"]`);
    if (page) page.classList.add("active");
    if (nav) nav.classList.add("active");
    const titles = {
      dashboard: "Dashboard", platform: "Platform", applications: "Applications",
      constraints: "Constraints", explorer: "DSE Configuration", results: "Results", "ai-analyst": "AI Analyst",
      "arch-studio": "Architecture Studio", "pareto-explorer": "Pareto Explorer", "continuous-dse": "Continuous DSE"
    };
    pageTitle.textContent = titles[pageName] || pageName;
    if (pageName === "explorer") generateConfigPreview();
    if (pageName === "arch-studio" && window.ArchStudio) {
      window.ArchStudio.syncCanvasFromModel();
      setTimeout(() => window.ArchStudio.init(), 50);
    }
    if (pageName === "pareto-explorer" && window.ParetoFrontier) {
      setTimeout(() => window.ParetoFrontier.init(), 50);
    }
    if (pageName === "continuous-dse" && window.IncrementalDSE) {
      setTimeout(() => window.IncrementalDSE.init(), 50);
    }
    // Close mobile sidebar
    sidebar.classList.remove("open");
  }

  navItems.forEach(item => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      switchPage(item.dataset.page);
    });
  });

  menuToggle.addEventListener("click", () => sidebar.classList.toggle("open"));

  // ═══════════════════════ TOAST ═══════════════════════════════
  function toast(msg, type = "info") {
    const container = $("#toast-container");
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  // ═══════════════════════ FILE LOADING ════════════════════════
  function readFile(input, cb) {
    input.value = "";
    input.onchange = () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => cb(reader.result, file.name);
      reader.readAsText(file);
    };
    input.click();
  }

  // ── Platform XML Parser ─────────────────────────────────────
  function parsePlatformXml(text) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "text/xml");
    const procs = [];
    doc.querySelectorAll("processor").forEach(p => {
      const model = p.getAttribute("model");
      const count = parseInt(p.getAttribute("number")) || 1;
      const modes = [];
      p.querySelectorAll("mode").forEach(m => {
        modes.push({
          name: m.getAttribute("name"),
          cycle: parseFloat(m.getAttribute("cycle")) || 1,
          mem: parseInt(m.getAttribute("mem")) || 0,
          dynPower: parseInt(m.getAttribute("dynPower")) || 0,
          staticPower: parseInt(m.getAttribute("staticPower")) || 0,
          area: parseInt(m.getAttribute("area")) || 0,
          monetary: parseInt(m.getAttribute("monetary")) || 0,
        });
      });
      procs.push({ model, count, modes });
    });

    const ics = [];
    doc.querySelectorAll("TDN_NoC, TDN_BUS").forEach(ic => {
      ics.push({
        type: ic.tagName,
        name: ic.getAttribute("name"),
        topology: ic.getAttribute("topology") || "",
        xDim: parseInt(ic.getAttribute("x-dimension")) || 0,
        yDim: parseInt(ic.getAttribute("y-dimension")) || 0,
        routing: ic.getAttribute("routing") || "",
        flitSize: parseInt(ic.getAttribute("flitSize")) || 0,
        cycles: parseInt(ic.getAttribute("cycles")) || 0,
      });
    });

    state.platform = { processors: procs, interconnects: ics };
    renderPlatform();
    updateKPIs();
    toast(`Platform loaded: ${procs.length} processor type(s)`, "success");
  }

  // ── SDF XML Parser ──────────────────────────────────────────
  function parseSdfXml(text, filename) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "text/xml");
    const appGraph = doc.querySelector("applicationGraph");
    const name = appGraph ? appGraph.getAttribute("name") : filename.replace(/\..*$/, "");

    const actors = [];
    const channels = [];
    doc.querySelectorAll("actor").forEach(a => {
      const ports = [];
      a.querySelectorAll("port").forEach(p => {
        ports.push({ name: p.getAttribute("name"), type: p.getAttribute("type"), rate: parseInt(p.getAttribute("rate")) || 1 });
      });
      actors.push({ name: a.getAttribute("name"), type: a.getAttribute("type"), ports });
    });
    doc.querySelectorAll("channel").forEach(c => {
      channels.push({
        name: c.getAttribute("name"),
        srcActor: c.getAttribute("srcActor"),
        srcPort: c.getAttribute("srcPort"),
        dstActor: c.getAttribute("dstActor"),
        dstPort: c.getAttribute("dstPort"),
      });
    });

    // Check duplicate
    const existing = state.applications.findIndex(a => a.name === name);
    if (existing >= 0) state.applications[existing] = { name, actors, channels };
    else state.applications.push({ name, actors, channels });

    renderApplications();
    updateKPIs();
    populateAppSelector();
    toast(`SDF graph "${name}" loaded: ${actors.length} actors, ${channels.length} channels`, "success");
  }

  // ── WCET XML Parser ─────────────────────────────────────────
  function parseWcetXml(text) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "text/xml");
    state.wcets = [];
    doc.querySelectorAll("mapping").forEach(m => {
      const taskType = m.getAttribute("task_type");
      m.querySelectorAll("wcet").forEach(w => {
        state.wcets.push({
          taskType,
          processor: w.getAttribute("processor"),
          mode: w.getAttribute("mode"),
          wcet: parseInt(w.getAttribute("wcet")) || 0,
        });
      });
    });
    renderWcets();
    toast(`WCET table loaded: ${state.wcets.length} entries`, "success");
  }

  // ── Design Constraints Parser ───────────────────────────────
  function parseConstraintsXml(text) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "text/xml");
    state.constraints = [];
    doc.querySelectorAll("constraint").forEach(c => {
      state.constraints.push({
        appName: c.getAttribute("app_name"),
        period: parseInt(c.getAttribute("period")) || 0,
        latency: parseInt(c.getAttribute("latency")) || 0,
      });
    });
    renderConstraints();
    toast(`Constraints loaded: ${state.constraints.length} entries`, "success");
  }

  // ── Config.cfg Parser ───────────────────────────────────────
  function parseConfig(text) {
    const lines = text.split(/\r?\n/);
    let section = "";
    const inputPaths = [];

    lines.forEach(line => {
      line = line.trim();
      if (!line || line.startsWith("#")) return;
      const secMatch = line.match(/^\[(.+)\]$/);
      if (secMatch) { section = secMatch[1]; return; }
      const [key, ...rest] = line.split("=");
      const val = rest.join("=").trim();
      const k = key.trim();

      if (section === "") {
        if (k === "inputs") inputPaths.push(val);
        else if (k === "output-file-type") state.output.type = val.toUpperCase();
        else if (k === "output-print-frequency") state.output.freq = val;
        else if (k === "print-metric") state.output.metric = val.toUpperCase();
        else if (k === "log-level" && !state._logLevelSet) { state.output.logLevel = val.toUpperCase(); state._logLevelSet = true; }
      } else if (section === "dse") {
        if (k === "model") state.dse.model = val.toUpperCase();
        else if (k === "search") state.dse.search = val.toUpperCase();
        else if (k === "criteria") state.dse.criteria = val.toUpperCase();
        else if (k === "threads") state.dse.threads = parseInt(val) || 0;
        else if (k === "timeout" && !state._dseT1Set) { state.dse.timeout1 = parseInt(val) || 0; state._dseT1Set = true; }
        else if (k === "timeout") state.dse.timeout2 = parseInt(val) || 0;
        else if (k === "luby_scale") state.dse.lubyScale = parseInt(val) || 0;
        else if (k === "noGoodDepth") state.dse.noGoodDepth = parseInt(val) || 0;
        else if (k === "th_prop") state.dse.thProp = val.toUpperCase();
      } else if (section === "presolver") {
        if (k === "model") state.presolver.model = val.toUpperCase();
        else if (k === "search") state.presolver.search = val.toUpperCase();
        else if (k === "heuristic") state.presolver.heuristic = val.toUpperCase();
        else if (k === "multi-search") state.presolver.multiSearch = val.toUpperCase();
        else if (k === "timeout" && !state._preT1Set) { state.presolver.timeout1 = parseInt(val) || 0; state._preT1Set = true; }
        else if (k === "timeout") state.presolver.timeout2 = parseInt(val) || 0;
      }
    });

    // Clean up temp flags
    delete state._logLevelSet;
    delete state._dseT1Set;
    delete state._preT1Set;

    syncFormFromState();
    toast("Configuration imported", "success");
  }

  // ── Results Parser ──────────────────────────────────────────
  function parseResults(text, filename = "out.txt") {
    if (filename.endsWith(".csv")) {
      const lines = text.trim().split(/\r?\n/);
      if (lines.length < 2) { toast("CSV is empty", "error"); return; }
      const headers = lines[0].split(/[;,]/).map(h => h.trim());
      const rows = lines.slice(1).map(l => {
        const cols = l.split(/[;,]/).map(c => c.trim());
        const row = {};
        headers.forEach((h, i) => row[h] = cols[i] || "");
        return row;
      }).filter(r => Object.values(r).some(v => v));
      let finalRows = rows;
