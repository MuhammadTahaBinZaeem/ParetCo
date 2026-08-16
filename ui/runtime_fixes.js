/*
 * ParetoCo UI integration.
 *
 * This file intentionally uses public window.paretoco APIs instead of rewriting
 * app.js, overriding window.fetch, or fabricating solver results.
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

  function setOptions(id, values, preferred) {
    const select = document.getElementById(id);
    if (!select) return;
    const current = String(preferred ?? select.value ?? '');
    select.replaceChildren(...values.map(value => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      return option;
    }));
    select.value = values.includes(current) ? current : values[0];
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function normalizeNativeControls() {
    setOptions('dse-model', ['SDF_PR_ONLINE'], state.dse?.model || 'SDF_PR_ONLINE');
    setOptions('dse-search', ['FIRST', 'ALL', 'OPTIMIZE', 'OPTIMIZE_IT'], state.dse?.search || 'FIRST');
    setOptions('dse-criteria', ['THROUGHPUT', 'POWER', 'NONE'], state.dse?.criteria || 'THROUGHPUT');
    setOptions('dse-thprop', ['SSE', 'MCR'], state.dse?.thProp || state.dse?.th_prop || 'SSE');
    setOptions('pre-model', ['NONE', 'ONE_PROC_MAPPINGS'], state.presolver?.model || 'NONE');
    setOptions('pre-search', ['NONESEARCH', 'FIRST', 'ALL', 'OPTIMIZE'], state.presolver?.search || 'NONESEARCH');
    setOptions('pre-heuristic', ['NONE', 'TODAES'], state.presolver?.heuristic || 'NONE');
    setOptions('pre-multisearch', ['NONESEARCH', 'FIRST', 'ALL', 'OPTIMIZE'], state.presolver?.multiSearch || 'NONESEARCH');
    setOptions('out-type', ['ALL_OUT', 'TXT'], state.output?.type || 'ALL_OUT');
    setOptions('out-freq', ['ALL_SOL', 'FIRSTandLAST', 'LAST'], state.output?.freq || 'ALL_SOL');
    setOptions('out-metric', ['NONE'], 'NONE');
    setOptions('out-log-level', ['INFO', 'DEBUG', 'WARNING', 'ERROR', 'CRITICAL'], state.output?.logLevel || 'INFO');

    Object.assign(state.dse, {
      model: document.getElementById('dse-model')?.value || 'SDF_PR_ONLINE',
      search: document.getElementById('dse-search')?.value || 'FIRST',
      criteria: document.getElementById('dse-criteria')?.value || 'THROUGHPUT',
      thProp: document.getElementById('dse-thprop')?.value || 'SSE'
    });
    state.dse.th_prop = state.dse.thProp;
    state.output = state.output || {};
    state.output.freq = document.getElementById('out-freq')?.value || 'ALL_SOL';
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
      input.addEventListener('change', syncSystemConstraints);
    }
  }

  function currentJob() {
    syncSystemConstraints();
    const dse = deepClone(state.dse || {});
    dse.th_prop = dse.th_prop || dse.thProp || 'SSE';
    return {
      platform: deepClone(state.platform || {}),
      applications: deepClone(state.applications || []),
      wcets: deepClone(state.wcets || []),
      constraints: deepClone(state.constraints || []),
      sysConstraints: deepClone(state.sysConstraints || {}),
      dse,
      presolver: deepClone(state.presolver || {}),
      output: deepClone(state.output || {})
    };
  }

  function interceptClick(id, handler) {
    const element = document.getElementById(id);
    if (!element) return;
    element.addEventListener('click', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      Promise.resolve(handler()).catch(error => {
        console.error(`[ParetoCo] ${id}:`, error);
        api.toast?.(error.message || 'Operation failed.', 'error');
      });
    }, { capture: true });
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
    Object.assign(state.dse, { model: 'SDF_PR_ONLINE', search: 'FIRST', criteria: 'THROUGHPUT', thProp: 'SSE', th_prop: 'SSE' });
    state.output = { ...(state.output || {}), type: 'ALL_OUT', freq: 'ALL_SOL', metric: 'NONE', logLevel: 'INFO' };
    normalizeNativeControls();
    for (const id of Object.values(systemFields)) { const el = document.getElementById(id); if (el) el.value = ''; }
    api.save?.();
    writeLog('Clean demo loaded. Click “Launch DSE” to execute the real native solver.\n', true);
    api.toast?.('Clean native demo loaded.', 'success');
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

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

  function platformXml(platform) {
    const processors = platform?.processors || [];
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<platform>\n';
    for (const proc of processors) {
      xml += `  <processor model="${escapeHtml(proc.model)}" number="${Math.max(1, Number(proc.count) || 1)}">\n`;
      for (const mode of proc.modes || []) {
        xml += `    <mode name="${escapeHtml(mode.name)}" cycle="${Number(mode.cycle) || 1}" mem="${Number(mode.mem) || 1}" dynPower="${Number(mode.dynPower) || 0}" staticPower="${Number(mode.staticPower) || 0}" area="${Number(mode.area) || 0}" monetary="${Number(mode.monetary) || 0}"/>\n`;
      }
      xml += '  </processor>\n';
    }
    xml += '</platform>\n';
    return xml;
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
      api.loadPlatformXml?.(platformXml(data.platform));
      if (data.verification.outTxt) api.loadResults?.(data.verification.outTxt, 'native-verified-out.txt');
      else if (data.verification.outCsv) api.loadResults?.(data.verification.outCsv, 'native-verified-out.csv');
      api.save?.();
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

  function sanitizeArchitectureOverlay() {
    if (!window.ArchStudio?.applyResultOverlay || window.ArchStudio.__nativeOverlaySanitized) return;
    const original = window.ArchStudio.applyResultOverlay.bind(window.ArchStudio);
    window.ArchStudio.applyResultOverlay = function() {
      original();
      const studio = window.ArchStudio.getStudio?.();
      if (!studio) return;
      for (const node of studio.platformNodes || []) {
        if (!node.overlay) continue;
        node.overlay.utilization = 0;
        node.overlay.power = 0;
        node.overlay.memPressure = 0;
        node.overlay.isCritical = false;
      }
      for (const edge of [...(studio.platformEdges || []), ...(studio.workloadEdges || [])]) {
        if (!edge.overlay) continue;
        edge.overlay.utilization = 0;
        edge.overlay.dataRate = 0;
        edge.overlay.saturated = false;
        edge.overlay.isCritical = false;
      }
    };
    window.ArchStudio.__nativeOverlaySanitized = true;
  }

  restoreSystemConstraints();
  normalizeNativeControls();
  document.querySelector('label[for="sys-power"]')?.replaceChildren(document.createTextNode('Max Power (mW)'));
  document.querySelector('label[for="sys-utilization"]')?.replaceChildren(document.createTextNode('Min Utilization (%)'));
  document.querySelector('label[for="sys-procs"]')?.replaceChildren(document.createTextNode('Active Processors (exact)'));

  interceptClick('btn-launch', launchNative);
  interceptClick('btn-demo-preset', loadCleanDemo);
  interceptClick('btn-generate-insights', generateInsights);
  interceptClick('btn-ai-auto-opt', autoOptimize);
  interceptClick('btn-unsat-doctor', diagnoseUnsat);
  sanitizeArchitectureOverlay();

  console.info('[ParetoCo] Clean UI integration loaded: native-only launch and native-verified AI flows.');
})();
