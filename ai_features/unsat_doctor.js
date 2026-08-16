const { askFeatherlessJson } = require('./featherless');

function transcript(messages) {
  return (messages || [])
    .filter(message => message && typeof message.content === 'string' && message.content.trim())
    .map(message => `${String(message.role || 'user').toUpperCase()}: ${message.content}`)
    .join('\n\n');
}

function normalizeTweak(tweak) {
  if (!tweak || typeof tweak !== 'object') return null;
  const type = String(tweak.type || '').toLowerCase();
  if (!['period', 'power', 'area', 'cost', 'cores', 'utilization', 'procsused'].includes(type)) return null;
  const value = Number(tweak.value);
  if (!Number.isFinite(value) || value <= 0) return null;
  return { type, value };
}

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.slice(0, 3).map((option, index) => {
    const suggestedTweak = normalizeTweak(option?.suggestedTweak);
    if (!suggestedTweak) return null;
    return {
      title: String(option?.title || `Repair option ${index + 1}`),
      explanation: String(option?.explanation || 'Adjust this constraint and rerun the native DSE engine to verify feasibility.'),
      suggestedTweak,
      verified: false
    };
  }).filter(Boolean);
}

function deterministicFallback(messages) {
  const text = transcript(messages);
  const periodMatch = text.match(/"period"\s*:\s*(\d+(?:\.\d+)?)/i);
  const powerMatch = text.match(/"power"\s*:\s*(\d+(?:\.\d+)?)/i);
  const countMatch = text.match(/"count"\s*:\s*(\d+)/i);

  const options = [];
  if (periodMatch) {
    const current = Number(periodMatch[1]);
    options.push({
      title: `Relax period bound from ${current} to ${Math.max(current + 10, Math.ceil(current * 1.5))} cycles`,
      explanation: 'A tighter period bound is a common source of zero-solution DSE runs. This is a candidate relaxation, not a claim of feasibility.',
      suggestedTweak: { type: 'period', value: Math.max(current + 10, Math.ceil(current * 1.5)) },
      verified: false
    });
  }
  if (powerMatch && Number(powerMatch[1]) > 0) {
    const current = Number(powerMatch[1]);
    options.push({
      title: `Increase power ceiling above ${current} mW`,
      explanation: 'If the native platform minimum exceeds the current ceiling, the search is necessarily infeasible. The next run will verify this candidate.',
      suggestedTweak: { type: 'power', value: Math.ceil(current * 1.5) },
      verified: false
    });
  }
  if (countMatch) {
    const cores = Math.max(1, Number(countMatch[1]));
    options.push({
      title: `Add one processor core (${cores} → ${cores + 1})`,
      explanation: 'Additional parallelism can relax timing pressure. The native engine must still verify the modified design.',
      suggestedTweak: { type: 'cores', value: cores + 1 },
      verified: false
    });
  }

  if (options.length === 0) {
    options.push({
      title: 'Relax the tightest application period bound',
      explanation: 'The available context is insufficient to quantify a safe repair automatically. Increase the tightest period modestly and rerun the native engine.',
      suggestedTweak: { type: 'period', value: 100 },
      verified: false
    });
  }
  return options.slice(0, 3);
}

async function analyzeUnsatAgent(messages, onLog = () => {}) {
  onLog('[UNSAT Doctor] Inspecting active constraints and platform...');
  const systemPrompt = `You are ParetoCo's UNSAT diagnosis assistant.
The supplied transcript contains the active application constraints, system constraints, WCET information when available, platform, and workload.

Return ONLY JSON in this shape:
{
  "options": [
    {
      "title": "short repair title",
      "explanation": "why this specific change may restore feasibility",
      "suggestedTweak": {"type":"period|power|area|cost|cores|utilization|procsUsed","value":123}
    }
  ]
}

Rules:
- Return at most 3 minimal, concrete repairs.
- Prefer changing one thing at a time.
- Do not invent a fake solver result or claim a repair is feasible. Every repair will be verified only after the real native DSE engine is rerun.
- Respect the native semantics: power/area/cost are maximum bounds, utilization is a minimum percentage, and procsUsed is an exact active-processor count.
- ParetoCo power units are mW and period/latency units are engine cycles.
- If a power cap is clearly below observed/native output, recommend raising the cap rather than pretending the existing result satisfies it.
- Do not recommend an operating mode that is absent from the supplied platform.`;

  try {
    const result = await askFeatherlessJson(systemPrompt, transcript(messages));
    const options = normalizeOptions(result.options);
    if (options.length === 0) throw new Error('UNSAT model returned no usable repair options.');
    onLog(`[UNSAT Doctor] Generated ${options.length} candidate repair(s). Native rerun required for verification.`);
    return { options };
  } catch (error) {
    onLog(`[UNSAT Doctor] AI diagnosis unavailable: ${error.message}. Using deterministic candidates.`);
    return { options: deterministicFallback(messages), fallback: true };
  }
}

module.exports = { analyzeUnsatAgent };
