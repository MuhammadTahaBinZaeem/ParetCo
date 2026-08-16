/* ParetoCo browser reliability layer.
 * Keeps UI state, native XML payloads, and long-running AI requests consistent
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

  function syncSystemConstraintsFromForm() {
    state.sysConstraints = state.sysConstraints || {};
    for (const [key, id] of Object.entries(constraintFields)) {
      const el = document.getElementById(id);
      if (!el) continue;
      state.sysConstraints[key] = positiveNumber(el.value);
    }

    // Keep legacy names populated because the existing results parser still
    // checks these aliases on some paths.
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

    const ic = interconnects[0] || { name: 'bus0', topology: 'TDMA-bus', xDim: Math.max(1, processors.reduce((sum, proc) => sum + (parseInt(proc.count, 10) || 1), 0)), flitSize: 32, slots: 2 };
    const xDim = Math.max(1, parseInt(ic.xDim ?? ic['x-dimension'], 10) || 1);
    const slots = Math.max(1, parseInt(ic.slots ?? ic.tdma_slots, 10) || 2);
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

  const originalFetch = window.fetch.bind(window);
  window.fetch = async function paretocoFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const nextInit = { ...init };

    // Before every native launch, capture the values currently visible in the form.
    // The old UI never did this, so Max Power/Area/Cost were silently ignored.
    if (/\/api\/launch(?:\?|$)/.test(url) && typeof nextInit.body === 'string') {
      syncSystemConstraintsFromForm();
      try {
        const payload = JSON.parse(nextInit.body);
        payload.sysConstraints = { ...(payload.sysConstraints || {}), ...(state.sysConstraints || {}) };
        payload.constraintsXml = buildConstraintsXml(payload.constraints || state.constraints, payload.sysConstraints);
        // The old UI's generated platform.xml omitted its interconnect. Rebuild it from
        // the structured state so the native engine sees the same platform shown in UI.
        if (payload.platform && Array.isArray(payload.platform.processors) && payload.platform.processors.length) {
          payload.platformXml = buildPlatformXml(payload.platform);
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

  restoreSystemConstraintForm();
  const utilizationLabel = document.querySelector('label[for="sys-utilization"]');
  const procsLabel = document.querySelector('label[for="sys-procs"]');
  if (utilizationLabel) utilizationLabel.textContent = 'Min Utilization (%)';
  if (procsLabel) procsLabel.textContent = 'Active Processors (exact)';

  // Ensure a click captures the latest constraint values even if the user has not
  // blurred the input yet.
  document.getElementById('btn-launch')?.addEventListener('pointerdown', syncSystemConstraintsFromForm, { capture: true });

  console.info('[ParetoCo reliability] Constraint sync, native XML normalization, and AI request bounds enabled.');
})();
