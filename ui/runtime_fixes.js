/* ParetoCo browser reliability layer.
 * Keeps UI state, native XML payloads, AI requests, and verification claims
 * consistent without changing the native engine.
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

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
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

    const ic = interconnects[0] || {
      name: 'bus0', topology: 'TDMA-bus',
      xDim: Math.max(1, processors.reduce((sum, proc) => sum + (parseInt(proc.count, 10) || 1), 0)),
      yDim: 1, flitSize: 32, slots: 2
    };
    const xDim = Math.max(1, parseInt(ic.xDim ?? ic['x-dimension'], 10) || 1);
    const yDim = Math.max(1, parseInt(ic.yDim ?? ic['y-dimension'], 10) || 1);
    const slots = Math.max(1, parseInt(ic.slots ?? ic.tdma_slots, 10) || 2);
    const flitSize = Math.max(1, parseInt(ic.flitSize, 10) || 32);
    const icMode = ic.mode || {};
    xml += '  <interconnect>\n';
    xml += `    <TDMA_bus name="${xmlEscape(ic.name || 'bus0')}" x-dimension="${xDim}" y-dimension="${yDim}" flitSize="${flitSize}" tdma_slots="${slots}" maxSlotsPerProc="${Math.max(1, parseInt(ic.maxSlotsPerProc, 10) || slots)}">\n`;
    xml += `      <mode name="${xmlEscape(icMode.name || 'default')}" cycleLength="${xmlNumber(icMode.cycleLength, 1)}" dynPower_NI="${xmlNumber(icMode.dynPower_NI, 1)}" dynPower_bus="${xmlNumber(icMode.dynPower_bus, 1)}" staticPower_NI="${xmlNumber(icMode.staticPower_NI, 1)}" staticPower_bus="${xmlNumber(icMode.staticPower_bus, 1)}" area_NI="${xmlNumber(icMode.area_NI, 1)}" area_bus="${xmlNumber(icMode.area_bus, 1)}" monetary_NI="${xmlNumber(icMode.monetary_NI, 1)}" monetary_bus="${xmlNumber(icMode.monetary_bus, 1)}"/>\n`;
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

  function currentJob() {
    syncSystemConstraintsFromForm();
    const dse = clone(state.dse || {});
    dse.th_prop = dse.th_prop || dse.thProp || 'SSE';
    return {
      platform: clone(state.platform || {}),
      applications: clone(state.applications || []),
      wcets: clone(state.wcets || []),
      constraints: clone(state.constraints || []),
      sysConstraints: clone(state.sysConstraints || {}),
      dse
    };
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function safeMarkdown(markdown) {
    return escapeHtml(markdown)
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }

  function resultNumber(row, names) {
    for (const name of names) {
      const value = Number(row?.[name]);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return null;
  }

  function factualFallbackInsights() {
    const rows = state.results?.rows || [];
    if (rows.length === 0) {
      return `### Native DSE Result\n\nThe current result set contains **0 feasible solutions**. No single cause is inferred from the result table alone. Use the UNSAT Doctor to test repair candidates against the native solver.`;
    }

    const periods = rows.map(r => resultNumber(r, ['Period', '_period'])).filter(Number.isFinite);
    const powers = rows.map(r => resultNumber(r, ['Power (mW)', '_power'])).filter(Number.isFinite);
    const areas = rows.map(r => resultNumber(r, ['Area', '_area'])).filter(Number.isFinite);
    const costs = rows.map(r => resultNumber(r, ['Cost ($)', '_cost'])).filter(Number.isFinite);
    const min = values => values.length ? Math.min(...values) : null;
    const max = values => values.length ? Math.max(...values) : null;

    const lines = [
      '### Result Summary',
      '',
      `- **Native feasible solutions:** ${rows.length}`
    ];
    if (periods.length) lines.push(`- **Period range:** ${min(periods)} to ${max(periods)} cycles`);
    if (powers.length) lines.push(`- **Power range:** ${min(powers)} to ${max(powers)} mW`);
    if (areas.length) lines.push(`- **Area range:** ${min(areas)} to ${max(areas)}`);
    if (costs.length) lines.push(`- **Cost range:** ${min(costs)} to ${max(costs)}`);
    lines.push('', 'This fallback reports only values present in the current result set; it does not invent knee-point percentages, bottlenecks, or performance claims.');
    return lines.join('\n');
  }

  function setEngineStatus(mode, label) {
    const el = document.getElementById('engine-status');
    if (!el) return;
    el.innerHTML = `<span class="status-dot ${escapeHtml(mode)}"></span><span>${escapeHtml(label)}</span>`;
  }

  function writeLog(text, reset = false) {
    const log = document.getElementById('log-output');
    if (!log) return;
    if (reset) log.textContent = '';
    log.textContent += String(text || '');
    log.scrollTop = log.scrollHeight;
  }

  function openResultsPage() {
    document.querySelector('.nav-item[data-page="results"]')?.click();
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
        if (payload.platform && Array.isArray(payload.platform.processors) && payload.platform.processors.length) {
          payload.platformXml = buildPlatformXml(payload.platform);
        }
        nextInit.body = JSON.stringify(payload);
      } catch (err) {
        console.error('[ParetoCo reliability] Could not normalize launch payload:', err);
      }
    }

    if (/\/api\/ai\/auto-optimize(?:\?|$)/.test(url) && typeof nextInit.body === 'string') {
      try {
        const payload = JSON.parse(nextInit.body);
        if (!payload.messages) {
          payload.messages = [{
            role: 'user',
            content: JSON.stringify({
              goal: payload.budgetPrompt || '',
              currentJob: currentJob(),
              baselineResults: state.results?.raw || payload.resultsText || ''
            })
          }];
        }
        nextInit.body = JSON.stringify(payload);
      } catch (err) {
        console.error('[ParetoCo reliability] Could not attach native-verification context to Auto-Optimize:', err);
      }
    }

    const isAi = /\/api\/ai\//.test(url);
    if (!isAi || nextInit.signal) return originalFetch(input, nextInit);

    const controller = new AbortController();
    nextInit.signal = controller.signal;
    const longAgent = /\/api\/ai\/(?:auto-optimize|unsat-doctor)/.test(url);
    const timeoutMs = longAgent ? 95_000 : 45_000;
    const timer = setTimeout(() => controller.abort(new DOMException('AI request timed out', 'TimeoutError')), timeoutMs);
    try {
      return await originalFetch(input, nextInit);
    } finally {
      clearTimeout(timer);
    }
  };

  async function nativeLaunch() {
    if (!Array.isArray(state.platform?.processors) || state.platform.processors.length === 0 || !Array.isArray(state.applications) || state.applications.length === 0) {
      const err = new Error('No DSE model is loaded. Use Load Demo, import a model, or generate one with NL-to-DSE first.');
      api.toast?.(err.message, 'error');
      throw err;
    }

    const job = currentJob();
    job.presolver = clone(state.presolver || {});
    job.config = typeof api.generateConfig === 'function' ? api.generateConfig() : '';

    const endpoint = (api.getEngineUrl?.() || '') + '/api/launch';
    writeLog('═══════════════════════════════════════════════════\n', true);
    writeLog(` ParetoCo Native DSE — ${new Date().toLocaleString()}\n`);
    writeLog('═══════════════════════════════════════════════════\n\n');
    writeLog(`[HTTP] Launching native DSE solver on ${endpoint} ...\n`);
    setEngineStatus('running', 'Native engine running…');

    let data = null;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(job)
      });
      const text = await response.text();
      try { data = JSON.parse(text); } catch (_) { data = { error: text || `HTTP ${response.status}` }; }

      if (!response.ok || data.success === false) {
        const detail = [data.error, data.stderr, data.stdout].filter(Boolean).join('\n');
        throw new Error(detail || `Native DSE request failed with HTTP ${response.status}.`);
      }

      const nativeOutput = data.outTxt || data.log || data.outCsv || '';
      if (!nativeOutput) throw new Error('Native engine returned no result output.');

      writeLog(`\n${data.log || data.outTxt || 'Native DSE execution completed.'}\n`);
      setEngineStatus('done', 'Native engine finished');

      if (data.outTxt && typeof api.loadResults === 'function') api.loadResults(data.outTxt, 'out.txt');
      else if (data.outCsv && typeof api.loadResults === 'function') api.loadResults(data.outCsv, 'out.csv');

      openResultsPage();
      api.toast?.('Native DSE exploration complete.', 'success');
      return data;
    } catch (err) {
      const message = err?.message || String(err);
      writeLog(`\n[ERROR] Native DSE failed:\n${message}\n`);
      setEngineStatus('error', 'Native engine failed');
      api.toast?.('Native DSE failed. See Engine Output for the real error.', 'error');
      throw err;
    }
  }

  function installNativeOnlyLaunch() {
    const oldButton = document.getElementById('btn-launch');
    if (!oldButton || oldButton.dataset.nativeOnly === 'true') {
      api.launchEngine = nativeLaunch;
      return;
    }

    const button = oldButton.cloneNode(true);
    button.dataset.nativeOnly = 'true';
    oldButton.replaceWith(button);
    api.launchEngine = nativeLaunch;

    button.addEventListener('pointerdown', syncSystemConstraintsFromForm, { capture: true });
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      const oldText = button.textContent;
      button.textContent = 'Running native DSE...';
      try {
        await nativeLaunch();
      } catch (_) {
        // nativeLaunch has already surfaced the real error to the UI.
      } finally {
        button.disabled = false;
        button.textContent = oldText || '▶ Launch DSE';
      }
    });
  }

  function applyVerifiedPatch(patch) {
    for (const op of Array.isArray(patch) ? patch : []) {
      if (op.target === 'constraint') {
        let index = Number.isInteger(op.index) ? op.index : -1;
        if (index < 0 && op.appName) index = (state.constraints || []).findIndex(c => (c.appName || c.app_name) === op.appName);
        if (index < 0 && state.constraints?.length === 1) index = 0;
        if (index < 0 || !state.constraints[index]) continue;
        if (op.field === 'period' && typeof api.updateConstraintPeriod === 'function') api.updateConstraintPeriod(index, op.value);
        else if (op.field === 'latency' && typeof api.updateConstraintLatency === 'function') api.updateConstraintLatency(index, op.value);
        else state.constraints[index][op.field] = op.value;
      } else if (op.target === 'sysConstraint') {
        state.sysConstraints[op.field] = Number(op.value) > 0 ? Number(op.value) : -1;
        const id = constraintFields[op.field];
        const el = id ? document.getElementById(id) : null;
        if (el) el.value = Number(op.value) > 0 ? String(op.value) : '';
      } else if (op.target === 'processor' && op.field === 'count') {
        let index = Number.isInteger(op.index) ? op.index : -1;
        if (index < 0 && op.model) index = (state.platform.processors || []).findIndex(p => p.model === op.model);
        if (index < 0 && state.platform.processors?.length === 1) index = 0;
        if (index >= 0 && typeof api.updateProcessorCount === 'function') api.updateProcessorCount(index, op.value);
      }
    }
    syncSystemConstraintsFromForm();
    if (typeof api.save === 'function') api.save();
  }

  function installVerifiedUnsatDoctor() {
    const oldButton = document.getElementById('btn-unsat-doctor');
    if (!oldButton || oldButton.dataset.nativeVerified === 'true') return;
    const button = oldButton.cloneNode(true);
    button.dataset.nativeVerified = 'true';
    oldButton.replaceWith(button);

    button.addEventListener('click', async () => {
      const optionsEl = document.getElementById('unsat-doctor-options');
      if (!optionsEl) return;
      button.disabled = true;
      button.textContent = 'Testing repairs with native solver...';
      optionsEl.textContent = 'Generating repair candidates and verifying each candidate with real native DSE runs...';

      try {
        const response = await fetch((api.getEngineUrl?.() || '') + '/api/ai/unsat-doctor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{
              role: 'user',
              content: JSON.stringify({
                currentJob: currentJob(),
                baselineResults: state.results?.raw || ''
              })
            }]
          })
        });
        const data = await response.json();
        if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);

        optionsEl.innerHTML = '';
        if (data.alreadyFeasible) {
          const p = document.createElement('p');
          p.textContent = data.message || 'The current job is already feasible.';
          optionsEl.appendChild(p);
          return;
        }

        const options = Array.isArray(data.options) ? data.options : [];
        if (options.length === 0) {
          const p = document.createElement('p');
          p.textContent = data.message || 'No bounded repair was verified. Multiple constraints may need to change together.';
          optionsEl.appendChild(p);
          return;
        }

        for (const option of options) {
          const card = document.createElement('div');
          card.style.cssText = 'background:#fff;border:2px solid #B6CBE0;padding:16px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.06)';

          const header = document.createElement('div');
          header.style.cssText = 'display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:8px';
          const title = document.createElement('strong');
          title.textContent = option.title || 'Native-verified repair';
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.style.cssText = 'background:#E2F0D9;color:#276749;font-weight:600;padding:2px 8px;border-radius:4px;font-size:.75rem';
          badge.textContent = `Native verified · ${option.verifiedSolutions || 0} solution(s)`;
          header.append(title, badge);

          const explanation = document.createElement('p');
          explanation.style.cssText = 'font-size:.85rem;color:#4A5568;margin:0 0 12px;line-height:1.4';
          explanation.textContent = option.explanation || 'Verified through a real native DSE run.';

          const apply = document.createElement('button');
          apply.className = 'btn btn-primary btn-sm';
          apply.textContent = 'Apply Verified Repair & Re-run DSE';
          apply.addEventListener('click', async () => {
            apply.disabled = true;
            try {
              applyVerifiedPatch(option.patch);
              optionsEl.innerHTML = '';
              api.toast?.('Verified repair applied. Re-running native DSE...', 'success');
              await nativeLaunch();
            } catch (err) {
              api.toast?.(`Repair apply failed: ${err.message}`, 'error');
            } finally {
              apply.disabled = false;
            }
          });

          card.append(header, explanation, apply);
          optionsEl.appendChild(card);
        }
      } catch (err) {
        optionsEl.textContent = `UNSAT Doctor failed: ${err.message}`;
        api.toast?.(`UNSAT Doctor failed: ${err.message}`, 'error');
      } finally {
        button.disabled = false;
        button.textContent = '🩺 Diagnose & Propose Repairs';
      }
    });
  }

  function installSafeInsights() {
    const oldButton = document.getElementById('btn-generate-insights');
    if (!oldButton || oldButton.dataset.safeInsights === 'true') return;
    const button = oldButton.cloneNode(true);
    button.dataset.safeInsights = 'true';
    oldButton.replaceWith(button);

    button.addEventListener('click', async () => {
      if (!state.results) return api.toast?.('No results to analyze. Please run DSE first.', 'error');
      const target = document.getElementById('ai-markdown-render');
      if (!target) return;
      button.disabled = true;
      button.textContent = 'Analyzing...';
      target.textContent = 'Analyzing the current native result set...';

      const rows = state.results.rows || [];
      const appName = state.applications?.[0]?.name || 'Active Workload';
      const platformSummary = (state.platform.processors || []).map(p => `${p.model} x${p.count || 1}`).join(', ');
      const constraintsSummary = (state.constraints || []).map(c => `${c.appName}: period≤${c.period}, latency≤${c.latency}`).join(' | ');
      const solutionsSummary = rows.slice(0, 20).map((r, i) =>
        `Solution ${r['Solution #'] || i + 1}: period=${r['Period'] || r._period || 'n/a'}, power=${r['Power (mW)'] || r._power || 'n/a'}, area=${r['Area'] || r._area || 'n/a'}, cost=${r['Cost ($)'] || r._cost || 'n/a'}`
      ).join('\n');

      let markdown = '';
      try {
        const response = await fetch((api.getEngineUrl?.() || '') + '/api/ai/insights', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            appName,
            platformSummary,
            constraintsSummary,
            solutionsCount: rows.length,
            solutionsSummary,
            outTxt: state.results.raw || ''
          })
        });
        const data = await response.json();
        if (response.ok && data.insights && !data.fallback) markdown = String(data.insights);
      } catch (_) {}

      if (!markdown) markdown = factualFallbackInsights();
      target.innerHTML = safeMarkdown(markdown);
      button.disabled = false;
      button.textContent = '✨ Generate Insights';
      api.toast?.('Analysis generated from the current result set.', 'success');
    });
  }

  restoreSystemConstraintForm();

  const utilizationLabel = document.querySelector('label[for="sys-utilization"]');
  const procsLabel = document.querySelector('label[for="sys-procs"]');
  if (utilizationLabel) utilizationLabel.textContent = 'Min Utilization (%)';
  if (procsLabel) procsLabel.textContent = 'Active Processors (exact)';

  installNativeOnlyLaunch();
  installVerifiedUnsatDoctor();
  installSafeInsights();

  console.info('[ParetoCo reliability] Native-only launch, constraint sync, verified AI repairs, bounded AI requests, and safe result analysis enabled.');
})();
