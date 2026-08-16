'use strict';

const { askFeatherlessJson } = require('./featherless');

function transcript(messages) {
  return (messages || [])
    .filter(m => m && typeof m.content === 'string' && m.content.trim())
    .map(m => `${String(m.role || 'user').toUpperCase()}: ${m.content}`)
    .join('\n\n');
}

function userText(messages) {
  return (messages || [])
    .filter(m => m && String(m.role || 'user').toLowerCase() === 'user' && typeof m.content === 'string')
    .map(m => m.content)
    .join('\n');
}

function parseClockHz(text) {
  const match = String(text || '').match(/\b(\d+(?:\.\d+)?)\s*(ghz|mhz|khz|hz)\b/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === 'ghz' ? 1e9 : unit === 'mhz' ? 1e6 : unit === 'khz' ? 1e3 : 1;
  return Number.isFinite(value) && value > 0 ? value * multiplier : null;
}

function durationSeconds(value, unit) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  const u = String(unit || '').toLowerCase().replace('μ', 'µ');
  if (u === 's' || u === 'sec' || u === 'secs' || u === 'second' || u === 'seconds') return number;
  if (u === 'ms') return number / 1e3;
  if (u === 'us' || u === 'µs') return number / 1e6;
  if (u === 'ns') return number / 1e9;
  return null;
}

function findTimingConstraint(text, name) {
  const source = String(text || '');
  const re = new RegExp(`\\b${name}\\b[^\\d]{0,35}(\\d+(?:\\.\\d+)?)\\s*(cycles?|ms|us|µs|μs|ns|seconds?|secs?|sec|s)\\b`, 'i');
  const match = source.match(re);
  if (!match) return null;
  return { value: Number(match[1]), unit: match[2].toLowerCase().replace('μ', 'µ') };
}

function findPowerLimitMilliwatts(text) {
  const source = String(text || '');
  const patterns = [
    /\bpower(?:\s+(?:budget|limit|consumption))?\b[^\d]{0,35}(\d+(?:\.\d+)?)\s*(mw|w)\b/i,
    /\b(?:under|below|max(?:imum)?|less than)\s*(\d+(?:\.\d+)?)\s*(mw|w)\b[^\n]{0,20}\bpower\b/i
  ];
  for (const re of patterns) {
    const match = source.match(re);
    if (!match) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    return Math.round(match[2].toLowerCase() === 'w' ? value * 1000 : value);
  }
  return null;
}

function normalizeExplicitUnits(model, messages) {
  const text = userText(messages);
  model.sysConstraints = model.sysConstraints && typeof model.sysConstraints === 'object' ? model.sysConstraints : {};

  const powerMw = findPowerLimitMilliwatts(text);
  if (powerMw !== null) model.sysConstraints.power = powerMw;

  const clockHz = parseClockHz(text);
  const timingFields = [
    ['period', findTimingConstraint(text, 'period')],
    ['latency', findTimingConstraint(text, 'latency')],
    ['latency', findTimingConstraint(text, 'deadline')]
  ];

  for (const [field, timing] of timingFields) {
    if (!timing) continue;
    let cycles;
    if (/^cycles?$/.test(timing.unit)) {
      cycles = Math.round(timing.value);
    } else {
      if (!clockHz) {
        return {
          question: `You specified ${field} as ${timing.value} ${timing.unit}, but ParetoCo's native ${field} constraint is in processor cycles. What clock frequency should I use for the conversion (for example, 1 GHz)?`
        };
      }
      const seconds = durationSeconds(timing.value, timing.unit);
      if (seconds === null) continue;
      cycles = Math.max(0, Math.round(seconds * clockHz));
    }

    if (!Array.isArray(model.constraints)) model.constraints = [];
    if (model.constraints.length === 0 && Array.isArray(model.applications) && model.applications[0]) {
      model.constraints.push({ appName: model.applications[0].name || 'App', period: 0, latency: 0 });
    }
    if (model.constraints[0]) model.constraints[0][field] = cycles;
  }

  return { model };
}

function validateModel(model) {
  if (!model || typeof model !== 'object') throw new Error('AI did not return a DSE model object.');
  if (!model.platform || !Array.isArray(model.platform.processors) || model.platform.processors.length === 0) {
    throw new Error('AI model is missing platform.processors.');
  }
  if (!Array.isArray(model.applications) || model.applications.length === 0) {
    throw new Error('AI model is missing applications.');
  }

  const processorNames = new Set();
  for (const processor of model.platform.processors) {
    processor.model = String(processor.model || '').trim();
    if (!processor.model) throw new Error('AI model contains a processor without a model name.');
    if (processorNames.has(processor.model)) throw new Error(`AI model contains duplicate processor model name ${processor.model}.`);
    processorNames.add(processor.model);
    processor.count = Math.max(1, parseInt(processor.count, 10) || 1);
    if (!Array.isArray(processor.modes) || processor.modes.length === 0) {
      processor.modes = [{ name: 'default', cycle: 1, mem: 4096, dynPower: 10, staticPower: 2, area: 5, monetary: 10 }];
    }
  }

  const actorTypes = new Set();
  for (const app of model.applications) {
    app.name = String(app.name || 'App');
    if (!Array.isArray(app.actors) || app.actors.length === 0) throw new Error(`Application ${app.name} has no actors.`);
    const names = new Set();
    for (const actor of app.actors) {
      const actorName = typeof actor === 'string' ? actor : actor?.name;
      const actorType = typeof actor === 'string' ? actor : (actor?.type || actor?.name);
      if (!actorName) throw new Error(`Application ${app.name} contains an unnamed actor.`);
      if (names.has(actorName)) throw new Error(`Application ${app.name} contains duplicate actor ${actorName}.`);
      names.add(actorName);
      actorTypes.add(String(actorType || actorName));
    }
    if (!Array.isArray(app.channels)) app.channels = [];
    for (const channel of app.channels) {
      const src = channel.srcActor || channel.src;
      const dst = channel.dstActor || channel.dst;
      if (!names.has(src) || !names.has(dst)) {
        throw new Error(`Application ${app.name} contains channel ${channel.name || ''} referencing unknown actor(s): ${src} -> ${dst}.`);
      }
    }
  }

  if (!Array.isArray(model.wcets)) model.wcets = [];
  for (const wcet of model.wcets) {
    const processor = wcet.procModel || wcet.processor;
    if (!processorNames.has(processor)) {
      throw new Error(`WCET for ${wcet.taskType || 'task'} references unknown processor model ${processor}.`);
    }
    if (wcet.taskType && !actorTypes.has(String(wcet.taskType))) {
      throw new Error(`WCET references unknown actor/task type ${wcet.taskType}.`);
    }
    wcet.procModel = processor;
    wcet.processor = processor;
    wcet.wcet = Math.max(0, Number(wcet.wcet) || 0);
  }

  if (!Array.isArray(model.constraints)) model.constraints = [];
  model.sysConstraints = model.sysConstraints && typeof model.sysConstraints === 'object'
    ? model.sysConstraints
    : { power: -1, utilization: -1, area: -1, cost: -1, procsUsed: -1 };

  model.dse = {
    model: 'SDF_PR_ONLINE',
    criteria: 'THROUGHPUT',
    search: 'FIRST',
    th_prop: 'SSE',
    ...(model.dse || {})
  };
  model.dse.search = String(model.dse.search || 'FIRST').toUpperCase();
  model.dse.criteria = String(model.dse.criteria || 'THROUGHPUT').toUpperCase();
  model.dse.th_prop = String(model.dse.th_prop || model.dse.thProp || 'SSE').toUpperCase();
  delete model.dse.thProp;
  return model;
}

async function convertNlToDseAgent(messages, onLog = () => {}) {
  onLog('[NL-to-DSE] Building a structured DSE model...');
  const systemPrompt = `You convert a user's embedded-system description into a ParetoCo DSE JSON model.

Return one of these shapes:
1) If essential information is genuinely missing: {"question":"one concise clarification question"}
2) Otherwise: {"model": { ... }}

Canonical units required by the native engine:
- period and latency: processor cycles
- sysConstraints.power: milliwatts (mW); convert watts to mW (12 W = 12000 mW)
- utilization: percentage
- memory: KB
- cost/area: use the platform's numeric units consistently
If the user supplies period/latency/deadline in ms/us/ns/seconds and no clock frequency is supplied, ask for the clock frequency rather than treating wall-clock time as cycles.

The model object must use this schema:
{
  "platform": {
    "processors": [
      {"model":"ARM","count":2,"modes":[{"name":"default","cycle":1,"mem":4096,"dynPower":10,"staticPower":2,"area":5,"monetary":10}]}
    ],
    "interconnects": [{"name":"bus0","topology":"TDMA-bus","xDim":2,"yDim":1,"flitSize":32,"slots":2}]
  },
  "applications": [
    {"name":"App","actors":["a0","a1"],"channels":[{"name":"c0","src":"a0","dst":"a1","tokens":0}]}
  ],
  "wcets": [{"taskType":"a0","procModel":"ARM","mode":"default","wcet":10}],
  "constraints": [{"appName":"App","period":100,"latency":0}],
  "sysConstraints": {"power":-1,"utilization":-1,"area":-1,"cost":-1,"procsUsed":-1},
  "dse": {"model":"SDF_PR_ONLINE","criteria":"THROUGHPUT","search":"FIRST","th_prop":"SSE"}
}

Rules:
- Infer reasonable defaults only for genuinely optional values.
- WCET taskType values must match actor names/types used in the application.
- Processor names in WCET entries must exactly match platform processor model names.
- Channel endpoints must reference actors in the same application.
- Use FIRST search by default for reliable hosted execution.
- Preserve explicit constraints; normalize units to the canonical units above and never silently relax limits.`;

  const result = await askFeatherlessJson(systemPrompt, transcript(messages));
  if (result.question) {
    onLog('[NL-to-DSE] Clarification required.');
    return { question: String(result.question) };
  }

  const model = validateModel(result.model || result);
  const normalized = normalizeExplicitUnits(model, messages);
  if (normalized.question) {
    onLog('[NL-to-DSE] Unit conversion requires clarification.');
    return normalized;
  }

  onLog('[NL-to-DSE] Model generated, unit-normalized, and reference-validated.');
  return { model: normalized.model };
}

module.exports = { convertNlToDseAgent, validateModel };
