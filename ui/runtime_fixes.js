/* ParetoCo browser reliability layer.
 * Keeps UI state, native XML payloads, demo state, AI requests, and verification
 * claims consistent without changing the native engine.
 */
(() => {
  'use strict';

  const api = window.paretoco;
  if (!api || !api.state) return;
  const state = api.state;
  if (!state.config) state.config = state.dse;

  const constraintFields = {
    power: 'sys-power',
    utilization: 'sys-utilization',
    area: 'sys-area',
    cost: 'sys-cost',
    procsUsed: 'sys-procs'
  };

  function positiveNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : -1;
  }

  function deepClone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function syncSystemConstraintsFromForm() {
    state.sysConstraints = state.sysConstraints || {};
    for (const [key, id] of Object.entries(constraintFields)) {
      const el = document.getElementById(id);
      if (!el) continue;
      state.sysConstraints[key] = positiveNumber(el.value);
    }
    state.sysConstraints.maxPower = state.sysConstraints.power;
    state.sysConstraints.maxUtil = state.sysConstraints.utilization;
    api.save?.();
  }

  function restoreSystemConstraintForm() {
    state.sysConstraints = state.sysConstraints || {};
    if (!(Number(state.sysConstraints.power) > 0) && Number(state.sysConstraints.maxPower) > 0) {
      state.sysConstraints.power = Number(state.sysConstraints.maxPower);
    }
    if (!(Number(state.sysConstraints.utilization) > 0) && Number(state.sysConstraints.maxUtil) > 0) {
      state.sysConstraints.utilization = Number(state.sysConstraints.maxUtil);
    }
    for (const [key, id] of Object.entries(constraintFields)) {
      const el = document.getElementById(id);
      if (!el) continue;
      const value = Number(state.sysConstraints[key]);
      el.value = Number.isFinite(value) && value > 0 ? String(value) : '';
      el.addEventListener('input', syncSystemConstraintsFromForm);
      el.addEventListener('change', syncSystemConstraintsFromForm);
    }
    state.sysConstraints.maxPower = state.sysConstraints.power;
    state.sysConstraints.maxUtil = state.sysConstraints.utilization;
  }

  function xmlEscape(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function xmlNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  function buildPlatformXml(platform) {
    const processors = Array.isArray(platform?.processors) ? platform.processors : [];
    const interconnects = Array.isArray(platform?.interconnects)
      ? platform.interconnects
      : (platform?.interconnect ? [platform.interconnect] : []);
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<platform name="generated_platform">\n';
    for (const proc of processors) {
      const model = xmlEscape(proc.model || 'ARM');
      const count = Math.max(1, parseInt(proc.count, 10) || 1);
      xml += `  <processor model="${model}" number="${count}">\n`;
      const modes = Array.isArray(proc.modes) && proc.modes.length ? proc.modes : [{ name: 'default', cycle: 1, mem: 4096, dynPower: 10, staticPower: 2, area: 5, monetary: 10 }];
      for (const mode of modes) {
        xml += `    <mode name="${xmlEscape(mode.name || 'default')}" cycle="${xmlNumber(mode.cycle, 1)}" mem="${xmlNumber(mode.mem, 4096)}" dynPower="${xmlNumber(mode.dynPower, 0)}" staticPower="${xmlNumber(mode.staticPower, 0)}" area="${xmlNumber(mode.area, 0)}" monetary="${xmlNumber(mode.monetary, 0)}"/>\n`;
      }
      xml += '  </processor>\n';
    }
    const totalCores = processors.reduce((sum, proc) => sum + (parseInt(proc.count, 10) || 1), 0);
    const ic = interconnects[0] || { name: 'bus0', topology: 'TDMA-bus', xDim: Math.max(1, totalCores), yDim: 1, flitSize: 32, slots: Math.max(2, totalCores) };
    const slots = Math.max(1, parseInt(ic.slots ?? ic.tdma_slots, 10) || Math.max(2, totalCores));
    const mode = ic.mode || {};
    xml += '  <interconnect>\n';
    xml += `    <TDMA_bus name="${xmlEscape(ic.name || 'bus0')}" x-dimension="${Math.max(1, parseInt(ic.xDim ?? ic['x-dimension'], 10) || Math.max(1, totalCores))}" y-dimension="${Math.max(1, parseInt(ic.yDim ?? ic['y-dimension'], 10) || 1)}" flitSize="${Math.max(1, parseInt(ic.flitSize, 10) || 32)}" tdma_slots="${slots}" maxSlotsPerProc="${Math.max(1, parseInt(ic.maxSlotsPerProc, 10) || slots)}">\n`;
    xml += `      <mode name="${xmlEscape(mode.name || 'default')}" cycleLength="${xmlNumber(mode.cycleLength, 1)}" dynPower_NI="${xmlNumber(mode.dynPower_NI, 1)}" dynPower_bus="${xmlNumber(mode.dynPower_bus, 1)}" staticPower_NI="${xmlNumber(mode.staticPower_NI, 1)}" staticPower_bus="${xmlNumber(mode.staticPower_bus, 1)}" area_NI="${xmlNumber(mode.area_NI, 1)}" area_bus="${xmlNumber(mode.area_bus, 1)}" monetary_NI="${xmlNumber(mode.monetary_NI, 1)}" monetary_bus="${xmlNumber(mode.monetary_bus, 1)}"/>\n`;
    xml += '    </TDMA_bus>\n  </interconnect>\n</platform>\n';
    return xml;
  }

  function buildConstraintsXml(constraints, sysConstraints) {
    const rows = Array.isArray(constraints) ? constraints : [];
    const sys = sysConstraints || {};
    const systemAttrs = [];
    if (positiveNumber(sys.power) > 0) systemAttrs.push(`power="${Math.round(Number(sys.power))}"`);
    if (positiveNumber(sys.area) > 0) systemAttrs.push(`area="${Math.round(Number(sys.area))}"`);
    if (positiveNumber(sys.cost) > 0) systemAttrs.push(`money="${Math.round(Number(sys.cost))}"`);
    if (positiveNumber(sys.utilization) > 0) systemAttrs.push(`utilization="${Math.round(Number(sys.utilization))}"`);
    if (positiveNumber(sys.procsUsed) > 0) systemAttrs.push(`procsUsed="${Math.round(Number(sys.procsUsed))}"`);
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<designConstraints>\n';
    for (const c of rows) {
      const attrs = [
        `app_name="${xmlEscape(c.appName || c.app_name || 'App')}"`,
        `period="${Math.max(0, parseInt(c.period, 10) || 0)}"`,
        `latency="${Math.max(0, parseInt(c.latency, 10) || 0)}"`,
        ...systemAttrs
      ];
      xml += `  <constraint ${attrs.join(' ')}></constraint>\n`;
    }
    if (rows.length === 0 && systemAttrs.length) xml += `  <constraint ${systemAttrs.join(' ')}></constraint>\n`;
    xml += '</designConstraints>\n';
    return xml;
  }

  function currentJob() {
    syncSystemConstraintsFromForm();
    const dse = deepClone(state.dse || {});
    dse.thProp = dse.thProp || dse.th_prop || 'SSE';
    dse.th_prop = dse.th_prop || dse.thProp;
    return {
      platform: deepClone(state.platform || {}),
      applications: deepClone(state.applications || []),
      wcets: deepClone(state.wcets || []),
      constraints: deepClone(state.constraints || []),
      sysConstraints: deepClone(state.sysConstraints || {}),
      dse,
      presolver: deepClone(state.presolver || {})
    };
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderSafeMarkdown(text) {
    return escapeHtml(text || '')
      .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
      .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
      .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/^[-*]\s+(.+)$/gm, '• $1')
      .replace(/\n/g, '<br>');
  }

  function setButtonBusy(button, busyText) {
    if (!button) return () => {};
    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
    return () => { button.disabled = false; button.textContent = oldText; };
  }

  function resetResultsUi() {
    state.results = null;
    document.getElementById('results-empty')?.classList.remove('hidden');
    document.getElementById('results-content')?.classList.add('hidden');
    document.getElementById('unsat-doctor-container')?.classList.add('hidden');
    for (const id of ['results-summary', 'results-tbody', 'results-thead']) {
      const el = document.getElementById(id); if (el) el.textContent = '';
    }
    const kpi = document.getElementById('kpi-solutions'); if (kpi) kpi.textContent = '—';
  }

  function interceptClick(id, handler) {
    const element = document.getElementById(id);
    if (!element) return;
    element.addEventListener('click', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      Promise.resolve(handler(event)).catch(error => {
        console.error(`[ParetoCo reliability] ${id} failed:`, error);
        api.toast?.(error.message || 'Operation failed.', 'error');
      });
    }, { capture: true });
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async function paretocoFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const nextInit = { ...init };
    if (/\/api\/launch(?:\?|$)/.test(url) && typeof nextInit.body === 'string') {
      syncSystemConstraintsFromForm();
      try {
        const payload = JSON.parse(nextInit.body);
        payload.sysConstraints = { ...(payload.sysConstraints || {}), ...(state.sysConstraints || {}) };
        payload.constraintsXml = buildConstraintsXml(payload.constraints || state.constraints, payload.sysConstraints);
        if (payload.platform?.processors?.length) payload.platformXml = buildPlatformXml(payload.platform);
        if (payload.dse) {
          payload.dse.thProp = payload.dse.thProp || payload.dse.th_prop || 'SSE';
          payload.dse.th_prop = payload.dse.th_prop || payload.dse.thProp;
        }
        nextInit.body = JSON.stringify(payload);
      } catch (err) {
        console.error('[ParetoCo reliability] Could not normalize launch payload:', err);
      }
    }
    const isAi = /\/api\/ai\//.test(url);
    if (!isAi || nextInit.signal) return originalFetch(input, nextInit);
    const controller = new AbortController();
    nextInit.signal = controller.signal;
    const longAgent = /\/api\/ai\/(?:auto-optimize|unsat-doctor)/.test(url);
    const timer = setTimeout(() => controller.abort(new DOMException('AI request timed out', 'TimeoutError')), longAgent ? 120_000 : 45_000);
    try { return await originalFetch(input, nextInit); }
    finally { clearTimeout(timer); }
  };

  function writeLog(text, reset = false) {
    const log = document.getElementById('log-output');
    if (!log) return;
    if (reset) log.textContent = '';
    log.textContent += String(text || '');
    log.scrollTop = log.scrollHeight;
  }

  async function nativeLaunch() {
    if (!state.platform?.processors?.length || !state.applications?.length) {
      throw new Error('No DSE model is loaded. Use Load Demo, import a model, or generate one with NL-to-DSE first.');
    }
    const endpoint = (api.getEngineUrl?.() || '') + '/api/launch';
    const job = currentJob();
    job.config = api.generateConfig?.() || '';
    writeLog('═══════════════════════════════════════════════════\n', true);
    writeLog(` ParetoCo Native DSE — ${new Date().toLocaleString()}\n`);
    writeLog('═══════════════════════════════════════════════════\n\n');
    writeLog(`[HTTP] Launching native solver at ${endpoint} ...\n`);
    api.setEngineStatus?.('running', 'Native engine running…');
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job) });
      const text = await response.text();
      let data = {};
      try { data = JSON.parse(text); } catch (_) { data = { error: text || `HTTP ${response.status}` }; }
      if (!response.ok || data.success === false) {
        throw new Error([data.error, data.stderr, data.stdout].filter(Boolean).join('\n') || `HTTP ${response.status}`);
      }
      if (!data.outTxt && !data.outCsv) throw new Error('Native solver returned no result file.');
      writeLog(`\n${data.log || data.outTxt || 'Native DSE completed.'}\n`);
      if (data.outTxt) api.loadResults?.(data.outTxt, 'out.txt');
      else api.loadResults?.(data.outCsv, 'out.csv');
      api.setEngineStatus?.('done', 'Native engine finished');
      document.querySelector('.nav-item[data-page="results"]')?.click();
      api.toast?.('Native DSE exploration complete.', 'success');
      return data;
    } catch (error) {
      writeLog(`\n[ERROR] Native DSE failed:\n${error.message}\n`);
      api.setEngineStatus?.('error', 'Native engine failed');
      api.toast?.('Native DSE failed. See Engine Output for the real error.', 'error');
      throw error;
    }
  }
  api.launchEngine = nativeLaunch;

  async function loadCleanDemo() {
    state.constraints = [];
    state.sysConstraints = { power: -1, utilization: -1, area: -1, cost: -1, procsUsed: -1, maxPower: -1, maxUtil: -1 };
    resetResultsUi();
    if (typeof api.loadDemoPreset !== 'function') throw new Error('Demo loader is unavailable.');
    api.loadDemoPreset();
    api.loadConstraintsXml?.('<?xml version="1.0" encoding="UTF-8"?>\n<designConstraints>\n  <constraint app_name="TestApp" period="1000" latency="0"></constraint>\n</designConstraints>\n');
    Object.assign(state.dse, { model: 'SDF_PR_ONLINE', search: 'FIRST', criteria: 'THROUGHPUT', thProp: 'SSE', th_prop: 'SSE' });
    for (const [id, value] of [['dse-model','SDF_PR_ONLINE'],['dse-search','FIRST'],['dse-criteria','THROUGHPUT'],['dse-thprop','SSE']]) {
      const el = document.getElementById(id); if (el) el.value = value;
    }
    for (const id of Object.values(constraintFields)) { const el = document.getElementById(id); if (el) el.value = ''; }
    const selector = document.getElementById('app-selector');
    if (selector && selector.options.length > 1) { selector.value = '0'; selector.dispatchEvent(new Event('change', { bubbles: true })); }
    const log = document.getElementById('log-output');
    if (log) log.textContent = 'Clean demo loaded. Click “Launch DSE” to run the real native engine.\n';
    api.save?.();
    api.toast?.('Clean native demo loaded: TestApp, 2× ARM, FIRST search.', 'success');
  }

  function deterministicInsights() {
    const rows = state.results?.rows || [];
    const appName = state.applications?.[0]?.name || 'Active workload';
    const procSummary = (state.platform?.processors || []).map(proc => `${proc.model} ×${proc.count || 1}`).join(', ') || 'No platform';
    if (!rows.length) return `### No feasible solution\nThe current native DSE result contains **0 feasible solutions** for ${appName}.\n\n- Platform: ${procSummary}\n- Use the UNSAT Doctor to test repairs with native solver runs.`;
    const numeric = rows.map((row,index) => ({
      number: row['Solution #'] || index + 1,
      period: Number(row._period) || Number.parseFloat(row['Period']) || 0,
      power: Number(row._power) || Number.parseFloat(row['Power (mW)']) || 0
    }));
    const periods = numeric.filter(x => x.period > 0).sort((a,b) => a.period-b.period);
    const powers = numeric.filter(x => x.power > 0).sort((a,b) => a.power-b.power);
    let text = `### DSE result summary\nParetoCo shows **${rows.length} native feasible solution(s)** for ${appName}.\n\n- Platform: ${procSummary}`;
    if (periods[0]) text += `\n- Lowest observed period: **${periods[0].period} cycles** (Solution #${periods[0].number})`;
    if (powers[0]) text += `\n- Lowest observed power lower-bound/value: **${powers[0].power} mW** (Solution #${powers[0].number})`;
    text += '\n\nNo unsupported percentage improvement or bottleneck claim is added by this fallback.';
    return text;
  }

  async function generateInsightsFixed() {
    if (!state.results) return api.toast?.('Run DSE first, then generate insights.', 'error');
    const button = document.getElementById('btn-generate-insights');
    const restore = setButtonBusy(button, 'Analyzing…');
    const output = document.getElementById('ai-markdown-render');
    if (output) output.textContent = 'Analyzing the current native result…';
    try {
      const response = await fetch('/api/ai/insights', {
        method: 'POST', headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({
          appName: state.applications?.[0]?.name || 'Active workload',
          platformSummary: (state.platform?.processors || []).map(p => `${p.model} x${p.count || 1}`).join(', '),
          constraintsSummary: JSON.stringify({ application: state.constraints || [], system: state.sysConstraints || {} }),
          solutionsCount: state.results.rows?.length || 0,
          solutionsSummary: (state.results.rows || []).slice(0,20),
          outTxt: state.results.raw || ''
        })
      });
      const data = await response.json().catch(() => ({}));
      const report = response.ok && data.insights ? data.insights : deterministicInsights();
      if (output) output.innerHTML = renderSafeMarkdown(report);
      api.toast?.(data.insights ? 'AI analysis generated.' : 'Deterministic result analysis generated.', 'success');
    } catch (error) {
      if (output) output.innerHTML = renderSafeMarkdown(deterministicInsights());
      api.toast?.(`AI unavailable: ${error.message}. Showing deterministic analysis.`, 'info');
    } finally { restore(); }
  }

  async function autoOptimizeFixed() {
    const input = document.getElementById('ai-auto-opt-input');
    const goal = input?.value?.trim();
    if (!goal) return api.toast?.('Enter an optimization goal first.', 'error');
    if (!state.results) return api.toast?.('Run a baseline native DSE first.', 'error');
    const button = document.getElementById('btn-ai-auto-opt');
    const restore = setButtonBusy(button, 'Proposing & native-verifying…');
    try {
      const response = await fetch('/api/ai/auto-optimize', {
        method: 'POST', headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({
          budgetPrompt: goal,
          platform: state.platform,
          resultsText: state.results.raw || JSON.stringify(state.results.rows || []),
          messages: [{ role: 'user', content: JSON.stringify({ goal, currentJob: currentJob(), baselineResults: state.results.raw || '' }) }]
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      if (!data.platform?.processors?.length || !data.verification?.native) throw new Error('Auto-Optimize returned no native-verified architecture.');
      (data.logs || []).forEach(log => api.appendLog?.(`${log}\n`));
      api.loadPlatformXml?.(buildPlatformXml(data.platform));
      if (data.verification.outTxt) api.loadResults?.(data.verification.outTxt, 'native-verified-out.txt');
      else if (data.verification.outCsv) api.loadResults?.(data.verification.outCsv, 'native-verified-out.csv');
      api.save?.();
      document.querySelector('.nav-item[data-page="results"]')?.click();
      const improvement = Number.isFinite(Number(data.improvementPct)) ? `, ${Number(data.improvementPct).toFixed(1)}% objective improvement` : '';
      api.toast?.(`Architecture native-verified (${data.verification.solutionCount} solution(s)${improvement}).`, 'success');
      if (input) input.value = '';
    } finally { restore(); }
  }

  function applyPatch(patch) {
    for (const op of Array.isArray(patch) ? patch : []) {
      if (op.target === 'constraint') {
        let index = Number.isInteger(op.index) ? op.index : -1;
        if (index < 0 && op.appName) index = (state.constraints || []).findIndex(c => (c.appName || c.app_name) === op.appName);
        if (index < 0 && state.constraints?.length === 1) index = 0;
        if (index < 0 || !state.constraints[index]) continue;
        state.constraints[index][op.field] = Math.max(0, Number(op.value) || 0);
      } else if (op.target === 'sysConstraint') {
        state.sysConstraints[op.field] = Number(op.value) > 0 ? Number(op.value) : -1;
      } else if (op.target === 'processor' && op.field === 'count') {
        let index = Number.isInteger(op.index) ? op.index : -1;
        if (index < 0 && op.model) index = (state.platform.processors || []).findIndex(p => p.model === op.model);
        if (index < 0 && state.platform.processors?.length === 1) index = 0;
        if (index >= 0) state.platform.processors[index].count = Math.max(1, Math.round(Number(op.value) || 1));
      }
    }
    api.loadPlatformXml?.(buildPlatformXml(state.platform));
    api.loadConstraintsXml?.(buildConstraintsXml(state.constraints, state.sysConstraints));
    for (const [key,id] of Object.entries(constraintFields)) {
      const el = document.getElementById(id); if (el) el.value = Number(state.sysConstraints[key]) > 0 ? String(state.sysConstraints[key]) : '';
    }
    api.save?.();
  }

  function renderVerifiedUnsatOptions(options) {
    const container = document.getElementById('unsat-doctor-options');
    if (!container) return;
    container.textContent = '';
    for (const option of options || []) {
      const card = document.createElement('div');
      card.style.cssText = 'background:#fff;border:1px solid #D7E0EA;padding:14px;border-radius:8px';
      const title = document.createElement('strong'); title.textContent = option.title || 'Native-verified repair';
      const badge = document.createElement('span'); badge.className = 'badge'; badge.style.marginLeft='8px'; badge.textContent = `Native verified · ${option.verifiedSolutions || 0}`;
      const explanation = document.createElement('p'); explanation.style.margin='8px 0 12px'; explanation.textContent = option.explanation || 'Verified by the native solver.';
      const apply = document.createElement('button'); apply.className='btn btn-primary btn-sm'; apply.textContent='Apply & rerun native DSE';
      apply.addEventListener('click', async () => {
        const restore = setButtonBusy(apply, 'Applying & rerunning…');
        try { applyPatch(option.patch); await nativeLaunch(); }
        finally { restore(); }
      });
      card.append(title,badge,explanation,apply); container.appendChild(card);
    }
  }

  async function diagnoseUnsatFixed() {
    const container = document.getElementById('unsat-doctor-options');
    if (!container) return;
    const button = document.getElementById('btn-unsat-doctor');
    const restore = setButtonBusy(button, 'Native diagnosis…');
    container.textContent = 'Isolating active constraints and testing repairs with real native DSE runs…';
    try {
      const response = await fetch('/api/ai/unsat-doctor', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ messages: [{ role:'user', content: JSON.stringify({ currentJob: currentJob(), baselineResults: state.results?.raw || '' }) }] })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      (data.logs || []).forEach(log => api.appendLog?.(`${log}\n`));
      if (data.alreadyFeasible) { container.textContent = data.message || 'The current job is already feasible.'; return; }
      if (!Array.isArray(data.options) || !data.options.length) { container.textContent = data.message || 'No single native-verified repair was found.'; return; }
      renderVerifiedUnsatOptions(data.options);
      api.toast?.(`${data.options.length} repair option(s) verified by native DSE.`, 'success');
    } catch (error) {
      container.textContent = `Diagnosis failed: ${error.message}`;
      api.toast?.(`UNSAT diagnosis failed: ${error.message}`, 'error');
    } finally { restore(); }
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
      for (const node of studio.workloadNodes || []) if (node.overlay) node.overlay.isCritical = false;
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

  restoreSystemConstraintForm();
  const powerLabel = document.querySelector('label[for="sys-power"]');
  const utilizationLabel = document.querySelector('label[for="sys-utilization"]');
  const procsLabel = document.querySelector('label[for="sys-procs"]');
  if (powerLabel) powerLabel.textContent = 'Max Power (mW)';
  if (utilizationLabel) utilizationLabel.textContent = 'Min Utilization (%)';
  if (procsLabel) procsLabel.textContent = 'Active Processors (exact)';

  document.getElementById('btn-launch')?.addEventListener('pointerdown', syncSystemConstraintsFromForm, { capture:true });
  interceptClick('btn-launch', nativeLaunch);
  interceptClick('btn-demo-preset', loadCleanDemo);
  interceptClick('btn-generate-insights', generateInsightsFixed);
  interceptClick('btn-ai-auto-opt', autoOptimizeFixed);
  interceptClick('btn-unsat-doctor', diagnoseUnsatFixed);
  sanitizeArchitectureOverlay();

  console.info('[ParetoCo reliability] Native-only launch, clean demo, native-verified AI features, and honest architecture overlays enabled.');
})();
