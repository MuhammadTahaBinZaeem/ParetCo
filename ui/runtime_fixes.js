/* ParetoCo browser reliability layer.
 * Keeps UI state, native XML payloads, demo state, and AI requests consistent
 * without changing the native engine.
 */
(() => {
  'use strict';

  const api = window.paretoco;
  if (!api || !api.state) return;
  const state = api.state;

  // Compatibility for the older NL-to-DSE handler, which referenced state.config.
  // Make it a live alias instead of allowing a successful AI response to throw.
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

    // Keep legacy names populated because older result parsing paths use them.
    state.sysConstraints.maxPower = state.sysConstraints.power;
    state.sysConstraints.maxUtil = state.sysConstraints.utilization;
    if (typeof api.save === 'function') api.save();
  }

  function restoreSystemConstraintForm() {
    state.sysConstraints = state.sysConstraints || {};
    for (const [key, id] of Object.entries(constraintFields)) {
      const el = document.getElementById(id);
      if (!el) continue;
      const value = Number(state.sysConstraints[key]);
      el.value = Number.isFinite(value) && value > 0 ? String(value) : '';
      el.addEventListener('input', syncSystemConstraintsFromForm);
      el.addEventListener('change', syncSystemConstraintsFromForm);
    }

    // Migrate older stored sessions using maxPower/maxUtil.
    if (!(Number(state.sysConstraints.power) > 0) && Number(state.sysConstraints.maxPower) > 0) {
      state.sysConstraints.power = Number(state.sysConstraints.maxPower);
      const el = document.getElementById('sys-power');
      if (el) el.value = String(state.sysConstraints.power);
    }
    if (!(Number(state.sysConstraints.utilization) > 0) && Number(state.sysConstraints.maxUtil) > 0) {
      state.sysConstraints.utilization = Number(state.sysConstraints.maxUtil);
      const el = document.getElementById('sys-utilization');
      if (el) el.value = String(state.sysConstraints.utilization);
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
    const p = platform || {};
    const processors = Array.isArray(p.processors) ? p.processors : [];
    const interconnects = Array.isArray(p.interconnects)
      ? p.interconnects
      : (p.interconnect ? [p.interconnect] : []);

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<platform name="generated_platform">\n';
    for (const proc of processors) {
      const model = xmlEscape(proc.model || 'ARM');
      const count = Math.max(1, parseInt(proc.count, 10) || 1);
      xml += `  <processor model="${model}" number="${count}">\n`;
      const modes = Array.isArray(proc.modes) && proc.modes.length
        ? proc.modes
        : [{ name: 'default', cycle: 1, mem: 4096, dynPower: 10, staticPower: 2, area: 5, monetary: 10 }];
      for (const mode of modes) {
        xml += `    <mode name="${xmlEscape(mode.name || 'default')}" cycle="${xmlNumber(mode.cycle, 1)}" mem="${xmlNumber(mode.mem, 4096)}" dynPower="${xmlNumber(mode.dynPower, 0)}" staticPower="${xmlNumber(mode.staticPower, 0)}" area="${xmlNumber(mode.area, 0)}" monetary="${xmlNumber(mode.monetary, 0)}"/>\n`;
      }
      xml += '  </processor>\n';
    }

    const totalCores = processors.reduce((sum, proc) => sum + (parseInt(proc.count, 10) || 1), 0);
    const ic = interconnects[0] || { name: 'bus0', topology: 'TDMA-bus', xDim: Math.max(1, totalCores), flitSize: 32, slots: Math.max(2, totalCores) };
    const xDim = Math.max(1, parseInt(ic.xDim ?? ic['x-dimension'], 10) || Math.max(1, totalCores));
    const slots = Math.max(1, parseInt(ic.slots ?? ic.tdma_slots, 10) || Math.max(2, totalCores));
    const flitSize = Math.max(1, parseInt(ic.flitSize, 10) || 32);
    const icMode = ic.mode || {};
    xml += '  <interconnect>\n';
    xml += `    <TDMA_bus name="${xmlEscape(ic.name || 'bus0')}" x-dimension="${xDim}" y-dimension="${Math.max(1, parseInt(ic.yDim ?? ic['y-dimension'], 10) || 1)}" flitSize="${flitSize}" tdma_slots="${slots}" maxSlotsPerProc="${Math.max(1, parseInt(ic.maxSlotsPerProc, 10) || slots)}">\n`;
    xml += `      <mode name="${xmlEscape(icMode.name || 'default')}" cycleLength="${xmlNumber(icMode.cycleLength, 1)}" dynPower_NI="${xmlNumber(icMode.dynPower_NI, 1)}" dynPower_bus="${xmlNumber(icMode.dynPower_bus, 1)}" staticPower_NI="${xmlNumber(icMode.staticPower_NI, 1)}" staticPower_bus="${xmlNumber(icMode.staticPower_bus, 1)}" area_NI="${xmlNumber(icMode.area_NI, 1)}" area_bus="${xmlNumber(icMode.area_bus, 1)}" monetary_NI="${xmlNumber(icMode.monetary_NI, 1)}" monetary_bus="${xmlNumber(icMode.monetary_bus, 1)}"/>\n`;
    xml += '    </TDMA_bus>\n  </interconnect>\n</platform>\n';
    return xml;
  }

  function buildConstraintsXml(constraints, sysConstraints) {
    const rows = Array.isArray(constraints) ? constraints : [];
    const sys = sysConstraints || {};

    // Match the native engine semantics exactly: power/area/cost are maxima,
    // utilization is a minimum percentage, and procsUsed is an exact count.
    const systemAttrs = [];
    if (positiveNumber(sys.power) > 0) systemAttrs.push(`power="${Math.round(Number(sys.power))}"`);
    if (positiveNumber(sys.area) > 0) systemAttrs.push(`area="${Math.round(Number(sys.area))}"`);
    if (positiveNumber(sys.cost) > 0) systemAttrs.push(`money="${Math.round(Number(sys.cost))}"`);
    if (positiveNumber(sys.utilization) > 0) systemAttrs.push(`utilization="${Math.round(Number(sys.utilization))}"`);
    if (positiveNumber(sys.procsUsed) > 0) systemAttrs.push(`procsUsed="${Math.round(Number(sys.procsUsed))}"`);

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<designConstraints>\n';
    if (rows.length) {
      for (const c of rows) {
        const attrs = [
          `app_name="${xmlEscape(c.appName || c.app_name || 'App')}"`,
          `period="${Math.max(0, parseInt(c.period, 10) || 0)}"`,
          `latency="${Math.max(0, parseInt(c.latency, 10) || 0)}"`,
          ...systemAttrs
        ];
        xml += `  <constraint ${attrs.join(' ')}></constraint>\n`;
      }
    } else if (systemAttrs.length) {
      xml += `  <constraint ${systemAttrs.join(' ')}></constraint>\n`;
    }
    xml += '</designConstraints>\n';
    return xml;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderSafeMarkdown(text) {
    let html = escapeHtml(text || '');
    html = html
      .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
      .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
      .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/^[-*]\s+(.+)$/gm, '• $1')
      .replace(/\n/g, '<br>');
    return html;
  }

  function setButtonBusy(button, busyText) {
    if (!button) return () => {};
    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
    return () => {
      button.disabled = false;
      button.textContent = oldText;
    };
  }

  function resetResultsUi() {
    state.results = null;
    const empty = document.getElementById('results-empty');
    const content = document.getElementById('results-content');
    const unsat = document.getElementById('unsat-doctor-container');
    const summary = document.getElementById('results-summary');
    const tbody = document.getElementById('results-tbody');
    const thead = document.getElementById('results-thead');
    if (empty) empty.classList.remove('hidden');
    if (content) content.classList.add('hidden');
    if (unsat) unsat.classList.add('hidden');
    if (summary) summary.textContent = '';
    if (tbody) tbody.textContent = '';
    if (thead) thead.textContent = '';
    const kpi = document.getElementById('kpi-solutions');
    if (kpi) kpi.textContent = '—';
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

  // Normalize all launch payloads immediately before they reach the server.
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
        if (payload.platform && Array.isArray(payload.platform.processors) && payload.platform.processors.length) {
          payload.platformXml = buildPlatformXml(payload.platform);
        }
        if (payload.dse) {
          payload.dse.thProp = payload.dse.thProp || payload.dse.th_prop || 'SSE';
          payload.dse.th_prop = payload.dse.th_prop || payload.dse.thProp;
        }
        nextInit.body = JSON.stringify(payload);
      } catch (err) {
        console.error('[ParetoCo reliability] Could not normalize launch payload:', err);
      }
    }

    // AI calls must always terminate. Featherless also has a server-side timeout,
    // but this protects the browser from a lost/aborted upstream request.
    const isAi = /\/api\/ai\//.test(url);
    if (!isAi || nextInit.signal) return originalFetch(input, nextInit);

    const controller = new AbortController();
    nextInit.signal = controller.signal;
    const timeoutMs = 35_000;
    const timer = setTimeout(() => controller.abort(new DOMException('AI request timed out', 'TimeoutError')), timeoutMs);
    try {
      return await originalFetch(input, nextInit);
    } finally {
      clearTimeout(timer);
    }
  };

  async function loadCleanDemo() {
    // A demo must never inherit a previous user's impossible constraints or stale
    // results. Clear the entire mutable experiment surface first.
    state.constraints = [];
    state.sysConstraints = { power: -1, utilization: -1, area: -1, cost: -1, procsUsed: -1, maxPower: -1, maxUtil: -1 };
    resetResultsUi();

    if (typeof api.loadDemoPreset !== 'function') throw new Error('Demo loader is unavailable.');
    api.loadDemoPreset();

    // The hosted native smoke test proves this exact period bound is feasible.
    // It demonstrates constraints without risking a stale power limit.
    api.loadConstraintsXml?.('<?xml version="1.0" encoding="UTF-8"?>\n<designConstraints>\n  <constraint app_name="TestApp" period="1000" latency="0"></constraint>\n</designConstraints>\n');

    Object.assign(state.dse, { model: 'SDF_PR_ONLINE', search: 'FIRST', criteria: 'THROUGHPUT', thProp: 'SSE', th_prop: 'SSE' });
    for (const [id, value] of [
      ['dse-model', 'SDF_PR_ONLINE'],
      ['dse-search', 'FIRST'],
      ['dse-criteria', 'THROUGHPUT'],
      ['dse-thprop', 'SSE']
    ]) {
      const el = document.getElementById(id);
      if (el) el.value = value;
    }
    for (const id of Object.values(constraintFields)) {
      const el = document.getElementById(id);
      if (el) el.value = '';
    }

    const selector = document.getElementById('app-selector');
    if (selector && selector.options.length > 1) {
      selector.value = '0';
      selector.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const log = document.getElementById('log-output');
    if (log) log.textContent = 'Demo loaded and validated for hosted execution. Click “Launch DSE” to run the native engine.\n';
    const insight = document.getElementById('ai-markdown-render');
    if (insight) insight.textContent = '';
    const unsatOptions = document.getElementById('unsat-doctor-options');
    if (unsatOptions) unsatOptions.textContent = '';

    api.save?.();
    api.toast?.('Clean demo loaded: 2× ARM, TestApp, FIRST search, feasible period bound.', 'success');
  }

  function deterministicInsights() {
    const rows = state.results?.rows || [];
    const appName = state.applications?.[0]?.name || 'Active workload';
    const procSummary = (state.platform?.processors || [])
      .map(proc => `${proc.model} ×${proc.count || 1}`)
      .join(', ') || 'No platform';

    if (rows.length === 0) {
      return `### No feasible solution\nThe native DSE result contains **0 feasible solutions** for ${appName}.\n\n- Platform: ${procSummary}\n- Review the active period and system bounds.\n- Use the UNSAT Doctor to generate candidate repairs, then verify each repair by rerunning the native engine.`;
    }

    const numeric = rows.map((row, index) => ({
      index,
      number: row['Solution #'] || index + 1,
      period: Number(row._period || parseFloat(row['Period'])) || 0,
      power: Number(row._power || parseFloat(row['Power (mW)'])) || 0,
      area: Number(row._area || parseFloat(row['Area'])) || 0,
      cost: Number(row._cost || parseFloat(row['Cost ($)'])) || 0
    }));
    const byPeriod = numeric.filter(item => item.period > 0).sort((a, b) => a.period - b.period);
    const byPower = numeric.filter(item => item.power > 0).sort((a, b) => a.power - b.power);
    const fastest = byPeriod[0];
    const lowestPower = byPower[0];

    let text = `### DSE result summary\nParetoCo currently shows **${rows.length} feasible solution(s)** for ${appName}.\n\n- Platform: ${procSummary}`;
    if (fastest) text += `\n- Lowest observed period: **${fastest.period} cycles** (Solution #${fastest.number})`;
    if (lowestPower) text += `\n- Lowest observed power lower-bound/value: **${lowestPower.power} mW** (Solution #${lowestPower.number})`;
    text += '\n\nThese statements are computed directly from the displayed native result rows; no unsupported percentage improvement is assumed.';
    return text;
  }

  async function generateInsightsFixed() {
    if (!state.results) return api.toast?.('Run DSE first, then generate insights.', 'error');
    const button = document.getElementById('btn-generate-insights');
    const restore = setButtonBusy(button, 'Analyzing…');
    const output = document.getElementById('ai-markdown-render');
    if (output) output.textContent = 'Analyzing the current native DSE result with Featherless…';

    try {
      const rows = state.results.rows || [];
      const response = await fetch('/api/ai/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appName: state.applications?.[0]?.name || 'Active workload',
          platformSummary: (state.platform?.processors || []).map(p => `${p.model} x${p.count || 1}`).join(', '),
          constraintsSummary: JSON.stringify({ application: state.constraints || [], system: state.sysConstraints || {} }),
          solutionsCount: rows.length,
          solutionsSummary: rows.slice(0, 20),
          outTxt: state.results.raw || ''
        })
      });
      const data = await response.json().catch(() => ({}));
      const report = response.ok && data.insights ? data.insights : deterministicInsights();
      if (output) output.innerHTML = renderSafeMarkdown(report);
      api.toast?.(data.insights ? 'AI analysis generated.' : 'Local result analysis generated.', 'success');
    } catch (error) {
      if (output) output.innerHTML = renderSafeMarkdown(deterministicInsights());
      api.toast?.(`AI unavailable: ${error.message}. Showing deterministic analysis.`, 'info');
    } finally {
      restore();
    }
  }

  async function autoOptimizeFixed() {
    const input = document.getElementById('ai-auto-opt-input');
    const goal = input?.value?.trim();
    if (!goal) return api.toast?.('Enter an optimization goal first.', 'error');
    if (!state.results) return api.toast?.('Run a baseline DSE first.', 'error');

    const button = document.getElementById('btn-ai-auto-opt');
    const restore = setButtonBusy(button, 'Generating proposal…');
    const baselinePlatform = deepClone(state.platform);
    const baselineResultsRef = state.results;

    try {
      const response = await fetch('/api/ai/auto-optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          budgetPrompt: goal,
          platform: state.platform,
          resultsText: state.results.raw || JSON.stringify(state.results.rows || [])
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      if (!data.platform?.processors?.length) throw new Error('Featherless returned no usable platform proposal.');
      (data.logs || []).forEach(log => api.appendLog?.(`${log}\n`));

      // Re-import through the same XML path as user input so every dependent view
      // is rendered from the exact normalized platform that will reach the solver.
      api.loadPlatformXml?.(buildPlatformXml(data.platform));
      api.save?.();
      if (button) button.textContent = 'Verifying with native DSE…';

      await api.launchEngine?.();
      const gotFreshNativeResult = state.results && state.results !== baselineResultsRef;
      if (!gotFreshNativeResult) {
        api.loadPlatformXml?.(buildPlatformXml(baselinePlatform));
        throw new Error('Native verification did not complete; the original platform was restored.');
      }

      if ((state.results.rows || []).length > 0) {
        api.toast?.('Architecture proposal verified by the native DSE engine.', 'success');
      } else {
        api.toast?.('Proposal was tested by the native engine but is infeasible under the active constraints.', 'info');
      }
      if (input) input.value = '';
    } finally {
      restore();
    }
  }

  function renderUnsatOptions(options) {
    const container = document.getElementById('unsat-doctor-options');
    if (!container) return;
    container.textContent = '';

    for (const option of options || []) {
      const card = document.createElement('div');
      card.style.background = '#FFFFFF';
      card.style.border = '1px solid #D7E0EA';
      card.style.padding = '14px';
      card.style.borderRadius = '8px';

      const title = document.createElement('strong');
      title.textContent = option.title || 'Candidate repair';
      card.appendChild(title);

      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.style.marginLeft = '8px';
      badge.textContent = 'Verify on rerun';
      card.appendChild(badge);

      const explanation = document.createElement('p');
      explanation.style.margin = '8px 0 12px';
      explanation.textContent = option.explanation || 'Candidate change generated from the active infeasible design.';
      card.appendChild(explanation);

      const apply = document.createElement('button');
      apply.className = 'btn btn-primary btn-sm';
      apply.textContent = 'Apply & verify with native DSE';
      apply.addEventListener('click', () => applyUnsatRepair(option, apply));
      card.appendChild(apply);
      container.appendChild(card);
    }
  }

  async function applyUnsatRepair(option, button) {
    const tweak = option?.suggestedTweak || {};
    const type = String(tweak.type || '').toLowerCase();
    const value = Number(tweak.value);
    if (!Number.isFinite(value) || value <= 0) throw new Error('Repair contains an invalid value.');
    const restore = setButtonBusy(button, 'Applying & verifying…');
    const previousResults = state.results;

    try {
      if (type === 'period') {
        if (!state.constraints.length) {
          state.constraints.push({ appName: state.applications?.[0]?.name || 'App', period: Math.round(value), latency: 0 });
        } else {
          state.constraints[0].period = Math.round(value);
        }
        api.loadConstraintsXml?.(buildConstraintsXml(state.constraints, state.sysConstraints));
      } else if (type === 'cores') {
        if (!state.platform?.processors?.length) throw new Error('No processor exists to scale.');
        state.platform.processors[0].count = Math.max(1, Math.round(value));
        api.loadPlatformXml?.(buildPlatformXml(state.platform));
      } else {
        const key = type === 'procsused' ? 'procsUsed' : type;
        if (!(key in constraintFields)) throw new Error(`Unsupported repair type: ${type}`);
        state.sysConstraints[key] = value;
        const input = document.getElementById(constraintFields[key]);
        if (input) {
          input.value = String(value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        api.loadConstraintsXml?.(buildConstraintsXml(state.constraints, state.sysConstraints));
      }

      api.save?.();
      await api.launchEngine?.();
      if (!state.results || state.results === previousResults) {
        throw new Error('Native verification did not complete.');
      }
      if ((state.results.rows || []).length > 0) {
        api.toast?.('Repair verified: the native engine found feasible solution(s).', 'success');
      } else {
        api.toast?.('Repair tested, but the design is still infeasible. Try another candidate.', 'info');
      }
    } finally {
      restore();
    }
  }

  async function diagnoseUnsatFixed() {
    const container = document.getElementById('unsat-doctor-options');
    const button = document.getElementById('btn-unsat-doctor');
    if (!container) return;
    const restore = setButtonBusy(button, 'Diagnosing…');
    container.textContent = 'Analyzing active constraints with Featherless…';

    try {
      const response = await fetch('/api/ai/unsat-doctor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          constraints: {
            application: state.constraints || [],
            system: state.sysConstraints || {},
            wcets: state.wcets || []
          },
          platform: state.platform,
          applications: state.applications
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      (data.logs || []).forEach(log => api.appendLog?.(`${log}\n`));
      const options = Array.isArray(data.options) ? data.options : [];
      if (!options.length) throw new Error('No usable repair options were returned.');
      renderUnsatOptions(options);
      api.toast?.('Candidate repairs generated. Each one will be verified only after a native rerun.', 'success');
    } catch (error) {
      container.textContent = `Diagnosis failed: ${error.message}`;
      api.toast?.(`UNSAT diagnosis failed: ${error.message}`, 'error');
    } finally {
      restore();
    }
  }

  restoreSystemConstraintForm();

  // Correct two labels whose old “Max” wording contradicted the native engine.
  const powerLabel = document.querySelector('label[for="sys-power"]');
  const utilizationLabel = document.querySelector('label[for="sys-utilization"]');
  const procsLabel = document.querySelector('label[for="sys-procs"]');
  if (powerLabel) powerLabel.textContent = 'Max Power (mW)';
  if (utilizationLabel) utilizationLabel.textContent = 'Min Utilization (%)';
  if (procsLabel) procsLabel.textContent = 'Active Processors (exact)';

  // Ensure a click captures the latest constraint values even if the user has not
  // blurred the input yet.
  document.getElementById('btn-launch')?.addEventListener('pointerdown', syncSystemConstraintsFromForm, { capture: true });

  // Replace known-broken legacy click paths with bounded, end-to-end flows.
  interceptClick('btn-demo-preset', loadCleanDemo);
  interceptClick('btn-generate-insights', generateInsightsFixed);
  interceptClick('btn-ai-auto-opt', autoOptimizeFixed);
  interceptClick('btn-unsat-doctor', diagnoseUnsatFixed);

  console.info('[ParetoCo reliability] Demo reset, constraint sync, native XML normalization, and bounded AI feature flows enabled.');
})();
