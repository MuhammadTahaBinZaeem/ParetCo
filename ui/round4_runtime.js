/* ParetoCo model integrity + launch validation layer.
 * Prevents broken references and stale experiment results from reaching the
 * native solver. Native engine behavior is not modified.
 */
(() => {
  'use strict';

  const api = window.paretoco;
  if (!api?.state) return;
  const state = api.state;

  const ALLOWED_SEARCH = new Set(['FIRST', 'ALL', 'OPTIMIZE', 'OPTIMIZE_IT']);
  const ALLOWED_CRITERIA = new Set(['POWER', 'THROUGHPUT', 'AREA', 'COST', 'NONE']);
  const ALLOWED_PROP = new Set(['SSE', 'MCR']);

  function actorName(actor, index = 0) {
    return String(typeof actor === 'string' ? actor : (actor?.name || actor?.type || `actor_${index}`));
  }

  function actorType(actor, index = 0) {
    return String(typeof actor === 'string' ? actor : (actor?.type || actor?.name || `actor_${index}`));
  }

  function actorPorts(actor) {
    if (Array.isArray(actor?.ports) && actor.ports.length) return actor.ports;
    const ports = [];
    for (const port of actor?.inPorts || []) ports.push({ ...port, type: 'in' });
    for (const port of actor?.outPorts || []) ports.push({ ...port, type: 'out' });
    if (ports.length) return ports;
    return [{ name: 'p_in', type: 'in', rate: 1 }, { name: 'p_out', type: 'out', rate: 1 }];
  }

  function currentProcessorMap() {
    const map = new Map();
    for (const proc of state.platform?.processors || []) {
      map.set(String(proc?.model || ''), proc);
    }
    return map;
  }

  function currentActorKeys() {
    const set = new Set();
    for (const app of state.applications || []) {
      (app.actors || []).forEach((actor, index) => {
        set.add(actorName(actor, index));
        set.add(actorType(actor, index));
      });
    }
    return set;
  }

  function validateExperiment() {
    const errors = [];
    const warnings = [];
    const processors = state.platform?.processors || [];
    const applications = state.applications || [];
    const wcets = state.wcets || [];
    const constraints = state.constraints || [];

    if (processors.length === 0) errors.push('Define at least one processor before launching DSE.');
    const processorNames = new Set();
    let totalCores = 0;
    for (const [pi, proc] of processors.entries()) {
      const name = String(proc?.model || '').trim();
      if (!name) errors.push(`Processor #${pi + 1} has no model name.`);
      else if (processorNames.has(name)) errors.push(`Processor model name “${name}” is duplicated.`);
      else processorNames.add(name);

      const count = Number(proc?.count);
      if (!Number.isInteger(count) || count < 1) errors.push(`Processor ${name || `#${pi + 1}`} must have an integer core count ≥ 1.`);
      else totalCores += count;

      const modes = Array.isArray(proc?.modes) ? proc.modes : [];
      if (modes.length === 0) errors.push(`Processor ${name || `#${pi + 1}`} has no operating mode.`);
      const modeNames = new Set();
      for (const [mi, mode] of modes.entries()) {
        const modeName = String(mode?.name || '').trim();
        if (!modeName) errors.push(`Processor ${name || `#${pi + 1}`} mode #${mi + 1} has no name.`);
        else if (modeNames.has(modeName)) errors.push(`Processor ${name} contains duplicate mode “${modeName}”.`);
        else modeNames.add(modeName);
        const mem = Number(mode?.mem);
        if (!Number.isFinite(mem) || mem < 0) errors.push(`${name}.${modeName || `mode${mi + 1}`} has invalid memory.`);
        for (const key of ['dynPower', 'staticPower', 'area', 'monetary']) {
          const value = Number(mode?.[key]);
          if (!Number.isFinite(value) || value < 0) errors.push(`${name}.${modeName || `mode${mi + 1}`} has invalid ${key}.`);
        }
      }
    }

    if (applications.length === 0) errors.push('Load or create at least one SDF application before launching DSE.');
    const appNames = new Set();
    const allActorKeys = new Set();
    for (const [ai, app] of applications.entries()) {
      const appName = String(app?.name || '').trim();
      if (!appName) errors.push(`Application #${ai + 1} has no name.`);
      else if (appNames.has(appName)) errors.push(`Application name “${appName}” is duplicated.`);
      else appNames.add(appName);

      const actors = Array.isArray(app?.actors) ? app.actors : [];
      if (actors.length === 0) errors.push(`Application ${appName || `#${ai + 1}`} has no actors.`);
      const names = new Set();
      const portMap = new Map();
      actors.forEach((actor, index) => {
        const name = actorName(actor, index).trim();
        const type = actorType(actor, index).trim();
        if (!name) errors.push(`${appName || `Application #${ai + 1}`} contains an unnamed actor.`);
        else if (names.has(name)) errors.push(`${appName} contains duplicate actor name “${name}”.`);
        else names.add(name);
        if (name) allActorKeys.add(name);
        if (type) allActorKeys.add(type);
        portMap.set(name, new Set(actorPorts(actor).map(port => String(port?.name || '')).filter(Boolean)));
      });

      for (const [ci, channel] of (app?.channels || []).entries()) {
        const label = channel?.name || `channel #${ci + 1}`;
        const src = String(channel?.srcActor || channel?.src || '');
        const dst = String(channel?.dstActor || channel?.dst || '');
        const srcPort = String(channel?.srcPort || 'p_out');
        const dstPort = String(channel?.dstPort || 'p_in');
        if (!names.has(src)) errors.push(`${appName} ${label} references unknown source actor “${src}”.`);
        if (!names.has(dst)) errors.push(`${appName} ${label} references unknown destination actor “${dst}”.`);
        if (names.has(src) && portMap.get(src)?.size && !portMap.get(src).has(srcPort)) errors.push(`${appName} ${label} references missing source port ${src}.${srcPort}.`);
        if (names.has(dst) && portMap.get(dst)?.size && !portMap.get(dst).has(dstPort)) errors.push(`${appName} ${label} references missing destination port ${dst}.${dstPort}.`);
        const tokens = Number(channel?.initialTokens ?? channel?.tokens ?? 0);
        if (!Number.isInteger(tokens) || tokens < 0) errors.push(`${appName} ${label} has invalid initialTokens.`);
        const size = Number(channel?.size ?? 1);
        if (!Number.isFinite(size) || size <= 0) errors.push(`${appName} ${label} has invalid token size.`);
      }
    }

    if (wcets.length === 0) errors.push('Define WCET mappings before launching DSE; ParetoCo will not invent execution times.');
    const processorMap = currentProcessorMap();
    const coveredActorKeys = new Set();
    for (const [wi, row] of wcets.entries()) {
      const task = String(row?.taskType || row?.name || '').trim();
      const procName = String(row?.processor || row?.procModel || '').trim();
      const modeName = String(row?.mode || '').trim();
      const wcet = Number(row?.wcet);
      if (!task) errors.push(`WCET row #${wi + 1} has no task type.`);
      else if (!allActorKeys.has(task)) errors.push(`WCET task “${task}” does not match any loaded actor name/type.`);
      else coveredActorKeys.add(task);
      const proc = processorMap.get(procName);
      if (!proc) errors.push(`WCET task ${task || `#${wi + 1}`} references unknown processor “${procName}”.`);
      else if (!(proc.modes || []).some(mode => String(mode?.name || '') === modeName)) errors.push(`WCET task ${task || `#${wi + 1}`} references unknown mode ${procName}.${modeName}.`);
      if (!Number.isFinite(wcet) || wcet <= 0) errors.push(`WCET task ${task || `#${wi + 1}`} must be > 0 cycles.`);
    }

    for (const app of applications) {
      (app.actors || []).forEach((actor, index) => {
        const name = actorName(actor, index);
        const type = actorType(actor, index);
        if (!coveredActorKeys.has(name) && !coveredActorKeys.has(type)) {
          errors.push(`Actor ${app.name || 'App'}.${name} has no valid WCET mapping.`);
        }
      });
    }

    for (const [ci, constraint] of constraints.entries()) {
      const appName = String(constraint?.appName || constraint?.app_name || '').trim();
      if (!appNames.has(appName)) errors.push(`Constraint #${ci + 1} references unknown application “${appName}”.`);
      for (const key of ['period', 'latency']) {
        const value = Number(constraint?.[key] ?? 0);
        if (!Number.isFinite(value) || value < 0) errors.push(`Constraint ${appName || `#${ci + 1}`} has invalid ${key}.`);
      }
    }

    const sys = state.sysConstraints || {};
    for (const key of ['power', 'area', 'cost']) {
      const value = Number(sys[key]);
      if (Number.isFinite(value) && value !== -1 && value <= 0) errors.push(`System ${key} must be a positive bound or left unlimited.`);
    }
    const util = Number(sys.utilization);
    if (Number.isFinite(util) && util !== -1 && (util <= 0 || util > 100)) errors.push('Minimum utilization must be between 1 and 100%, or unlimited.');
    const procsUsed = Number(sys.procsUsed);
    if (Number.isFinite(procsUsed) && procsUsed !== -1) {
      if (!Number.isInteger(procsUsed) || procsUsed < 1) errors.push('Active Processors must be an integer ≥ 1, or unlimited.');
      else if (totalCores > 0 && procsUsed > totalCores) errors.push(`Active Processors (${procsUsed}) exceeds the platform core count (${totalCores}).`);
    }

    const dse = state.dse || {};
    const search = String(dse.search || '').toUpperCase();
    const criteria = String(dse.criteria || '').toUpperCase();
    const prop = String(dse.thProp || dse.th_prop || '').toUpperCase();
    if (!ALLOWED_SEARCH.has(search)) errors.push(`Unsupported DSE search mode “${search}”.`);
    if (!ALLOWED_CRITERIA.has(criteria)) errors.push(`Unsupported DSE criteria “${criteria}”.`);
    if (!ALLOWED_PROP.has(prop)) errors.push(`Unsupported throughput propagator “${prop}”.`);
    if (search === 'OPTIMIZE_IT') warnings.push('OPTIMIZE_IT is known to be less stable through Wine on the hosted Render deployment; FIRST is recommended for demos.');

    return { valid: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
  }

  function resetCurrentResults(reason = 'Model changed; rerun DSE to refresh results.') {
    if (!state.results) return;
    state.results = null;
    const empty = document.getElementById('results-empty');
    const content = document.getElementById('results-content');
    const unsat = document.getElementById('unsat-doctor-container');
    if (empty) {
      empty.classList.remove('hidden');
      const paragraph = empty.querySelector('p');
      if (paragraph) paragraph.textContent = reason;
    }
    if (content) content.classList.add('hidden');
    if (unsat) unsat.classList.add('hidden');
    const kpi = document.getElementById('kpi-solutions');
    if (kpi) kpi.textContent = '—';
    const ai = document.getElementById('ai-markdown-render');
    if (ai) ai.textContent = '';
  }

  function reportValidation(result) {
    const log = document.getElementById('log-output');
    const lines = [
      '[VALIDATION] DSE launch blocked because the experiment is inconsistent:',
      ...result.errors.map((error, index) => `  ${index + 1}. ${error}`)
    ];
    if (result.warnings.length) {
      lines.push('', '[WARNINGS]', ...result.warnings.map(warning => `  - ${warning}`));
    }
    if (log) log.textContent = `${lines.join('\n')}\n`;
    api.toast?.(`Fix ${result.errors.length} model issue(s) before launching DSE.`, 'error');
  }

  function validateBeforeLaunch() {
    const result = validateExperiment();
    if (!result.valid) reportValidation(result);
    else if (result.warnings.length) api.toast?.(result.warnings[0], 'info');
    return result;
  }

  // The visible launch button is wired directly to a private launchDSE function,
  // so validate at capture phase before that legacy listener can run.
  document.getElementById('btn-launch')?.addEventListener('click', event => {
    const result = validateBeforeLaunch();
    if (!result.valid) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, { capture: true });

  // Programmatic native reruns (Auto-Optimize / UNSAT repair) use the public API.
  const originalLaunch = api.launchEngine?.bind(api);
  if (originalLaunch) {
    api.launchEngine = async (...args) => {
      const result = validateBeforeLaunch();
      if (!result.valid) return false;
      await originalLaunch(...args);
      return Boolean(state.results);
    };
  }

  function wrapMutator(name, wrapper) {
    const original = api[name];
    if (typeof original !== 'function') return;
    api[name] = wrapper(original.bind(api));
  }

  wrapMutator('updateProcessorModel', original => (idx, value) => {
    const proc = state.platform?.processors?.[idx];
    if (!proc) return;
    const oldName = String(proc.model || '');
    const newName = String(value || '').trim();
    if (!newName) return api.toast?.('Processor model name cannot be empty.', 'error');
    if ((state.platform.processors || []).some((candidate, pi) => pi !== idx && String(candidate.model) === newName)) {
      return api.toast?.(`Processor model “${newName}” already exists.`, 'error');
    }
    for (const row of state.wcets || []) {
      if (String(row.processor || row.procModel || '') === oldName) {
        row.processor = newName;
        row.procModel = newName;
      }
    }
    original(idx, newName);
    resetCurrentResults('Processor model changed; dependent WCET references were updated. Rerun DSE.');
  });

  wrapMutator('updateModeName', original => (idx, mi, value) => {
    const proc = state.platform?.processors?.[idx];
    const mode = proc?.modes?.[mi];
    if (!proc || !mode) return;
    const oldName = String(mode.name || '');
    const newName = String(value || '').trim();
    if (!newName) return api.toast?.('Operating mode name cannot be empty.', 'error');
    if ((proc.modes || []).some((candidate, index) => index !== mi && String(candidate.name) === newName)) {
      return api.toast?.(`Mode “${newName}” already exists on ${proc.model}.`, 'error');
    }
    for (const row of state.wcets || []) {
      const procName = String(row.processor || row.procModel || '');
      if (procName === String(proc.model) && String(row.mode || '') === oldName) row.mode = newName;
    }
    original(idx, mi, newName);
    resetCurrentResults('Operating mode changed; dependent WCET references were updated. Rerun DSE.');
  });

  wrapMutator('removeProcessor', original => idx => {
    const proc = state.platform?.processors?.[idx];
    if (!proc) return;
    const refs = (state.wcets || []).filter(row => String(row.processor || row.procModel || '') === String(proc.model));
    if (refs.length) return api.toast?.(`Cannot delete ${proc.model}: ${refs.length} WCET mapping(s) still reference it. Reassign them first.`, 'error');
    original(idx);
    resetCurrentResults('Processor removed; rerun DSE.');
  });

  wrapMutator('removeProcessorMode', original => (idx, mi) => {
    const proc = state.platform?.processors?.[idx];
    const mode = proc?.modes?.[mi];
    if (!proc || !mode) return;
    const refs = (state.wcets || []).filter(row => String(row.processor || row.procModel || '') === String(proc.model) && String(row.mode || '') === String(mode.name));
    if (refs.length) return api.toast?.(`Cannot delete ${proc.model}.${mode.name}: ${refs.length} WCET mapping(s) still reference it.`, 'error');
    original(idx, mi);
    resetCurrentResults('Operating mode removed; rerun DSE.');
  });

  wrapMutator('updateWcetProc', original => (idx, value) => {
    const row = state.wcets?.[idx];
    const proc = currentProcessorMap().get(String(value || '').trim());
    if (!row || !proc) return api.toast?.(`Unknown processor “${value}”.`, 'error');
    const modeNames = (proc.modes || []).map(mode => String(mode.name || ''));
    if (!modeNames.includes(String(row.mode || ''))) row.mode = modeNames[0] || 'default';
    original(idx, proc.model);
    resetCurrentResults('WCET mapping changed; rerun DSE.');
  });

  wrapMutator('updateWcetMode', original => (idx, value) => {
    const row = state.wcets?.[idx];
    if (!row) return;
    const procName = String(row.processor || row.procModel || '');
    const proc = currentProcessorMap().get(procName);
    const newMode = String(value || '').trim();
    if (!proc || !(proc.modes || []).some(mode => String(mode.name || '') === newMode)) {
      return api.toast?.(`Mode “${newMode}” does not exist on ${procName || 'the selected processor'}.`, 'error');
    }
    original(idx, newMode);
    resetCurrentResults('WCET mapping changed; rerun DSE.');
  });

  wrapMutator('updateWcetTask', original => (idx, value) => {
    const task = String(value || '').trim();
    if (!currentActorKeys().has(task)) return api.toast?.(`WCET task “${task}” does not match a loaded actor.`, 'error');
    original(idx, task);
    resetCurrentResults('WCET mapping changed; rerun DSE.');
  });

  wrapMutator('updateWcetTime', original => (idx, value) => {
    const wcet = Number(value);
    if (!Number.isFinite(wcet) || wcet <= 0) return api.toast?.('WCET must be greater than 0 cycles.', 'error');
    original(idx, Math.round(wcet));
    resetCurrentResults('WCET changed; rerun DSE.');
  });

  wrapMutator('updateConstraintApp', original => (idx, value) => {
    const appName = String(value || '').trim();
    if (!(state.applications || []).some(app => String(app.name || '') === appName)) return api.toast?.(`Unknown application “${appName}”.`, 'error');
    original(idx, appName);
    resetCurrentResults('Design constraint changed; rerun DSE.');
  });

  for (const name of [
    'updateProcessorCount', 'updateModeMem', 'updateModeDynPower', 'updateModeStaticPower',
    'updateModeArea', 'updateModeCost', 'updateInterconnectName', 'updateInterconnectTopology',
    'updateInterconnectXDim', 'updateInterconnectYDim', 'updateInterconnectFlit', 'updateInterconnectSlots',
    'removeInterconnect', 'updateConstraintPeriod', 'updateConstraintLatency', 'removeConstraint', 'removeWcet'
  ]) {
    wrapMutator(name, original => (...args) => {
      const result = original(...args);
      resetCurrentResults('Experiment changed; rerun DSE before analyzing results.');
      return result;
    });
  }

  wrapMutator('removeApp', original => idx => {
    const app = state.applications?.[idx];
    if (!app) return;
    const appName = String(app.name || '');
    const deletedTasks = new Set((app.actors || []).flatMap((actor, index) => [actorName(actor, index), actorType(actor, index)]));
    original(idx);
    state.constraints = (state.constraints || []).filter(constraint => String(constraint.appName || constraint.app_name || '') !== appName);
    const stillUsed = currentActorKeys();
    state.wcets = (state.wcets || []).filter(row => !deletedTasks.has(String(row.taskType || '')) || stillUsed.has(String(row.taskType || '')));
    api.save?.();
    resetCurrentResults(`Application ${appName} was removed with its orphaned constraints/WCET rows. Rerun DSE.`);
    api.toast?.(`Removed ${appName} and cleaned dependent references.`, 'info');
  });

  // Direct add buttons and configuration/system-bound controls live outside the
  // public mutator API. Any user edit invalidates the current result snapshot.
  for (const id of ['btn-add-processor', 'btn-add-interconnect', 'btn-add-constraint']) {
    document.getElementById(id)?.addEventListener('click', () => setTimeout(() => resetCurrentResults('Experiment changed; rerun DSE.'), 0));
  }
  for (const selector of ['#page-explorer input', '#page-explorer select', '#page-constraints input']) {
    document.querySelectorAll(selector).forEach(element => {
      element.addEventListener('change', () => resetCurrentResults('DSE configuration or constraints changed; rerun DSE.'));
    });
  }
  for (const id of ['sys-power', 'sys-utilization', 'sys-area', 'sys-cost', 'sys-procs']) {
    document.getElementById(id)?.addEventListener('change', () => resetCurrentResults('System constraint changed; rerun DSE.'));
  }

  // Visible imports change the model and therefore invalidate old native results.
  for (const id of ['file-platform', 'file-sdf', 'file-wcet', 'file-constraints']) {
    document.getElementById(id)?.addEventListener('change', event => {
      if (event.target.files?.length) setTimeout(() => resetCurrentResults('Imported model data changed; rerun DSE.'), 0);
    });
  }

  api.validateExperiment = validateExperiment;
  api.invalidateResults = resetCurrentResults;
  console.info('[ParetoCo validation] Dependency-safe editing and pre-launch experiment validation enabled.');
})();
