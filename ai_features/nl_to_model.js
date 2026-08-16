const { askFeatherlessJson } = require('./featherless');

function transcript(messages) {
  return (messages || [])
    .filter(m => m && typeof m.content === 'string' && m.content.trim())
    .map(m => `${String(m.role || 'user').toUpperCase()}: ${m.content}`)
    .join('\n\n');
}

function validateModel(model) {
  if (!model || typeof model !== 'object') throw new Error('AI did not return a DSE model object.');
  if (!model.platform || !Array.isArray(model.platform.processors) || model.platform.processors.length === 0) {
    throw new Error('AI model is missing platform.processors.');
  }
  if (!Array.isArray(model.applications) || model.applications.length === 0) {
    throw new Error('AI model is missing applications.');
  }
  if (!Array.isArray(model.wcets)) model.wcets = [];
  if (!Array.isArray(model.constraints)) model.constraints = [];
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
- Infer reasonable defaults when the user gives enough context; do not ask about every missing optional number.
- WCET taskType values must match actor names/types used in the application.
- Processor names in WCET entries must exactly match platform processor model names.
- Use FIRST search by default for reliable hosted execution.
- Preserve explicit numeric constraints and units as the user gave them; do not silently relax constraints.`;

  const result = await askFeatherlessJson(systemPrompt, transcript(messages));
  if (result.question) {
    onLog('[NL-to-DSE] Clarification required.');
    return { question: String(result.question) };
  }

  const model = validateModel(result.model || result);
  onLog('[NL-to-DSE] Model generated and validated.');
  return { model };
}

module.exports = { convertNlToDseAgent };
