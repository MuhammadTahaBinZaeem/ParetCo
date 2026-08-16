'use strict';

const { askFeatherlessJson } = require('./featherless');
const { runNativeDse } = require('./native_verify');

const MAX_NATIVE_TESTS = Math.max(6, Math.min(24, Number(process.env.PARETOCO_UNSAT_MAX_TESTS) || 16));
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

function normalizeCandidate(candidate, fallbackTitle = 'Repair candidate') {
  if (!candidate || typeof candidate !== 'object') return null;
  const patch = (Array.isArray(candidate.patch) ? candidate.patch : []).map(normalizePatchOp).filter(Boolean);
  if (patch.length === 0) return null;
  return {
    title: String(candidate.title || fallbackTitle),
    explanation: String(candidate.explanation || 'This change is tested by the native ParetoCo solver.'),
    patch
  };
}

function applyPatch(job, patch) {
  const next = deepClone(job);
  next.constraints = Array.isArray(next.constraints) ? next.constraints : [];
  next.sysConstraints = next.sysConstraints && typeof next.sysConstraints === 'object' ? next.sysConstraints : {};
  next.platform = next.platform && typeof next.platform === 'object' ? next.platform : { processors: [] };
  next.platform.processors = Array.isArray(next.platform.processors) ? next.platform.processors : [];

  for (const op of patch || []) {
    if (op.target === 'constraint') {
      let idx = Number.isInteger(op.index) ? op.index : -1;
      if (idx < 0 && op.appName) idx = next.constraints.findIndex(c => (c.appName || c.app_name) === op.appName);
      if (idx < 0 && next.constraints.length === 1) idx = 0;
      if (idx >= 0 && next.constraints[idx]) next.constraints[idx][op.field] = op.value;
    } else if (op.target === 'sysConstraint') {
      next.sysConstraints[op.field] = op.value;
      if (op.field === 'power') next.sysConstraints.maxPower = op.value;
      if (op.field === 'utilization') next.sysConstraints.maxUtil = op.value;
    } else if (op.target === 'processor') {
      let idx = Number.isInteger(op.index) ? op.index : -1;
      if (idx < 0 && op.model) idx = next.platform.processors.findIndex(p => p.model === op.model);
      if (idx < 0 && next.platform.processors.length === 1) idx = 0;
      if (idx >= 0 && next.platform.processors[idx]) next.platform.processors[idx].count = op.value;
    }
  }
  return next;
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

function activeIsolationProbes(job) {
  const probes = [];
  const constraints = Array.isArray(job.constraints) ? job.constraints : [];
  constraints.forEach((constraint, index) => {
    for (const field of ['period', 'latency']) {
      const current = Number(constraint[field]);
      if (!(current > 0)) continue;
      probes.push({
        field,
        current,
        title: `Temporarily remove ${field} bound`,
        patch: [{ target: 'constraint', index, appName: constraint.appName || constraint.app_name, field, value: 0 }]
      });
    }
  });

  const sys = job.sysConstraints || {};
  for (const field of ['power', 'area', 'cost', 'utilization', 'procsUsed']) {
    const current = Number(sys[field]);
    if (!(current > 0)) continue;
    probes.push({
      field,
      current,
      title: `Temporarily remove ${field} constraint`,
      patch: [{ target: 'sysConstraint', field, value: -1 }]
    });
  }
  return probes;
}

function measuredRepairFromProbe(probe, summary) {
  let value = null;
  let label = probe.field;
  if (probe.field === 'power' && Number.isFinite(summary.minPower)) value = Math.ceil(summary.minPower);
  else if (probe.field === 'area' && Number.isFinite(summary.minArea)) value = Math.ceil(summary.minArea);
  else if (probe.field === 'cost' && Number.isFinite(summary.minCost)) value = Math.ceil(summary.minCost);
  else if (probe.field === 'period' && Number.isFinite(summary.minPeriod)) value = Math.ceil(summary.minPeriod);
  else if (probe.field === 'utilization' && Number.isFinite(summary.maxUtilization)) value = Math.floor(summary.maxUtilization);

  if (!(value > 0)) return null;
  const originalOp = probe.patch[0];
  return {
    title: `Set ${label} constraint to ${value}`,
    explanation: `Removing the ${label} constraint made the real native model feasible. The unconstrained native run measured ${value} as the relevant boundary; this exact value is tested again before being offered.`,
    patch: [{ ...originalOp, value }]
  };
}

async function nativeIsolation(job, onLog, budget) {
  const verified = [];
  let tested = 0;
  for (const probe of activeIsolationProbes(job)) {
    if (tested >= budget || verified.length >= MAX_VERIFIED_OPTIONS) break;
    tested++;
    onLog(`[UNSAT Doctor] Isolation test ${tested}/${budget}: ${probe.title}`);
    try {
      const relaxed = await runNativeDse(applyPatch(job, probe.patch));
      if (!relaxed.ok || !relaxed.summary.feasible) continue;

      const measured = measuredRepairFromProbe(probe, relaxed.summary);
      if (measured && tested < budget) {
        tested++;
        onLog(`[UNSAT Doctor] Verifying measured boundary: ${measured.title}`);
        const exact = await runNativeDse(applyPatch(job, measured.patch));
        if (exact.ok && exact.summary.feasible) {
          verified.push({
            ...measured,
            verified: true,
            verificationEngine: 'native',
            verifiedSolutions: exact.summary.solutionCount,
            metrics: exact.summary,
            verifiedJob: applyPatch(job, measured.patch)
          });
          continue;
        }
      }

      verified.push({
        title: probe.title.replace('Temporarily ', ''),
        explanation: `The model became feasible only after removing this constraint in a real native run. A tighter single-number repair could not be verified within this bounded diagnostic pass.`,
        patch: probe.patch,
        verified: true,
        verificationEngine: 'native',
        verifiedSolutions: relaxed.summary.solutionCount,
        metrics: relaxed.summary,
        verifiedJob: applyPatch(job, probe.patch)
      });
    } catch (err) {
      onLog(`[UNSAT Doctor] Isolation test failed: ${err.message}`);
    }
  }
  return { verified, tested };
}

function systematicCandidates(job, broad = false) {
  const candidates = [];
  const multipliers = broad ? [2, 4, 8, 16, 32] : [1.25, 1.5, 2];
  const constraints = Array.isArray(job.constraints) ? job.constraints : [];

  constraints.forEach((constraint, index) => {
    for (const field of ['period', 'latency']) {
      const current = Number(constraint[field]);
      if (!(current > 0)) continue;
      for (const multiplier of multipliers) {
        const value = Math.max(current + 1, Math.ceil(current * multiplier));
        candidates.push({
          title: `Relax ${field} bound to ${value}`,
          explanation: `Tests a ${field} relaxation from ${current} to ${value} using the native solver.`,
          patch: [{ target: 'constraint', index, appName: constraint.appName || constraint.app_name, field, value }]
        });
      }
    }
  });

  const sys = job.sysConstraints || {};
  for (const field of ['power', 'area', 'cost']) {
    const current = Number(sys[field]);
    if (!(current > 0)) continue;
    for (const multiplier of multipliers) {
      const value = Math.max(current + 1, Math.ceil(current * multiplier));
      candidates.push({
        title: `Relax ${field} ceiling to ${value}`,
        explanation: `Tests a ${field} ceiling change from ${current} to ${value} with the native solver.`,
        patch: [{ target: 'sysConstraint', field, value }]
      });
    }
  }

  const util = Number(sys.utilization);
  if (util > 0) {
    for (const multiplier of [0.9, 0.75, 0.5, 0.25]) {
      const value = Math.max(1, Math.floor(util * multiplier));
      if (value < util) candidates.push({
        title: `Lower minimum utilization to ${value}%`,
        explanation: `Tests a lower minimum-utilization requirement (${util}% → ${value}%) with the native solver.`,
        patch: [{ target: 'sysConstraint', field: 'utilization', value }]
      });
    }
  }

  const processors = job.platform?.processors || [];
  processors.forEach((proc, index) => {
    const count = Math.max(1, Number(proc.count) || 1);
    for (const delta of broad ? [1, 2, 4, 8] : [1, 2]) {
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
  const systemPrompt = `You are the ParetoCo UNSAT repair planner. You propose hypotheses only; the native solver decides feasibility.
Return JSON only:
{"candidates":[{"title":"short name","explanation":"why it may help without claiming success","patch":[{"target":"constraint","index":0,"appName":"App","field":"period","value":100}]}]}
Allowed operations:
- constraint period or latency
- sysConstraint power, area, cost, utilization, procsUsed; -1 removes it
- processor count
Return at most 4 small candidates. Never invent solution counts and never use words like verified/feasible unless referring to the later native check.`;
  try {
    onLog('[UNSAT Doctor] Asking Featherless for additional repair hypotheses...');
    const result = await askFeatherlessJson(systemPrompt, JSON.stringify({
      currentJob: job,
      baselineResultTail: String(baselineResults || '').slice(-7000)
    }));
    return (Array.isArray(result.candidates) ? result.candidates : [])
      .map((candidate, index) => normalizeCandidate(candidate, `AI repair candidate ${index + 1}`))
      .filter(Boolean);
  } catch (err) {
    onLog(`[UNSAT Doctor] Featherless planning unavailable (${err.message}); continuing with native search.`);
    return [];
  }
}

async function verifyCandidates(job, candidates, onLog, budget) {
  const verified = [];
  let tested = 0;
  for (const candidate of dedupeCandidates(candidates)) {
    if (tested >= budget || verified.length >= MAX_VERIFIED_OPTIONS) break;
    tested++;
    onLog(`[UNSAT Doctor] Native candidate test ${tested}/${budget}: ${candidate.title}`);
    try {
      const trialJob = applyPatch(job, candidate.patch);
      const verification = await runNativeDse(trialJob);
      if (!verification.ok || !verification.summary.feasible) continue;
      verified.push({
        ...candidate,
        verified: true,
        verificationEngine: 'native',
        verifiedSolutions: verification.summary.solutionCount,
        metrics: verification.summary,
        verifiedJob: trialJob
      });
    } catch (err) {
      onLog(`[UNSAT Doctor] Candidate test failed: ${err.message}`);
    }
  }
  return { verified, tested };
}

async function analyzeUnsatAgent(messages, onLog = () => {}) {
  const context = extractContext(messages);
  const job = deepClone(context.currentJob);
  const baselineResults = context.baselineResults || '';

  onLog('[UNSAT Doctor] Re-running the current job with the native solver...');
  const baseline = await runNativeDse(job);
  if (baseline.ok && baseline.summary.feasible) {
    return {
      alreadyFeasible: true,
      options: [],
      baseline: baseline.summary,
      message: `The current job is already feasible (${baseline.summary.solutionCount} native solution(s)).`
    };
  }

  let remaining = MAX_NATIVE_TESTS;
  const isolated = await nativeIsolation(job, onLog, remaining);
  remaining -= isolated.tested;
  let verified = isolated.verified;

  if (verified.length < MAX_VERIFIED_OPTIONS && remaining > 0) {
    const ai = await aiCandidates(job, baselineResults, onLog);
    const first = await verifyCandidates(job, [...ai, ...systematicCandidates(job, false)], onLog, remaining);
    remaining -= first.tested;
    verified = [...verified, ...first.verified];
  }

  if (verified.length === 0 && remaining > 0) {
    const broad = await verifyCandidates(job, systematicCandidates(job, true), onLog, remaining);
    remaining -= broad.tested;
    verified = broad.verified;
  }

  const unique = [];
  const seen = new Set();
  for (const option of verified) {
    const key = JSON.stringify(option.patch);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(option);
    if (unique.length >= MAX_VERIFIED_OPTIONS) break;
  }

  const testedRuns = MAX_NATIVE_TESTS - remaining;
  return {
    options: unique,
    testedRuns,
    baseline: baseline.summary,
    message: unique.length
      ? `${unique.length} repair option(s) were verified by real native solver runs.`
      : `No tested single repair produced a native solution within ${testedRuns} bounded attempts. The conflict may require a multi-parameter change.`
  };
}

module.exports = { analyzeUnsatAgent, applyPatch };
