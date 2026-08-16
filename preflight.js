'use strict';

// UI import/export compatibility repairs. This file modifies only the shipped
// JavaScript source at container start; native engine binaries are untouched.
const fs = require('fs');
const path = require('path');

const appPath = path.join(__dirname, 'ui', 'app.js');

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
    state.constraints.forEach(c => {
      xml += \`  <constraint app_name="\${c.appName}" period="\${c.period}" latency="\${c.latency}"\${systemAttrs.length ? ' ' + systemAttrs.join(' ') : ''}></constraint>\\n\`;
    });
    if (state.constraints.length === 0 && systemAttrs.length) xml += \`  <constraint \${systemAttrs.join(' ')}></constraint>\\n\`;
    xml += '</designConstraints>\\n';
    return xml;
  }`;
  replaceOnce(oldGenerateConstraints, newGenerateConstraints, 'exported desConst.xml includes system power/area/cost bounds');

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

  if (changed) fs.writeFileSync(appPath, source, 'utf8');
}

patchUiSource();
require('./start');
