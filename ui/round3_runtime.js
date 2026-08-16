/* ParetoCo project I/O reliability layer.
 * Validates user files before mutating shared state, normalizes native CSV
 * results for all analysis views, and provides a complete ZIP project export.
 */
(() => {
  'use strict';

  const api = window.paretoco;
  if (!api?.state) return;
  const state = api.state;

  function xmlEscape(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function parseXml(text, label) {
    const doc = new DOMParser().parseFromString(String(text || ''), 'text/xml');
    const parseError = doc.querySelector('parsererror');
    if (parseError) throw new Error(`${label} is not valid XML.`);
    return doc;
  }

  function readTextFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Could not read file.'));
      reader.readAsText(file);
    });
  }

  function interceptFileButton(buttonId, inputId, handler) {
    const button = document.getElementById(buttonId);
    const input = document.getElementById(inputId);
    if (!button || !input) return;

    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      input.value = '';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const text = await readTextFile(file);
          await handler(text, file.name);
        } catch (error) {
          console.error(`[ParetoCo I/O] ${buttonId} failed:`, error);
          api.toast?.(error.message || 'Import failed.', 'error');
        }
      };
      input.click();
    }, { capture: true });
  }

  function validatePlatformXml(text) {
    const doc = parseXml(text, 'platform.xml');
    const processors = [...doc.querySelectorAll('processor')];
    if (processors.length === 0) throw new Error('platform.xml contains no <processor> elements.');
    for (const proc of processors) {
      if (!proc.getAttribute('model')) throw new Error('Every processor must have a model name.');
      const count = Number(proc.getAttribute('number') || 1);
      if (!Number.isFinite(count) || count < 1) throw new Error(`Processor ${proc.getAttribute('model')} has an invalid count.`);
      const modes = [...proc.querySelectorAll(':scope > mode')];
      if (modes.length === 0) throw new Error(`Processor ${proc.getAttribute('model')} has no operating mode.`);
      for (const mode of modes) {
        if (!mode.getAttribute('name')) throw new Error(`Processor ${proc.getAttribute('model')} contains an unnamed mode.`);
      }
    }
    return doc;
  }

  function validateSdfXml(text) {
    const doc = parseXml(text, 'SDF XML');
    const actors = [...doc.querySelectorAll('actor')];
    if (actors.length === 0) throw new Error('SDF XML contains no actors.');
    const names = actors.map(actor => actor.getAttribute('name')).filter(Boolean);
    if (names.length !== actors.length) throw new Error('Every SDF actor must have a name.');
    if (new Set(names).size !== names.length) throw new Error('SDF actor names must be unique.');

    const actorPorts = new Map();
    for (const actor of actors) {
      const ports = new Set([...actor.querySelectorAll(':scope > port')].map(port => port.getAttribute('name')).filter(Boolean));
      actorPorts.set(actor.getAttribute('name'), ports);
    }

    for (const channel of doc.querySelectorAll('channel')) {
      const srcActor = channel.getAttribute('srcActor');
      const dstActor = channel.getAttribute('dstActor');
      const srcPort = channel.getAttribute('srcPort');
      const dstPort = channel.getAttribute('dstPort');
      if (!actorPorts.has(srcActor) || !actorPorts.has(dstActor)) {
        throw new Error(`Channel ${channel.getAttribute('name') || ''} references an unknown actor.`);
      }
      if (srcPort && !actorPorts.get(srcActor).has(srcPort)) {
        throw new Error(`Channel ${channel.getAttribute('name') || ''} references missing source port ${srcActor}.${srcPort}.`);
      }
      if (dstPort && !actorPorts.get(dstActor).has(dstPort)) {
        throw new Error(`Channel ${channel.getAttribute('name') || ''} references missing destination port ${dstActor}.${dstPort}.`);
      }
    }
    return doc;
  }

  function validateWcetXml(text) {
    const doc = parseXml(text, 'WCET XML');
    const mappings = [...doc.querySelectorAll('mapping, systemMapping')];
    if (mappings.length === 0) throw new Error('WCET XML contains no mapping/systemMapping elements.');
    let rows = 0;
    for (const mapping of mappings) {
      if (!mapping.getAttribute('task_type')) throw new Error('Every WCET mapping must define task_type.');
      for (const wcet of mapping.querySelectorAll('wcet')) {
        rows++;
        if (!wcet.getAttribute('processor')) throw new Error('Every WCET row must define a processor.');
        if (!wcet.getAttribute('mode')) throw new Error('Every WCET row must define a mode.');
        const value = Number(wcet.getAttribute('wcet'));
        if (!Number.isFinite(value) || value <= 0) throw new Error('Every WCET value must be a positive number of cycles.');
      }
    }
    if (rows === 0) throw new Error('WCET XML contains no <wcet> rows.');
    return doc;
  }

  function validateConstraintsXml(text) {
    const doc = parseXml(text, 'desConst.xml');
    const rows = [...doc.querySelectorAll('constraint')];
    if (rows.length === 0) throw new Error('desConst.xml contains no <constraint> elements.');
    for (const row of rows) {
      for (const attr of ['period', 'latency', 'power', 'area', 'money', 'utilization', 'procsUsed']) {
        if (!row.hasAttribute(attr)) continue;
        const value = Number(row.getAttribute(attr));
        if (!Number.isFinite(value) || value < 0) throw new Error(`Constraint attribute ${attr} must be a non-negative number.`);
      }
    }
    return doc;
  }

  interceptFileButton('btn-load-platform-xml', 'file-platform', async text => {
    validatePlatformXml(text);
    api.loadPlatformXml(text);
    api.toast?.('Validated platform.xml imported.', 'success');
  });

  interceptFileButton('btn-load-sdf-xml', 'file-sdf', async (text, filename) => {
    validateSdfXml(text);
    api.loadSdfXml(text, filename || 'application.xml');
    api.toast?.('Validated SDF graph imported.', 'success');
  });

  interceptFileButton('btn-load-wcet-xml', 'file-wcet', async text => {
    validateWcetXml(text);
    api.loadWcetXml(text);
    api.toast?.('Validated WCET table imported.', 'success');
  });

  interceptFileButton('btn-load-constraints-xml', 'file-constraints', async text => {
    validateConstraintsXml(text);
    api.loadConstraintsXml(text);
    api.toast?.('Validated design constraints imported.', 'success');
  });

  function detectDelimiter(line) {
    return (line.match(/;/g) || []).length > (line.match(/,/g) || []).length ? ';' : ',';
  }

  function normalizeHeader(value) {
    return String(value || '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  }

  function normalizeNativeCsv(text) {
    const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) throw new Error('CSV contains no result rows.');
    const delimiter = detectDelimiter(lines[0]);
    const sourceHeaders = lines[0].split(delimiter).map(header => normalizeHeader(header));

    const column = (...aliases) => {
      const normalized = aliases.map(normalizeHeader);
      return sourceHeaders.findIndex(header => normalized.includes(header));
    };
    const indices = {
      solution: column('solution', 'solution #', 'solution number'),
      period: column('period', 'latency'),
      throughput: column('throughput'),
      power: column('power', 'power (mw)', 'sys power'),
      area: column('area', 'sys area'),
      cost: column('cost', 'cost ($)', 'money', 'sys cost'),
      utilization: column('utilization', 'utilization (%)', 'sys utilization')
    };

    if (indices.period < 0 && indices.power < 0) {
      // It is still a CSV file, but not a ParetoCo result table. Let the original
      // parser display it rather than inventing metric semantics.
      return { text, filename: 'out.csv', normalized: false };
    }

    const rows = lines.slice(1).map((line, rowIndex) => {
      const cells = line.split(delimiter).map(value => value.trim());
      const get = index => index >= 0 ? (cells[index] || '') : '';
      return {
        solution: get(indices.solution) || String(rowIndex + 1),
        period: Number(get(indices.period)) || 0,
        throughput: Number(get(indices.throughput)) || 0,
        power: Number(get(indices.power)) || 0,
        area: Number(get(indices.area)) || 0,
        cost: Number(get(indices.cost)) || 0,
        utilization: Number(get(indices.utilization)) || 0
      };
    });

    let periodLimit = Infinity;
    for (const constraint of state.constraints || []) {
      const value = Number(constraint.period);
      if (Number.isFinite(value) && value > 0) periodLimit = Math.min(periodLimit, value);
    }
    const maxPower = Number(state.sysConstraints?.power) > 0 ? Number(state.sysConstraints.power) : Infinity;
    const maxArea = Number(state.sysConstraints?.area) > 0 ? Number(state.sysConstraints.area) : Infinity;
    const maxCost = Number(state.sysConstraints?.cost) > 0 ? Number(state.sysConstraints.cost) : Infinity;
    const minUtil = Number(state.sysConstraints?.utilization) > 0 ? Number(state.sysConstraints.utilization) : -Infinity;

    const valid = rows.filter(row => {
      if (periodLimit < Infinity && row.period > 0 && row.period > periodLimit) return false;
      if (maxPower < Infinity && row.power > 0 && row.power > maxPower) return false;
      if (maxArea < Infinity && row.area > 0 && row.area > maxArea) return false;
      if (maxCost < Infinity && row.cost > 0 && row.cost > maxCost) return false;
      if (minUtil > -Infinity && row.utilization > 0 && row.utilization < minUtil) return false;
      return true;
    });

    if (rows.length > 0 && valid.length === 0) {
      return {
        filename: 'out.txt',
        normalized: true,
        text: 'ParetoCo - Imported Result Constraint Verification\n * INFO: Imported CSV contained result rows, but none satisfy the currently active constraints.\n===== search ended after: imported result verification =====\n0 solutions found\n'
      };
    }

    const header = 'Solution #,Period,Throughput,Power (mW),Area,Cost ($),Utilization (%)';
    const body = valid.map(row => [row.solution, row.period, row.throughput, row.power, row.area, row.cost, row.utilization].join(',')).join('\n');
    return { filename: 'out.csv', normalized: true, text: `${header}\n${body}\n` };
  }

  interceptFileButton('btn-load-results', 'file-results', async (text, filename) => {
    if (/\.csv$/i.test(filename)) {
      const normalized = normalizeNativeCsv(text);
      api.loadResults(normalized.text, normalized.filename);
      api.toast?.(normalized.normalized ? 'CSV results normalized and loaded.' : 'CSV results loaded.', 'success');
    } else {
      api.loadResults(text, filename || 'out.txt');
    }
  });

  function safeStem(value, fallback = 'App') {
    const stem = String(value || fallback).replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^\.+/, '').slice(0, 100);
    return stem || fallback;
  }

  function actorPorts(actor) {
    if (Array.isArray(actor?.ports) && actor.ports.length) return actor.ports;
    const ports = [];
    for (const port of actor?.inPorts || []) ports.push({ ...port, type: 'in' });
    for (const port of actor?.outPorts || []) ports.push({ ...port, type: 'out' });
    if (ports.length) return ports;
    return [{ name: 'p_in', type: 'in', rate: 1 }, { name: 'p_out', type: 'out', rate: 1 }];
  }

  function generateSdfXml(app) {
    const appName = String(app?.name || 'App');
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<sdf3 type="sdf" name="${xmlEscape(appName)}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n  <applicationGraph name="${xmlEscape(appName)}">\n    <sdf name="${xmlEscape(appName)}" type="${xmlEscape(appName)}">\n`;
    for (const actor of app?.actors || []) {
      const name = String(actor?.name || actor?.type || 'actor');
      const type = String(actor?.type || name);
      xml += `      <actor name="${xmlEscape(name)}" type="${xmlEscape(type)}">\n`;
      for (const port of actorPorts(actor)) {
        xml += `        <port name="${xmlEscape(port?.name || 'p')}" type="${port?.type === 'out' ? 'out' : 'in'}" rate="${Math.max(1, parseInt(port?.rate, 10) || 1)}" />\n`;
      }
      xml += '      </actor>\n';
    }
    for (const [index, channel] of (app?.channels || []).entries()) {
      xml += `      <channel name="${xmlEscape(channel?.name || `ch${index + 1}`)}" srcActor="${xmlEscape(channel?.srcActor || channel?.src || '')}" srcPort="${xmlEscape(channel?.srcPort || 'p_out')}" dstActor="${xmlEscape(channel?.dstActor || channel?.dst || '')}" dstPort="${xmlEscape(channel?.dstPort || 'p_in')}" initialTokens="${Math.max(0, parseInt(channel?.initialTokens ?? channel?.tokens, 10) || 0)}" size="${Math.max(1, parseInt(channel?.size, 10) || 1)}" />\n`;
    }
    xml += '    </sdf>\n  </applicationGraph>\n</sdf3>\n';
    return xml;
  }

  function generateWcetXml() {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<WCET_table>\n';
    for (const row of state.wcets || []) {
      xml += `  <systemMapping task_type="${xmlEscape(row?.taskType || 'task')}">\n`;
      xml += `    <wcet processor="${xmlEscape(row?.processor || row?.procModel || '')}" mode="${xmlEscape(row?.mode || 'default')}" wcet="${Math.max(1, parseInt(row?.wcet, 10) || 1)}" />\n`;
      xml += '  </systemMapping>\n';
    }
    xml += '</WCET_table>\n';
    return xml;
  }

  function makeCrcTable() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  }
  const CRC_TABLE = makeCrcTable();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function concatBytes(parts) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }

  function zipProject(files) {
    const encoder = new TextEncoder();
    const locals = [];
    const centrals = [];
    let localOffset = 0;
    const now = new Date();
    const dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | ((Math.floor(now.getSeconds() / 2)) & 31);
    const dosDate = (((Math.max(1980, now.getFullYear()) - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);

    for (const [name, content] of Object.entries(files)) {
      const nameBytes = encoder.encode(name);
      const data = encoder.encode(String(content ?? ''));
      const crc = crc32(data);

      const localHeader = new Uint8Array(30);
      const lv = new DataView(localHeader.buffer);
      lv.setUint32(0, 0x04034B50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      const local = concatBytes([localHeader, nameBytes, data]);
      locals.push(local);

      const centralHeader = new Uint8Array(46);
      const cv = new DataView(centralHeader.buffer);
      cv.setUint32(0, 0x02014B50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, localOffset, true);
      centrals.push(concatBytes([centralHeader, nameBytes]));
      localOffset += local.length;
    }

    const central = concatBytes(centrals);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054B50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, centrals.length, true);
    ev.setUint16(10, centrals.length, true);
    ev.setUint32(12, central.length, true);
    ev.setUint32(16, localOffset, true);
    ev.setUint16(20, 0, true);
    return concatBytes([...locals, central, end]);
  }

  function exportProjectZip() {
    const files = {
      'config.cfg': api.generateConfig?.() || '',
      'xmls/platform.xml': api.generatePlatformXml?.() || '',
      'xmls/desConst.xml': api.generateConstraintsXml?.() || '<?xml version="1.0"?><designConstraints/>',
      'xmls/wcets.xml': generateWcetXml(),
      'project.json': JSON.stringify({
        format: 'ParetoCo Project Snapshot',
        version: api.VERSION || '3',
        exportedAt: new Date().toISOString(),
        platform: state.platform,
        applications: state.applications,
        wcets: state.wcets,
        constraints: state.constraints,
        sysConstraints: state.sysConstraints,
        dse: state.dse,
        presolver: state.presolver,
        output: state.output
      }, null, 2),
      'README.txt': 'ParetoCo project export\n\nconfig.cfg contains the DSE configuration.\nxmls/ contains platform, WCET and design-constraint XML.\nsdfs/ contains all workload graphs.\nproject.json is a complete structured snapshot of the editable experiment.\n'
    };
    for (const app of state.applications || []) {
      files[`sdfs/${safeStem(app?.name)}.xml`] = generateSdfXml(app);
    }

    const bytes = zipProject(files);
    const blob = new Blob([bytes], { type: 'application/zip' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `ParetoCo-project-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    api.toast?.(`Exported complete project ZIP (${Object.keys(files).length} files).`, 'success');
  }

  // Surface the previously hidden/incomplete export feature in a predictable place.
  let exportButton = document.getElementById('btn-export-project');
  if (!exportButton) {
    exportButton = document.createElement('button');
    exportButton.id = 'btn-export-project';
    exportButton.className = 'btn btn-outline';
    exportButton.title = 'Export complete ParetoCo project ZIP';
    exportButton.textContent = '↓ Export Project';
    const topBar = document.querySelector('.top-bar-right');
    const launch = document.getElementById('btn-launch');
    if (topBar) topBar.insertBefore(exportButton, launch || null);
  }
  exportButton?.addEventListener('click', event => {
    event.preventDefault();
    exportProjectZip();
  });

  console.info('[ParetoCo I/O] Validated imports, normalized CSV results, and complete ZIP export enabled.');
})();
