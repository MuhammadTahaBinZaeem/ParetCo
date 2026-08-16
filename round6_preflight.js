'use strict';

/**
 * Sixth reliability pass: align the UI/server configuration surface with the
 * options implemented by the packaged ParetoCo native parser.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8080);

function patchFile(relativePath, transform) {
  const filePath = path.join(ROOT, relativePath);
  if (!fs.existsSync(filePath)) return;
  const before = fs.readFileSync(filePath, 'utf8');
  const after = transform(before);
  if (after !== before) {
    fs.writeFileSync(filePath, after, 'utf8');
    console.log(`[round6-preflight] patched ${relativePath}`);
  }
}

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  if (!source.includes(oldText)) {
    console.warn(`[round6-preflight] ${label}: target not found`);
    return source;
  }
  console.log(`[round6-preflight] ${label}: applied`);
  return source.replace(oldText, newText);
}

patchFile('ui/index.html', source => replaceOnce(
  source,
  '  <script src="runtime_fixes.js"></script>',
  '  <script src="runtime_fixes.js"></script>\n  <script src="round6_runtime.js"></script>',
  'load native-config capability runtime'
));

patchFile('ui/app.js', source => {
  source = replaceOnce(
    source,
    '      model: "SDF_PR_ONLINE", search: "OPTIMIZE_IT", criteria: "POWER",',
    '      model: "SDF_PR_ONLINE", search: "FIRST", criteria: "THROUGHPUT",',
    'use a stable supported DSE default'
  );
  source = replaceOnce(
    source,
    '    output: { type: "ALL_OUT", freq: "LAST", metric: "NONE", logLevel: "INFO" },',
    '    output: { type: "ALL_OUT", freq: "ALL_SOL", metric: "NONE", logLevel: "INFO" },',
    'use output cadence safe with FIRST search'
  );

  const oldConfig = `    cfg += "log-file=output.log\\n";
    cfg += \`log-level=\${state.output.logLevel}\\n\`;
    cfg += \`log-level=DEBUG\\n\\n\`;
    cfg += \`output-file-type=\${state.output.type}\\n\`;
    cfg += \`output-print-frequency=\${state.output.freq}\\n\`;
    cfg += \`print-metric=\${state.output.metric}\\n\\n\`;

    cfg += "[dse]\\n\\n";
    cfg += \`model=\${state.dse.model}\\n\`;
    cfg += \`search=\${state.dse.search}\\n\`;
    cfg += \`criteria=\${state.dse.criteria}\\n\`;
    cfg += \`timeout=\${state.dse.timeout1}\\n\`;
    cfg += \`timeout=\${state.dse.timeout2}\\n\`;
    cfg += \`threads=\${state.dse.threads}\\n\`;
    cfg += \`luby_scale=\${state.dse.lubyScale}\\n\`;
    cfg += \`noGoodDepth=\${state.dse.noGoodDepth}\\n\`;
    cfg += \`th_prop=\${state.dse.thProp}\\n\\n\`;

    cfg += "[presolver]\\n\\n";
    cfg += \`model=\${state.presolver.model}\\n\`;
    cfg += \`search=\${state.presolver.search}\\n\`;
    cfg += \`heuristic=\${state.presolver.heuristic}\\n\`;
    cfg += \`multi-search=\${state.presolver.multiSearch}\\n\`;
    cfg += \`timeout=\${state.presolver.timeout1}\\n\`;
    cfg += \`timeout=\${state.presolver.timeout2}\\n\`;`;

  const newConfig = `    cfg += "log-file=output.log\\n";
    cfg += \`log-level=\${state.output.logLevel} DEBUG\\n\\n\`;
    cfg += \`output-file-type=\${state.output.type}\\n\`;
    cfg += \`output-print-frequency=\${state.output.freq}\\n\`;
    cfg += \`print-metric=NONE\\n\\n\`;

    cfg += "[dse]\\n\\n";
    cfg += \`model=\${state.dse.model}\\n\`;
    cfg += \`search=\${state.dse.search}\\n\`;
    cfg += \`criteria=\${state.dse.criteria}\\n\`;
    cfg += \`timeout=\${state.dse.timeout1} \${state.dse.timeout2}\\n\`;
    cfg += \`threads=\${state.dse.threads}\\n\`;
    cfg += \`luby_scale=\${state.dse.lubyScale}\\n\`;
    cfg += \`noGoodDepth=\${state.dse.noGoodDepth}\\n\`;
    cfg += \`th_prop=\${state.dse.thProp}\\n\\n\`;

    cfg += "[presolver]\\n\\n";
    cfg += \`model=\${state.presolver.model}\\n\`;
    cfg += \`search=\${state.presolver.search}\\n\`;
    cfg += \`heuristic=\${state.presolver.heuristic}\\n\`;
    cfg += \`multi-search=\${state.presolver.multiSearch}\\n\`;
    cfg += \`timeout=\${state.presolver.timeout1} \${state.presolver.timeout2}\\n\`;`;
  source = replaceOnce(source, oldConfig, newConfig, 'generate config.cfg using native vector option syntax');

  source = replaceOnce(
    source,
    '      dse: state.dse,\n      presolver: state.presolver\n    };',
    '      dse: state.dse,\n      presolver: state.presolver,\n      output: state.output\n    };',
    'send output settings to native bridge'
  );
  return source;
});

patchFile('ui/round4_runtime.js', source => source
  .replace("new Set(['POWER', 'THROUGHPUT', 'AREA', 'COST', 'NONE'])", "new Set(['POWER', 'THROUGHPUT', 'NONE'])")
);

patchFile('round4_preflight.js', source => {
  source = source.replace(
    "if (!['POWER', 'THROUGHPUT', 'AREA', 'COST', 'NONE'].includes(criteria))",
    "if (!['POWER', 'THROUGHPUT', 'NONE'].includes(criteria))"
  );

  const oldDseValidation = `  const dse = job.dse || {};
  const search = String(dse.search || 'FIRST').toUpperCase();
  const criteria = String(dse.criteria || 'THROUGHPUT').toUpperCase();
  const prop = String(dse.th_prop || dse.thProp || 'SSE').toUpperCase();`;
  const newDseValidation = `  const dse = job.dse || {};
  const model = String(dse.model || 'SDF_PR_ONLINE').toUpperCase();
  const search = String(dse.search || 'FIRST').toUpperCase();
  const criteria = String(dse.criteria || 'THROUGHPUT').toUpperCase();
  const prop = String(dse.th_prop || dse.thProp || 'SSE').toUpperCase();
  if (!['SDF_PR_ONLINE', 'SDF'].includes(model)) errors.push(\`Unsupported DSE model “\${model}”.\`);
  if ((search === 'OPTIMIZE' || search === 'OPTIMIZE_IT') && !['POWER', 'THROUGHPUT'].includes(criteria)) errors.push(\`\${search} requires POWER or THROUGHPUT criteria.\`);
  if (search === 'OPTIMIZE_IT' && Number(dse.lubyScale ?? dse.luby_scale ?? 0) <= 0) errors.push('OPTIMIZE_IT requires a positive Luby Scale.');

  const pre = job.presolver || {};
  const preModel = String(pre.model || 'NONE').toUpperCase();
  const preSearch = String(pre.search || 'NONESEARCH').toUpperCase();
  const preHeuristic = String(pre.heuristic || 'NONE').toUpperCase();
  const preMulti = String(pre.multiSearch || pre['multi-search'] || 'NONESEARCH').toUpperCase();
  if (!['NONE', 'ONE_PROC_MAPPINGS'].includes(preModel)) errors.push(\`Unsupported presolver model “\${preModel}”.\`);
  if (!['NONESEARCH', 'FIRST', 'ALL', 'OPTIMIZE'].includes(preSearch)) errors.push(\`Unsupported presolver search “\${preSearch}”.\`);
  if (!['NONE', 'TODAES'].includes(preHeuristic)) errors.push(\`Unsupported presolver heuristic “\${preHeuristic}”.\`);
  if (!['NONESEARCH', 'FIRST', 'ALL', 'OPTIMIZE'].includes(preMulti)) errors.push(\`Unsupported presolver multi-search “\${preMulti}”.\`);
  if (preModel === 'ONE_PROC_MAPPINGS' && preSearch === 'NONESEARCH') errors.push('ONE_PROC_MAPPINGS presolver requires a search mode.');
  if (preHeuristic === 'TODAES' && preMulti === 'NONESEARCH') errors.push('TODAES requires a multi-search mode.');

  const output = job.output || {};
  const outputType = String(output.type || 'ALL_OUT').toUpperCase();
  const outputFreq = String(output.freq || 'ALL_SOL');
  const logLevel = String(output.logLevel || 'INFO').toUpperCase();
  if (!['ALL_OUT', 'TXT'].includes(outputType)) errors.push(\`Unsupported hosted output type “\${outputType}”.\`);
  if (!['ALL_SOL', 'FIRSTandLAST', 'LAST'].includes(outputFreq)) errors.push(\`Unsupported output frequency “\${outputFreq}”.\`);
  if (search === 'FIRST' && outputFreq === 'LAST') errors.push('LAST output frequency is unsafe with FIRST search in this engine build.');
  if (!['CRITICAL', 'ERROR', 'WARNING', 'INFO', 'DEBUG'].includes(logLevel)) errors.push(\`Unsupported log level “\${logLevel}”.\`);`;
  source = replaceOnce(source, oldDseValidation, newDseValidation, 'expand server validation to native config controls');
  return source;
});

patchFile('server.js', source => {
  const oldBlock = `    // Write config.cfg
    const dseCriteria = jobData.dse?.criteria ? jobData.dse.criteria.toUpperCase() : 'THROUGHPUT';
    const dseProp = jobData.dse?.th_prop ? jobData.dse.th_prop.toUpperCase() : 'SSE';
    const dseSearch = jobData.dse?.search ? jobData.dse.search.toUpperCase() : 'FIRST';
    
    let configCfg = '';
    sdfFiles.forEach(sf => { configCfg += \`inputs = \${sf}\\n\`; });
    configCfg += \`inputs = platform.xml\\ninputs = wcets.xml\\n\`;
    if (constraintsXml) {
      // The packaged engine accepts design constraints as an input file. The
      // legacy design_constraints_file key is not part of this engine's CLI config parser.
      configCfg += \`inputs = desConst.xml\\n\`;
    }
    configCfg += \`\\n[dse]\\nmodel = SDF_PR_ONLINE\\ncriteria = \${dseCriteria}\\nsearch = \${dseSearch}\\nth_prop = \${dseProp}\\n\`;
    fs.writeFileSync(path.join(tempDir, 'config.cfg'), configCfg);`;

  const newBlock = `    // Write config.cfg using only options supported by this packaged engine.
    const dseConfig = jobData.dse || {};
    const preConfig = jobData.presolver || {};
    const outputConfig = jobData.output || {};
    const dseModel = String(dseConfig.model || 'SDF_PR_ONLINE').toUpperCase();
    const dseCriteria = String(dseConfig.criteria || 'THROUGHPUT').toUpperCase();
    const dseProp = String(dseConfig.th_prop || dseConfig.thProp || 'SSE').toUpperCase();
    const dseSearch = String(dseConfig.search || 'FIRST').toUpperCase();
    const dseThreads = Math.max(0, parseInt(dseConfig.threads, 10) || 0);
    const dseTimeout1 = Math.max(0, parseInt(dseConfig.timeout1, 10) || 0);
    const dseTimeout2 = Math.max(0, parseInt(dseConfig.timeout2, 10) || 0);
    const dseLuby = Math.max(0, parseInt(dseConfig.lubyScale ?? dseConfig.luby_scale, 10) || 0);
    const dseNoGood = Math.max(0, parseInt(dseConfig.noGoodDepth, 10) || 0);

    const preModel = String(preConfig.model || 'NONE').toUpperCase();
    const preSearch = String(preConfig.search || 'NONESEARCH').toUpperCase();
    const preHeuristic = String(preConfig.heuristic || 'NONE').toUpperCase();
    const preMulti = String(preConfig.multiSearch || preConfig['multi-search'] || 'NONESEARCH').toUpperCase();
    const preTimeout1 = Math.max(0, parseInt(preConfig.timeout1, 10) || 0);
    const preTimeout2 = Math.max(0, parseInt(preConfig.timeout2, 10) || 0);

    const outputType = String(outputConfig.type || 'ALL_OUT').toUpperCase();
    const outputFreq = String(outputConfig.freq || 'ALL_SOL');
    const logLevel = String(outputConfig.logLevel || 'INFO').toUpperCase();

    let configCfg = '';
    sdfFiles.forEach(sf => { configCfg += \`inputs = \${sf}\\n\`; });
    configCfg += \`inputs = platform.xml\\ninputs = wcets.xml\\n\`;
    if (constraintsXml) configCfg += \`inputs = desConst.xml\\n\`;
    configCfg += \`output-file-type = \${outputType}\\n\`;
    configCfg += \`output-print-frequency = \${outputFreq}\\n\`;
    configCfg += \`print-metric = NONE\\n\`;
    configCfg += \`log-level = \${logLevel} DEBUG\\n\`;
    configCfg += \`\\n[dse]\\nmodel = \${dseModel}\\nsearch = \${dseSearch}\\ncriteria = \${dseCriteria}\\ntimeout = \${dseTimeout1} \${dseTimeout2}\\nthreads = \${dseThreads}\\nluby_scale = \${dseLuby}\\nnoGoodDepth = \${dseNoGood}\\nth_prop = \${dseProp}\\n\`;
    configCfg += \`\\n[presolver]\\nmodel = \${preModel}\\nsearch = \${preSearch}\\nheuristic = \${preHeuristic}\\nmulti-search = \${preMulti}\\ntimeout = \${preTimeout1} \${preTimeout2}\\n\`;
    fs.writeFileSync(path.join(tempDir, 'config.cfg'), configCfg);`;
  source = replaceOnce(source, oldBlock, newBlock, 'forward DSE, presolver and output controls to native config.cfg');
  return source;
});

function postJson(pathname, payload, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk.toString(); });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode || 0, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function configControlSmoke() {
  const payload = {
    platform: { processors: [{ model: 'ARM', count: 2, modes: [{ name: 'default', cycle: 1, mem: 4096, dynPower: 10, staticPower: 2, area: 5, monetary: 10 }] }], interconnects: [{ name: 'bus0', topology: 'TDMA-bus', xDim: 2, yDim: 1, flitSize: 32, slots: 2 }] },
    applications: [{ name: 'ConfigSmoke', actors: [{ name: 'src', type: 'src' }, { name: 'work', type: 'work' }], channels: [{ name: 'c1', srcActor: 'src', dstActor: 'work', initialTokens: 0 }, { name: 'c2', srcActor: 'work', dstActor: 'src', initialTokens: 1 }] }],
    wcets: [{ taskType: 'src', processor: 'ARM', mode: 'default', wcet: 10 }, { taskType: 'work', processor: 'ARM', mode: 'default', wcet: 20 }],
    constraints: [{ appName: 'ConfigSmoke', period: 1000, latency: 0 }],
    sysConstraints: { power: -1, utilization: -1, area: -1, cost: -1, procsUsed: -1 },
    dse: { model: 'SDF_PR_ONLINE', search: 'FIRST', criteria: 'THROUGHPUT', thProp: 'MCR', th_prop: 'MCR', threads: 1, timeout1: 10000, timeout2: 0, lubyScale: 10, noGoodDepth: 20 },
    presolver: { model: 'NONE', search: 'NONESEARCH', heuristic: 'NONE', multiSearch: 'NONESEARCH', timeout1: 0, timeout2: 0 },
    output: { type: 'ALL_OUT', freq: 'ALL_SOL', metric: 'NONE', logLevel: 'INFO' }
  };
  try {
    const response = await postJson('/api/launch', payload, 35_000);
    const text = String(response.json?.outTxt || response.json?.log || '');
    const ok = response.status === 200 && response.json?.success !== false && /\b[1-9]\d*\s+solutions?\s+found/i.test(text);
    console[ok ? 'log' : 'error'](`[config-controls-smoke] ${ok ? 'PASS' : 'FAIL'}${ok ? ': threads/timeouts/MCR/output config parsed and ran natively.' : `: HTTP ${response.status} ${response.json?.error || response.text.slice(-700)}`}`);
  } catch (error) {
    console.error(`[config-controls-smoke] FAIL: ${error.message}`);
  }
}

require('./round5_preflight');
setTimeout(configControlSmoke, 7_000).unref?.();
