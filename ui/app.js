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
      let finalSummaryCount = String(rows.length);
      if (rows.length >= 200) {
        finalRows = rows.slice(0, 200);
        finalSummaryCount = "200 solutions found, more possible stopping due to limit.";
      }
      state.results = { headers, rows: finalRows, raw: text, summary: { solutions: finalSummaryCount, time: "< 1s" } };
    } else {
      // Robust parser for real Gecode engine and analytical solver output
      function extractVal(block, keyRegex) {
        const m = block.match(keyRegex);
        if (!m) return "—";
        let raw = m[1].trim();
        return raw;
      }

      function parseNumeric(val) {
        if (!val || val === "—") return 0;
        // Handle interval format {[50..2147483646]} or [0..50]
        const intervalMatch = val.match(/\[(\d+)(?:\.\.(\d+))?\]/);
        if (intervalMatch) {
          return parseInt(intervalMatch[1], 10);
        }
        const num = parseFloat(val.replace(/[^0-9.-]/g, ""));
        return isNaN(num) ? 0 : num;
      }

      const solBlocks = text.split(/\*\*\*\s*Solution number:\s*/i);
      const parsedRows = [];
      const solMatch = text.match(/(\d+)\s+solutions?\s+found/i);
      const solutionCount = solMatch ? solMatch[1] : String(Math.max(0, solBlocks.length - 1));
      const timeMatch = text.match(/search ended after:\s*([^\r\n]+)/i);
      const searchTime = timeMatch ? timeMatch[1].trim() : "< 1s";

      for (let i = 1; i < solBlocks.length; i++) {
        const block = solBlocks[i];
        const numMatch = block.match(/^(\d+)/);
        const solNum = numMatch ? numMatch[1] : String(i);

        const procMapping = extractVal(block, /Proc:\s*\{(.*?)\}/i);
        const periodRaw = extractVal(block, /Period:\s*(?:\{)?(.*?)(?:\})?(?:\r?\n|$)/i);
        const utilRaw = extractVal(block, /Sys utilization:\s*(.*?)(?:\r?\n|$)/i);
        const powerRaw = extractVal(block, /sys power(?:\s*\(only used parts\))?:\s*(.*?)(?:\r?\n|$)/i);
        const areaRaw = extractVal(block, /sys area(?:\s*\(only used parts\))?:\s*(.*?)(?:\r?\n|$)/i);
        const costRaw = extractVal(block, /sys cost(?:\s*\(only used parts\))?:\s*(.*?)(?:\r?\n|$)/i);
        const orderRaw = extractVal(block, /Next:\s*(.*?)(?:\r?\n|$)/i);
        const tdmaRaw = extractVal(block, /TDMA slots:\s*\{(.*?)\}/i);

        parsedRows.push({
          "Solution #": solNum,
          "Period": periodRaw,
          "Utilization (%)": utilRaw,
          "Power (mW)": powerRaw,
          "Area": areaRaw,
          "Cost ($)": costRaw,
          "PE Mapping": procMapping,
          "Order": orderRaw,
          "TDMA Slots": tdmaRaw,
          // Numeric fields for chart & Pareto frontier calculation
          _period: parseNumeric(periodRaw),
          _power: parseNumeric(powerRaw),
          _area: parseNumeric(areaRaw),
          _cost: parseNumeric(costRaw),
          _utilization: parseNumeric(utilRaw)
        });
      }

      // Check active design constraints from UI
      let activeMinPeriod = Infinity;
      (state.constraints || []).forEach(c => {
        const pVal = parseInt(c.period, 10);
        if (!isNaN(pVal) && pVal > 0 && pVal < activeMinPeriod) {
          activeMinPeriod = pVal;
        }
      });

      const activeMaxPower = (state.sysConstraints?.maxPower && state.sysConstraints.maxPower !== "Unlimited")
        ? parseFloat(state.sysConstraints.maxPower)
        : Infinity;

      // Filter rows that meet active constraints
      const validRows = parsedRows.filter(r => {
        if (activeMinPeriod < Infinity && r._period > activeMinPeriod) return false;
        if (isFinite(activeMaxPower) && r._power > activeMaxPower) return false;
        return true;
      });

      let finalRows = validRows;
      let finalSummaryCount = validRows.length.toString();

      if (validRows.length >= 200) {
        finalRows = validRows.slice(0, 200);
        finalSummaryCount = "200 solutions found, more possible stopping due to limit.";
      } else if (validRows.length === 0) {
        finalSummaryCount = "0 solutions found (all violated active constraints)";
      }

      if (finalRows.length > 0) {
        state.results = {
          headers: ["Solution #", "Period", "Utilization (%)", "Power (mW)", "Area", "Cost ($)", "PE Mapping", "Order"],
          rows: finalRows,
          raw: text,
          summary: {
            solutions: finalSummaryCount,
            time: searchTime
          }
        };
      } else {
        state.results = {
          headers: ["Raw Output"],
          rows: [],
          raw: text,
          summary: {
            solutions: "0 solutions found",
            time: searchTime || "—"
          }
        };
      }
    }
    renderResults();
    toast(`Results loaded: ${state.results.summary?.solutions || 0} solution(s)`, "success");
    // Trigger Pareto Frontier and Incremental DSE updates
    if (window.ParetoFrontier) window.ParetoFrontier.refresh();
    if (window.IncrementalDSE) window.IncrementalDSE.recordRun();
    if (window.ArchStudio) window.ArchStudio.applyResultOverlay();
  }

  // ═══════════════════════ RENDERING ══════════════════════════
  function updateKPIs() {
    let totalProcs = 0;
    state.platform.processors.forEach(p => totalProcs += p.count);
    $("#kpi-processors").textContent = totalProcs;
    $("#kpi-applications").textContent = state.applications.length;
    let totalActors = 0;
    state.applications.forEach(a => totalActors += a.actors.length);
    $("#kpi-actors").textContent = totalActors;
    $("#kpi-solutions").textContent = state.results?.summary?.solutions ?? "—";
  }

  // ── Platform ────────────────────────────────────────────────
  function renderPlatform() {
    const tbody = $("#platform-tbody");
    const empty = $("#platform-empty");
    tbody.innerHTML = "";

    if (state.platform.processors.length === 0) {
      empty.classList.remove("hidden");
      tbody.closest("table").classList.add("hidden");
    } else {
      empty.classList.add("hidden");
      tbody.closest("table").classList.remove("hidden");
      state.platform.processors.forEach((p, idx) => {
        p.modes.forEach((m, mi) => {
          const tr = document.createElement("tr");
          tr.innerHTML = `
            <td>${mi === 0 ? `<input type="text" class="table-input" value="${p.model}" onchange="paretoco.updateProcessorModel(${idx}, this.value)" title="Edit Processor Model Name">` : `<span style="color:var(--text-muted); font-size:0.75rem;">↳ mode ${mi + 1}</span>`}</td>
            <td>${mi === 0 ? `<input type="number" class="table-input table-input-sm" min="1" value="${p.count}" onchange="paretoco.updateProcessorCount(${idx}, this.value)" title="Edit Core Count">` : ""}</td>
            <td><input type="text" class="table-input table-input-sm" value="${m.name}" onchange="paretoco.updateModeName(${idx}, ${mi}, this.value)" title="Edit Mode Name"></td>
            <td><input type="number" class="table-input" value="${m.mem}" onchange="paretoco.updateModeMem(${idx}, ${mi}, this.value)" title="Edit Memory in Bytes"></td>
            <td><input type="number" class="table-input table-input-sm" value="${m.dynPower}" onchange="paretoco.updateModeDynPower(${idx}, ${mi}, this.value)" title="Edit Dynamic Power (mW)"></td>
            <td><input type="number" class="table-input table-input-sm" value="${m.staticPower}" onchange="paretoco.updateModeStaticPower(${idx}, ${mi}, this.value)" title="Edit Static Leakage Power (mW)"></td>
            <td><input type="number" class="table-input table-input-sm" value="${m.area}" onchange="paretoco.updateModeArea(${idx}, ${mi}, this.value)" title="Edit Silicon Area (mm²)"></td>
            <td><input type="number" class="table-input table-input-sm" value="${m.monetary}" onchange="paretoco.updateModeCost(${idx}, ${mi}, this.value)" title="Edit Monetary Cost ($)"></td>
            <td style="white-space: nowrap;">
              ${mi === 0 ? `<button class="btn btn-xs btn-outline" style="margin-right:4px;" onclick="paretoco.addProcessorMode(${idx})" title="Add Operating Mode">+ Mode</button><button class="btn btn-danger btn-xs" onclick="paretoco.removeProcessor(${idx})" title="Delete Processor">✕</button>` : `<button class="btn btn-danger btn-xs" onclick="paretoco.removeProcessorMode(${idx}, ${mi})" title="Delete Mode">✕</button>`}
            </td>
          `;
          tbody.appendChild(tr);
        });
      });
    }

    renderInterconnects();
    renderPlatformSummary();
  }

  function renderInterconnects() {
    const list = $("#interconnect-list");
    const empty = $("#interconnect-empty");
    if (!list) return;
    list.innerHTML = "";

    if (!state.platform.interconnects || state.platform.interconnects.length === 0) {
      if (empty) empty.classList.remove("hidden");
    } else {
      if (empty) empty.classList.add("hidden");
      state.platform.interconnects.forEach((ic, idx) => {
        const card = document.createElement("div");
        card.className = "card";
        card.style.marginBottom = "12px";
        card.style.padding = "14px";
        card.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
            <div style="display:flex; align-items:center; gap:8px;">
              <strong style="color:var(--text-primary);">Interconnect:</strong>
              <input type="text" class="table-input" style="width:140px;" value="${ic.name}" onchange="paretoco.updateInterconnectName(${idx}, this.value)" title="Edit Interconnect Name">
            </div>
            <button class="btn btn-danger btn-xs" onclick="paretoco.removeInterconnect(${idx})">✕ Remove</button>
          </div>
          <div class="form-grid" style="grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap:10px;">
            <div class="form-group">
              <label>Topology</label>
              <select class="table-input" onchange="paretoco.updateInterconnectTopology(${idx}, this.value)">
                <option value="TDMA-bus" ${ic.topology === "TDMA-bus" ? "selected" : ""}>TDMA-bus</option>
                <option value="2D-mesh" ${ic.topology === "2D-mesh" ? "selected" : ""}>2D-mesh</option>
                <option value="Ring" ${ic.topology === "Ring" ? "selected" : ""}>Ring</option>
                <option value="Crossbar" ${ic.topology === "Crossbar" ? "selected" : ""}>Crossbar</option>
              </select>
            </div>
            <div class="form-group">
              <label>X-Dim</label>
              <input type="number" class="table-input" min="1" value="${ic.xDim || 1}" onchange="paretoco.updateInterconnectXDim(${idx}, this.value)">
            </div>
            <div class="form-group">
              <label>Y-Dim</label>
              <input type="number" class="table-input" min="1" value="${ic.yDim || 1}" onchange="paretoco.updateInterconnectYDim(${idx}, this.value)">
            </div>
            <div class="form-group">
              <label>Flit Size (B)</label>
              <input type="number" class="table-input" value="${ic.flitSize || 32}" onchange="paretoco.updateInterconnectFlit(${idx}, this.value)">
            </div>
            <div class="form-group">
              <label>Slots</label>
              <input type="number" class="table-input" value="${ic.slots || 2}" onchange="paretoco.updateInterconnectSlots(${idx}, this.value)">
            </div>
          </div>
        `;
        list.appendChild(card);
      });
    }
  }

  function renderPlatformSummary() {
    const el = $("#platform-summary");
    if (!el) return;
    if (state.platform.processors.length === 0) {
      el.innerHTML = `<div class="empty-state"><div class="img-container" style="display: flex; flex: 1; max-width: 64px; margin: 0 auto; margin-bottom: 12px;"><img src="/assets/flat-platform.png" alt="Platform" style="max-width: 100%; height: auto; object-fit: contain; border: 3px solid #000; box-shadow: 3px 3px 0px #000;"></div><p>Import a <code>platform.xml</code> to see details.</p></div>`;
      return;
    }
    let html = '<div class="platform-chips">';
    state.platform.processors.forEach(p => {
      html += `<div class="chip"><strong>${p.model}</strong> × ${p.count}<br><span class="chip-sub">${p.modes.length} mode(s)</span></div>`;
    });
    if (state.platform.interconnects && state.platform.interconnects.length) {
      state.platform.interconnects.forEach(ic => {
        html += `<div class="chip ic"><strong>${ic.name}</strong><br><span class="chip-sub">${ic.topology} ${ic.xDim}×${ic.yDim}</span></div>`;
      });
    }
    html += '</div>';
    el.innerHTML = html;
  }

  // ── Applications ────────────────────────────────────────────
  function renderApplications() {
    const list = $("#applications-list");
    const empty = $("#applications-empty");
    if (!list) return;
    list.innerHTML = "";

    if (state.applications.length === 0) {
      if (empty) empty.classList.remove("hidden");
    } else {
      if (empty) empty.classList.add("hidden");
      state.applications.forEach((app, idx) => {
        const div = document.createElement("div");
        div.className = "app-card";
        div.innerHTML = `
          <div class="app-card-header">
            <div style="display:flex; align-items:center; gap:8px;">
              <img src="img/icon-applications.jpg" style="width:22px; height:22px; border-radius:4px; object-fit:cover;">
              <h3>${app.name}</h3>
            </div>
            <div>
              <span class="badge blue">${app.actors.length} actors</span>
              <span class="badge violet">${app.channels.length} channels</span>
              <button class="btn btn-danger btn-xs" onclick="paretoco.removeApp(${idx})">✕</button>
            </div>
          </div>
          <div class="app-card-actors">${app.actors.map(a => `<span class="actor-chip"><img src="img/icon-actors.jpg" style="width:12px; height:12px; border-radius:2px; vertical-align:middle; margin-right:4px;">${a.name}</span>`).join("")}</div>
        `;
        list.appendChild(div);
      });
    }
  }

  // ── WCETs ───────────────────────────────────────────────────
  function renderWcets() {
    const tbody = $("#wcet-tbody");
    const empty = $("#wcet-empty");
    if (!tbody) return;
    tbody.innerHTML = "";

    if (state.wcets.length === 0) {
      if (empty) empty.classList.remove("hidden");
      tbody.closest("table")?.classList.add("hidden");
    } else {
      if (empty) empty.classList.add("hidden");
      tbody.closest("table")?.classList.remove("hidden");
      state.wcets.forEach((w, idx) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td><input type="text" class="table-input" value="${w.taskType}" oninput="paretoco.updateWcetTask(${idx}, this.value)" onchange="paretoco.updateWcetTask(${idx}, this.value)" onkeydown="if(event.key==='Enter'){paretoco.updateWcetTask(${idx}, this.value); this.blur();}" title="Edit Task Type"></td>
          <td><input type="text" class="table-input" value="${w.processor || w.procModel || ''}" oninput="paretoco.updateWcetProc(${idx}, this.value)" onchange="paretoco.updateWcetProc(${idx}, this.value)" onkeydown="if(event.key==='Enter'){paretoco.updateWcetProc(${idx}, this.value); this.blur();}" title="Edit Target Processor"></td>
          <td><input type="text" class="table-input" value="${w.mode}" oninput="paretoco.updateWcetMode(${idx}, this.value)" onchange="paretoco.updateWcetMode(${idx}, this.value)" onkeydown="if(event.key==='Enter'){paretoco.updateWcetMode(${idx}, this.value); this.blur();}" title="Edit Mode"></td>
          <td><input type="number" class="table-input" value="${w.wcet}" oninput="paretoco.updateWcetTime(${idx}, this.value)" onchange="paretoco.updateWcetTime(${idx}, this.value)" onkeydown="if(event.key==='Enter'){paretoco.updateWcetTime(${idx}, this.value); this.blur();}" title="Edit WCET (cycles)"></td>
          <td><button class="btn btn-danger btn-xs" onclick="paretoco.removeWcet(${idx})" title="Delete WCET Entry">✕</button></td>
        `;
        tbody.appendChild(tr);
      });
    }
  }

  // ── Constraints ─────────────────────────────────────────────
  function renderConstraints() {
    const tbody = $("#constraints-tbody");
    const empty = $("#constraints-empty");
    if (!tbody) return;
    tbody.innerHTML = "";

    if (state.constraints.length === 0) {
      if (empty) empty.classList.remove("hidden");
      tbody.closest("table")?.classList.add("hidden");
    } else {
      if (empty) empty.classList.add("hidden");
      tbody.closest("table")?.classList.remove("hidden");
      state.constraints.forEach((c, idx) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td><input type="text" class="table-input" value="${c.appName}" oninput="paretoco.updateConstraintApp(${idx}, this.value)" onchange="paretoco.updateConstraintApp(${idx}, this.value)" onkeydown="if(event.key==='Enter'){paretoco.updateConstraintApp(${idx}, this.value); this.blur();}" title="Edit Application Name"></td>
          <td><input type="number" class="table-input" value="${c.period}" oninput="paretoco.updateConstraintPeriod(${idx}, this.value)" onchange="paretoco.updateConstraintPeriod(${idx}, this.value)" onkeydown="if(event.key==='Enter'){paretoco.updateConstraintPeriod(${idx}, this.value); this.blur();}" title="Edit Period Bound"></td>
          <td><input type="number" class="table-input" value="${c.latency}" oninput="paretoco.updateConstraintLatency(${idx}, this.value)" onchange="paretoco.updateConstraintLatency(${idx}, this.value)" onkeydown="if(event.key==='Enter'){paretoco.updateConstraintLatency(${idx}, this.value); this.blur();}" title="Edit Latency Bound"></td>
          <td><button class="btn btn-danger btn-xs" onclick="paretoco.removeConstraint(${idx})" title="Delete Constraint">✕</button></td>
        `;
        tbody.appendChild(tr);
      });
    }
  }

  // ── Results ─────────────────────────────────────────────────
  function renderResults() {
    const empty = $("#results-empty");
    const content = $("#results-content");
    const unsatContainer = $("#unsat-doctor-container");
    const resultsChart = $("#results-chart");
    const resultsTable = $("#results-table");

    if (!state.results) {
      if (empty) empty.classList.remove("hidden");
      if (content) content.classList.add("hidden");
      return;
    }

    if (empty) empty.classList.add("hidden");
    if (content) content.classList.remove("hidden");

    const solCountStr = String(state.results.summary?.solutions || "").trim();
    const isUnsat = !state.results.rows ||
      state.results.rows.length === 0 ||
      solCountStr === "0" ||
      solCountStr.startsWith("0 solutions");

    if (isUnsat) {
      if (unsatContainer) unsatContainer.classList.remove("hidden");
      if (resultsChart) resultsChart.classList.add("hidden");
      if (resultsTable) resultsTable.classList.add("hidden");
    } else {
      if (unsatContainer) unsatContainer.classList.add("hidden");
      if (resultsChart) resultsChart.classList.remove("hidden");
      if (resultsTable) resultsTable.classList.remove("hidden");
    }

    // Summary
    const sum = $("#results-summary");
    if (sum && state.results.summary) {
      sum.innerHTML = `
        <div class="stat"><span class="stat-label">Solutions</span><span class="stat-value">${state.results.summary.solutions}</span></div>
        <div class="stat"><span class="stat-label">Search Time</span><span class="stat-value">${state.results.summary.time}</span></div>
        <div class="stat"><span class="stat-label">Rows</span><span class="stat-value">${isUnsat ? 0 : state.results.rows.length}</span></div>
      `;
    }

    // Table
    const thead = $("#results-thead");
    const tbody = $("#results-tbody");
    if (thead && tbody && !isUnsat) {
      thead.innerHTML = "<tr>" + state.results.headers.map(h => `<th>${h}</th>`).join("") + "</tr>";
      tbody.innerHTML = "";
      state.results.rows.slice(0, 100).forEach(row => {
        const tr = document.createElement("tr");
        tr.innerHTML = state.results.headers.map(h => `<td>${row[h] || ""}</td>`).join("");
        tbody.appendChild(tr);
      });
    }

    if (!isUnsat) {
      drawResultsChart();
    }
    updateKPIs();
  }

  function drawResultsChart() {
    const canvas = $("#results-chart");
    const ctx = canvas.getContext("2d");
    const canvasWidth = canvas.offsetWidth || 800;
    canvas.width = canvasWidth * 2;
    canvas.height = 600;
    ctx.scale(2, 2);
    const w = canvasWidth;
    const h = 300;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);

    if (!state.results || !state.results.rows.length) return;

    // Find numeric columns
    const numCols = state.results.headers.filter(hdr => {
      return state.results.rows.some(r => !isNaN(parseFloat(r[hdr])) && r[hdr] !== "");
    });
    if (numCols.length === 0) {
      ctx.fillStyle = "#9095a4";
      ctx.font = "13px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No numeric data to chart", w / 2, h / 2);
      return;
    }

    const col = numCols[0];
    const values = state.results.rows.map(r => parseFloat(r[col]) || 0);
    const max = Math.max(...values, 1);
    const barW = Math.max(6, (w - 80) / values.length - 4);
    const chartH = h - 60;

    ctx.fillStyle = "#5a5d6b";
    ctx.font = "500 12px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(col, w / 2, h - 8);

    values.forEach((v, i) => {
      const bh = (v / max) * chartH;
      const x = 40 + i * ((w - 80) / values.length);
      ctx.fillStyle = "#c9513e";
      ctx.fillRect(x, 25 + chartH - bh, barW, bh);
    });
  }

  // ═══════════════════════ SDF GRAPH VISUALIZER ════════════════
  function populateAppSelector() {
    const sel = $("#app-selector");
    sel.innerHTML = '<option value="">— select application —</option>';
    state.applications.forEach((a, i) => {
      sel.innerHTML += `<option value="${i}">${a.name}</option>`;
    });
  }

  function drawSdfGraph(appIndex) {
    const canvas = $("#sdf-canvas");
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const canvasWidth = canvas.offsetWidth || 800;
    canvas.width = canvasWidth * dpr;
    canvas.height = 400 * dpr;
    ctx.scale(dpr, dpr);
    const w = canvasWidth;
    const h = 400;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#f7f7f8";
    ctx.fillRect(0, 0, w, h);

    if (appIndex === "" || appIndex === undefined || !state.applications[appIndex]) {
      ctx.fillStyle = "#9095a4";
      ctx.font = "13px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Select an application to visualize its SDF graph", w / 2, h / 2);
      return;
    }

    const app = state.applications[appIndex];
    const actors = app.actors;
    const channels = app.channels;
    const n = actors.length;
    if (n === 0) return;

    // Layout actors in a circle
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) / 2 - 60;
    const positions = {};

    actors.forEach((a, i) => {
      const angle = (2 * Math.PI * i) / n - Math.PI / 2;
      positions[a.name] = {
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
      };
    });

    // Draw channels (edges)
    channels.forEach(ch => {
      const src = positions[ch.srcActor];
      const dst = positions[ch.dstActor];
      if (!src || !dst) return;

      ctx.strokeStyle = "#c8cad0";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(src.x, src.y);
      ctx.lineTo(dst.x, dst.y);
      ctx.stroke();

      // Arrow head
      const angle = Math.atan2(dst.y - src.y, dst.x - src.x);
      const headLen = 8;
      const tipX = dst.x - 22 * Math.cos(angle);
      const tipY = dst.y - 22 * Math.sin(angle);
      ctx.fillStyle = "#5a5d6b";
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - headLen * Math.cos(angle - 0.4), tipY - headLen * Math.sin(angle - 0.4));
      ctx.lineTo(tipX - headLen * Math.cos(angle + 0.4), tipY - headLen * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fill();
    });

    // Draw actors (nodes)
    const colors = ["#c9513e", "#3a7bc8", "#2d8659", "#b8860b", "#5a5d6b", "#7b68ee"];
    actors.forEach((a, i) => {
      const pos = positions[a.name];
      const color = colors[i % colors.length];

      // Node circle
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 18, 0, Math.PI * 2);
      ctx.fill();

      // Node border
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 18, 0, Math.PI * 2);
      ctx.stroke();

      // Actor label
      ctx.fillStyle = "#1a1a2e";
      ctx.font = "600 11px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const label = a.name.length > 12 ? a.name.slice(0, 10) + "…" : a.name;
      ctx.fillText(label, pos.x, pos.y + 28);
    });
  }

  $("#app-selector").addEventListener("change", (e) => drawSdfGraph(e.target.value));

  // ═══════════════════════ CONFIG GENERATION ═══════════════════
  function generateConfigPreview() {
    syncStateFromForm();

    let cfg = "";
    cfg += "# ParetoCo configuration — generated by ParetoCo UI\n\n";
    cfg += "# Input paths (adjust for your experiment directory)\n";
    cfg += "inputs=./sdfs/\n";
    cfg += "inputs=./xmls/\n\n";
    cfg += "# Output path\n";
    cfg += "output=./\n\n";
    cfg += "log-file=output.log\n";
    cfg += `log-level=${state.output.logLevel}\n`;
    cfg += `log-level=DEBUG\n\n`;
    cfg += `output-file-type=${state.output.type}\n`;
    cfg += `output-print-frequency=${state.output.freq}\n`;
    cfg += `print-metric=${state.output.metric}\n\n`;

    cfg += "[dse]\n\n";
    cfg += `model=${state.dse.model}\n`;
    cfg += `search=${state.dse.search}\n`;
    cfg += `criteria=${state.dse.criteria}\n`;
    cfg += `timeout=${state.dse.timeout1}\n`;
    cfg += `timeout=${state.dse.timeout2}\n`;
    cfg += `threads=${state.dse.threads}\n`;
    cfg += `luby_scale=${state.dse.lubyScale}\n`;
    cfg += `noGoodDepth=${state.dse.noGoodDepth}\n`;
    cfg += `th_prop=${state.dse.thProp}\n\n`;

    cfg += "[presolver]\n\n";
    cfg += `model=${state.presolver.model}\n`;
    cfg += `search=${state.presolver.search}\n`;
    cfg += `heuristic=${state.presolver.heuristic}\n`;
    cfg += `multi-search=${state.presolver.multiSearch}\n`;
    cfg += `timeout=${state.presolver.timeout1}\n`;
    cfg += `timeout=${state.presolver.timeout2}\n`;

    $("#config-preview").textContent = cfg;
    return cfg;
  }

  // ═══════════════════════ FORM ↔ STATE SYNC ══════════════════
