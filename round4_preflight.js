'use strict';

/**
 * Fourth reliability pass: validate structured experiments on both browser and
 * server boundaries before the native solver is invoked. Native engine files are
 * not modified.
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

function patchFile(relativePath, transform) {
  const filePath = path.join(ROOT, relativePath);
  if (!fs.existsSync(filePath)) return;
  const before = fs.readFileSync(filePath, 'utf8');
  const after = transform(before);
  if (after !== before) {
    fs.writeFileSync(filePath, after, 'utf8');
    console.log(`[round4-preflight] patched ${relativePath}`);
  }
}

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  if (!source.includes(oldText)) {
    console.warn(`[round4-preflight] ${label}: target not found`);
    return source;
  }
  console.log(`[round4-preflight] ${label}: applied`);
  return source.replace(oldText, newText);
}

patchFile('ui/index.html', source => replaceOnce(
  source,
  '  <script src="runtime_fixes.js"></script>',
  '  <script src="runtime_fixes.js"></script>\n  <script src="round4_runtime.js"></script>',
  'load experiment validation runtime'
));

patchFile('ui/app.js', source => {
  source = replaceOnce(
    source,
    '    cfg += `log-level=${state.output.logLevel}\\n`;\n    cfg += `log-level=DEBUG\\n\\n`;',
    '    cfg += `log-level=${state.output.logLevel}\\n\\n`;',
    'remove duplicate forced DEBUG log level from exported config'
  );
  return source;
});

patchFile('ui/runtime_fixes.js', source => {
  source = replaceOnce(
    source,
    `      api.loadPlatformXml?.(buildPlatformXml(data.platform));
      api.save?.();
      if (button) button.textContent = 'Verifying with native DSE…';`,
    `      api.loadPlatformXml?.(buildPlatformXml(data.platform));
      state.results = null;
      api.save?.();
      if (button) button.textContent = 'Verifying with native DSE…';`,
    'invalidate baseline result before Auto-Optimize native verification'
  );

  source = replaceOnce(
    source,
    `      if (!gotFreshNativeResult) {
        api.loadPlatformXml?.(buildPlatformXml(baselinePlatform));
        throw new Error('Native verification did not complete; the original platform was restored.');
      }`,
    `      if (!gotFreshNativeResult) {
        api.loadPlatformXml?.(buildPlatformXml(baselinePlatform));
        state.results = baselineResultsRef;
        api.save?.();
        throw new Error('Native verification did not complete; the original platform and baseline results were restored.');
      }`,
    'restore baseline result if Auto-Optimize verification fails'
  );
  return source;
});

patchFile('server.js', source => {
  const nativeRequiredBlock = `function nativeRequired() {
  return String(process.env.PARETOCO_REQUIRE_NATIVE || '').toLowerCase() === 'true';
}`;

  const validationBlock = `function nativeRequired() {
  return String(process.env.PARETOCO_REQUIRE_NATIVE || '').toLowerCase() === 'true';
}

function validateStructuredLaunchJob(job) {
  const errors = [];
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    return { valid: false, errors: ['Launch payload must be a JSON object.'] };
  }
  if (typeof job.configText === 'string' && !job.platform && !job.applications) {
    return { valid: false, errors: ['Raw config text alone is not sufficient for the web solver bridge. Send structured platform, applications, WCETs, constraints and DSE settings.'] };
  }

  const processors = Array.isArray(job.platform?.processors) ? job.platform.processors : [];
  if (processors.length === 0) errors.push('At least one processor is required.');
  const processorMap = new Map();
  let totalCores = 0;
  processors.forEach((proc, index) => {
    const name = String(proc?.model || '').trim();
    if (!name) errors.push(\`Processor #\${index + 1} has no model name.\`);
    else if (processorMap.has(name)) errors.push(\`Processor model “\${name}” is duplicated.\`);
    else processorMap.set(name, proc);
    const count = Number(proc?.count ?? 1);
    if (!Number.isInteger(count) || count < 1) errors.push(\`Processor \${name || '#' + (index + 1)} has invalid core count.\`);
    else totalCores += count;
    const modes = Array.isArray(proc?.modes) ? proc.modes : [];
    if (modes.length === 0) errors.push(\`Processor \${name || '#' + (index + 1)} has no operating mode.\`);
    const modeNames = new Set();
    modes.forEach((mode, modeIndex) => {
      const modeName = String(mode?.name || '').trim();
      if (!modeName) errors.push(\`Processor \${name || '#' + (index + 1)} mode #\${modeIndex + 1} has no name.\`);
      else if (modeNames.has(modeName)) errors.push(\`Processor \${name} contains duplicate mode “\${modeName}”.\`);
      else modeNames.add(modeName);
    });
  });

  const apps = Array.isArray(job.applications) ? job.applications : [];
  if (apps.length === 0) errors.push('At least one application is required.');
  const appNames = new Set();
  const actorKeys = new Set();
  apps.forEach((app, appIndex) => {
    const appName = String(app?.name || '').trim();
    if (!appName) errors.push(\`Application #\${appIndex + 1} has no name.\`);
    else if (appNames.has(appName)) errors.push(\`Application name “\${appName}” is duplicated.\`);
    else appNames.add(appName);
    const actors = Array.isArray(app?.actors) ? app.actors : [];
    if (actors.length === 0) errors.push(\`Application \${appName || '#' + (appIndex + 1)} has no actors.\`);
    const actorNames = new Set();
    const portMap = new Map();
    actors.forEach((actor, actorIndex) => {
      const name = String(typeof actor === 'string' ? actor : (actor?.name || actor?.type || '')).trim();
      const type = String(typeof actor === 'string' ? actor : (actor?.type || actor?.name || '')).trim();
      if (!name) errors.push(\`Application \${appName || '#' + (appIndex + 1)} actor #\${actorIndex + 1} has no name.\`);
      else if (actorNames.has(name)) errors.push(\`Application \${appName} contains duplicate actor “\${name}”.\`);
      else actorNames.add(name);
      if (name) actorKeys.add(name);
      if (type) actorKeys.add(type);
      let ports = Array.isArray(actor?.ports) ? actor.ports : [];
      if (!ports.length && typeof actor === 'object') {
        ports = [
          ...(Array.isArray(actor?.inPorts) ? actor.inPorts.map(port => ({ ...port, type: 'in' })) : []),
          ...(Array.isArray(actor?.outPorts) ? actor.outPorts.map(port => ({ ...port, type: 'out' })) : [])
        ];
      }
      if (!ports.length) ports = [{ name: 'p_in' }, { name: 'p_out' }];
      portMap.set(name, new Set(ports.map(port => String(port?.name || '')).filter(Boolean)));
    });
    (Array.isArray(app?.channels) ? app.channels : []).forEach((channel, channelIndex) => {
      const label = channel?.name || \`channel #\${channelIndex + 1}\`;
      const src = String(channel?.srcActor || channel?.src || '');
      const dst = String(channel?.dstActor || channel?.dst || '');
      const srcPort = String(channel?.srcPort || 'p_out');
      const dstPort = String(channel?.dstPort || 'p_in');
      if (!actorNames.has(src)) errors.push(\`Application \${appName} \${label} references unknown source actor “\${src}”.\`);
      if (!actorNames.has(dst)) errors.push(\`Application \${appName} \${label} references unknown destination actor “\${dst}”.\`);
      if (actorNames.has(src) && portMap.get(src)?.size && !portMap.get(src).has(srcPort)) errors.push(\`Application \${appName} \${label} references missing source port \${src}.\${srcPort}.\`);
      if (actorNames.has(dst) && portMap.get(dst)?.size && !portMap.get(dst).has(dstPort)) errors.push(\`Application \${appName} \${label} references missing destination port \${dst}.\${dstPort}.\`);
    });
  });

  const wcets = Array.isArray(job.wcets) ? job.wcets : [];
  if (wcets.length === 0) errors.push('WCET mappings are required; the production bridge will not invent execution times.');
  const coveredTasks = new Set();
  wcets.forEach((row, index) => {
    const task = String(row?.taskType || row?.name || '').trim();
    const procName = String(row?.processor || row?.procModel || '').trim();
    const modeName = String(row?.mode || '').trim();
    const wcet = Number(row?.wcet);
    if (!task) errors.push(\`WCET row #\${index + 1} has no task type.\`);
    else if (!actorKeys.has(task)) errors.push(\`WCET task “\${task}” does not match a loaded actor.\`);
    else coveredTasks.add(task);
    const proc = processorMap.get(procName);
    if (!proc) errors.push(\`WCET task \${task || '#' + (index + 1)} references unknown processor “\${procName}”.\`);
    else if (!(proc.modes || []).some(mode => String(mode?.name || '') === modeName)) errors.push(\`WCET task \${task || '#' + (index + 1)} references unknown mode \${procName}.\${modeName}.\`);
    if (!Number.isFinite(wcet) || wcet <= 0) errors.push(\`WCET task \${task || '#' + (index + 1)} must be > 0 cycles.\`);
  });
  apps.forEach(app => (app.actors || []).forEach((actor, index) => {
    const name = String(typeof actor === 'string' ? actor : (actor?.name || '')).trim();
    const type = String(typeof actor === 'string' ? actor : (actor?.type || actor?.name || '')).trim();
    if (!coveredTasks.has(name) && !coveredTasks.has(type)) errors.push(\`Actor \${app.name || 'App'}.\${name || index} has no WCET mapping.\`);
  }));

  (Array.isArray(job.constraints) ? job.constraints : []).forEach((constraint, index) => {
    const appName = String(constraint?.appName || constraint?.app_name || '').trim();
    if (!appNames.has(appName)) errors.push(\`Constraint #\${index + 1} references unknown application “\${appName}”.\`);
    for (const key of ['period', 'latency']) {
      const value = Number(constraint?.[key] ?? 0);
      if (!Number.isFinite(value) || value < 0) errors.push(\`Constraint \${appName || '#' + (index + 1)} has invalid \${key}.\`);
    }
  });

  const sys = job.sysConstraints || {};
  const util = Number(sys.utilization);
  if (Number.isFinite(util) && util !== -1 && (util <= 0 || util > 100)) errors.push('Minimum utilization must be between 1 and 100%, or unlimited.');
  const procsUsed = Number(sys.procsUsed);
  if (Number.isFinite(procsUsed) && procsUsed !== -1 && (!Number.isInteger(procsUsed) || procsUsed < 1 || (totalCores > 0 && procsUsed > totalCores))) errors.push('procsUsed must be an integer between 1 and the platform core count, or unlimited.');
  for (const key of ['power', 'area', 'cost']) {
    const value = Number(sys[key]);
    if (Number.isFinite(value) && value !== -1 && value <= 0) errors.push(\`System \${key} must be a positive bound or unlimited.\`);
  }

  const dse = job.dse || {};
  const search = String(dse.search || 'FIRST').toUpperCase();
  const criteria = String(dse.criteria || 'THROUGHPUT').toUpperCase();
  const prop = String(dse.th_prop || dse.thProp || 'SSE').toUpperCase();
  if (!['FIRST', 'ALL', 'OPTIMIZE', 'OPTIMIZE_IT'].includes(search)) errors.push(\`Unsupported DSE search mode “\${search}”.\`);
  if (!['POWER', 'THROUGHPUT', 'AREA', 'COST', 'NONE'].includes(criteria)) errors.push(\`Unsupported DSE criteria “\${criteria}”.\`);
  if (!['SSE', 'MCR'].includes(prop)) errors.push(\`Unsupported throughput propagator “\${prop}”.\`);

  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}`;

  source = replaceOnce(source, nativeRequiredBlock, validationBlock, 'add server-side structured launch validator');

  source = replaceOnce(
    source,
    `  const nativeEngine = findNativeEngine();
  const requireNative = nativeRequired();`,
    `  const launchValidation = validateStructuredLaunchJob(jobData);
  if (!launchValidation.valid) {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'DSE launch payload is inconsistent.', validationErrors: launchValidation.errors }));
    return;
  }

  const nativeEngine = findNativeEngine();
  const requireNative = nativeRequired();`,
    'reject inconsistent jobs before native launch'
  );
  return source;
});

require('./round3_preflight');
