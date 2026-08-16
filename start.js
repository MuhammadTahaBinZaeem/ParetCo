'use strict';

/**
 * ParetoCo production bootstrap.
 * Keeps the native engine untouched while hardening the web/AI bridge around it.
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const ROOT_DIR = __dirname;
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DIAGNOSTIC_TAIL = 12_000;
const WINE_DEBUG = process.env.PARETOCO_WINEDEBUG || '-all,err+all';

function tail(text, limit = DIAGNOSTIC_TAIL) {
  const value = String(text || '');
  return value.length > limit ? value.slice(-limit) : value;
}

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return { source, changed: false };
  if (!source.includes(oldText)) {
    console.warn(`[bridge-fix] ${label}: target not found; current source may already differ.`);
    return { source, changed: false };
  }
  console.log(`[bridge-fix] ${label}: applied.`);
  return { source: source.replace(oldText, newText), changed: true };
}

/**
 * Patch only the JS bridge layer at boot. The native executable/DLLs are never
 * modified. These compatibility repairs mirror capabilities already present in
 * the bundled DeSyDe-derived engine (notably power/area/money constraints in
 * desConst.xml).
 */
function applyBridgeCompatibilityFixes() {
  const serverPath = path.join(ROOT_DIR, 'server.js');
  if (!fs.existsSync(serverPath)) return;

  let source = fs.readFileSync(serverPath, 'utf8');
  let changed = false;
  const apply = (oldText, newText, label) => {
    const result = replaceOnce(source, oldText, newText, label);
    source = result.source;
    changed ||= result.changed;
  };

  apply(
    "        const pModel = w.procModel || firstProcModel;",
    "        const pModel = w.procModel || w.processor || firstProcModel;",
    'honor imported WCET processor field'
  );

  apply(
    "    const dseProp = jobData.dse?.th_prop ? jobData.dse.th_prop.toUpperCase() : 'SSE';",
    "    const dseProp = String(jobData.dse?.th_prop || jobData.dse?.thProp || 'SSE').toUpperCase();",
    'honor UI thProp selection'
  );

  const oldConstraintsBlock = `    // Write Design Constraints XML\n    let constraintsXml = jobData.constraintsXml;\n    if (!constraintsXml && jobData.constraints && jobData.constraints.length > 0) {\n      constraintsXml = \`<?xml version="1.0" encoding="UTF-8"?>\\n<designConstraints>\\n\`;\n      jobData.constraints.forEach(c => {\n        constraintsXml += \`  <constraint app_name="\${c.appName || 'App'}" period="\${c.period || 0}" latency="\${c.latency || 0}"></constraint>\\n\`;\n      });\n      constraintsXml += \`</designConstraints>\\n\`;\n    }\n    if (constraintsXml) {\n      fs.writeFileSync(path.join(tempDir, 'desConst.xml'), constraintsXml);\n    }`;

  const newConstraintsBlock = `    // Write canonical Design Constraints XML. System power/area/money bounds are\n    // already supported by the native engine on <constraint> attributes; the old\n    // browser bridge simply never forwarded them. Rebuild instead of trusting a\n    // stale client-generated constraintsXml payload.\n    const sysConstraints = jobData.sysConstraints || {};\n    const positiveInt = (value) => {\n      const number = Number(value);\n      return Number.isFinite(number) && number > 0 ? Math.round(number) : null;\n    };\n    const escapeXmlAttr = (value) => String(value ?? '')\n      .replace(/&/g, '&amp;')\n      .replace(/"/g, '&quot;')\n      .replace(/</g, '&lt;')\n      .replace(/>/g, '&gt;');\n\n    const nativeSystemAttrs = [];\n    const nativePower = positiveInt(sysConstraints.power ?? sysConstraints.maxPower);\n    const nativeArea = positiveInt(sysConstraints.area);\n    const nativeMoney = positiveInt(sysConstraints.cost ?? sysConstraints.money);\n    if (nativePower !== null) nativeSystemAttrs.push(\`power="\${nativePower}"\`);\n    if (nativeArea !== null) nativeSystemAttrs.push(\`area="\${nativeArea}"\`);\n    if (nativeMoney !== null) nativeSystemAttrs.push(\`money="\${nativeMoney}"\`);\n\n    // Native 'utilization' is a minimum and native 'procsUsed' is equality, while\n    // the current UI labels those fields as maxima. Do not invert user intent by\n    // silently passing them to the engine. They remain available for post-analysis.\n    const constraintRows = Array.isArray(jobData.constraints) ? jobData.constraints : [];\n    let constraintsXml = '';\n    if (constraintRows.length > 0 || nativeSystemAttrs.length > 0) {\n      constraintsXml = \`<?xml version="1.0" encoding="UTF-8"?>\\n<designConstraints>\\n\`;\n      if (constraintRows.length > 0) {\n        constraintRows.forEach(c => {\n          const attrs = [\n            \`app_name="\${escapeXmlAttr(c.appName || c.app_name || 'App')}"\`,\n            \`period="\${Math.max(0, parseInt(c.period, 10) || 0)}"\`,\n            \`latency="\${Math.max(0, parseInt(c.latency, 10) || 0)}"\`,\n            ...nativeSystemAttrs\n          ];\n          constraintsXml += \`  <constraint \${attrs.join(' ')}></constraint>\\n\`;\n        });\n      } else {\n        constraintsXml += \`  <constraint \${nativeSystemAttrs.join(' ')}></constraint>\\n\`;\n      }\n      constraintsXml += \`</designConstraints>\\n\`;\n      fs.writeFileSync(path.join(tempDir, 'desConst.xml'), constraintsXml);\n    }`;

  apply(oldConstraintsBlock, newConstraintsBlock, 'forward system constraints to native desConst.xml');

  apply(
    "          const powersFound = [...outTxt.matchAll(/sys power(?:\\s*\\(only used parts\\))?:\\s*(\\d+(?:\\.\\d+)?)/gi)].map(m => parseFloat(m[1]));",
    "          const powersFound = [...outTxt.matchAll(/sys power(?:\\s*\\(only used parts\\))?:\\s*(?:\\{\\s*)?\\[?\\s*(-?\\d+(?:\\.\\d+)?)/gi)].map(m => parseFloat(m[1]));",
    'recognize native interval power output such as [682..1002]'
  );

  apply(
    'Goal: ${budgetPrompt}\\nCurrent Platform: ${JSON.stringify(platform)}\\nBaseline Results: ${resultsText}\\n\\nCall modify_architecture, then run_dse_engine, then inspect results.',
    'Goal: ${budgetPrompt}\\nCurrent Platform: ${JSON.stringify(platform)}\\nBaseline Results: ${resultsText}\\n\\nPropose a complete modified platform JSON. It will be verified by a subsequent native DSE run.',
    'remove nonexistent architecture-agent tool instruction'
  );

  if (changed) fs.writeFileSync(serverPath, source, 'utf8');
}

function applyDemoPresetCompatibilityFix() {
  const appPath = path.join(ROOT_DIR, 'ui', 'app.js');
  if (!fs.existsSync(appPath)) return;

  let source = fs.readFileSync(appPath, 'utf8');
  let changed = false;

  const original = [
    '    state.dse.criteria = "THROUGHPUT";',
    '    state.dse.search = "FIRST";',
    '    state.dse.th_prop = "SSE";',
    '',
    '    renderPlatform();'
  ].join('\n');
  const fixed = [
    '    state.dse.criteria = "THROUGHPUT";',
    '    state.dse.search = "FIRST";',
    '    state.dse.thProp = "SSE";',
    '    syncFormFromState();',
    '',
    '    renderPlatform();'
  ].join('\n');
  if (source.includes(original)) {
    source = source.replace(original, fixed);
    changed = true;
    console.log('[demo-fix] Demo preset synchronized with FIRST + THROUGHPUT + SSE.');
  }

  if (source.includes('Object.assign(state.config, data.model.dse);')) {
    source = source.replace('Object.assign(state.config, data.model.dse);', 'Object.assign(state.dse, data.model.dse);');
    changed = true;
    console.log('[ai-fix] NL-to-DSE now writes into state.dse.');
  }

  const oldAiConstraintLine = '          if (data.model.constraints) state.constraints = data.model.constraints;';
  const newAiConstraintBlock = [
    '          if (data.model.constraints) state.constraints = data.model.constraints;',
    '          if (data.model.sysConstraints) {',
    '            Object.assign(state.sysConstraints, data.model.sysConstraints);',
    '            const sysFields = { power: "sys-power", utilization: "sys-utilization", area: "sys-area", cost: "sys-cost", procsUsed: "sys-procs" };',
    '            Object.entries(sysFields).forEach(([key, id]) => {',
    '              const el = document.getElementById(id);',
    '              const value = Number(state.sysConstraints[key]);',
    '              if (el) el.value = Number.isFinite(value) && value > 0 ? String(value) : "";',
    '            });',
    '          }'
  ].join('\n');
  if (!source.includes(newAiConstraintBlock) && source.includes(oldAiConstraintLine)) {
    source = source.replace(oldAiConstraintLine, newAiConstraintBlock);
    changed = true;
    console.log('[ai-fix] NL-to-DSE system constraints now populate state and visible fields.');
  }

  if (changed) fs.writeFileSync(appPath, source, 'utf8');
}

applyBridgeCompatibilityFixes();
applyDemoPresetCompatibilityFix();

function isWineCommand(command) {
  const base = path.basename(String(command || '')).toLowerCase();
  return base === 'wine' || base === 'wine64';
}

function isParetoCoInvocation(command, args) {
  if (!isWineCommand(command)) return false;
  return (args || []).some(arg => /paretoco-engine\.exe$/i.test(String(arg)));
}

function formatNativeDiagnostic({ command, args, cwd, code, signal, stdout, stderr }) {
  const commandLine = [command, ...(args || [])].map(String).join(' ');
  return [
    '[native-diagnostics]',
    `command: ${commandLine}`,
    `cwd: ${cwd || process.cwd()}`,
    `platform: ${process.platform}/${process.arch}`,
    `wineDebug: ${WINE_DEBUG}`,
    `winePrefix: ${process.env.WINEPREFIX || path.join(os.tmpdir(), 'paretoco-wine')}`,
    `exitCode: ${code}`,
    `signal: ${signal || 'none'}`,
    '--- native stdout (tail) ---',
    tail(stdout).trim() || '<empty>',
    '--- wine/native stderr (tail) ---',
    tail(stderr).trim() || '<empty>',
    '[/native-diagnostics]'
  ].join('\n');
}

const originalSpawn = childProcess.spawn;
childProcess.spawn = function patchedSpawn(command, args = [], options = {}) {
  let launchOptions = options;
  if (isWineCommand(command)) {
    launchOptions = {
      ...options,
      env: { ...(options.env || process.env), WINEDEBUG: WINE_DEBUG }
    };
  }

  const child = originalSpawn.call(childProcess, command, args, launchOptions);
  if (!isParetoCoInvocation(command, args)) return child;

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => { stdout = tail(stdout + chunk.toString(), DIAGNOSTIC_TAIL * 2); });
  child.stderr?.on('data', chunk => { stderr = tail(stderr + chunk.toString(), DIAGNOSTIC_TAIL * 2); });

  child.on('close', (code, signal) => {
    if (code === 0) return;
    const diagnostic = formatNativeDiagnostic({ command, args, cwd: launchOptions.cwd, code, signal, stdout, stderr });
    console.error(diagnostic);
    child.stderr?.emit?.('data', Buffer.from(`\n${diagnostic}\n`));
  });
  return child;
};

function requestLaunch(payload, label, verify) {
  const body = JSON.stringify(payload);
  const request = http.request({
    hostname: '127.0.0.1',
    port: Number(PORT),
    path: '/api/launch',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 30_000
  }, response => {
    let responseBody = '';
    response.on('data', chunk => { responseBody += chunk.toString(); });
    response.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(responseBody); } catch (_) {}
      const ok = response.statusCode >= 200 && response.statusCode < 300 && parsed.success !== false && verify(parsed);
      if (ok) console.log(`[${label}] PASS`);
      else {
        console.error(`[${label}] FAIL: HTTP ${response.statusCode}`);
        if (parsed.error) console.error(`[${label}] error: ${parsed.error}`);
        if (parsed.outTxt) console.error(`[${label}] outTxt:\n${tail(parsed.outTxt, 4000)}`);
        if (parsed.stderr) console.error(`[${label}] stderr:\n${tail(parsed.stderr, 4000)}`);
      }
    });
  });
  request.on('timeout', () => { console.error(`[${label}] FAIL: timed out`); request.destroy(); });
  request.on('error', err => console.error(`[${label}] FAIL: ${err.message}`));
  request.write(body);
  request.end();
}

function baseSmokePayload() {
  return {
    platform: {
      processors: [{ model: 'ARM', count: 2, modes: [{ name: 'default', cycle: 1, mem: 4096, dynPower: 10, staticPower: 2, area: 5, monetary: 10 }] }],
      interconnects: [{ name: 'bus0', topology: 'TDMA-bus', xDim: 2, yDim: 1, flitSize: 32, slots: 2 }]
    },
    applications: [{
      name: 'SmokeApp', actors: ['src_node', 'proc_node', 'snk_node'],
      channels: [
        { name: 'ch1', src: 'src_node', dst: 'proc_node', tokens: 0 },
        { name: 'ch2', src: 'proc_node', dst: 'snk_node', tokens: 0 },
        { name: 'ch3', src: 'snk_node', dst: 'src_node', tokens: 1 }
      ]
    }],
    wcets: [
      { taskType: 'src_node', processor: 'ARM', mode: 'default', wcet: 10 },
      { taskType: 'proc_node', processor: 'ARM', mode: 'default', wcet: 25 },
      { taskType: 'snk_node', processor: 'ARM', mode: 'default', wcet: 15 }
    ],
    constraints: [{ appName: 'SmokeApp', period: 1000, latency: 0 }],
    dse: { model: 'SDF_PR_ONLINE', criteria: 'THROUGHPUT', search: 'FIRST', thProp: 'SSE' }
  };
}

function runSmokeTests() {
  const normal = baseSmokePayload();
  requestLaunch(normal, 'api-smoke', parsed => /\b[1-9]\d*\s+solutions?\s+found/i.test(String(parsed.outTxt || parsed.log || '')));

  const constrained = baseSmokePayload();
  constrained.sysConstraints = { power: 1, utilization: -1, area: -1, cost: -1, procsUsed: -1 };
  setTimeout(() => {
    requestLaunch(constrained, 'constraint-smoke', parsed => /0\s+solutions?\s+found/i.test(String(parsed.outTxt || '')));
  }, 800).unref?.();
}

function runAiSmokeTest() {
  const hasKey = Boolean(process.env.FEATHERLESS_API_KEY || process.env.featherless);
  if (!hasKey) {
    console.warn('[ai-smoke] SKIP: Featherless API key is not configured.');
    return;
  }

  const payload = JSON.stringify({
    prompt: 'Create a minimal DSE model with two ARM cores and two actors a0 then a1. WCETs are 10 and 20 cycles. Period deadline is 100 cycles.'
  });
  const request = http.request({
    hostname: '127.0.0.1',
    port: Number(PORT),
    path: '/api/ai/nl-to-dse',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    timeout: 32_000
  }, response => {
    let body = '';
    response.on('data', chunk => { body += chunk.toString(); });
    response.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (_) {}
      const validModel = Array.isArray(parsed?.model?.platform?.processors) && parsed.model.platform.processors.length > 0;
      if (response.statusCode >= 200 && response.statusCode < 300 && !parsed.error && validModel) {
        console.log('[ai-smoke] PASS: Featherless NL-to-DSE returned a valid structured model.');
      } else {
        console.error(`[ai-smoke] FAIL: HTTP ${response.statusCode}`);
        console.error(`[ai-smoke] ${parsed.error || parsed.question || tail(body, 1500) || 'invalid model response'}`);
      }
    });
  });
  request.on('timeout', () => {
    console.error('[ai-smoke] FAIL: request timed out');
    request.destroy();
  });
  request.on('error', err => console.error(`[ai-smoke] FAIL: ${err.message}`));
  request.write(payload);
  request.end();
}

const server = require('./server');
server.listen(PORT, HOST, () => {
  console.log('====================================================');
  console.log('  ParetoCo Web Dashboard & Engine Server');
  console.log(`  Running on http://${HOST}:${PORT}`);
  console.log(`  Wine diagnostics: ${WINE_DEBUG}`);
  console.log('  Bridge reliability fixes: enabled (native engine unchanged)');
  console.log('====================================================');
  setTimeout(runSmokeTests, 500).unref?.();
  setTimeout(runAiSmokeTest, 2_500).unref?.();
});
