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
