'use strict';

const { askFeatherlessJson } = require('./featherless');
const { runNativeDse, summarizeNativeText } = require('./native_verify');

function deepClone(value) { return JSON.parse(JSON.stringify(value)); }

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
  const copy = deepClone(platform);
  copy.processors = copy.processors.map(proc => ({
    ...proc,
    model: String(proc?.model || ''),
    count: Math.max(1, parseInt(proc?.count, 10) || 1),
    modes: (Array.isArray(proc?.modes) && proc.modes.length ? proc.modes : [{ name:'default', cycle:1, mem:4096, dynPower:10, staticPower:2, area:5, monetary:10 }]).map(normalizeMode)
  }));
  if (copy.processors.some(proc => !proc.model)) throw new Error('Auto-Optimize returned an empty processor model name.');
  if (baseline?.processors?.length) {
    if (copy.processors.length !== baseline.processors.length) throw new Error('Auto-Optimize cannot add/remove processor model types without rebuilding WCET mappings. Use NL-to-DSE for structural model changes.');
    baseline.processors.forEach((baseProc, index) => {
      const proposal = copy.processors[index];
      if (String(proposal.model) !== String(baseProc.model)) throw new Error(`Auto-Optimize changed processor model ${baseProc.model} to ${proposal.model}; that would invalidate existing WCET mappings.`);
      const baseModes = (baseProc.modes || []).map(mode => String(mode.name || 'default'));
      const proposedModes = (proposal.modes || []).map(mode => String(mode.name || 'default'));
      if (JSON.stringify(baseModes) !== JSON.stringify(proposedModes)) throw new Error(`Auto-Optimize changed operating-mode identifiers for ${baseProc.model}; that would invalidate existing WCET mappings.`);
    });
  }
  if (!Array.isArray(copy.interconnects) && copy.interconnect) copy.interconnects = [copy.interconnect];
  if (!Array.isArray(copy.interconnects)) copy.interconnects = deepClone(baseline?.interconnects || []);
  return copy;
}

function totalCores(platform) {
  return (platform?.processors || []).reduce((sum, proc) => sum + Math.max(1, Number(proc.count) || 1), 0);
}

function primaryObjective(goal) {
  const text = String(goal || '').toLowerCase();
  if (/power|energy|watt|thermal/.test(text)) return 'power';
  if (/area|silicon|footprint/.test(text)) return 'area';
  if (/cost|price|budget|money|bom/.test(text)) return 'cost';
  if (/latency|period|throughput|performance|speed|fps/.test(text)) return 'period';
  if (/core|processor|resource/.test(text)) return 'cores';
  return 'balanced';
}

function parseClockHz(text) {
  const match = String(text || '').match(/\b(\d+(?:\.\d+)?)\s*(ghz|mhz|khz|hz)\b/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const factor = unit === 'ghz' ? 1e9 : unit === 'mhz' ? 1e6 : unit === 'khz' ? 1e3 : 1;
  return value > 0 ? value * factor : null;
}

function parsePowerTarget(text) {
  const match = String(text || '').match(/(?:power|energy(?:\s+budget)?)[^\d]{0,35}(?:<=|<|below|under|max(?:imum)?|budget(?:\s+of)?|at\s+most)?\s*(\d+(?:\.\d+)?)\s*(mw|w)\b/i);
  if (!match || !(Number(match[1]) > 0)) return null;
  return Math.round(match[2].toLowerCase() === 'w' ? Number(match[1]) * 1000 : Number(match[1]));
}

function parseCostTarget(text) {
  for (const pattern of [
    /(?:cost|bom|budget|price)[^\d$]{0,35}(?:<=|<|below|under|max(?:imum)?|at\s+most)?\s*\$?\s*(\d+(?:\.\d+)?)/i,
    /(?:<=|<|below|under|max(?:imum)?|at\s+most)\s*\$\s*(\d+(?:\.\d+)?)\s*(?:bom|cost|budget|price)?/i
  ]) {
    const match = String(text || '').match(pattern);
    if (match && Number(match[1]) > 0) return Number(match[1]);
  }
  return null;
}

function deriveHardTargets(goal) {
  const text = String(goal || '');
  const targets = {};
  const power = parsePowerTarget(text);
  const cost = parseCostTarget(text);
  if (power !== null) targets.power = power;
  if (cost !== null) targets.cost = cost;
  const area = text.match(/(?:area|silicon\s+area|footprint)[^\d]{0,30}(?:<=|<|below|under|max(?:imum)?|at\s+most)?\s*(\d+(?:\.\d+)?)/i);
  if (area && Number(area[1]) > 0) targets.area = Number(area[1]);
  const period = text.match(/\bperiod\b[^\d]{0,30}(\d+(?:\.\d+)?)\s*cycles?\b/i);
  if (period) targets.periodCycles = Math.round(Number(period[1]));
  const latency = text.match(/\b(?:latency|deadline)\b[^\d]{0,30}(\d+(?:\.\d+)?)\s*cycles?\b/i);
  if (latency) targets.latencyCycles = Math.round(Number(latency[1]));
  const fps = text.match(/(?:>=|>|at\s+least)?\s*(\d+(?:\.\d+)?)\s*fps\b/i);
  if (fps) {
    const clockHz = parseClockHz(text);
    if (!clockHz) targets.unsupported = `The goal specifies ${fps[1]} FPS, but native DSE uses period in processor cycles. Include a clock frequency (for example, 1 GHz) so FPS can be converted to a cycle-period bound.`;
    else targets.periodCycles = Math.floor(clockHz / Number(fps[1]));
  }
  return targets;
}

function applyHardTargets(job, targets) {
  const next = deepClone(job);
  next.sysConstraints = next.sysConstraints && typeof next.sysConstraints === 'object' ? next.sysConstraints : {};
  if (Number(targets.power) > 0) next.sysConstraints.power = targets.power;
  if (Number(targets.area) > 0) next.sysConstraints.area = targets.area;
  if (Number(targets.cost) > 0) next.sysConstraints.cost = targets.cost;
  if (Number(targets.periodCycles) > 0 || Number(targets.latencyCycles) > 0) {
    next.constraints = Array.isArray(next.constraints) ? next.constraints : [];
    if (next.constraints.length === 0 && next.applications?.[0]) next.constraints.push({ appName: next.applications[0].name || 'App', period:0, latency:0 });
    if (next.constraints[0]) {
      if (Number(targets.periodCycles) > 0) next.constraints[0].period = targets.periodCycles;
      if (Number(targets.latencyCycles) > 0) next.constraints[0].latency = targets.latencyCycles;
    }
  }
  return next;
}

function primaryMetric(objective, summary, platform) {
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
    const candidateValue = primaryMetric(objective, candidateSummary, candidatePlatform);
    const baselineValue = primaryMetric(objective, baselineSummary, baselinePlatform);
    if (!Number.isFinite(candidateValue)) return -Infinity;
    if (Number.isFinite(baselineValue) && candidateValue >= baselineValue) return -Infinity;
    return -candidateValue;
  }
  let score = 0;
  for (const [baseline, candidate] of [[baselineSummary.minPeriod,candidateSummary.minPeriod],[baselineSummary.minPower,candidateSummary.minPower],[baselineSummary.minArea,candidateSummary.minArea],[baselineSummary.minCost,candidateSummary.minCost]]) {
    const improvement = improvementPct(baseline, candidate);
    if (improvement !== null) score += improvement;
  }
  const baseCores = totalCores(baselinePlatform), candidateCores = totalCores(candidatePlatform);
  if (baseCores > 0) score += ((baseCores - candidateCores) / baseCores) * 10;
  return score;
}

function deterministicCandidates(currentPlatform, objective) {
  const candidates = [];
  const baseline = validatePlatform(currentPlatform);
  baseline.processors.forEach((proc, index) => {
    const count = Math.max(1, Number(proc.count) || 1);
    if (['power','area','cost','cores','balanced'].includes(objective) && count > 1) {
      const platform = deepClone(baseline);
      platform.processors[index].count = count - 1;
      candidates.push({ platform, rationale:`Reduce ${proc.model} count from ${count} to ${count - 1}; native DSE will decide whether feasibility and the requested objective improve.`, expectedTradeoffs:['Fewer processing resources may increase period/latency.'], source:'deterministic' });
    }
    if (['period','balanced'].includes(objective)) {
      const platform = deepClone(baseline);
      platform.processors[index].count = count + 1;
      candidates.push({ platform, rationale:`Increase ${proc.model} count from ${count} to ${count + 1}; native DSE will verify whether period improves.`, expectedTradeoffs:['More processors can increase power, area, and cost.'], source:'deterministic' });
    }
  });
  return candidates;
}

function candidateKey(candidate) {
  return JSON.stringify({ processors:(candidate.platform?.processors || []).map(p => ({ model:p.model, count:p.count, modes:p.modes })), interconnects:candidate.platform?.interconnects || candidate.platform?.interconnect || [] });
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  return candidates.filter(candidate => {
    const key = candidateKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function aiCandidates(goal, currentPlatform, baselineResults, hardTargets, onLog) {
  const systemPrompt = `You are the ParetoCo architecture optimization planner. Propose candidates only; the real native solver decides feasibility and improvement.
Return ONLY JSON: {"candidates":[{"platform":<complete platform object>,"rationale":"short reason","expectedTradeoffs":["short item"]}]}.
Preserve processor model identifiers and mode names exactly; do not add/remove processor model types; hardTargets are immutable; never claim a candidate passed DSE.`;
  try {
    const result = await askFeatherlessJson(systemPrompt, JSON.stringify({ goal, hardTargets, currentPlatform, baselineResultTail:String(baselineResults || '').slice(-7000) }));
    const raw = Array.isArray(result.candidates) ? result.candidates : [];
    return raw.slice(0,3).map(candidate => ({ platform:validatePlatform(candidate.platform || candidate,currentPlatform), rationale:String(candidate.rationale || ''), expectedTradeoffs:Array.isArray(candidate.expectedTradeoffs) ? candidate.expectedTradeoffs.map(String) : [], source:'featherless' }));
  } catch (error) {
    onLog(`[Architecture Agent] Featherless proposal generation was unusable (${error.message}); continuing with deterministic native-verified candidates.`);
    return [];
  }
}

async function autoOptimizeAgent(messages, onLog = () => {}) {
  const context = extractContext(messages);
  const job = deepClone(context.currentJob);
  const goal = String(context.goal || 'Improve the architecture while preserving feasibility.');
  const baselineResults = String(context.baselineResults || '');
  const baselineSummary = summarizeNativeText(baselineResults);
  const objective = primaryObjective(goal);
  const hardTargets = deriveHardTargets(goal);
  if (hardTargets.unsupported) throw new Error(hardTargets.unsupported);

  onLog(`[Architecture Agent] Objective: ${objective}. Every candidate will be checked by native DSE.`);
  const ai = await aiCandidates(goal, job.platform, baselineResults, hardTargets, onLog);
  const deterministic = deterministicCandidates(job.platform, objective);
  const candidates = dedupeCandidates([...ai, ...deterministic]);
  if (candidates.length === 0) throw new Error('No safe architecture candidates could be generated without invalidating the existing WCET model.');

  const verified = [];
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    onLog(`[Architecture Agent] Native verification ${index + 1}/${candidates.length} (${candidate.source})...`);
    let trialJob = deepClone(job);
    trialJob.platform = candidate.platform;
    trialJob = applyHardTargets(trialJob, hardTargets);
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
      verified.push({ ...candidate, score, verification });
    } catch (err) {
      onLog(`[Architecture Agent] Candidate ${index + 1} native run failed: ${err.message}`);
    }
  }

  if (verified.length === 0) throw new Error('No generated architecture both passed native DSE and improved the requested objective while satisfying explicit targets. The current architecture was left unchanged.');
  verified.sort((a,b) => b.score - a.score);
  const best = verified[0];
  const baseValue = primaryMetric(objective, baselineSummary, job.platform);
  const candidateValue = primaryMetric(objective, best.verification.summary, best.platform);
  return {
    platform:best.platform,
    rationale:best.rationale,
    expectedTradeoffs:best.expectedTradeoffs,
    objective,
    hardTargets,
    improvementPct:improvementPct(baseValue,candidateValue),
    verification:{ native:true, solutionCount:best.verification.summary.solutionCount, metrics:best.verification.summary, outTxt:best.verification.result.outTxt || '', outCsv:best.verification.result.outCsv || '' }
  };
}

module.exports = { autoOptimizeAgent, validatePlatform, deriveHardTargets };
