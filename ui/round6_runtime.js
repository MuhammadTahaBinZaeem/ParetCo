/* ParetoCo native-config capability layer.
 * Keeps the DSE Configuration form honest about what the packaged engine
 * actually supports and validates unsafe option combinations before launch.
 */
(() => {
  'use strict';

  const api = window.paretoco;
  if (!api?.state) return;
  const state = api.state;

  const allowed = {
    model: new Set(['SDF_PR_ONLINE', 'SDF']),
    search: new Set(['FIRST', 'ALL', 'OPTIMIZE', 'OPTIMIZE_IT']),
    criteria: new Set(['POWER', 'THROUGHPUT', 'NONE']),
    prop: new Set(['SSE', 'MCR']),
    preModel: new Set(['NONE', 'ONE_PROC_MAPPINGS']),
    preSearch: new Set(['NONESEARCH', 'FIRST', 'ALL', 'OPTIMIZE']),
    heuristic: new Set(['NONE', 'TODAES']),
    multiSearch: new Set(['NONESEARCH', 'FIRST', 'ALL', 'OPTIMIZE']),
    outType: new Set(['ALL_OUT', 'TXT']),
    outFreq: new Set(['ALL_SOL', 'FIRSTandLAST', 'LAST']),
    logLevel: new Set(['CRITICAL', 'ERROR', 'WARNING', 'INFO', 'DEBUG'])
  };

  function setOptions(id, entries, value) {
    const select = document.getElementById(id);
    if (!select) return;
    select.textContent = '';
    for (const entry of entries) {
      const option = document.createElement('option');
      option.value = entry.value;
      option.textContent = entry.label || entry.value;
      select.appendChild(option);
    }
    if ([...select.options].some(option => option.value === value)) select.value = value;
  }

  function normalizeState() {
    if (!allowed.model.has(String(state.dse?.model || ''))) state.dse.model = 'SDF_PR_ONLINE';
    if (!allowed.search.has(String(state.dse?.search || ''))) state.dse.search = 'FIRST';
    if (!allowed.criteria.has(String(state.dse?.criteria || ''))) state.dse.criteria = 'THROUGHPUT';
    const prop = String(state.dse?.thProp || state.dse?.th_prop || 'SSE');
    state.dse.thProp = allowed.prop.has(prop) ? prop : 'SSE';
    state.dse.th_prop = state.dse.thProp;
    for (const key of ['threads', 'timeout1', 'timeout2', 'lubyScale', 'noGoodDepth']) {
      const value = Number(state.dse?.[key]);
      state.dse[key] = Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
    }

    if (!allowed.preModel.has(String(state.presolver?.model || ''))) state.presolver.model = 'NONE';
    if (!allowed.preSearch.has(String(state.presolver?.search || ''))) state.presolver.search = 'NONESEARCH';
    if (!allowed.heuristic.has(String(state.presolver?.heuristic || ''))) state.presolver.heuristic = 'NONE';
    if (!allowed.multiSearch.has(String(state.presolver?.multiSearch || ''))) state.presolver.multiSearch = 'NONESEARCH';
    for (const key of ['timeout1', 'timeout2']) {
      const value = Number(state.presolver?.[key]);
      state.presolver[key] = Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
    }

    if (!allowed.outType.has(String(state.output?.type || ''))) state.output.type = 'ALL_OUT';
    if (!allowed.outFreq.has(String(state.output?.freq || ''))) state.output.freq = 'ALL_SOL';
    state.output.metric = 'NONE'; // native model emits a fixed metrics bundle; selector was misleading
    if (!allowed.logLevel.has(String(state.output?.logLevel || ''))) state.output.logLevel = 'INFO';

    // FIRST + LAST is unsafe in this engine's output loop because LAST expects a
    // retained previous solution that FIRST intentionally does not keep.
    if (state.dse.search === 'FIRST' && state.output.freq === 'LAST') state.output.freq = 'ALL_SOL';
  }

  function renderControls() {
    setOptions('dse-model', [
      { value: 'SDF_PR_ONLINE', label: 'SDF_PR_ONLINE' },
      { value: 'SDF', label: 'SDF' }
    ], state.dse.model);
    setOptions('dse-criteria', [
      { value: 'POWER', label: 'POWER' },
      { value: 'THROUGHPUT', label: 'THROUGHPUT' },
      { value: 'NONE', label: 'NONE (non-optimizing search)' }
    ], state.dse.criteria);
    setOptions('pre-model', [
      { value: 'NONE', label: 'NONE' },
      { value: 'ONE_PROC_MAPPINGS', label: 'ONE_PROC_MAPPINGS' }
    ], state.presolver.model);
    setOptions('pre-search', [
      { value: 'NONESEARCH', label: 'NONESEARCH' },
      { value: 'FIRST', label: 'FIRST' },
      { value: 'ALL', label: 'ALL' },
      { value: 'OPTIMIZE', label: 'OPTIMIZE' }
    ], state.presolver.search);
    setOptions('pre-heuristic', [
      { value: 'NONE', label: 'NONE' },
      { value: 'TODAES', label: 'TODAES' }
    ], state.presolver.heuristic);
    setOptions('pre-multisearch', [
      { value: 'NONESEARCH', label: 'NONESEARCH' },
      { value: 'FIRST', label: 'FIRST' },
      { value: 'ALL', label: 'ALL' },
      { value: 'OPTIMIZE', label: 'OPTIMIZE' }
    ], state.presolver.multiSearch);
    setOptions('out-type', [
      { value: 'ALL_OUT', label: 'ALL_OUT' },
      { value: 'TXT', label: 'TXT' }
    ], state.output.type);
    setOptions('out-freq', [
      { value: 'ALL_SOL', label: 'ALL_SOL' },
      { value: 'FIRSTandLAST', label: 'FIRSTandLAST' },
      { value: 'LAST', label: 'LAST' }
    ], state.output.freq);
    setOptions('out-log-level', [
      { value: 'CRITICAL', label: 'CRITICAL' },
      { value: 'ERROR', label: 'ERROR' },
      { value: 'WARNING', label: 'WARNING' },
      { value: 'INFO', label: 'INFO' },
      { value: 'DEBUG', label: 'DEBUG' }
    ], state.output.logLevel);

    const metric = document.getElementById('out-metric');
    if (metric) {
      metric.textContent = '';
      const option = document.createElement('option');
      option.value = 'NONE';
      option.textContent = 'Native metrics bundle (fixed)';
      metric.appendChild(option);
      metric.value = 'NONE';
      metric.disabled = true;
      metric.title = 'This native build emits a fixed metrics vector; per-metric selection is not implemented by the model.';
    }

    for (const id of ['dse-timeout1', 'dse-timeout2', 'pre-timeout1', 'pre-timeout2']) {
      const input = document.getElementById(id);
      const label = document.querySelector(`label[for="${id}"]`);
      if (label && !label.textContent.includes('(ms)')) label.textContent += ' (ms)';
      if (input) input.min = '0';
    }
    for (const id of ['dse-threads', 'dse-luby', 'dse-nogood']) {
      const input = document.getElementById(id);
      if (input) input.min = '0';
    }

    const configCard = document.querySelector('#page-explorer .card:nth-of-type(3) .card-body');
    if (configCard && !document.getElementById('native-config-note')) {
      const note = document.createElement('p');
      note.id = 'native-config-note';
      note.className = 'muted-text';
      note.style.marginTop = '12px';
      note.textContent = 'These controls are restricted to options supported by the packaged ParetoCo engine. Timeout values are milliseconds.';
      configCard.appendChild(note);
    }
  }

  function syncStateFromVisibleControls() {
    const value = id => document.getElementById(id)?.value;
    state.dse.model = value('dse-model') || state.dse.model;
    state.dse.search = value('dse-search') || state.dse.search;
    state.dse.criteria = value('dse-criteria') || state.dse.criteria;
    state.dse.thProp = value('dse-thprop') || state.dse.thProp;
    state.dse.th_prop = state.dse.thProp;
    state.dse.threads = Math.max(0, parseInt(value('dse-threads'), 10) || 0);
    state.dse.timeout1 = Math.max(0, parseInt(value('dse-timeout1'), 10) || 0);
    state.dse.timeout2 = Math.max(0, parseInt(value('dse-timeout2'), 10) || 0);
    state.dse.lubyScale = Math.max(0, parseInt(value('dse-luby'), 10) || 0);
    state.dse.noGoodDepth = Math.max(0, parseInt(value('dse-nogood'), 10) || 0);

    state.presolver.model = value('pre-model') || state.presolver.model;
    state.presolver.search = value('pre-search') || state.presolver.search;
    state.presolver.heuristic = value('pre-heuristic') || state.presolver.heuristic;
    state.presolver.multiSearch = value('pre-multisearch') || state.presolver.multiSearch;
    state.presolver.timeout1 = Math.max(0, parseInt(value('pre-timeout1'), 10) || 0);
    state.presolver.timeout2 = Math.max(0, parseInt(value('pre-timeout2'), 10) || 0);

    state.output.type = value('out-type') || state.output.type;
    state.output.freq = value('out-freq') || state.output.freq;
    state.output.metric = 'NONE';
    state.output.logLevel = value('out-log-level') || state.output.logLevel;
  }

  function validateNativeControls() {
    syncStateFromVisibleControls();
    const errors = [];
    const warnings = [];

    if (!allowed.model.has(state.dse.model)) errors.push(`Model ${state.dse.model} is not supported by this engine build.`);
    if (!allowed.search.has(state.dse.search)) errors.push(`Search ${state.dse.search} is not supported by this hosted UI.`);
    if (!allowed.criteria.has(state.dse.criteria)) errors.push(`Criteria ${state.dse.criteria} is not supported by the native optimization model.`);
    if ((state.dse.search === 'OPTIMIZE' || state.dse.search === 'OPTIMIZE_IT') && !['POWER', 'THROUGHPUT'].includes(state.dse.criteria)) {
      errors.push(`${state.dse.search} requires POWER or THROUGHPUT criteria in this native model.`);
    }
    if (state.dse.search === 'OPTIMIZE_IT') {
      if (state.dse.lubyScale <= 0) errors.push('OPTIMIZE_IT requires a positive Luby Scale.');
      warnings.push('OPTIMIZE_IT uses restart-based branch-and-bound and has been less stable through Wine; FIRST is recommended for demos.');
    }
    if (state.output.freq === 'LAST' && state.dse.search === 'FIRST') {
      errors.push('LAST print frequency is unsafe with FIRST search in this engine build. Use ALL_SOL or FIRSTandLAST.');
    }

    if (state.presolver.model === 'ONE_PROC_MAPPINGS' && state.presolver.search === 'NONESEARCH') {
      errors.push('ONE_PROC_MAPPINGS presolver requires a Presolver Search such as FIRST or ALL.');
    }
    if (state.presolver.heuristic === 'TODAES' && state.presolver.multiSearch === 'NONESEARCH') {
      errors.push('TODAES multi-step presolving requires a Multi Search such as FIRST or ALL.');
    }

    for (const [label, number] of [
      ['Threads', state.dse.threads], ['Timeout 1', state.dse.timeout1], ['Timeout 2', state.dse.timeout2],
      ['Luby Scale', state.dse.lubyScale], ['NoGood Depth', state.dse.noGoodDepth],
      ['Presolver Timeout 1', state.presolver.timeout1], ['Presolver Timeout 2', state.presolver.timeout2]
    ]) {
      if (!Number.isInteger(number) || number < 0) errors.push(`${label} must be a non-negative integer.`);
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  document.getElementById('dse-search')?.addEventListener('change', () => {
    syncStateFromVisibleControls();
    if (state.dse.search === 'FIRST' && document.getElementById('out-freq')?.value === 'LAST') {
      document.getElementById('out-freq').value = 'ALL_SOL';
      state.output.freq = 'ALL_SOL';
      api.toast?.('Print Frequency changed to ALL_SOL because LAST is unsafe with FIRST in this engine build.', 'info');
    }
  });

  document.getElementById('btn-launch')?.addEventListener('click', event => {
    const result = validateNativeControls();
    if (!result.valid) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const log = document.getElementById('log-output');
      if (log) log.textContent = `[NATIVE CONFIG VALIDATION]\n${result.errors.map((error, index) => `${index + 1}. ${error}`).join('\n')}\n`;
      api.toast?.(`Fix ${result.errors.length} native configuration issue(s) before launch.`, 'error');
      return;
    }
    if (result.warnings.length) api.toast?.(result.warnings[0], 'info');
  }, { capture: true });

  const previousValidate = api.validateExperiment;
  if (typeof previousValidate === 'function') {
    api.validateExperiment = () => {
      const base = previousValidate();
      const native = validateNativeControls();
      return {
        valid: base.valid && native.valid,
        errors: [...(base.errors || []), ...(native.errors || [])],
        warnings: [...(base.warnings || []), ...(native.warnings || [])]
      };
    };
  }

  normalizeState();
  renderControls();
  api.save?.();
  api.validateNativeControls = validateNativeControls;
  console.info('[ParetoCo config] Native DSE controls aligned with the packaged engine parser.');
})();
