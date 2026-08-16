const { askFeatherlessJson } = require('./featherless');

function transcript(messages) {
  return (messages || [])
    .filter(m => m && typeof m.content === 'string' && m.content.trim())
    .map(m => `${String(m.role || 'user').toUpperCase()}: ${m.content}`)
    .join('\n\n');
}

function validatePlatform(platform) {
  if (!platform || typeof platform !== 'object' || !Array.isArray(platform.processors) || platform.processors.length === 0) {
    throw new Error('AI optimizer returned an invalid platform: processors are missing.');
  }
  for (const proc of platform.processors) {
    proc.count = Math.max(1, parseInt(proc.count, 10) || 1);
    if (!Array.isArray(proc.modes) || proc.modes.length === 0) {
      proc.modes = [{ name: 'default', cycle: 1, mem: 4096, dynPower: 10, staticPower: 2, area: 5, monetary: 10 }];
    }
  }
  return platform;
}

async function autoOptimizeAgent(messages, onLog = () => {}) {
  onLog('[Architecture Agent] Analyzing goals and baseline results...');
  const systemPrompt = `You are an embedded-systems architecture optimization assistant for ParetoCo.
The transcript contains a user goal, the current platform JSON, and baseline DSE results.
There are NO callable tools in this request; ignore any old transcript instruction that says to call modify_architecture or run_dse_engine.

Return JSON with:
{
  "platform": <complete modified platform object using the same schema as the current platform>,
  "rationale": "short explanation",
  "expectedTradeoffs": ["short item", "short item"]
}

Requirements:
- Return the COMPLETE platform, not a patch.
- Keep processor models/modes structurally valid for the existing WCET mappings where possible.
- Change only architecture properties that help the stated goal.
- Do not claim the proposed platform has already passed the native solver; it will be verified by a subsequent DSE run.
- Respect explicit power, performance, cost, area, and processor-count targets rather than silently relaxing them.`;

  const result = await askFeatherlessJson(systemPrompt, transcript(messages));
  const platform = validatePlatform(result.platform || result);
  onLog('[Architecture Agent] Proposal generated. Run DSE to verify feasibility.');
  return {
    platform,
    rationale: result.rationale || '',
    expectedTradeoffs: Array.isArray(result.expectedTradeoffs) ? result.expectedTradeoffs : []
  };
}

module.exports = { autoOptimizeAgent };
