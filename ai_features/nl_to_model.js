const { askFeatherlessJson } = require('./featherless');

function transcript(messages) {
  return (messages || [])
    .filter(m => m && typeof m.content === 'string' && m.content.trim())
    .map(m => `${String(m.role || 'user').toUpperCase()}: ${m.content}`)
    .join('\n\n');
}

function positiveOrUnlimited(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : -1;
}

function normalizeActor(actor, index) {
  if (typeof actor === 'string') {
    const name = actor.trim() || `actor_${index}`;
    return {
      name,
      type: name,
      ports: [
        { name: 'p_in', type: 'in', rate: 1 },
        { name: 'p_out', type: 'out', rate: 1 }
      ]
    };
  }

  const name = String(actor?.name || actor?.type || `actor_${index}`);
  let ports = Array.isArray(actor?.ports) ? actor.ports : [];
  if (ports.length === 0) {
    ports = [
      { name: 'p_in', type: 'in', rate: 1 },
      { name: 'p_out', type: 'out', rate: 1 }
    ];
  }

  return {
    ...actor,
    name,
    type: String(actor?.type || name),
    ports: ports.map((port, pi) => ({
      name: String(port?.name || (pi === 0 ? 'p_in' : 'p_out')),
      type: String(port?.type || (pi === 0 ? 'in' : 'out')),
      rate: Math.max(1, parseInt(port?.rate, 10) || 1)
    }))
  };
}

function normalizeApplication(app, index) {
  const name = String(app?.name || `App${index + 1}`);
  const actors = (Array.isArray(app?.actors) ? app.actors : []).map(normalizeActor);
  const actorNames = new Set(actors.map(actor => actor.name));

  const channels = (Array.isArray(app?.channels) ? app.channels : []).map((channel, ci) => {
    const src = String(channel?.srcActor || channel?.src || actors[ci % Math.max(1, actors.length)]?.name || 'src_node');
    const dst = String(channel?.dstActor || channel?.dst || actors[(ci + 1) % Math.max(1, actors.length)]?.name || 'snk_node');
    return {
      ...channel,
      name: String(channel?.name || `ch${ci + 1}`),
      srcActor: src,
      srcPort: String(channel?.srcPort || 'p_out'),
      dstActor: dst,
      dstPort: String(channel?.dstPort || 'p_in'),
      initialTokens: Math.max(0, parseInt(channel?.initialTokens ?? channel?.tokens, 10) || 0),
      size: Math.max(1, parseInt(channel?.size, 10) || 1)
    };
  }).filter(channel => actorNames.has(channel.srcActor) && actorNames.has(channel.dstActor));

  return { ...app, name, actors, channels };
}

function validateModel(model) {
  if (!model || typeof model !== 'object') throw new Error('AI did not return a DSE model object.');
  if (!model.platform || !Array.isArray(model.platform.processors) || model.platform.processors.length === 0) {
    throw new Error('AI model is missing platform.processors.');
  }
  if (!Array.isArray(model.applications) || model.applications.length === 0) {
    throw new Error('AI model is missing applications.');
  }

  model.platform.processors = model.platform.processors.map((proc, index) => {
    const modelName = String(proc?.model || `Processor${index + 1}`);
    const modes = Array.isArray(proc?.modes) && proc.modes.length > 0
      ? proc.modes
      : [{ name: 'default', cycle: 1, mem: 4096, dynPower: 10, staticPower: 2, area: 5, monetary: 10 }];
    return {
      ...proc,
      model: modelName,
      count: Math.max(1, parseInt(proc?.count, 10) || 1),
      modes: modes.map(mode => ({
        ...mode,
        name: String(mode?.name || 'default'),
        cycle: Number.isFinite(Number(mode?.cycle)) && Number(mode.cycle) > 0 ? Number(mode.cycle) : 1,
        mem: Math.max(1, parseInt(mode?.mem, 10) || 4096),
        dynPower: Math.max(0, Number(mode?.dynPower) || 0),
        staticPower: Math.max(0, Number(mode?.staticPower) || 0),
        area: Math.max(0, Number(mode?.area) || 0),
        monetary: Math.max(0, Number(mode?.monetary) || 0)
      }))
    };
  });

  if (!Array.isArray(model.platform.interconnects)) {
    model.platform.interconnects = model.platform.interconnect ? [model.platform.interconnect] : [];
  }
  if (model.platform.interconnects.length === 0) {
    const totalCores = model.platform.processors.reduce((sum, proc) => sum + proc.count, 0);
    model.platform.interconnects = [{ name: 'bus0', topology: 'TDMA-bus', xDim: Math.max(1, totalCores), yDim: 1, flitSize: 32, slots: Math.max(2, totalCores) }];
  }

  model.applications = model.applications.map(normalizeApplication);
  const actorNames = new Set(model.applications.flatMap(app => app.actors.map(actor => actor.name)));
  const processorNames = new Set(model.platform.processors.map(proc => proc.model));
  const defaultProcessor = model.platform.processors[0].model;
  const defaultMode = model.platform.processors[0].modes[0].name;

  if (!Array.isArray(model.wcets)) model.wcets = [];
  model.wcets = model.wcets
    .filter(wcet => actorNames.has(String(wcet?.taskType || wcet?.name || '')))
    .map(wcet => {
      const processor = String(wcet?.procModel || wcet?.processor || defaultProcessor);
      const normalizedProcessor = processorNames.has(processor) ? processor : defaultProcessor;
      const proc = model.platform.processors.find(p => p.model === normalizedProcessor) || model.platform.processors[0];
      const requestedMode = String(wcet?.mode || defaultMode);
      const normalizedMode = proc.modes.some(mode => mode.name === requestedMode) ? requestedMode : proc.modes[0].name;
      return {
        taskType: String(wcet.taskType || wcet.name),
        processor: normalizedProcessor,
        procModel: normalizedProcessor,
        mode: normalizedMode,
        wcet: Math.max(1, parseInt(wcet?.wcet, 10) || 10)
      };
    });

  // Guarantee every actor has at least one valid WCET row so the generated model
  // is immediately runnable rather than merely renderable.
  for (const actorName of actorNames) {
    if (!model.wcets.some(wcet => wcet.taskType === actorName)) {
      model.wcets.push({ taskType: actorName, processor: defaultProcessor, procModel: defaultProcessor, mode: defaultMode, wcet: 10 });
    }
  }

  if (!Array.isArray(model.constraints)) model.constraints = [];
  model.constraints = model.constraints.map((constraint, index) => ({
    appName: String(constraint?.appName || constraint?.app_name || model.applications[index]?.name || model.applications[0].name),
    period: Math.max(0, parseInt(constraint?.period, 10) || 0),
    latency: Math.max(0, parseInt(constraint?.latency, 10) || 0)
  }));

  const sys = model.sysConstraints && typeof model.sysConstraints === 'object' ? model.sysConstraints : {};
  model.sysConstraints = {
    power: positiveOrUnlimited(sys.power ?? sys.maxPower),
    utilization: positiveOrUnlimited(sys.utilization ?? sys.minUtilization),
    area: positiveOrUnlimited(sys.area),
    cost: positiveOrUnlimited(sys.cost ?? sys.money),
    procsUsed: positiveOrUnlimited(sys.procsUsed)
  };

  const incomingDse = model.dse || {};
  const thProp = String(incomingDse.thProp || incomingDse.th_prop || 'SSE').toUpperCase();
  model.dse = {
    model: String(incomingDse.model || 'SDF_PR_ONLINE').toUpperCase(),
    criteria: String(incomingDse.criteria || 'THROUGHPUT').toUpperCase(),
    search: String(incomingDse.search || 'FIRST').toUpperCase(),
    thProp,
    th_prop: thProp
  };

  // Hosted demo/runtime stability: avoid unsupported or crash-prone values from a
  // free-form model response. Users can still change these manually afterwards.
  if (!['FIRST', 'ALL', 'OPTIMIZE', 'OPTIMIZE_IT'].includes(model.dse.search)) model.dse.search = 'FIRST';
  if (!['POWER', 'THROUGHPUT', 'AREA', 'COST', 'NONE'].includes(model.dse.criteria)) model.dse.criteria = 'THROUGHPUT';
  if (!['SSE', 'MCR'].includes(model.dse.thProp)) model.dse.thProp = model.dse.th_prop = 'SSE';

  return model;
}

async function convertNlToDseAgent(messages, onLog = () => {}) {
  onLog('[NL-to-DSE] Building a structured DSE model...');
  const systemPrompt = `You convert a user's embedded-system description into a ParetoCo DSE JSON model.

Return one of these shapes:
1) If essential information is genuinely missing: {"question":"one concise clarification question"}
2) Otherwise: {"model": { ... }}

The model object must use this schema:
{
  "platform": {
    "processors": [
      {"model":"ARM","count":2,"modes":[{"name":"default","cycle":1,"mem":4096,"dynPower":10,"staticPower":2,"area":5,"monetary":10}]}
    ],
    "interconnects": [{"name":"bus0","topology":"TDMA-bus","xDim":2,"yDim":1,"flitSize":32,"slots":2}]
  },
  "applications": [
    {"name":"App","actors":[{"name":"a0","type":"a0"},{"name":"a1","type":"a1"}],"channels":[{"name":"c0","srcActor":"a0","dstActor":"a1","initialTokens":0}]}
  ],
  "wcets": [{"taskType":"a0","procModel":"ARM","mode":"default","wcet":10}],
  "constraints": [{"appName":"App","period":100,"latency":0}],
  "sysConstraints": {"power":-1,"utilization":-1,"area":-1,"cost":-1,"procsUsed":-1},
  "dse": {"model":"SDF_PR_ONLINE","criteria":"THROUGHPUT","search":"FIRST","thProp":"SSE"}
}

Rules:
- Infer reasonable defaults when the user gives enough context; do not ask about every missing optional number.
- Actor names must be unique. Channel srcActor/dstActor values must exactly match actor names.
- WCET taskType values must exactly match actor names/types used in the application.
- Processor names in WCET entries must exactly match platform processor model names.
- Use FIRST search by default for reliable hosted execution.
- ParetoCo power values are in mW. Convert explicit watts to milliwatts (for example 15 W -> 15000 mW).
- Application period/latency constraints are engine cycles. If the user only supplies a wall-clock deadline such as 33 ms but gives no timing/frequency information that permits a defensible cycle conversion, ask one concise clarification question rather than pretending milliseconds are cycles.
- Preserve explicit constraints. Never silently relax a user's bound.`;

  const result = await askFeatherlessJson(systemPrompt, transcript(messages));
  if (result.question) {
    onLog('[NL-to-DSE] Clarification required.');
    return { question: String(result.question) };
  }

  const model = validateModel(result.model || result);
  onLog('[NL-to-DSE] Model generated, normalized, and validated.');
  return { model };
}

module.exports = { convertNlToDseAgent, validateModel };
