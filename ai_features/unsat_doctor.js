'use strict';

const { askFeatherlessJson } = require('./featherless');
const { runNativeDse } = require('./native_verify');

const MAX_NATIVE_TESTS = Math.max(4, Math.min(20, Number(process.env.PARETOCO_UNSAT_MAX_TESTS) || 12));
const MAX_VERIFIED_OPTIONS = 4;

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
  throw new Error('UNSAT Doctor requires the current DSE job context. Refresh the UI and try again.');
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizePatchOp(op) {
  if (!op || typeof op !== 'object') return null;
  const target = String(op.target || '');
  const field = String(op.field || '');
  const value = numberOrNull(op.value);
  if (value === null) return null;

  if (target === 'constraint' && ['period', 'latency'].includes(field)) {
    return {
      target,
      field,
      value: Math.max(0, Math.round(value)),
      appName: op.appName ? String(op.appName) : undefined,
      index: Number.isInteger(op.index) ? op.index : undefined
    };
  }

  if (target === 'sysConstraint' && ['power', 'area', 'cost', 'utilization', 'procsUsed'].includes(field)) {
    return { target, field, value: value > 0 ? Math.round(value) : -1 };
  }

  if (target === 'processor' && field === 'count') {
    return {
      target,
      field,
      value: Math.max(1, Math.round(value)),
      model: op.model ? String(op.model) : undefined,
      index: Number.isInteger(op.index) ? op.index : undefined
    };
  }

  return null;
}

function normalizeCandidate(candidate, fallbackTitle = 'Verified repair candidate') {
  if (!candidate || typeof candidate !== 'object') return null;
  const rawPatch = Array.isArray(candidate.patch) ? candidate.patch : [];
  const patch = rawPatch.map(normalizePatchOp).filter(Boolean);
  if (patch.length === 0) return null;
  return {
    title: String(candidate.title || fallbackTitle),
    explanation: String(candidate.explanation || 'This repair is tested against the native ParetoCo solver before being shown as feasible.'),
    patch
  };
}

function applyPatch(job, patch) {
  const next = deepClone(job);
  next.constraints = Array.isArray(next.constraints) ? next.constraints : [];
  next.sysConstraints = next.sysConstraints && typeof next.sysConstraints === 'object' ? next.sysConstraints : {};
  next.platform = next.platform && typeof next.platform === 'object' ? next.platform : { processors: [] };
  next.platform.processors = Array.isArray(next.platform.processors) ? next.platform.processors : [];

  for (const op of patch) {
    if (op.target === 'constraint') {
      let idx = Number.isInteger(op.index) ? op.index : -1;
      if (idx < 0 && op.appName) idx = next.constraints.findIndex(c => (c.appName || c.app_name) === op.appName);
      if (idx < 0 && next.constraints.length === 1) idx = 0;
      if (idx < 0 || !next.constraints[idx]) continue;
      next.constraints[idx][op.field] = op.value;
    } else if (op.target === 'sysConstraint') {
      next.sysConstraints[op.field] = op.value;
      if (op.field === 'power') next.sysConstraints.maxPower = op.value;
      if (op.field === 'utilization') next.sysConstraints.maxUtil = op.value;
    } else if (op.target === 'processor') {
      let idx = Number.isInteger(op.index) ? op.index : -1;
      if (idx < 0 && op.model) idx = next.platform.processors.findIndex(p => p.model === op.model);
      if (idx < 0 && next.platform.processors.length === 1) idx = 0;
      if (idx < 0 || !next.platform.processors[idx]) continue;
      next.platform.processors[idx].count = op.value;
    }
  }

  return next;
}

function systematicCandidates(job, broad = false) {
  const candidates = [];
  const multipliers = broad ? [1.5, 2, 3, 4] : [1.25, 1.5, 2];
  const constraints = Array.isArray(job.constraints) ? job.constraints : [];

  constraints.forEach((constraint, index) => {
    for (const field of ['period', 'latency']) {
      const current = Number(constraint[field]);
      if (!(current > 0)) continue;
      multipliers.forEach(multiplier => {
        const value = Math.max(current + 1, Math.ceil(current * multiplier));
        candidates.push({
          title: `Relax ${field} bound to ${value}`,
          explanation: `Tests a ${field} relaxation from ${current} to ${value} using the native solver.`,
          patch: [{ target: 'constraint', index, appName: constraint.appName || constraint.app_name, field, value }]
        });
      });
    }
  });

  const sys = job.sysConstraints || {};
  for (const field of ['power', 'area', 'cost']) {
    const current = Number(sys[field]);
    if (!(current > 0)) continue;
    multipliers.forEach(multiplier => {
      const value = Math.max(current + 1, Math.ceil(current * multiplier));
      candidates.push({
        title: `Relax ${field} ceiling to ${value}`,
        explanation: `Tests a ${field} ceiling change from ${current} to ${value} with the native solver.`,
        patch: [{ target: 'sysConstraint', field, value }]
      });
    });
  }

  const util = Number(sys.utilization);
  if (util > 0) {
    [0.9, 0.75, 0.5].forEach(multiplier => {
      const value = Math.max(1, Math.floor(util * multiplier));
      if (value < util) candidates.push({
        title: `Lower minimum utilization to ${value}%`,
        explanation: `Tests a lower minimum-utilization requirement (${util}% → ${value}%) with the native solver.`,
        patch: [{ target: 'sysConstraint', field: 'utilization', value }]
      });
    });
  }

  if (Number(sys.procsUsed) > 0) {
    candidates.push({
      title: 'Remove exact active-processor constraint',
      explanation: 'Tests whether the exact active-processor-count equality is causing the conflict.',
      patch: [{ target: 'sysConstraint', field: 'procsUsed', value: -1 }]
    });
  }

  const processors = job.platform?.processors || [];
  processors.forEach((proc, index) => {
    const count = Math.max(1, Number(proc.count) || 1);
    for (const delta of broad ? [1, 2, 4] : [1, 2]) {
      candidates.push({
        title: `Increase ${proc.model || `processor ${index + 1}`} cores to ${count + delta}`,
        explanation: `Tests ${count + delta} instances of ${proc.model || 'this processor model'} using the native solver.`,
        patch: [{ target: 'processor', index, model: proc.model, field: 'count', value: count + delta }]
      });
    }
  });

  return candidates;
}

async function aiCandidates(job, baselineResults, onLog) {
  const systemPrompt = `You are the ParetoCo UNSAT repair planner. You do NOT decide feasibility; the native solver will verify every proposal.
Return JSON only in this shape:
{
  "candidates": [
    {
      "title": "short repair name",
      "explanation": "why this may resolve the conflict without claiming it is feasible",
      "patch": [
        {"target":"constraint","index":0,"appName":"App","field":"period","value":100}
      ]
    }
  ]
}
Allowed patch operations only:
- constraint: field period or latency
- sysConstraint: field power, area, cost, utilization, or procsUsed; use value -1 to remove a system constraint
- processor: field count
Propose at most 5 small, minimally invasive candidates. Never invent a feasible-solution count and never state a candidate is verified.`;

  const userPrompt = JSON.stringify({
    currentJob: job,
    baselineResultTail: String(baselineResults || '').slice(-7000)
  });

  try {
    onLog('[UNSAT Doctor] Asking Featherless for repair hypotheses...');
    const result = await askFeatherlessJson(systemPrompt, userPrompt);
    return (Array.isArray(result.candidates) ? result.candidates : [])
      .map((candidate, index) => normalizeCandidate(candidate, `AI repair candidate ${index + 1}`))
      .filter(Boolean);
  } catch (err) {
    onLog(`[UNSAT Doctor] Featherless planning unavailable (${err.message}); continuing with native systematic search.`);
    return [];
  }
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    const normalized = normalizeCandidate(candidate);
    if (!normalized) continue;
    const key = JSON.stringify(normalized.patch);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

async function verifyCandidates(job, candidates, onLog, remainingBudget) {
  const verified = [];
  let tested = 0;

  for (const candidate of candidates) {
    if (tested >= remainingBudget || verified.length >= MAX_VERIFIED_OPTIONS) break;
    tested++;
    onLog(`[UNSAT Doctor] Native test ${tested}/${remainingBudget}: ${candidate.title}`);

    try {
      const trialJob = applyPatch(job, candidate.patch);
      const verification = await runNativeDse(trialJob);
      if (!verification.ok || !verification.summary.feasible) {
        onLog(`[UNSAT Doctor] Rejected: ${verification.summary.solutionCount} native solutions.`);
        continue;
      }

      onLog(`[UNSAT Doctor] VERIFIED: ${verification.summary.solutionCount} native solution(s).`);
      verified.push({
        ...candidate,
        verified: true,
        verificationEngine: 'native',
        verifiedSolutions: verification.summary.solutionCount,
        metrics: verification.summary,
        verifiedJob: trialJob
      });
    } catch (err) {
      onLog(`[UNSAT Doctor] Native test failed: ${err.message}`);
    }
  }

  return { verified, tested };
}

async function analyzeUnsatAgent(messages, onLog = () => {}) {
  const context = extractContext(messages);
  const job = deepClone(context.currentJob);
  const baselineResults = context.baselineResults || '';

  onLog('[UNSAT Doctor] Confirming the current job with the native solver...');
  const baseline = await runNativeDse(job);
  if (baseline.ok && baseline.summary.feasible) {
    return {
      alreadyFeasible: true,
      options: [],
      baseline: baseline.summary,
      message: `The current job is already feasible (${baseline.summary.solutionCount} native solution(s)).`
    };
  }

  const ai = await aiCandidates(job, baselineResults, onLog);
  let pool = dedupeCandidates([...ai, ...systematicCandidates(job, false)]);
  let first = await verifyCandidates(job, pool, onLog, MAX_NATIVE_TESTS);
  let verified = first.verified;
  let tested = first.tested;

  if (verified.length === 0 && tested < MAX_NATIVE_TESTS) {
    onLog('[UNSAT Doctor] No bounded repair verified yet; broadening the native search.');
    const broad = dedupeCandidates(systematicCandidates(job, true));
    const usedKeys = new Set(pool.map(c => JSON.stringify(c.patch)));
    pool = broad.filter(c => !usedKeys.has(JSON.stringify(c.patch)));
    const second = await verifyCandidates(job, pool, onLog, MAX_NATIVE_TESTS - tested);
    verified = second.verified;
    tested += second.tested;
  }

  return {
    options: verified,
    testedRuns: tested,
    baseline: baseline.summary,
    message: verified.length
      ? `${verified.length} repair option(s) were verified by real native solver runs.`
      : `No tested single repair produced a native solution within ${tested} bounded attempts. The conflict may require a multi-parameter change.`
  };
}

module.exports = { analyzeUnsatAgent, applyPatch };
