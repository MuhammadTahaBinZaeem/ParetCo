'use strict';

// Source-level compatibility repairs applied before the server loads. These
// changes affect only the web/server bridge; native engine binaries are untouched.
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const appPath = path.join(ROOT, 'ui', 'app.js');
const serverPath = path.join(ROOT, 'server.js');
const archStudioPath = path.join(ROOT, 'ui', 'architecture_studio.js');
const paretoFrontierPath = path.join(ROOT, 'ui', 'pareto_frontier.js');
const incrementalPath = path.join(ROOT, 'ui', 'incremental_dse.js');

function patchTextFile(filePath, patches, prefix) {
  if (!fs.existsSync(filePath)) return;
  let source = fs.readFileSync(filePath, 'utf8');
  let changed = false;

  for (const patch of patches) {
    const { oldText, newText, label } = patch;
    if (source.includes(newText)) continue;
    if (!source.includes(oldText)) {
      console.warn(`[${prefix}] ${label}: target not found.`);
      continue;
    }
    source = source.replace(oldText, newText);
    changed = true;
    console.log(`[${prefix}] ${label}: applied.`);
  }

  if (changed) fs.writeFileSync(filePath, source, 'utf8');
}

function patchServerConstraintSemantics() {
  if (!fs.existsSync(serverPath)) return;
  let source = fs.readFileSync(serverPath, 'utf8');

  const oldBlock = `    // Write Design Constraints XML
    let constraintsXml = jobData.constraintsXml;
    if (!constraintsXml && jobData.constraints && jobData.constraints.length > 0) {
      constraintsXml = \`<?xml version="1.0" encoding="UTF-8"?>\\n<designConstraints>\\n\`;
      jobData.constraints.forEach(c => {
        constraintsXml += \`  <constraint app_name="\${c.appName || 'App'}" period="\${c.period || 0}" latency="\${c.latency || 0}"></constraint>\\n\`;
      });
      constraintsXml += \`</designConstraints>\\n\`;
    }
    if (constraintsXml) {
      fs.writeFileSync(path.join(tempDir, 'desConst.xml'), constraintsXml);
    }`;

  const newBlock = `    // Canonical native design constraints. Semantics match the packaged engine:
    // power/area/money are maxima, utilization is a minimum percentage, and
    // procsUsed is the exact active-processor count.
    const sysConstraints = jobData.sysConstraints || {};
    const positiveInt = (value) => {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
    };
    const escapeXmlAttr = (value) => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const nativeSystemAttrs = [];
    const nativePower = positiveInt(sysConstraints.power ?? sysConstraints.maxPower);
    const nativeArea = positiveInt(sysConstraints.area);
    const nativeMoney = positiveInt(sysConstraints.cost ?? sysConstraints.money);
    const nativeUtilization = positiveInt(sysConstraints.utilization ?? sysConstraints.minUtilization);
    const nativeProcsUsed = positiveInt(sysConstraints.procsUsed);
    if (nativePower !== null) nativeSystemAttrs.push(\`power="\${nativePower}"\`);
    if (nativeArea !== null) nativeSystemAttrs.push(\`area="\${nativeArea}"\`);
    if (nativeMoney !== null) nativeSystemAttrs.push(\`money="\${nativeMoney}"\`);
    if (nativeUtilization !== null) nativeSystemAttrs.push(\`utilization="\${nativeUtilization}"\`);
    if (nativeProcsUsed !== null) nativeSystemAttrs.push(\`procsUsed="\${nativeProcsUsed}"\`);

    const constraintRows = Array.isArray(jobData.constraints) ? jobData.constraints : [];
    let constraintsXml = '';
    if (constraintRows.length > 0 || nativeSystemAttrs.length > 0) {
      constraintsXml = \`<?xml version="1.0" encoding="UTF-8"?>\\n<designConstraints>\\n\`;
      if (constraintRows.length > 0) {
        constraintRows.forEach(c => {
          const attrs = [
            \`app_name="\${escapeXmlAttr(c.appName || c.app_name || 'App')}"\`,
            \`period="\${Math.max(0, parseInt(c.period, 10) || 0)}"\`,
            \`latency="\${Math.max(0, parseInt(c.latency, 10) || 0)}"\`,
            ...nativeSystemAttrs
          ];
          constraintsXml += \`  <constraint \${attrs.join(' ')}></constraint>\\n\`;
        });
      } else {
        constraintsXml += \`  <constraint \${nativeSystemAttrs.join(' ')}></constraint>\\n\`;
      }
      constraintsXml += \`</designConstraints>\\n\`;
      fs.writeFileSync(path.join(tempDir, 'desConst.xml'), constraintsXml);
    }`;

  if (!source.includes(newBlock) && source.includes(oldBlock)) {
    source = source.replace(oldBlock, newBlock);
    fs.writeFileSync(serverPath, source, 'utf8');
    console.log('[server-preflight] native system-constraint semantics enabled.');
  }
}

function patchServerReliability() {
  patchTextFile(serverPath, [
    {
      label: 'analytical fallback treats utilization as a minimum',
      oldText: `  const maxAllowedUtil = (job.sysConstraints?.utilization > 0)
    ? parseFloat(job.sysConstraints.utilization)
    : ((job.sysConstraints?.maxUtil && job.sysConstraints.maxUtil !== "Unlimited") ? parseFloat(job.sysConstraints.maxUtil) : Infinity);`,
      newText: `  const minAllowedUtil = (job.sysConstraints?.utilization > 0)
    ? parseFloat(job.sysConstraints.utilization)
    : -Infinity;
  const maxAllowedArea = (job.sysConstraints?.area > 0) ? parseFloat(job.sysConstraints.area) : Infinity;
  const maxAllowedCost = (job.sysConstraints?.cost > 0) ? parseFloat(job.sysConstraints.cost) : Infinity;
  const exactProcsUsed = (job.sysConstraints?.procsUsed > 0) ? parseInt(job.sysConstraints.procsUsed, 10) : null;`
    },
    {
      label: 'analytical fallback enforces all supported system semantics',
      oldText: `    if (period > minAllowedPeriod || power > maxAllowedPower || util > maxAllowedUtil) continue;`,
      newText: `    if (period > minAllowedPeriod || power > maxAllowedPower || area > maxAllowedArea || cost > maxAllowedCost || util < minAllowedUtil || (exactProcsUsed !== null && totalCores !== exactProcsUsed)) continue;`
    },
    {
      label: 'bound native solver wall-clock execution',
      oldText: `    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });`,
      newText: `    let stdout = '';
    let stderr = '';
    const nativeTimeoutMs = Math.max(10_000, Number(process.env.PARETOCO_NATIVE_TIMEOUT_MS) || 60_000);
    const nativeTimeout = setTimeout(() => {
      stderr += \`\\n[ParetoCo] Native solver exceeded \${nativeTimeoutMs} ms and was terminated.\\n\`;
      try { child.kill('SIGKILL'); } catch (_) {}
    }, nativeTimeoutMs);
    nativeTimeout.unref?.();

    child.stdout.on('data', (d) => { stdout += d.toString(); });`
    },
    {
      label: 'clear native solver timeout on process close',
      oldText: `    child.on('close', (code) => {
      let outTxt = '';`,
      newText: `    child.on('close', (code) => {
      clearTimeout(nativeTimeout);
      let outTxt = '';`
    },
    {
      label: 'clear native solver timeout on launch error',
      oldText: `    child.on('error', (err) => {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}`,
      newText: `    child.on('error', (err) => {
      clearTimeout(nativeTimeout);
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}`
    }
  ], 'server-preflight');
}

function patchUiSource() {
  if (!fs.existsSync(appPath)) return;
  let source = fs.readFileSync(appPath, 'utf8');
  let changed = false;

  function replaceOnce(oldText, newText, label) {
    if (source.includes(newText)) return;
    if (!source.includes(oldText)) {
      console.warn(`[ui-preflight] ${label}: target not found.`);
      return;
    }
    source = source.replace(oldText, newText);
    changed = true;
    console.log(`[ui-preflight] ${label}: applied.`);
  }

  replaceOnce(
    '    doc.querySelectorAll("mapping").forEach(m => {',
    '    doc.querySelectorAll("mapping, systemMapping").forEach(m => {',
    'WCET importer accepts native systemMapping elements'
  );

  replaceOnce(
    '    doc.querySelectorAll("TDN_NoC, TDN_BUS").forEach(ic => {',
    '    doc.querySelectorAll("TDN_NoC, TDN_BUS, TDMA_bus").forEach(ic => {',
    'platform importer accepts native TDMA_bus interconnects'
  );

  replaceOnce(
    '        cycles: parseInt(ic.getAttribute("cycles")) || 0,',
    '        cycles: parseInt(ic.getAttribute("cycles")) || 0,\n        slots: parseInt(ic.getAttribute("tdma_slots")) || 0,\n        maxSlotsPerProc: parseInt(ic.getAttribute("maxSlotsPerProc")) || 0,\n        mode: (() => { const m = ic.querySelector("mode"); return m ? { name: m.getAttribute("name") || "default", cycleLength: parseFloat(m.getAttribute("cycleLength")) || 1, dynPower_NI: parseFloat(m.getAttribute("dynPower_NI")) || 0, dynPower_bus: parseFloat(m.getAttribute("dynPower_bus")) || 0, staticPower_NI: parseFloat(m.getAttribute("staticPower_NI")) || 0, staticPower_bus: parseFloat(m.getAttribute("staticPower_bus")) || 0, area_NI: parseFloat(m.getAttribute("area_NI")) || 0, area_bus: parseFloat(m.getAttribute("area_bus")) || 0, monetary_NI: parseFloat(m.getAttribute("monetary_NI")) || 0, monetary_bus: parseFloat(m.getAttribute("monetary_bus")) || 0 } : null; })(),',
    'preserve TDMA slots and interconnect mode data'
  );

  const oldConstraintParser = `    state.constraints = [];
    doc.querySelectorAll("constraint").forEach(c => {
      state.constraints.push({
        appName: c.getAttribute("app_name"),
        period: parseInt(c.getAttribute("period")) || 0,
        latency: parseInt(c.getAttribute("latency")) || 0,
      });
    });
    renderConstraints();`;

  const newConstraintParser = `    state.constraints = [];
    let importedSystemConstraints = false;
    doc.querySelectorAll("constraint").forEach(c => {
      const appName = c.getAttribute("app_name");
      if (appName) {
        state.constraints.push({
          appName,
          period: parseInt(c.getAttribute("period")) || 0,
          latency: parseInt(c.getAttribute("latency")) || 0,
        });
      }
      if (!importedSystemConstraints) {
        const attrs = { power: "power", utilization: "utilization", area: "area", cost: "money", procsUsed: "procsUsed" };
        let found = false;
        Object.entries(attrs).forEach(([key, attr]) => {
          if (!c.hasAttribute(attr)) return;
          const value = Number(c.getAttribute(attr));
          state.sysConstraints[key] = Number.isFinite(value) && value > 0 ? value : -1;
          found = true;
        });
        if (found) {
          importedSystemConstraints = true;
          const ids = { power: "sys-power", utilization: "sys-utilization", area: "sys-area", cost: "sys-cost", procsUsed: "sys-procs" };
          Object.entries(ids).forEach(([key, id]) => {
            const el = document.getElementById(id);
            const value = Number(state.sysConstraints[key]);
            if (el) el.value = Number.isFinite(value) && value > 0 ? String(value) : "";
          });
        }
      }
    });
    renderConstraints();`;
  replaceOnce(oldConstraintParser, newConstraintParser, 'desConst importer restores system constraint attributes');

  const oldGenerateConstraints = `  function generateConstraintsXml() {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\\n<designConstraints>\\n';
    state.constraints.forEach(c => {
      xml += \`  <constraint app_name="\${c.appName}" period="\${c.period}" latency="\${c.latency}"></constraint>\\n\`;
    });
    xml += '</designConstraints>\\n';
    return xml;
  }`;

  const newGenerateConstraints = `  function generateConstraintsXml() {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\\n<designConstraints>\\n';
    const systemAttrs = [];
    if (Number(state.sysConstraints?.power) > 0) systemAttrs.push(\`power="\${Math.round(Number(state.sysConstraints.power))}"\`);
    if (Number(state.sysConstraints?.area) > 0) systemAttrs.push(\`area="\${Math.round(Number(state.sysConstraints.area))}"\`);
    if (Number(state.sysConstraints?.cost) > 0) systemAttrs.push(\`money="\${Math.round(Number(state.sysConstraints.cost))}"\`);
    if (Number(state.sysConstraints?.utilization) > 0) systemAttrs.push(\`utilization="\${Math.round(Number(state.sysConstraints.utilization))}"\`);
    if (Number(state.sysConstraints?.procsUsed) > 0) systemAttrs.push(\`procsUsed="\${Math.round(Number(state.sysConstraints.procsUsed))}"\`);
    state.constraints.forEach(c => {
      xml += \`  <constraint app_name="\${c.appName}" period="\${c.period}" latency="\${c.latency}"\${systemAttrs.length ? ' ' + systemAttrs.join(' ') : ''}></constraint>\\n\`;
    });
    if (state.constraints.length === 0 && systemAttrs.length) xml += \`  <constraint \${systemAttrs.join(' ')}></constraint>\\n\`;
    xml += '</designConstraints>\\n';
    return xml;
  }`;
  replaceOnce(oldGenerateConstraints, newGenerateConstraints, 'exported desConst.xml includes all native system constraints');

  const oldPlatformClose = "    xml += '</platform>\\n';";
  const newPlatformClose = `    if (state.platform.interconnects && state.platform.interconnects.length) {
      const ic = state.platform.interconnects[0];
      const mode = ic.mode || {};
      xml += '  <interconnect>\\n';
      xml += \`    <TDMA_bus name="\${ic.name || 'bus0'}" x-dimension="\${ic.xDim || 1}" y-dimension="\${ic.yDim || 1}" flitSize="\${ic.flitSize || 32}" tdma_slots="\${ic.slots || 2}" maxSlotsPerProc="\${ic.maxSlotsPerProc || ic.slots || 2}">\\n\`;
      xml += \`      <mode name="\${mode.name || 'default'}" cycleLength="\${mode.cycleLength || 1}" dynPower_NI="\${mode.dynPower_NI ?? 1}" dynPower_bus="\${mode.dynPower_bus ?? 1}" staticPower_NI="\${mode.staticPower_NI ?? 1}" staticPower_bus="\${mode.staticPower_bus ?? 1}" area_NI="\${mode.area_NI ?? 1}" area_bus="\${mode.area_bus ?? 1}" monetary_NI="\${mode.monetary_NI ?? 1}" monetary_bus="\${mode.monetary_bus ?? 1}"/>\\n\`;
      xml += '    </TDMA_bus>\\n  </interconnect>\\n';
    }
    xml += '</platform>\\n';`;
  replaceOnce(oldPlatformClose, newPlatformClose, 'generated/exported platform.xml retains interconnect data');

  replaceOnce(
    '    state.dse.criteria = "THROUGHPUT";',
    `    // Demo must be self-contained: clear stale user limits/results before loading it.
    state.constraints = [{ appName: "TestApp", period: 1000, latency: 0 }];
    Object.assign(state.sysConstraints, { power: -1, utilization: -1, area: -1, cost: -1, procsUsed: -1, maxPower: -1, maxUtil: -1 });
    state.results = null;
    state.dse.criteria = "THROUGHPUT";`,
    'demo resets stale constraints and prior results'
  );

  const oldAutoOptFinish = `        renderPlatform(); updateKPIs(); autoSave();
        toast("Architecture Optimized! Rerun DSE to verify.", "success");`;
  const newAutoOptFinish = `        renderPlatform(); updateKPIs(); autoSave();
        if (data.verification?.outTxt) parseResults(data.verification.outTxt, "native-verified-out.txt");
        const verifiedCount = data.verification?.solutionCount || 0;
        toast(\`Architecture optimized and native-verified (\${verifiedCount} solution(s)).\`, "success");`;
  replaceOnce(oldAutoOptFinish, newAutoOptFinish, 'Auto-Optimize displays native-verified result instead of asking for manual verification');

  if (changed) fs.writeFileSync(appPath, source, 'utf8');
}

function patchArchitectureStudio() {
  const oldOverlayBlock = `    // Calculate utilization per PE
    const totalUtil = parseInt(lastSolution["Utilization (%)"]) || 0;
    peNodes.forEach((pe, i) => {
      const taskCount = pe.overlay.mappedTasks.length;
      pe.overlay.utilization = taskCount > 0 ? Math.min(100, Math.round(totalUtil * taskCount / Math.max(1, mappings.length))) : 0;
      pe.overlay.power = Math.round((parseInt(lastSolution["Power (mW)"]) || 0) / Math.max(1, peNodes.length));
      pe.overlay.memPressure = taskCount > 0 ? Math.min(100, taskCount * 25) : 0;
    });

    // Mark critical path (highest WCET chain)
    if (studio.workloadNodes.length > 0) {
      let maxWcet = 0, criticalIdx = 0;
      studio.workloadNodes.forEach((wn, i) => {
        if ((wn.properties.wcet || 0) > maxWcet) {
          maxWcet = wn.properties.wcet || 0;
          criticalIdx = i;
        }
      });
      studio.workloadNodes[criticalIdx].overlay.isCritical = true;
      // Mark edges connected to critical node
      studio.workloadEdges.forEach(e => {
        if (e.srcNodeId === studio.workloadNodes[criticalIdx]?.id || e.dstNodeId === studio.workloadNodes[criticalIdx]?.id) {
          e.overlay.isCritical = true;
          e.overlay.dataRate = 1;
        }
      });
    }

    // Communication edges
    studio.workloadEdges.forEach(e => {
      const srcWn = studio.workloadNodes.find(n => n.id === e.srcNodeId);
      const dstWn = studio.workloadNodes.find(n => n.id === e.dstNodeId);
      if (srcWn && dstWn && srcWn.overlay.mappedTo !== null && dstWn.overlay.mappedTo !== null) {
        if (srcWn.overlay.mappedTo !== dstWn.overlay.mappedTo) {
          e.overlay.dataRate = 1;
          e.overlay.utilization = Math.round(30 + Math.random() * 50);
          if (e.overlay.utilization > 75) e.overlay.saturated = true;
        }
      }
    });

    // Platform edges utilization
    studio.platformEdges.forEach(e => {
      e.overlay.dataRate = 1;
      e.overlay.utilization = Math.round(20 + Math.random() * 60);
      if (e.overlay.utilization > 80) e.overlay.saturated = true;
    });`;

  const newOverlayBlock = `    // The native result currently exposes task→PE mapping and system-wide metrics,
    // not per-PE power/utilization, edge traffic, memory pressure, or a critical path.
    // Preserve only the mapping we can prove; do not fabricate physical metrics.
    peNodes.forEach(pe => {
      pe.overlay.utilization = 0;
      pe.overlay.power = 0;
      pe.overlay.memPressure = 0;
    });
    studio.workloadEdges.forEach(e => {
      e.overlay.dataRate = 0;
      e.overlay.utilization = 0;
      e.overlay.saturated = false;
      e.overlay.isCritical = false;
    });
    studio.platformEdges.forEach(e => {
      e.overlay.dataRate = 0;
      e.overlay.utilization = 0;
      e.overlay.saturated = false;
      e.overlay.isCritical = false;
    });`;

  patchTextFile(archStudioPath, [{
    oldText: oldOverlayBlock,
    newText: newOverlayBlock,
    label: 'remove random/fabricated architecture overlay metrics'
  }], 'studio-preflight');
}

function patchParetoFrontier() {
  patchTextFile(paretoFrontierPath, [
    {
      label: 'derive throughput as inverse period without an invented 1000x scale',
      oldText: '        throughput:  row["Period"] ? (1000 / parseFloat(row["Period"])) : 0,',
      newText: '        throughput:  parseFloat(row["Throughput"]) || (row["Period"] ? (1 / parseFloat(row["Period"])) : 0),'
    },
    {
      label: 'use white chart background',
      oldText: '    ctx.fillStyle = "#EBF4FA";',
      newText: '    ctx.fillStyle = "#FFFFFF";'
    }
  ], 'pareto-preflight');
}

function patchIncrementalDseLabels() {
  patchTextFile(incrementalPath, [
    {
      label: 'do not claim cached solutions are passed into native solver as warm-start seeds',
      oldText: '<h4>🔥 Warm-Start Payload</h4>',
      newText: '<h4>♻️ Prior-Solution Cache</h4>'
    },
    {
      label: 'rename seed count to cached solution count',
      oldText: '<span class="ws-label">Seed solutions</span>',
      newText: '<span class="ws-label">Cached solutions</span>'
    }
  ], 'incremental-preflight');
}

patchServerConstraintSemantics();
patchServerReliability();
patchUiSource();
patchArchitectureStudio();
patchParetoFrontier();
patchIncrementalDseLabels();
require('./start');
