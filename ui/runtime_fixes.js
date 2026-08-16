/*
 * ParetoCo UI integration.
 *
 * This module connects the legacy dashboard views to the clean server APIs.
 * It does not rewrite source files, override window.fetch, or fabricate DSE data.
 */
(() => {
  'use strict';

  const api = window.paretoco;
  if (!api?.state) return;
  const state = api.state;

  const systemFields = {
    power: 'sys-power',
    utilization: 'sys-utilization',
    area: 'sys-area',
    cost: 'sys-cost',
    procsUsed: 'sys-procs'
  };

  const deepClone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const positiveOrUnlimited = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : -1;
  const escapeXml = value => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const escapeHtml = value => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  // ───────────────────────────── Feature surfaces ──────────────────────────
  function ensureFeatureSurfaces() {
    const studioRoot = document.getElementById('architecture-studio-container');
    if (studioRoot && !document.getElementById('studio-canvas')) {
      studioRoot.innerHTML = `
        <div class="studio-layout">
          <aside class="studio-left">
            <div class="studio-tabs">
              <button type="button" class="studio-tab active" data-tab="platform">Platform</button>
              <button type="button" class="studio-tab" data-tab="workload">Workload</button>
            </div>
            <div class="studio-palette-container">
              <div class="studio-palette-title">Components</div>
              <div id="studio-palette"></div>
            </div>
            <div class="studio-inspector-container" style="overflow:auto; flex:1; border-top:1px solid var(--border-color);">
              <div class="studio-inspector-title">Inspector</div>
              <div id="studio-inspector"></div>
            </div>
          </aside>
          <section class="studio-center">
            <div class="studio-toolbar">
              <button type="button" class="btn btn-sm btn-outline" id="studio-overlay-toggle">Show Native Mapping</button>
              <span class="studio-zoom-label">Drag nodes · drag ports to connect · wheel to zoom</span>
            </div>
            <canvas id="studio-canvas" class="studio-canvas" style="min-height:560px;"></canvas>
          </section>
        </div>`;
    }

    const paretoRoot = document.getElementById('pareto-frontier-container');
    if (paretoRoot && !document.getElementById('pareto-scatter-canvas')) {
      paretoRoot.innerHTML = `
        <div class="pareto-layout">
          <div>
            <div class="card">
              <div class="card-header"><h3>Pareto Frontier</h3><div id="pareto-dims" style="display:flex;gap:10px"></div></div>
              <div class="card-body"><canvas id="pareto-scatter-canvas" style="width:100%;min-height:420px;height:420px"></canvas></div>
            </div>
            <div class="card">
              <div class="card-header"><h3>Parallel Coordinates</h3></div>
              <div class="card-body"><canvas id="pareto-pc-canvas" style="width:100%;min-height:340px;height:340px"></canvas></div>
            </div>
          </div>
          <div>
            <div class="card"><div class="card-body" id="pareto-constraints"></div></div>
            <div class="card"><div class="card-body" id="pareto-detail"></div></div>
            <div class="card"><div class="card-body" id="pareto-sensitivity"></div></div>
          </div>
        </div>`;
    }

    const historyRoot = document.getElementById('incremental-dse-container');
    if (historyRoot && !document.getElementById('dse-timeline')) {
      historyRoot.innerHTML = `
        <div id="dse-status-banner" style="margin-bottom:16px"></div>
        <div class="dse-layout">
          <div class="card"><div class="card-header"><h3>Run Timeline</h3></div><div class="card-body" id="dse-timeline"></div></div>
          <div class="card"><div class="card-header"><h3>Run Delta</h3></div><div class="card-body" id="dse-delta"><div class="inspector-empty"><p>Select or create a DSE run to inspect changes.</p></div></div></div>
        </div>`;
    }
  }

  // ───────────────────────── Native control surface ────────────────────────
  function setOptions(id, values, preferred) {
    const select = document.getElementById(id);
    if (!select) return;
    const requested = String(preferred ?? select.value ?? '');
    select.replaceChildren(...values.map(value => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      return option;
    }));
    select.value = values.includes(requested) ? requested : values[0];
  }

  function normalizeNativeControls() {
    state.dse = state.dse || {};
    state.presolver = state.presolver || {};
    state.output = state.output || {};

    if (String(state.dse.search || '').toUpperCase() === 'OPTIMIZE_IT' && !(Number(state.dse.lubyScale) > 0)) {
      state.dse.search = 'FIRST';
    }
    if (String(state.dse.search || '').toUpperCase() === 'FIRST' && String(state.output.freq || '') === 'LAST') {
      state.output.freq = 'ALL_SOL';
    }

    setOptions('dse-model', ['SDF_PR_ONLINE'], state.dse.model || 'SDF_PR_ONLINE');
    setOptions('dse-search', ['FIRST', 'ALL', 'OPTIMIZE', 'OPTIMIZE_IT'], state.dse.search || 'FIRST');
    setOptions('dse-criteria', ['THROUGHPUT', 'POWER', 'NONE'], state.dse.criteria || 'THROUGHPUT');
    setOptions('dse-thprop', ['SSE', 'MCR'], state.dse.thProp || state.dse.th_prop || 'SSE');
    setOptions('pre-model', ['NONE', 'ONE_PROC_MAPPINGS'], state.presolver.model || 'NONE');
    setOptions('pre-search', ['NONESEARCH', 'FIRST', 'ALL', 'OPTIMIZE'], state.presolver.search || 'NONESEARCH');
    setOptions('pre-heuristic', ['NONE', 'TODAES'], state.presolver.heuristic || 'NONE');
    setOptions('pre-multisearch', ['NONESEARCH', 'FIRST', 'ALL', 'OPTIMIZE'], state.presolver.multiSearch || 'NONESEARCH');
    setOptions('out-type', ['ALL_OUT', 'TXT'], state.output.type || 'ALL_OUT');
    setOptions('out-freq', ['ALL_SOL', 'FIRSTandLAST', 'LAST'], state.output.freq || 'ALL_SOL');
    setOptions('out-metric', ['NONE'], 'NONE');
    setOptions('out-log-level', ['INFO', 'DEBUG', 'WARNING', 'ERROR', 'CRITICAL'], state.output.logLevel || 'INFO');

    syncConfigFromForm();
  }

  function numericInput(id, fallback = 0) {
    const value = Number(document.getElementById(id)?.value);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  function syncConfigFromForm() {
    state.dse = {
      ...(state.dse || {}),
      model: document.getElementById('dse-model')?.value || 'SDF_PR_ONLINE',
      search: document.getElementById('dse-search')?.value || 'FIRST',
      criteria: document.getElementById('dse-criteria')?.value || 'THROUGHPUT',
      thProp: document.getElementById('dse-thprop')?.value || 'SSE',
      threads: numericInput('dse-threads'),
      timeout1: numericInput('dse-timeout1'),
      timeout2: numericInput('dse-timeout2'),
      lubyScale: numericInput('dse-luby'),
      noGoodDepth: numericInput('dse-nogood', 75)
    };
    state.dse.th_prop = state.dse.thProp;

    state.presolver = {
      ...(state.presolver || {}),
      model: document.getElementById('pre-model')?.value || 'NONE',
      search: document.getElementById('pre-search')?.value || 'NONESEARCH',
      heuristic: document.getElementById('pre-heuristic')?.value || 'NONE',
      multiSearch: document.getElementById('pre-multisearch')?.value || 'NONESEARCH',
      timeout1: numericInput('pre-timeout1'),
      timeout2: numericInput('pre-timeout2')
    };

    state.output = {
      ...(state.output || {}),
      type: document.getElementById('out-type')?.value || 'ALL_OUT',
      freq: document.getElementById('out-freq')?.value || 'ALL_SOL',
      metric: 'NONE',
      logLevel: document.getElementById('out-log-level')?.value || 'INFO'
    };

    if (state.dse.search === 'FIRST' && state.output.freq === 'LAST') {
      state.output.freq = 'ALL_SOL';
      const outputFreq = document.getElementById('out-freq');
      if (outputFreq) outputFreq.value = 'ALL_SOL';
    }
    api.save?.();
  }

  function syncSystemConstraints() {
    state.sysConstraints = state.sysConstraints || {};
    for (const [key, id] of Object.entries(systemFields)) {
      const input = document.getElementById(id);
      if (input) state.sysConstraints[key] = positiveOrUnlimited(input.value);
    }
    state.sysConstraints.maxPower = state.sysConstraints.power;
    state.sysConstraints.maxUtil = state.sysConstraints.utilization;
    api.save?.();
  }

  function restoreSystemConstraints() {
    state.sysConstraints = state.sysConstraints || {};
    if (!(Number(state.sysConstraints.power) > 0) && Number(state.sysConstraints.maxPower) > 0) state.sysConstraints.power = Number(state.sysConstraints.maxPower);
    if (!(Number(state.sysConstraints.utilization) > 0) && Number(state.sysConstraints.maxUtil) > 0) state.sysConstraints.utilization = Number(state.sysConstraints.maxUtil);
    for (const [key, id] of Object.entries(systemFields)) {
      const input = document.getElementById(id);
      if (!input) continue;
      input.value = Number(state.sysConstraints[key]) > 0 ? String(state.sysConstraints[key]) : '';
      if (!input.dataset.nativeSyncBound) {
        input.dataset.nativeSyncBound = 'true';
        input.addEventListener('change', syncSystemConstraints);
      }
    }
  }

  function currentJob() {
    syncSystemConstraints();
    syncConfigFromForm();
    return {
      platform: deepClone(state.platform || {}),
      applications: deepClone(state.applications || []),
      wcets: deepClone(state.wcets || []),
      constraints: deepClone(state.constraints || []),
      sysConstraints: deepClone(state.sysConstraints || {}),
      dse: deepClone(state.dse || {}),
      presolver: deepClone(state.presolver || {}),
      output: deepClone(state.output || {})
    };
  }

  // ───────────────────────────── HTTP helpers ───────────────────────────────
  async function postJson(pathname, payload, timeoutMs = 60_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const text = await response.text();
      let data = {};
      try { data = JSON.parse(text); } catch (_) { data = { error: text }; }
      if (!response.ok || data.success === false || data.error) {
        throw new Error([data.error, data.stderr, data.stdout].filter(Boolean).join('\n') || `HTTP ${response.status}`);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  function setBusy(button, text) {
    if (!button) return () => {};
    const previous = button.textContent;
    button.disabled = true;
    button.textContent = text;
    return () => { button.disabled = false; button.textContent = previous; };
  }

  function writeLog(text, reset = false) {
    const target = document.getElementById('log-output');
    if (!target) return;
    if (reset) target.textContent = '';
    target.textContent += String(text || '');
    target.scrollTop = target.scrollHeight;
  }

  function interceptClick(id, handler) {
    const element = document.getElementById(id);
    if (!element) return;
    element.addEventListener('click', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      Promise.resolve(handler()).catch(error => {
        console.error(`[ParetoCo] ${id}:`, error);
        api.toast?.(error.name === 'AbortError' ? 'Request timed out.' : (error.message || 'Operation failed.'), 'error');
      });
    }, { capture: true });
  }

  // ───────────────────────────── Native launch ──────────────────────────────
  async function launchNative() {
    if (!state.platform?.processors?.length || !state.applications?.length) {
      throw new Error('No complete DSE model is loaded. Import or generate a model first.');
    }
    const button = document.getElementById('btn-launch');
    const restore = setBusy(button, 'Running native DSE…');
    writeLog(`ParetoCo Native DSE — ${new Date().toLocaleString()}\n`, true);
    api.setEngineStatus?.('running', 'Native engine running…');
    try {
      const result = await postJson('/api/launch', currentJob(), 75_000);
      writeLog(result.log || result.outTxt || result.stdout || 'Native run completed.');
      if (result.outTxt) api.loadResults?.(result.outTxt, 'out.txt');
      else if (result.outCsv) api.loadResults?.(result.outCsv, 'out.csv');
      api.setEngineStatus?.('done', 'Native engine finished');
      document.querySelector('.nav-item[data-page="results"]')?.click();
      api.toast?.('Native DSE exploration complete.', 'success');
      return result;
    } catch (error) {
      writeLog(`\n[ERROR]\n${error.message}\n`);
      api.setEngineStatus?.('error', 'Native engine failed');
      throw error;
    } finally {
      restore();
    }
  }
  api.launchEngine = launchNative;

  async function loadCleanDemo() {
    state.constraints = [];
    state.sysConstraints = { power: -1, utilization: -1, area: -1, cost: -1, procsUsed: -1, maxPower: -1, maxUtil: -1 };
    state.results = null;
    api.loadDemoPreset?.();
    Object.assign(state.dse, { model: 'SDF_PR_ONLINE', search: 'FIRST', criteria: 'THROUGHPUT', thProp: 'SSE', th_prop: 'SSE', lubyScale: 0 });
    state.output = { ...(state.output || {}), type: 'ALL_OUT', freq: 'ALL_SOL', metric: 'NONE', logLevel: 'INFO' };
    normalizeNativeControls();
    for (const id of Object.values(systemFields)) { const el = document.getElementById(id); if (el) el.value = ''; }
    api.save?.();
    writeLog('Clean demo loaded. Click “Launch DSE” to execute the real native solver.\n', true);
    api.toast?.('Clean native demo loaded.', 'success');
  }

  // ───────────────────────────── AI features ────────────────────────────────
  function renderMarkdown(text) {
    return escapeHtml(text || '')
      .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
      .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
      .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }

  async function generateInsights() {
    if (!state.results) throw new Error('Run DSE first.');
    const button = document.getElementById('btn-generate-insights');
    const restore = setBusy(button, 'Analyzing…');
    try {
      const rows = state.results.rows || [];
      const data = await postJson('/api/ai/insights', {
        appName: state.applications?.[0]?.name || 'Active workload',
        platformSummary: (state.platform?.processors || []).map(p => `${p.model} x${p.count || 1}`).join(', '),
        constraintsSummary: JSON.stringify({ application: state.constraints || [], system: state.sysConstraints || {} }),
        solutionsCount: rows.length,
        solutionsSummary: rows.slice(0, 20),
        outTxt: state.results.raw || ''
      }, 45_000);
      const target = document.getElementById('ai-markdown-render');
      if (target) target.innerHTML = renderMarkdown(data.insights || 'No analysis returned.');
    } finally {
      restore();
    }
  }

  function legacyDisplayPlatformXml(platform) {
    const processors = platform?.processors || [];
    const interconnects = platform?.interconnects || (platform?.interconnect ? [platform.interconnect] : []);
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<platform>\n';
    for (const proc of processors) {
      xml += `  <processor model="${escapeXml(proc.model)}" number="${Math.max(1, Number(proc.count) || 1)}">\n`;
      for (const mode of proc.modes || []) {
        xml += `    <mode name="${escapeXml(mode.name)}" cycle="${Number(mode.cycle) || 1}" mem="${Number(mode.mem) || 1}" dynPower="${Number(mode.dynPower) || 0}" staticPower="${Number(mode.staticPower) || 0}" area="${Number(mode.area) || 0}" monetary="${Number(mode.monetary) || 0}"/>\n`;
      }
      xml += '  </processor>\n';
    }
    for (const ic of interconnects) {
      xml += `  <TDN_BUS name="${escapeXml(ic.name || 'bus0')}" topology="${escapeXml(ic.topology || 'TDMA-bus')}" x-dimension="${Number(ic.xDim) || 1}" y-dimension="${Number(ic.yDim) || 1}" flitSize="${Number(ic.flitSize) || 32}" cycles="${Number(ic.cycles) || 1}"/>\n`;
    }
    xml += '</platform>\n';
    return xml;
  }

  function applyPlatformToUi(platform) {
    const exact = deepClone(platform);
    api.loadPlatformXml?.(legacyDisplayPlatformXml(exact));
    state.platform = exact;
    api.save?.();
  }

  async function autoOptimize() {
    const goal = document.getElementById('ai-auto-opt-input')?.value?.trim();
    if (!goal) throw new Error('Enter an optimization goal first.');
    if (!state.results) throw new Error('Run a baseline native DSE first.');
    const button = document.getElementById('btn-ai-auto-opt');
    const restore = setBusy(button, 'Proposing & native-verifying…');
    try {
      const data = await postJson('/api/ai/auto-optimize', {
        messages: [{ role: 'user', content: JSON.stringify({ goal, currentJob: currentJob(), baselineResults: state.results.raw || '' }) }]
      }, 120_000);
      if (!data.verification?.native || !data.platform?.processors?.length) throw new Error('No native-verified architecture was returned.');
      applyPlatformToUi(data.platform);
      if (data.verification.outTxt) api.loadResults?.(data.verification.outTxt, 'native-verified-out.txt');
      else if (data.verification.outCsv) api.loadResults?.(data.verification.outCsv, 'native-verified-out.csv');
      document.querySelector('.nav-item[data-page="results"]')?.click();
      api.toast?.(`Architecture native-verified (${data.verification.solutionCount} solution(s)).`, 'success');
    } finally {
      restore();
    }
  }

  function applyRepair(patch) {
    for (const op of patch || []) {
      if (op.target === 'constraint') {
        let index = Number.isInteger(op.index) ? op.index : -1;
        if (index < 0 && op.appName) index = (state.constraints || []).findIndex(c => (c.appName || c.app_name) === op.appName);
        if (index < 0 && state.constraints?.length === 1) index = 0;
        if (index >= 0 && state.constraints[index]) state.constraints[index][op.field] = Math.max(0, Number(op.value) || 0);
      } else if (op.target === 'sysConstraint') {
        state.sysConstraints[op.field] = Number(op.value) > 0 ? Number(op.value) : -1;
      } else if (op.target === 'processor' && op.field === 'count') {
        let index = Number.isInteger(op.index) ? op.index : -1;
        if (index < 0 && op.model) index = (state.platform.processors || []).findIndex(p => p.model === op.model);
        if (index >= 0) state.platform.processors[index].count = Math.max(1, Math.round(Number(op.value) || 1));
      }
    }
    restoreSystemConstraints();
    api.save?.();
  }

  function renderRepairs(options) {
    const container = document.getElementById('unsat-doctor-options');
    if (!container) return;
    container.replaceChildren();
    for (const option of options || []) {
      const card = document.createElement('div');
      card.style.cssText = 'background:#fff;border:1px solid #D7E0EA;padding:14px;border-radius:8px';
      const title = document.createElement('strong');
      title.textContent = option.title || 'Native-verified repair';
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.style.marginLeft = '8px';
      badge.textContent = `Native verified · ${option.verifiedSolutions || 0} solution(s)`;
      const text = document.createElement('p');
      text.textContent = option.explanation || 'Verified by the native solver.';
      const button = document.createElement('button');
      button.className = 'btn btn-primary btn-sm';
      button.textContent = 'Apply & rerun native DSE';
      button.addEventListener('click', async () => {
        applyRepair(option.patch);
        await launchNative();
      });
      card.append(title, badge, text, button);
      container.appendChild(card);
    }
  }

  async function diagnoseUnsat() {
    const button = document.getElementById('btn-unsat-doctor');
    const restore = setBusy(button, 'Native diagnosis…');
    const container = document.getElementById('unsat-doctor-options');
    if (container) container.textContent = 'Testing repair candidates with the real native solver…';
    try {
      const data = await postJson('/api/ai/unsat-doctor', {
        messages: [{ role: 'user', content: JSON.stringify({ currentJob: currentJob(), baselineResults: state.results?.raw || '0 solutions found' }) }]
      }, 120_000);
      if (data.alreadyFeasible) {
        if (container) container.textContent = data.message || 'The current model is feasible.';
      } else if (data.options?.length) {
        renderRepairs(data.options);
      } else if (container) {
        container.textContent = data.message || 'No single native-verified repair was found.';
      }
    } finally {
      restore();
    }
  }

  // ───────────────────────────── Robust imports ─────────────────────────────
  function readTextFile(inputId) {
    return new Promise((resolve, reject) => {
      const input = document.getElementById(inputId);
      if (!input) return reject(new Error(`Missing file input ${inputId}.`));
      input.value = '';
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        const reader = new FileReader();
        reader.onload = () => resolve({ text: String(reader.result || ''), name: file.name });
        reader.onerror = () => reject(reader.error || new Error('Could not read file.'));
        reader.readAsText(file);
      };
      input.click();
    });
  }

  function xmlDocument(text) {
    const doc = new DOMParser().parseFromString(String(text || ''), 'text/xml');
    const parserError = doc.querySelector('parsererror');
    if (parserError) throw new Error('The selected XML is malformed.');
    return doc;
  }

  async function importPlatform() {
    const file = await readTextFile('file-platform');
    if (!file) return;
    const doc = xmlDocument(file.text);
    const processors = [...doc.querySelectorAll('processor')].map(proc => ({
      model: proc.getAttribute('model') || proc.getAttribute('type') || proc.getAttribute('name') || '',
      count: Math.max(1, parseInt(proc.getAttribute('number'), 10) || 1),
      modes: [...proc.querySelectorAll('mode')].map(mode => ({
        name: mode.getAttribute('name') || 'default',
        cycle: Number(mode.getAttribute('cycle')) || 1,
        mem: Number(mode.getAttribute('mem')) || Number(proc.getAttribute('memory')) || 1,
        dynPower: Number(mode.getAttribute('dynPower')) || 0,
        staticPower: Number(mode.getAttribute('staticPower')) || 0,
        area: Number(mode.getAttribute('area')) || 0,
        monetary: Number(mode.getAttribute('monetary')) || 0
      }))
    })).map(proc => ({ ...proc, modes: proc.modes.length ? proc.modes : [{ name: 'default', cycle: 1, mem: 4096, dynPower: 0, staticPower: 0, area: 0, monetary: 0 }] }));

    const interconnects = [...doc.querySelectorAll('TDMA_bus, TDN_BUS, TDN_NoC')].map(ic => {
      const mode = ic.querySelector('mode');
      return {
        type: ic.tagName,
        name: ic.getAttribute('name') || 'bus0',
        topology: ic.getAttribute('topology') || (ic.tagName === 'TDMA_bus' ? 'TDMA-bus' : ''),
        xDim: Number(ic.getAttribute('x-dimension')) || 1,
        yDim: Number(ic.getAttribute('y-dimension')) || 1,
        routing: ic.getAttribute('routing') || '',
        flitSize: Number(ic.getAttribute('flitSize')) || 32,
        slots: Number(ic.getAttribute('tdma_slots')) || 2,
        maxSlotsPerProc: Number(ic.getAttribute('maxSlotsPerProc')) || 2,
        mode: mode ? {
          name: mode.getAttribute('name') || 'default',
          cycleLength: Number(mode.getAttribute('cycleLength')) || 1,
          dynPower_NI: Number(mode.getAttribute('dynPower_NI')) || 0,
          dynPower_bus: Number(mode.getAttribute('dynPower_bus')) || 0,
          staticPower_NI: Number(mode.getAttribute('staticPower_NI')) || 0,
          staticPower_bus: Number(mode.getAttribute('staticPower_bus')) || 0,
          area_NI: Number(mode.getAttribute('area_NI')) || 0,
          area_bus: Number(mode.getAttribute('area_bus')) || 0,
          monetary_NI: Number(mode.getAttribute('monetary_NI')) || 0,
          monetary_bus: Number(mode.getAttribute('monetary_bus')) || 0
        } : undefined
      };
    });
    if (!processors.length) throw new Error('No processor definitions were found in the platform XML.');
    applyPlatformToUi({ processors, interconnects });
    api.toast?.(`Platform loaded: ${processors.length} processor type(s).`, 'success');
  }

  async function importWcets() {
    const file = await readTextFile('file-wcet');
    if (!file) return;
    const doc = xmlDocument(file.text);
    const rows = [];
    for (const mapping of doc.querySelectorAll('mapping, systemMapping')) {
      const taskType = mapping.getAttribute('task_type') || mapping.getAttribute('taskType') || '';
      for (const wcet of mapping.querySelectorAll('wcet')) {
        rows.push({
          taskType,
          processor: wcet.getAttribute('processor') || '',
          procModel: wcet.getAttribute('processor') || '',
          mode: wcet.getAttribute('mode') || 'default',
          wcet: Number(wcet.getAttribute('wcet')) || 0
        });
      }
    }
    state.wcets = rows;
    let compatible = '<?xml version="1.0"?><WCET_table>';
    for (const row of rows) compatible += `<mapping task_type="${escapeXml(row.taskType)}"><wcet processor="${escapeXml(row.processor)}" mode="${escapeXml(row.mode)}" wcet="${row.wcet}"/></mapping>`;
    compatible += '</WCET_table>';
    api.loadWcetXml?.(compatible);
    state.wcets = rows;
    api.save?.();
  }

  async function importConstraints() {
    const file = await readTextFile('file-constraints');
    if (!file) return;
    const doc = xmlDocument(file.text);
    const constraints = [];
    const sys = { ...(state.sysConstraints || {}) };
    let systemRead = false;
    for (const element of doc.querySelectorAll('constraint')) {
      const appName = element.getAttribute('app_name');
      if (appName) constraints.push({ appName, period: Number(element.getAttribute('period')) || 0, latency: Number(element.getAttribute('latency')) || 0 });
      if (!systemRead) {
        const map = { power: 'power', utilization: 'utilization', area: 'area', cost: 'money', procsUsed: 'procsUsed' };
        for (const [key, attr] of Object.entries(map)) {
          if (element.hasAttribute(attr)) sys[key] = positiveOrUnlimited(element.getAttribute(attr));
        }
        systemRead = true;
      }
    }
    state.constraints = constraints;
    state.sysConstraints = sys;
    let compatible = '<?xml version="1.0"?><designConstraints>';
    for (const row of constraints) compatible += `<constraint app_name="${escapeXml(row.appName)}" period="${row.period}" latency="${row.latency}"></constraint>`;
    compatible += '</designConstraints>';
    api.loadConstraintsXml?.(compatible);
    state.constraints = constraints;
    state.sysConstraints = sys;
    restoreSystemConstraints();
    api.save?.();
  }

  async function importConfig() {
    const file = await readTextFile('file-config');
    if (!file) return;
    let section = '';
    for (const raw of file.text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const sectionMatch = line.match(/^\[(.+)\]$/);
      if (sectionMatch) { section = sectionMatch[1].toLowerCase(); continue; }
      const equal = line.indexOf('=');
      if (equal < 0) continue;
      const key = line.slice(0, equal).trim();
      const value = line.slice(equal + 1).trim();
      if (!section) {
        if (key === 'output-file-type') state.output.type = value.toUpperCase();
        if (key === 'output-print-frequency') state.output.freq = value;
        if (key === 'log-level') state.output.logLevel = value.split(/\s+/)[0].toUpperCase();
      } else if (section === 'dse') {
        if (key === 'model') state.dse.model = value.toUpperCase();
        if (key === 'search') state.dse.search = value.toUpperCase();
        if (key === 'criteria') state.dse.criteria = value.toUpperCase();
        if (key === 'th_prop') state.dse.thProp = value.toUpperCase();
        if (key === 'threads') state.dse.threads = Number(value) || 0;
        if (key === 'luby_scale') state.dse.lubyScale = Number(value) || 0;
        if (key === 'noGoodDepth') state.dse.noGoodDepth = Number(value) || 0;
        if (key === 'timeout') {
          const [a, b] = value.split(/\s+/).map(Number);
          state.dse.timeout1 = Number.isFinite(a) ? a : 0;
          state.dse.timeout2 = Number.isFinite(b) ? b : 0;
        }
      } else if (section === 'presolver') {
        if (key === 'model') state.presolver.model = value.toUpperCase();
        if (key === 'search') state.presolver.search = value.toUpperCase();
        if (key === 'heuristic') state.presolver.heuristic = value.toUpperCase();
        if (key === 'multi-search') state.presolver.multiSearch = value.toUpperCase();
        if (key === 'timeout') {
          const [a, b] = value.split(/\s+/).map(Number);
          state.presolver.timeout1 = Number.isFinite(a) ? a : 0;
          state.presolver.timeout2 = Number.isFinite(b) ? b : 0;
        }
      }
    }
    normalizeNativeControls();
    api.save?.();
    api.toast?.('Configuration imported and normalized to supported native options.', 'success');
  }

  // ───────────────────── Honest Architecture Studio overlay ─────────────────
  function installNativeMappingOverlay() {
    if (!window.ArchStudio || window.ArchStudio.__nativeMappingOverlay) return;
    window.ArchStudio.applyResultOverlay = function applyNativeMappingOverlay() {
      const studio = window.ArchStudio.getStudio?.();
      const rows = state.results?.rows || [];
      if (!studio || !rows.length) {
        if (studio) studio.overlayVisible = false;
        return;
      }
      studio.overlayVisible = true;
      for (const node of studio.platformNodes || []) node.overlay = { utilization: 0, power: 0, mappedTasks: [], isCritical: false, memPressure: 0 };
      for (const node of studio.workloadNodes || []) node.overlay = { mappedTo: null, startTime: 0, endTime: 0, isCritical: false };
      for (const edge of [...(studio.platformEdges || []), ...(studio.workloadEdges || [])]) edge.overlay = { saturated: false, utilization: 0, dataRate: 0, isCritical: false };

      const mapping = String(rows[rows.length - 1]['PE Mapping'] || '')
        .split(/[,\s]+/)
        .map(Number)
        .filter(Number.isInteger);
      const processingElements = (studio.platformNodes || []).filter(node => !['NoC', 'Bus', 'Memory'].includes(node.type));
      mapping.forEach((peIndex, taskIndex) => {
        if (studio.workloadNodes?.[taskIndex]) studio.workloadNodes[taskIndex].overlay.mappedTo = peIndex;
        if (processingElements[peIndex]) processingElements[peIndex].overlay.mappedTasks.push(taskIndex);
      });
    };
    window.ArchStudio.__nativeMappingOverlay = true;
  }

  // ───────────────────────────── Initialization ─────────────────────────────
  ensureFeatureSurfaces();
  restoreSystemConstraints();
  normalizeNativeControls();
  installNativeMappingOverlay();

  document.querySelector('label[for="sys-power"]')?.replaceChildren(document.createTextNode('Max Power (mW)'));
  document.querySelector('label[for="sys-utilization"]')?.replaceChildren(document.createTextNode('Min Utilization (%)'));
  document.querySelector('label[for="sys-procs"]')?.replaceChildren(document.createTextNode('Active Processors (exact)'));

  for (const id of ['dse-model','dse-search','dse-criteria','dse-thprop','dse-threads','dse-timeout1','dse-timeout2','dse-luby','dse-nogood','pre-model','pre-search','pre-heuristic','pre-multisearch','pre-timeout1','pre-timeout2','out-type','out-freq','out-log-level']) {
    document.getElementById(id)?.addEventListener('change', syncConfigFromForm);
  }

  interceptClick('btn-launch', launchNative);
  interceptClick('btn-demo-preset', loadCleanDemo);
  interceptClick('btn-generate-insights', generateInsights);
  interceptClick('btn-ai-auto-opt', autoOptimize);
  interceptClick('btn-unsat-doctor', diagnoseUnsat);
  interceptClick('btn-load-platform-xml', importPlatform);
  interceptClick('btn-load-wcet-xml', importWcets);
  interceptClick('btn-load-constraints-xml', importConstraints);
  interceptClick('btn-import-config', importConfig);

  document.getElementById('nav-arch-studio')?.addEventListener('click', () => {
    try { window.ArchStudio?.clear?.(); window.ArchStudio?.syncCanvasFromModel?.(); } catch (_) {}
  }, { capture: true });

  console.info('[ParetoCo] Clean UI integration loaded: modular imports, native-only DSE, native-verified AI.');
})();
