'use strict';

/**
 * Deep app-layer preflight.
 * Repairs legacy UI/module integration points before the existing preflight and
 * production bootstrap run. Native ParetoCo executable/DLL files are untouched.
 */
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const ROOT = __dirname;

function patchTextFile(relativePath, transform) {
  const filePath = path.join(ROOT, relativePath);
  if (!fs.existsSync(filePath)) return;
  const before = fs.readFileSync(filePath, 'utf8');
  const after = transform(before);
  if (after !== before) {
    fs.writeFileSync(filePath, after, 'utf8');
    console.log(`[deep-preflight] patched ${relativePath}`);
  }
}

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  if (!source.includes(oldText)) {
    console.warn(`[deep-preflight] ${label}: target not found`);
    return source;
  }
  console.log(`[deep-preflight] ${label}: applied`);
  return source.replace(oldText, newText);
}

patchTextFile('ui/index.html', source => replaceOnce(
  source,
  '  <script src="app.js"></script>\n  <script src="runtime_fixes.js"></script>',
  '  <script src="app.js"></script>\n  <script src="feature_scaffolds.js"></script>\n  <script src="runtime_fixes.js"></script>',
  'load missing feature scaffolds'
));

patchTextFile('ui/app.js', source => {
  source = replaceOnce(
    source,
    '    const basePeriod = Math.max(20, Math.ceil(totalWorkload / totalCores));\n\n    // Check user design constraints',
    '    const basePeriod = Math.max(20, Math.ceil(totalWorkload / totalCores));\n    const basePower = totalCores * 10 + 2;\n\n    // Check user design constraints',
    'define client-side fallback basePower before constraint checks'
  );

  source = replaceOnce(
    source,
    '    outTxt += \'200 solutions found, more possible stopping due to limit.\\n\';',
    '    outTxt += solutions.length >= 200 ? \'200 solutions found, more possible stopping due to limit.\\n\' : `${solutions.length} solutions found\\n`;',
    'report actual client-side fallback solution count'
  );

  source = replaceOnce(
    source,
    '      const activeMaxPower = (state.sysConstraints?.maxPower && state.sysConstraints.maxPower !== "Unlimited")\n        ? parseFloat(state.sysConstraints.maxPower)\n        : Infinity;',
    '      const activeMaxPower = (Number(state.sysConstraints?.power) > 0)\n        ? Number(state.sysConstraints.power)\n        : ((state.sysConstraints?.maxPower && state.sysConstraints.maxPower !== "Unlimited") ? parseFloat(state.sysConstraints.maxPower) : Infinity);',
    'result parser reads canonical power constraint'
  );

  source = replaceOnce(
    source,
    '  function loadDemoPreset() {\n    state.platform.processors = [',
    '  function loadDemoPreset() {\n    state.constraints = [{ appName: "TestApp", period: 1000, latency: 0 }];\n    state.sysConstraints = { power: -1, utilization: -1, area: -1, cost: -1, procsUsed: -1, maxPower: -1, maxUtil: -1 };\n    state.results = null;\n    state.platform.processors = [',
    'demo clears stale constraints and results'
  );

  source = replaceOnce(
    source,
    '    state.dse.criteria = "THROUGHPUT";\n    state.dse.search = "FIRST";\n    state.dse.th_prop = "SSE";\n\n    renderPlatform();',
    '    state.dse.criteria = "THROUGHPUT";\n    state.dse.search = "FIRST";\n    state.dse.thProp = "SSE";\n    state.dse.th_prop = "SSE";\n    syncFormFromState();\n\n    renderPlatform();',
    'demo synchronizes stable DSE configuration'
  );

  source = replaceOnce(
    source,
    '    $("#ai-empty").classList.add("hidden");\n    $("#ai-content").classList.remove("hidden");\n    $("#ai-markdown-render").innerHTML = "<em>Analyzing currently active DSE results with Featherless AI models... Please wait.</em>";',
    '    const aiEmpty = $("#ai-empty");\n    const aiContent = $("#ai-content");\n    if (aiEmpty) aiEmpty.classList.add("hidden");\n    if (aiContent) aiContent.classList.remove("hidden");\n    $("#ai-markdown-render").textContent = "Analyzing currently active DSE results with Featherless AI models... Please wait.";',
    'AI Analyst tolerates current DOM structure'
  );

  return source;
});

patchTextFile('ui/architecture_studio.js', source => {
  source = replaceOnce(
    source,
    '  // ═══════════════════════ INITIALIZATION ═════════════════════\n  function init() {\n    canvas = document.getElementById("studio-canvas");\n    if (!canvas) return;\n\n    ctx = canvas.getContext("2d");',
    '  // ═══════════════════════ INITIALIZATION ═════════════════════\n  let initialized = false;\n  function init() {\n    canvas = document.getElementById("studio-canvas");\n    if (!canvas) return;\n    if (initialized) {\n      syncCanvasFromModel();\n      applyResultOverlay();\n      return;\n    }\n    initialized = true;\n\n    ctx = canvas.getContext("2d");',
    'Architecture Studio binds events/render loop only once'
  );

  source = replaceOnce(
    source,
    '        const center = screenToWorld(canvas.width / 2, canvas.height / 2);',
    '        const center = screenToWorld(canvas.clientWidth / 2, canvas.clientHeight / 2);',
    'Architecture Studio palette uses CSS pixels on high-DPI displays'
  );

  source = replaceOnce(
    source,
    '    const totalUtil = parseInt(lastSolution["Utilization (%)"]) || 0;',
    '    const totalUtil = Number(lastSolution._utilization) || parseFloat(String(lastSolution["Utilization (%)"] || "").replace(/[^0-9.-]/g, "")) || 0;',
    'Architecture Studio reads parsed utilization values'
  );

  source = replaceOnce(
    source,
    '      pe.overlay.power = Math.round((parseInt(lastSolution["Power (mW)"]) || 0) / Math.max(1, peNodes.length));',
    '      const totalPower = Number(lastSolution._power) || parseFloat(String(lastSolution["Power (mW)"] || "").replace(/[^0-9.-]/g, "")) || 0;\n      pe.overlay.power = Math.round(totalPower / Math.max(1, peNodes.length));',
    'Architecture Studio reads native interval power values'
  );

  source = replaceOnce(
    source,
    '          e.overlay.utilization = Math.round(30 + Math.random() * 50);',
    '          e.overlay.utilization = Math.min(100, Math.max(0, totalUtil));',
    'remove random workload-edge utilization overlay'
  );

  source = replaceOnce(
    source,
    '      e.overlay.utilization = Math.round(20 + Math.random() * 60);',
    '      e.overlay.utilization = Math.min(100, Math.max(0, Math.round(totalUtil / Math.max(1, studio.platformEdges.length))));',
    'remove random platform-edge utilization overlay'
  );

  return source;
});

patchTextFile('ui/pareto_frontier.js', source => {
  const replacements = [
    ['        period:      parseFloat(row["Period"]) || 0,', '        period:      Number(row._period) || parseFloat(String(row["Period"] || "").replace(/[^0-9.-]/g, "")) || 0,', 'Pareto period parser uses numeric result field'],
    ['        power:       parseFloat(row["Power (mW)"]) || 0,', '        power:       Number(row._power) || parseFloat(String(row["Power (mW)"] || "").replace(/[^0-9.-]/g, "")) || 0,', 'Pareto power parser handles native intervals'],
    ['        area:        parseFloat(row["Area"]) || 0,', '        area:        Number(row._area) || parseFloat(String(row["Area"] || "").replace(/[^0-9.-]/g, "")) || 0,', 'Pareto area parser handles native intervals'],
    ['        cost:        parseFloat(row["Cost ($)"]) || 0,', '        cost:        Number(row._cost) || parseFloat(String(row["Cost ($)"] || "").replace(/[^0-9.-]/g, "")) || 0,', 'Pareto cost parser handles native intervals'],
    ['        utilization: parseFloat(row["Utilization (%)"]) || 0,', '        utilization: Number(row._utilization) || parseFloat(String(row["Utilization (%)"] || "").replace(/[^0-9.-]/g, "")) || 0,', 'Pareto utilization parser handles native intervals'],
    ['        throughput:  row["Period"] ? (1000 / parseFloat(row["Period"])) : 0,', '        throughput:  (() => { const p = Number(row._period) || parseFloat(String(row["Period"] || "").replace(/[^0-9.-]/g, "")) || 0; return p > 0 ? 1 / p : 0; })(),', 'derive dimensionless throughput consistently from period'],
    ['      if (av === 0 && bv === 0) continue;', '      if (!(av > 0) || !(bv > 0)) continue;', 'ignore missing dimensions in Pareto dominance']
  ];
  for (const [oldText, newText, label] of replacements) source = replaceOnce(source, oldText, newText, label);
  source = source.replaceAll('ctx.fillStyle = "#EBF4FA";', 'ctx.fillStyle = "#FFFFFF";');
  return source;
});

patchTextFile('ui/incremental_dse.js', source => {
  source = replaceOnce(
    source,
    '      applications: state.applications?.map(a => ({ name: a.name, actors: a.actors?.length, channels: a.channels?.length })),\n      wcets: state.wcets?.length,',
    '      applications: state.applications,\n      wcets: state.wcets,',
    'Continuous DSE fingerprint includes actual graph and WCET content'
  );

  source = replaceOnce(
    source,
    '  async function init() {\n    // Load sessions from IndexedDB',
    '  async function init() {\n    if (dseState.initialized) {\n      renderSessionList();\n      renderTimeline();\n      renderStatusBanner();\n      return;\n    }\n    // Load sessions from IndexedDB',
    'Continuous DSE initializes persistent session state only once'
  );
  return source;
});

// Bound every native Wine solver process. This protects the web request from an
// engine/search mode that never returns while preserving stderr diagnostics.
const realSpawn = childProcess.spawn;
const nativeTimeoutMs = Math.max(10_000, Number(process.env.PARETOCO_NATIVE_TIMEOUT_MS) || 60_000);
childProcess.spawn = function spawnWithParetoTimeout(command, args = [], options = {}) {
  const child = realSpawn.call(childProcess, command, args, options);
  const isPareto = (args || []).some(arg => /paretoco-engine\.exe$/i.test(String(arg)));
  if (!isPareto) return child;

  let finished = false;
  const timer = setTimeout(() => {
    if (finished) return;
    const note = `\n[native-timeout] ParetoCo engine exceeded ${nativeTimeoutMs} ms and was terminated.\n`;
    try { child.stderr?.emit?.('data', Buffer.from(note)); } catch (_) {}
    try { child.kill('SIGKILL'); } catch (_) {}
  }, nativeTimeoutMs);

  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
  };
  child.once('close', finish);
  child.once('error', finish);
  return child;
};

console.log(`[deep-preflight] native launch hard timeout: ${nativeTimeoutMs} ms`);
require('./preflight');
