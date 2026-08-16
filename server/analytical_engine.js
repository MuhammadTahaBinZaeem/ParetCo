'use strict';

/**
 * Deterministic analytical fallback used only when native execution is optional.
 * This is deliberately labeled approximate and is never used when
 * PARETOCO_REQUIRE_NATIVE=true.
 */
function runAnalyticalDse(job) {
  const processors = Array.isArray(job?.platform?.processors) ? job.platform.processors : [];
  const totalCores = processors.reduce((sum, proc) => sum + Math.max(1, Number(proc.count) || 1), 0);
  const wcets = Array.isArray(job?.wcets) ? job.wcets : [];
  const totalWorkload = wcets.reduce((sum, row) => sum + Math.max(0, Number(row.wcet) || 0), 0);
  const basePeriod = Math.max(1, Math.ceil(totalWorkload / Math.max(1, totalCores)));
  const basePower = processors.reduce((sum, proc) => {
    const count = Math.max(1, Number(proc.count) || 1);
    const mode = proc.modes?.[0] || {};
    return sum + count * (Math.max(0, Number(mode.dynPower) || 0) + Math.max(0, Number(mode.staticPower) || 0));
  }, 0);
  const baseArea = processors.reduce((sum, proc) => sum + Math.max(1, Number(proc.count) || 1) * Math.max(0, Number(proc.modes?.[0]?.area) || 0), 0);
  const baseCost = processors.reduce((sum, proc) => sum + Math.max(1, Number(proc.count) || 1) * Math.max(0, Number(proc.modes?.[0]?.monetary) || 0), 0);

  const periodBound = Math.min(...(job.constraints || []).map(c => Number(c.period) > 0 ? Number(c.period) : Infinity), Infinity);
  const maxPower = Number(job.sysConstraints?.power) > 0 ? Number(job.sysConstraints.power) : Infinity;
  const maxArea = Number(job.sysConstraints?.area) > 0 ? Number(job.sysConstraints.area) : Infinity;
  const maxCost = Number(job.sysConstraints?.cost) > 0 ? Number(job.sysConstraints.cost) : Infinity;
  const minUtil = Number(job.sysConstraints?.utilization) > 0 ? Number(job.sysConstraints.utilization) : -Infinity;
  const exactProcs = Number(job.sysConstraints?.procsUsed) > 0 ? Number(job.sysConstraints.procsUsed) : null;
  const util = Math.min(100, Math.round((totalWorkload / Math.max(1, basePeriod * totalCores)) * 100));

  const feasible = basePeriod <= periodBound && basePower <= maxPower && baseArea <= maxArea && baseCost <= maxCost && util >= minUtil && (exactProcs === null || exactProcs === totalCores);
  if (!feasible) {
    const outTxt = `ParetoCo Analytical Estimate\n0 solutions found\n`;
    return { success: true, approximate: true, engine: 'ParetoCo Analytical Estimate', outTxt, outCsv: 'solution,period,power,area,cost,utilization\n', solutions: [] };
  }

  const outTxt = [
    'ParetoCo Analytical Estimate',
    '*** Solution number: 1 ***',
    `Period: {${basePeriod}}`,
    `Sys utilization: ${util}`,
    `sys power: ${basePower}`,
    `sys area: ${baseArea}`,
    `sys cost: ${baseCost}`,
    '1 solutions found',
    ''
  ].join('\n');
  const outCsv = `solution,period,power,area,cost,utilization\n1,${basePeriod},${basePower},${baseArea},${baseCost},${util}\n`;
  return {
    success: true,
    approximate: true,
    engine: 'ParetoCo Analytical Estimate',
    outTxt,
    outCsv,
    solutions: [{ solutionNumber: 1, period: basePeriod, power: basePower, area: baseArea, cost: baseCost, utilization: util }]
  };
}

module.exports = { runAnalyticalDse };
