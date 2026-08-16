'use strict';

const { askFeatherlessJson } = require('./featherless');
const { runNativeDse, summarizeNativeText } = require('./native_verify');

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function extractContext(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const content = messages[i]?.content;
    if (typeof content !== 'string') continue;
    try {
      const parsed = JSON.parse(content);
      if (parsed && parsed.currentJob) return parsed;
    } catch (_) {}
  }
  throw new Error('Auto-Optimize requires the full current DSE job context. Refresh the UI and try again.');
}

function validatePlatform(platform) {
  if (!platform || typeof platform !== 'object' || !Array.isArray(platform.processors) || platform.processors.length === 0) {
    throw new Error('AI optimizer returned an invalid platform: processors are missing.');
  }

  const copy = deepClone(platform);
  for (const proc of copy.processors) {
    proc.model = String(proc.model || 'ARM');
    proc.count = Math.max(1, parseInt(proc.count, 10) || 1);
    if (!Array.isArray(proc.modes) || proc.modes.length === 0) {
      proc.modes = [{ name: 'default', cycle: 1, mem: 4096, dynPower: 10, staticPower: 2, area: 5, monetary: 10 }];
    }
    proc.modes = proc.modes.map(mode => ({
      name: String(mode.name || 'default'),
      cycle: Number.isFinite(Number(mode.cycle)) ? Number(mode.cycle) : 1,
      mem: Math.max(1, Number(mode.mem) || 4096),
      dynPower: Math.max(0, Number(mode.dynPower) || 0),
      staticPower: Math.max(0, Number(mode.staticPower) || 0),
      area: Math.max(0, Number(mode.area) || 0),
      monetary: Math.max(0, Number(mode.monetary) || 0)
    }));
  }
  if (!Array.isArray(copy.interconnects) && copy.interconnect) copy.interconnects = [copy.interconnect];
  if (!Array.isArray(copy.interconnects)) copy.interconnects = [];
  return copy;
}

function totalCores(platform) {
  return (platform?.processors || []).reduce((sum, proc) => sum + Math.max(1, Number(proc.count) || 1), 0);
}

function primaryObjective(goal) {
  const text = String(goal || '').toLowerCase();
  if (/power|energy|watt|thermal/.test(text)) return 'power';
  if (/area|silicon|footprint/.test(text)) return 'area';
  if (/cost|price|budget|money/.test(text)) return 'cost';
  if (/latency|period|throughput|performance|speed/.test(text)) return 'period';
  if (/core|processor|resource/.test(text)) return 'cores';
  return 'balanced';
}

function objectiveValue(objective, summary, platform) {
  if (objective === 'power') return summary.minPower;
  if (objective === 'area') return summary.minArea;
  if (objective === 'cost') return summary.minCost;
  if (objective === 'period') return summary.minPeriod;
  if (objective === 'cores') return totalCores(platform);
  return null;
}

function improvementPct(baseline, candidate) {
  if (!(Number.isFinite(baseline) && baseline > 0 && Number.isFinite(candidate))) return null;
  return ((baseline - candidate) / baseline) * 100;
}

function scoreCandidate(objective, candidateSummary, candidatePlatform, baselineSummary, baselinePlatform) {
  if (!candidateSummary.feasible) return -Infinity;

  if (objective !== 'balanced') {
    const candidateValue = objectiveValue(objective, candidateSummary, candidatePlatform);
    const baselineValue = objectiveValue(objective, baselineSummary, baselinePlatform);
    if (!Number.isFinite(candidateValue)) return -Infinity;
    if (Number.isFinite(baselineValue) && candidateValue >= baselineValue) return -Infinity;
    return -candidateValue;
  }

  let score = 0;
  const pairs = [
    [baselineSummary.minPeriod, candidateSummary.minPeriod],
    [baselineSummary.minPower, candidateSummary.minPower],
    [baselineSummary.minArea, candidateSummary.minArea],
    [baselineSummary.minCost, candidateSummary.minCost]
  ];
  for (const [baseline, candidate] of pairs) {
    const improvement = improvementPct(baseline, candidate);
    if (improvement !== null) score += improvement;
  }
  const baseCores = totalCores(baselinePlatform);
  const candidateCores = totalCores(candidatePlatform);
  if (baseCores > 0) score += ((baseCores - candidateCores) / baseCores) * 10;
  return score;
}

async function proposeCandidates(goal, currentPlatform, baselineResults) {
  const systemPrompt = `You are the ParetoCo architecture optimization planner. You propose architecture candidates; you NEVER claim they are feasible or improved until the native solver verifies them.
Return ONLY JSON in this shape:
{
  "candidates": [
    {
      "platform": <complete platform object using the same schema as the input>,
      "rationale": "short reason this candidate may help",
      "expectedTradeoffs": ["short item"]
    }
  ]
}
Rules:
- Return 1 to 3 COMPLETE platform candidates.
- Preserve processor model and mode names when changing them is not required, because WCET mappings reference those names.
- Prefer small, defensible changes rather than arbitrary redesigns.
- Respect explicit hard limits present in the current job.
- Do not modify application, WCET, or constraint semantics.
- Do not say a candidate passed DSE; the native solver will verify it.`;

  const result = await askFeatherlessJson(systemPrompt, JSON.stringify({
    goal,
    currentPlatform,
    baselineResultTail: String(baselineResults || '').slice(-7000)
  }));

  const raw = Array.isArray(result.candidates) ? result.candidates : [];
  return raw.slice(0, 3).map(candidate => ({
    platform: validatePlatform(candidate.platform || candidate),
    rationale: String(candidate.rationale || ''),
    expectedTradeoffs: Array.isArray(candidate.expectedTradeoffs) ? candidate.expectedTradeoffs.map(String) : []
  }));
}

async function autoOptimizeAgent(messages, onLog = () => {}) {
  const context = extractContext(messages);
  const job = deepClone(context.currentJob);
  const goal = String(context.goal || 'Improve the architecture while preserving feasibility.');
  const baselineResults = String(context.baselineResults || '');
  const baselineSummary = summarizeNativeText(baselineResults);
  const objective = primaryObjective(goal);

  onLog(`[Architecture Agent] Objective: ${objective}. Generating bounded candidate architectures...`);
  const candidates = await proposeCandidates(goal, job.platform, baselineResults);
  if (candidates.length === 0) throw new Error('Featherless returned no valid architecture candidates.');

  const verified = [];
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    onLog(`[Architecture Agent] Native verification ${index + 1}/${candidates.length}...`);
    const trialJob = deepClone(job);
    trialJob.platform = candidate.platform;

    try {
      const verification = await runNativeDse(trialJob);
      if (!verification.ok || !verification.summary.feasible) {
        onLog(`[Architecture Agent] Candidate ${index + 1} rejected: ${verification.summary.solutionCount} native solutions.`);
        continue;
      }

      const score = scoreCandidate(objective, verification.summary, candidate.platform, baselineSummary, job.platform);
      if (!Number.isFinite(score)) {
        onLog(`[Architecture Agent] Candidate ${index + 1} is feasible but does not improve the requested objective.`);
        continue;
      }

      onLog(`[Architecture Agent] Candidate ${index + 1} VERIFIED with ${verification.summary.solutionCount} native solution(s).`);
      verified.push({
        ...candidate,
        score,
        verification
      });
    } catch (err) {
      onLog(`[Architecture Agent] Candidate ${index + 1} native run failed: ${err.message}`);
    }
  }

  if (verified.length === 0) {
    throw new Error('No proposed architecture both passed the native solver and improved the requested objective. The current architecture was left unchanged.');
  }

  verified.sort((a, b) => b.score - a.score);
  const best = verified[0];
  const baseValue = objectiveValue(objective, baselineSummary, job.platform);
  const candidateValue = objectiveValue(objective, best.verification.summary, best.platform);
  const improvement = improvementPct(baseValue, candidateValue);

  onLog(`[Architecture Agent] Selected native-verified candidate (${best.verification.summary.solutionCount} solutions).`);
  return {
    platform: best.platform,
    rationale: best.rationale,
    expectedTradeoffs: best.expectedTradeoffs,
    objective,
    improvementPct: improvement,
    verification: {
      native: true,
      solutionCount: best.verification.summary.solutionCount,
      metrics: best.verification.summary,
      outTxt: best.verification.result.outTxt || '',
      outCsv: best.verification.result.outCsv || ''
    }
  };
}

module.exports = { autoOptimizeAgent };
