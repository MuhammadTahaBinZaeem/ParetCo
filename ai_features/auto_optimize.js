const { askFeatherlessJson } = require('./featherless');

function transcript(messages) {
  return (messages || [])
    .filter(m => m && typeof m.content === 'string' && m.content.trim())
    .map(m => `${String(m.role || 'user').toUpperCase()}: ${m.content}`)
    .join('\n\n');
}

function extractBaselinePlatform(messages) {
  const text = (messages || []).map(m => String(m?.content || '')).join('\n');
  const marker = 'Current Platform:';
  const start = text.lastIndexOf(marker);
  if (start < 0) return null;
  const after = text.slice(start + marker.length);
  const end = after.indexOf('\nBaseline Results:');
  const jsonText = (end >= 0 ? after.slice(0, end) : after).trim();
  try { return JSON.parse(jsonText); } catch (_) { return null; }
}

function normalizeMode(mode) {
  return {
    ...mode,
    name: String(mode?.name || 'default'),
    cycle: Number.isFinite(Number(mode?.cycle)) && Number(mode.cycle) > 0 ? Number(mode.cycle) : 1,
    mem: Math.max(1, parseInt(mode?.mem, 10) || 4096),
    dynPower: Math.max(0, Number(mode?.dynPower) || 0),
    staticPower: Math.max(0, Number(mode?.staticPower) || 0),
    area: Math.max(0, Number(mode?.area) || 0),
    monetary: Math.max(0, Number(mode?.monetary) || 0)
  };
}

function validatePlatform(platform, baseline = null) {
  if (!platform || typeof platform !== 'object' || !Array.isArray(platform.processors) || platform.processors.length === 0) {
    throw new Error('AI optimizer returned an invalid platform: processors are missing.');
  }

  platform.processors = platform.processors.map(proc => ({
    ...proc,
    model: String(proc?.model || ''),
    count: Math.max(1, parseInt(proc?.count, 10) || 1),
    modes: (Array.isArray(proc?.modes) && proc.modes.length > 0
      ? proc.modes
      : [{ name: 'default', cycle: 1, mem: 4096, dynPower: 10, staticPower: 2, area: 5, monetary: 10 }]
    ).map(normalizeMode)
  }));

  // This feature modifies the platform only. WCET mappings are not regenerated,
  // therefore processor model and mode identifiers must remain stable. Structural
  // changes that need new processor types belong in NL-to-DSE, which rebuilds all
  // dependent mappings together.
  if (baseline?.processors?.length) {
    if (platform.processors.length !== baseline.processors.length) {
      throw new Error('Auto-Optimize cannot add/remove processor model types without rebuilding WCET mappings. Use NL-to-DSE for structural model changes.');
    }
    baseline.processors.forEach((baseProc, index) => {
      const proposal = platform.processors[index];
      if (String(proposal.model) !== String(baseProc.model)) {
        throw new Error(`Auto-Optimize changed processor model ${baseProc.model} to ${proposal.model}; that would invalidate existing WCET mappings.`);
      }
      const baseModeNames = (baseProc.modes || []).map(mode => String(mode.name || 'default'));
      const proposedModeNames = (proposal.modes || []).map(mode => String(mode.name || 'default'));
      if (JSON.stringify(baseModeNames) !== JSON.stringify(proposedModeNames)) {
        throw new Error(`Auto-Optimize changed operating-mode identifiers for ${baseProc.model}; that would invalidate existing WCET mappings.`);
      }
    });
  }

  if (!Array.isArray(platform.interconnects) && baseline?.interconnects) {
    platform.interconnects = baseline.interconnects;
  }
  return platform;
}

async function autoOptimizeAgent(messages, onLog = () => {}) {
  onLog('[Architecture Agent] Analyzing goals and baseline results...');
  const systemPrompt = `You are an embedded-systems architecture optimization assistant for ParetoCo.
The transcript contains a user goal, the current platform JSON, and baseline DSE results.
There are NO callable tools in this request.

Return JSON with:
{
  "platform": <complete modified platform object using the same schema as the current platform>,
  "rationale": "short explanation",
  "expectedTradeoffs": ["short item", "short item"]
}

Requirements:
- Return the COMPLETE platform, not a patch.
- Preserve every existing processor model identifier exactly.
- Preserve every existing operating-mode name exactly.
- Do not add/remove processor model types in this feature. You may change processor counts and numeric mode properties such as cycle, memory, dynamic/static power, area and monetary cost.
- Preserve the current interconnect unless the goal specifically requires a compatible numeric adjustment.
- Change only architecture properties that help the stated goal.
- Never silently relax an explicit power, performance, cost, area, or processor-count target.
- Do not claim the proposal has passed the solver; the browser verifies it with the real native DSE engine afterwards.
- If the requested goal fundamentally requires a new processor/accelerator type, keep the current model structurally valid and state in rationale that the user should use NL-to-DSE for a full workload+WCET remap.`;

  const result = await askFeatherlessJson(systemPrompt, transcript(messages));
  const baseline = extractBaselinePlatform(messages);
  const platform = validatePlatform(result.platform || result, baseline);
  onLog('[Architecture Agent] Proposal generated. Native DSE verification is required.');
  return {
    platform,
    rationale: result.rationale || '',
    expectedTradeoffs: Array.isArray(result.expectedTradeoffs) ? result.expectedTradeoffs : []
  };
}

module.exports = { autoOptimizeAgent, validatePlatform };
