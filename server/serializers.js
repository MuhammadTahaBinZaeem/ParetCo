'use strict';

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function positiveInt(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.round(n);
}

function nonNegativeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function actorShape(actor) {
  if (typeof actor === 'string') {
    return { name: actor, type: actor, ports: [{ name: 'p_in', type: 'in', rate: 1 }, { name: 'p_out', type: 'out', rate: 1 }] };
  }
  const name = String(actor?.name || actor?.type || 'actor');
  const type = String(actor?.type || actor?.name || name);
  let ports = Array.isArray(actor?.ports) ? actor.ports : [];
  if (!ports.length) {
    ports = [
      ...(Array.isArray(actor?.inPorts) ? actor.inPorts.map(p => ({ ...p, type: 'in' })) : []),
      ...(Array.isArray(actor?.outPorts) ? actor.outPorts.map(p => ({ ...p, type: 'out' })) : [])
    ];
  }
  if (!ports.length) ports = [{ name: 'p_in', type: 'in', rate: 1 }, { name: 'p_out', type: 'out', rate: 1 }];
  return { name, type, ports };
}

function serializePlatform(platform) {
  const processors = Array.isArray(platform?.processors) ? platform.processors : [];
  const interconnects = Array.isArray(platform?.interconnects)
    ? platform.interconnects
    : (platform?.interconnect ? [platform.interconnect] : []);

  // The packaged model contains one system interconnect. Never manufacture one
  // or silently drop extras: validation should make the architecture explicit.
  if (interconnects.length !== 1) {
    throw new Error(`Exactly one interconnect is required; received ${interconnects.length}.`);
  }

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<platform xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n';
  for (const processor of processors) {
    xml += `  <processor model="${escapeXml(processor.model)}" number="${positiveInt(processor.count, 1)}">\n`;
    for (const mode of processor.modes || []) {
      xml += `    <mode name="${escapeXml(mode.name)}" cycle="${nonNegativeNumber(mode.cycle, 1)}" mem="${positiveInt(mode.mem, 1)}" dynPower="${nonNegativeNumber(mode.dynPower)}" staticPower="${nonNegativeNumber(mode.staticPower)}" area="${nonNegativeNumber(mode.area)}" monetary="${nonNegativeNumber(mode.monetary)}" />\n`;
    }
    xml += '  </processor>\n';
  }

  const totalCores = processors.reduce((sum, p) => sum + positiveInt(p.count, 1), 0);
  const ic = interconnects[0];
  const mode = ic.mode || {};
  const slots = positiveInt(ic.slots ?? ic.tdma_slots, Math.max(2, totalCores));
  xml += '  <interconnect>\n';
  xml += `    <TDMA_bus name="${escapeXml(ic.name || 'bus0')}" x-dimension="${positiveInt(ic.xDim ?? ic['x-dimension'], Math.max(1, totalCores))}" y-dimension="${positiveInt(ic.yDim ?? ic['y-dimension'], 1)}" flitSize="${positiveInt(ic.flitSize, 32)}" tdma_slots="${slots}" maxSlotsPerProc="${positiveInt(ic.maxSlotsPerProc, slots)}">\n`;
  xml += `      <mode name="${escapeXml(mode.name || 'default')}" cycleLength="${nonNegativeNumber(mode.cycleLength, 1)}" dynPower_NI="${nonNegativeNumber(mode.dynPower_NI, 1)}" dynPower_bus="${nonNegativeNumber(mode.dynPower_bus, 1)}" staticPower_NI="${nonNegativeNumber(mode.staticPower_NI, 1)}" staticPower_bus="${nonNegativeNumber(mode.staticPower_bus, 1)}" area_NI="${nonNegativeNumber(mode.area_NI, 1)}" area_bus="${nonNegativeNumber(mode.area_bus, 1)}" monetary_NI="${nonNegativeNumber(mode.monetary_NI, 1)}" monetary_bus="${nonNegativeNumber(mode.monetary_bus, 1)}" />\n`;
  xml += '    </TDMA_bus>\n  </interconnect>\n</platform>\n';
  return xml;
}

function serializeApplication(app) {
  const name = String(app?.name || 'App');
  const actors = (Array.isArray(app?.actors) ? app.actors : []).map(actorShape);
  const actorByName = new Map(actors.map(a => [a.name, a]));
  const channels = Array.isArray(app?.channels) ? app.channels : [];

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<sdf3 type="sdf" name="${escapeXml(name)}" xsi:noNamespaceSchemaLocation="http://www.es.ele.tue.nl/sdf3/xsd/sdf3-sdf.xsd" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n  <applicationGraph name="${escapeXml(name)}">\n    <sdf name="${escapeXml(name)}" type="${escapeXml(name)}">\n`;
  for (const actor of actors) {
    xml += `      <actor name="${escapeXml(actor.name)}" type="${escapeXml(actor.type)}">\n`;
    for (const port of actor.ports) {
      xml += `        <port name="${escapeXml(port.name)}" type="${escapeXml(port.type || 'in')}" rate="${positiveInt(port.rate, 1)}" />\n`;
    }
    xml += '      </actor>\n';
  }

  channels.forEach((channel, index) => {
    const src = String(channel.srcActor || channel.src || '');
    const dst = String(channel.dstActor || channel.dst || '');
    const srcActor = actorByName.get(src);
    const dstActor = actorByName.get(dst);
    const srcPort = String(channel.srcPort || (srcActor?.ports.find(p => (p.type || '').toLowerCase() === 'out')?.name) || 'p_out');
    const dstPort = String(channel.dstPort || (dstActor?.ports.find(p => (p.type || '').toLowerCase() === 'in')?.name) || 'p_in');
    const initialTokens = Math.max(0, parseInt(channel.initialTokens ?? channel.tokens, 10) || 0);
    const size = Math.max(1, parseInt(channel.size, 10) || 1);
    xml += `      <channel name="${escapeXml(channel.name || `ch${index + 1}`)}" srcActor="${escapeXml(src)}" srcPort="${escapeXml(srcPort)}" dstActor="${escapeXml(dst)}" dstPort="${escapeXml(dstPort)}" initialTokens="${initialTokens}" size="${size}" />\n`;
  });

  xml += '    </sdf>\n  </applicationGraph>\n</sdf3>\n';
  return xml;
}

function serializeWcets(wcets) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<WCET_table xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n';
  for (const row of wcets || []) {
    xml += `  <systemMapping task_type="${escapeXml(row.taskType || row.name)}">\n`;
    xml += `    <wcet processor="${escapeXml(row.procModel || row.processor)}" mode="${escapeXml(row.mode)}" wcet="${positiveInt(row.wcet, 1)}" />\n`;
    xml += '  </systemMapping>\n';
  }
  xml += '</WCET_table>\n';
  return xml;
}

function serializeConstraints(constraints, sysConstraints = {}) {
  const attrs = [];
  const power = positiveInt(sysConstraints.power ?? sysConstraints.maxPower);
  const area = positiveInt(sysConstraints.area);
  const money = positiveInt(sysConstraints.cost ?? sysConstraints.money);
  const utilization = positiveInt(sysConstraints.utilization);
  const procsUsed = positiveInt(sysConstraints.procsUsed);
  if (power !== null) attrs.push(`power="${power}"`);
  if (area !== null) attrs.push(`area="${area}"`);
  if (money !== null) attrs.push(`money="${money}"`);
  if (utilization !== null) attrs.push(`utilization="${utilization}"`);
  if (procsUsed !== null) attrs.push(`procsUsed="${procsUsed}"`);

  const rows = Array.isArray(constraints) ? constraints : [];
  if (!rows.length && !attrs.length) return '';

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<designConstraints>\n';
  if (rows.length) {
    for (const row of rows) {
      const rowAttrs = [
        `app_name="${escapeXml(row.appName || row.app_name)}"`,
        `period="${Math.max(0, parseInt(row.period, 10) || 0)}"`,
        `latency="${Math.max(0, parseInt(row.latency, 10) || 0)}"`,
        ...attrs
      ];
      xml += `  <constraint ${rowAttrs.join(' ')}></constraint>\n`;
    }
  } else {
    xml += `  <constraint ${attrs.join(' ')}></constraint>\n`;
  }
  xml += '</designConstraints>\n';
  return xml;
}

function serializeConfig(job, sdfFiles, hasConstraints) {
  const dse = job.dse || {};
  const pre = job.presolver || {};
  const output = job.output || {};
  const model = String(dse.model || 'SDF_PR_ONLINE').toUpperCase();
  const criteria = String(dse.criteria || 'THROUGHPUT').toUpperCase();
  const search = String(dse.search || 'FIRST').toUpperCase();
  const prop = String(dse.th_prop || dse.thProp || 'SSE').toUpperCase();
  const lines = [];

  for (const file of sdfFiles) lines.push(`inputs = ${file}`);
  lines.push('inputs = platform.xml', 'inputs = wcets.xml');
  if (hasConstraints) lines.push('inputs = desConst.xml');

  lines.push(
    `output-file-type = ${String(output.type || 'ALL_OUT').toUpperCase()}`,
    `output-print-frequency = ${String(output.freq || 'ALL_SOL')}`,
    'print-metric = NONE',
    `log-level = ${String(output.logLevel || 'INFO').toUpperCase()} DEBUG`,
    '',
    '[dse]',
    `model = ${model}`,
    `search = ${search}`,
    `criteria = ${criteria}`,
    `timeout = ${Math.max(0, parseInt(dse.timeout1, 10) || 0)} ${Math.max(0, parseInt(dse.timeout2, 10) || 0)}`,
    `threads = ${Math.max(0, parseInt(dse.threads, 10) || 0)}`,
    `luby_scale = ${Math.max(0, parseInt(dse.lubyScale ?? dse.luby_scale, 10) || 0)}`,
    `noGoodDepth = ${Math.max(0, parseInt(dse.noGoodDepth, 10) || 0)}`,
    `th_prop = ${prop}`,
    '',
    '[presolver]',
    `model = ${String(pre.model || 'NONE').toUpperCase()}`,
    `search = ${String(pre.search || 'NONESEARCH').toUpperCase()}`,
    `heuristic = ${String(pre.heuristic || 'NONE').toUpperCase()}`,
    `multi-search = ${String(pre.multiSearch || pre['multi-search'] || 'NONESEARCH').toUpperCase()}`,
    `timeout = ${Math.max(0, parseInt(pre.timeout1, 10) || 0)} ${Math.max(0, parseInt(pre.timeout2, 10) || 0)}`,
    ''
  );
  return lines.join('\n');
}

module.exports = {
  serializePlatform,
  serializeApplication,
  serializeWcets,
  serializeConstraints,
  serializeConfig
};