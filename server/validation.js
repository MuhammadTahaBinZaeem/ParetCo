'use strict';

const DSE_MODELS = new Set(['SDF_PR_ONLINE', 'SDF']);
const DSE_SEARCHES = new Set(['FIRST', 'ALL', 'OPTIMIZE', 'OPTIMIZE_IT']);
const DSE_CRITERIA = new Set(['POWER', 'THROUGHPUT', 'NONE']);
const DSE_PROPS = new Set(['SSE', 'MCR']);
const PRE_MODELS = new Set(['NONE', 'ONE_PROC_MAPPINGS']);
const PRE_SEARCHES = new Set(['NONESEARCH', 'FIRST', 'ALL', 'OPTIMIZE']);
const PRE_HEURISTICS = new Set(['NONE', 'TODAES']);
const OUTPUT_TYPES = new Set(['ALL_OUT', 'TXT']);
const OUTPUT_FREQUENCIES = new Set(['ALL_SOL', 'FIRSTandLAST', 'LAST']);
const LOG_LEVELS = new Set(['CRITICAL', 'ERROR', 'WARNING', 'INFO', 'DEBUG']);

function actorIdentity(actor) {
  if (typeof actor === 'string') return { name: actor, type: actor };
  return {
    name: String(actor?.name || actor?.type || '').trim(),
    type: String(actor?.type || actor?.name || '').trim()
  };
}

function validateStructuredLaunchJob(job) {
  const errors = [];
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    return { valid: false, errors: ['Launch payload must be a JSON object.'] };
  }

  const processors = Array.isArray(job.platform?.processors) ? job.platform.processors : [];
  if (!processors.length) errors.push('At least one processor is required.');
  const processorMap = new Map();
  let totalCores = 0;

  processors.forEach((proc, index) => {
    const model = String(proc?.model || '').trim();
    if (!model) errors.push(`Processor #${index + 1} has no model name.`);
    else if (processorMap.has(model)) errors.push(`Processor model “${model}” is duplicated.`);
    else processorMap.set(model, proc);

    const count = Number(proc?.count ?? 1);
    if (!Number.isInteger(count) || count < 1) errors.push(`Processor ${model || '#' + (index + 1)} has an invalid core count.`);
    else totalCores += count;

    const modes = Array.isArray(proc?.modes) ? proc.modes : [];
    if (!modes.length) errors.push(`Processor ${model || '#' + (index + 1)} has no operating mode.`);
    const modeNames = new Set();
    modes.forEach((mode, modeIndex) => {
      const name = String(mode?.name || '').trim();
      if (!name) errors.push(`Processor ${model || '#' + (index + 1)} mode #${modeIndex + 1} has no name.`);
      else if (modeNames.has(name)) errors.push(`Processor ${model} contains duplicate mode “${name}”.`);
      else modeNames.add(name);
    });
  });

  const apps = Array.isArray(job.applications) ? job.applications : [];
  if (!apps.length) errors.push('At least one application is required.');
  const appNames = new Set();
  const actorTypes = new Set();

  apps.forEach((app, appIndex) => {
    const appName = String(app?.name || '').trim();
    if (!appName) errors.push(`Application #${appIndex + 1} has no name.`);
    else if (appNames.has(appName)) errors.push(`Application name “${appName}” is duplicated.`);
    else appNames.add(appName);

    const actors = Array.isArray(app?.actors) ? app.actors : [];
    if (!actors.length) errors.push(`Application ${appName || '#' + (appIndex + 1)} has no actors.`);
    const actorNames = new Set();
    const portMap = new Map();

    actors.forEach((actor, actorIndex) => {
      const { name, type } = actorIdentity(actor);
      if (!name) errors.push(`Application ${appName || '#' + (appIndex + 1)} actor #${actorIndex + 1} has no name.`);
      else if (actorNames.has(name)) errors.push(`Application ${appName} contains duplicate actor “${name}”.`);
      else actorNames.add(name);
      if (name) actorTypes.add(name);
      if (type) actorTypes.add(type);

      let ports = Array.isArray(actor?.ports) ? actor.ports : [];
      if (!ports.length && actor && typeof actor === 'object') {
        ports = [
          ...(Array.isArray(actor.inPorts) ? actor.inPorts.map(p => ({ ...p, type: 'in' })) : []),
          ...(Array.isArray(actor.outPorts) ? actor.outPorts.map(p => ({ ...p, type: 'out' })) : [])
        ];
      }
      if (!ports.length) ports = [{ name: 'p_in', type: 'in' }, { name: 'p_out', type: 'out' }];
      portMap.set(name, new Set(ports.map(p => String(p?.name || '')).filter(Boolean)));
    });

    (Array.isArray(app?.channels) ? app.channels : []).forEach((channel, channelIndex) => {
      const label = channel?.name || `channel #${channelIndex + 1}`;
      const src = String(channel?.srcActor || channel?.src || '');
      const dst = String(channel?.dstActor || channel?.dst || '');
      const srcPort = String(channel?.srcPort || 'p_out');
      const dstPort = String(channel?.dstPort || 'p_in');
      if (!actorNames.has(src)) errors.push(`Application ${appName} ${label} references unknown source actor “${src}”.`);
      if (!actorNames.has(dst)) errors.push(`Application ${appName} ${label} references unknown destination actor “${dst}”.`);
      if (actorNames.has(src) && !portMap.get(src)?.has(srcPort)) errors.push(`Application ${appName} ${label} references missing source port ${src}.${srcPort}.`);
      if (actorNames.has(dst) && !portMap.get(dst)?.has(dstPort)) errors.push(`Application ${appName} ${label} references missing destination port ${dst}.${dstPort}.`);
    });
  });

  const wcets = Array.isArray(job.wcets) ? job.wcets : [];
  if (!wcets.length) errors.push('WCET mappings are required; the production bridge will not invent execution times.');
  const covered = new Set();
  wcets.forEach((row, index) => {
    const task = String(row?.taskType || row?.name || '').trim();
    const procName = String(row?.procModel || row?.processor || '').trim();
    const modeName = String(row?.mode || '').trim();
    const wcet = Number(row?.wcet);
    if (!task) errors.push(`WCET row #${index + 1} has no task type.`);
    else if (!actorTypes.has(task)) errors.push(`WCET task “${task}” does not match a loaded actor.`);
    else covered.add(task);

    const proc = processorMap.get(procName);
    if (!proc) errors.push(`WCET task ${task || '#' + (index + 1)} references unknown processor “${procName}”.`);
    else if (!(proc.modes || []).some(mode => String(mode?.name || '') === modeName)) errors.push(`WCET task ${task || '#' + (index + 1)} references unknown mode ${procName}.${modeName}.`);
    if (!Number.isFinite(wcet) || wcet <= 0) errors.push(`WCET task ${task || '#' + (index + 1)} must be > 0 cycles.`);
  });

  apps.forEach(app => (app.actors || []).forEach((actor, index) => {
    const { name, type } = actorIdentity(actor);
    if (!covered.has(name) && !covered.has(type)) errors.push(`Actor ${app.name || 'App'}.${name || index} has no WCET mapping.`);
  }));

  (Array.isArray(job.constraints) ? job.constraints : []).forEach((constraint, index) => {
    const appName = String(constraint?.appName || constraint?.app_name || '').trim();
    if (!appNames.has(appName)) errors.push(`Constraint #${index + 1} references unknown application “${appName}”.`);
    for (const key of ['period', 'latency']) {
      const value = Number(constraint?.[key] ?? 0);
      if (!Number.isFinite(value) || value < 0) errors.push(`Constraint ${appName || '#' + (index + 1)} has invalid ${key}.`);
    }
  });

  const sys = job.sysConstraints || {};
  for (const key of ['power', 'area', 'cost']) {
    const value = Number(sys[key]);
    if (Number.isFinite(value) && value !== -1 && value <= 0) errors.push(`System ${key} must be a positive bound or unlimited.`);
  }
  const util = Number(sys.utilization);
  if (Number.isFinite(util) && util !== -1 && (util <= 0 || util > 100)) errors.push('Minimum utilization must be between 1 and 100%, or unlimited.');
  const procsUsed = Number(sys.procsUsed);
  if (Number.isFinite(procsUsed) && procsUsed !== -1 && (!Number.isInteger(procsUsed) || procsUsed < 1 || (totalCores > 0 && procsUsed > totalCores))) {
    errors.push('procsUsed must be an integer between 1 and the platform core count, or unlimited.');
  }

  const dse = job.dse || {};
  const model = String(dse.model || 'SDF_PR_ONLINE').toUpperCase();
  const search = String(dse.search || 'FIRST').toUpperCase();
  const criteria = String(dse.criteria || 'THROUGHPUT').toUpperCase();
  const prop = String(dse.th_prop || dse.thProp || 'SSE').toUpperCase();
  if (!DSE_MODELS.has(model)) errors.push(`Unsupported DSE model “${model}”.`);
  if (!DSE_SEARCHES.has(search)) errors.push(`Unsupported DSE search mode “${search}”.`);
  if (!DSE_CRITERIA.has(criteria)) errors.push(`Unsupported DSE criteria “${criteria}”.`);
  if (!DSE_PROPS.has(prop)) errors.push(`Unsupported throughput propagator “${prop}”.`);
  if (['OPTIMIZE', 'OPTIMIZE_IT'].includes(search) && !['POWER', 'THROUGHPUT'].includes(criteria)) errors.push(`${search} requires POWER or THROUGHPUT criteria.`);
  if (search === 'OPTIMIZE_IT' && Number(dse.lubyScale ?? dse.luby_scale ?? 0) <= 0) errors.push('OPTIMIZE_IT requires a positive Luby Scale.');

  const pre = job.presolver || {};
  const preModel = String(pre.model || 'NONE').toUpperCase();
  const preSearch = String(pre.search || 'NONESEARCH').toUpperCase();
  const preHeuristic = String(pre.heuristic || 'NONE').toUpperCase();
  const preMulti = String(pre.multiSearch || pre['multi-search'] || 'NONESEARCH').toUpperCase();
  if (!PRE_MODELS.has(preModel)) errors.push(`Unsupported presolver model “${preModel}”.`);
  if (!PRE_SEARCHES.has(preSearch)) errors.push(`Unsupported presolver search “${preSearch}”.`);
  if (!PRE_HEURISTICS.has(preHeuristic)) errors.push(`Unsupported presolver heuristic “${preHeuristic}”.`);
  if (!PRE_SEARCHES.has(preMulti)) errors.push(`Unsupported presolver multi-search “${preMulti}”.`);
  if (preModel === 'ONE_PROC_MAPPINGS' && preSearch === 'NONESEARCH') errors.push('ONE_PROC_MAPPINGS presolver requires a search mode.');
  if (preHeuristic === 'TODAES' && preMulti === 'NONESEARCH') errors.push('TODAES requires a multi-search mode.');

  const output = job.output || {};
  const outputType = String(output.type || 'ALL_OUT').toUpperCase();
  const outputFreq = String(output.freq || 'ALL_SOL');
  const logLevel = String(output.logLevel || 'INFO').toUpperCase();
  if (!OUTPUT_TYPES.has(outputType)) errors.push(`Unsupported hosted output type “${outputType}”.`);
  if (!OUTPUT_FREQUENCIES.has(outputFreq)) errors.push(`Unsupported output frequency “${outputFreq}”.`);
  if (search === 'FIRST' && outputFreq === 'LAST') errors.push('LAST output frequency is unsafe with FIRST search in this engine build.');
  if (!LOG_LEVELS.has(logLevel)) errors.push(`Unsupported log level “${logLevel}”.`);

  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

module.exports = { validateStructuredLaunchJob };
