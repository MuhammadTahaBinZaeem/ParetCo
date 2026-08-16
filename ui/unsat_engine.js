/**
 * ParetoCo Unsat Doctor & Repair Engine (unsat_engine.js)
 * QuickXplain Minimal Unsatisfiable Core (MUC) Extraction, Slack Quantification, and Conflict-Directed Relaxation.
 */

(function(root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.UnsatEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  class QuickXplain {
    static isConsistent(constraintSubset, platform, wcets) {
      const procs = (platform && platform.processors) || [];
      const totalCores = procs.reduce((acc, p) => acc + (p.count || 1), 0);
      if (totalCores === 0) return false;

      const totalWorkload = (wcets || []).reduce((acc, w) => acc + (parseInt(w.wcet) || 10), 0);
      const minPeriodBound = Math.ceil(totalWorkload / totalCores);

      for (let i = 0; i < constraintSubset.length; i++) {
        const c = constraintSubset[i];
        if (c.type === 'PERIOD' && c.value < minPeriodBound) return false;
        if (c.type === 'POWER') {
          const minStaticPower = procs.reduce((acc, p) => acc + (((p.modes && p.modes[0] && p.modes[0].staticPower) || 2) * (p.count || 1)), 0);
          if (c.value < minStaticPower) return false;
        }
        if (c.type === 'MEMORY') {
          const totalMem = procs.reduce((acc, p) => acc + (((p.modes && p.modes[0] && p.modes[0].mem) || 4096) * (p.count || 1)), 0);
          if (c.value > totalMem) return false;
        }
      }
      return true;
    }

    static findMinimalUnsatCore(allConstraints, platform, wcets) {
      if (QuickXplain.isConsistent(allConstraints, platform, wcets)) {
        return { isFeasible: true, core: [] };
      }

      const qx = (background, current) => {
        if (current.length === 0 || !QuickXplain.isConsistent(background, platform, wcets)) {
          return [];
        }
        if (current.length === 1) {
          return current;
        }

        const k = Math.floor(current.length / 2);
        const c1 = current.slice(0, k);
        const c2 = current.slice(k);

        const delta2 = qx([...background, ...c1], c2);
        const delta1 = qx([...background, ...delta2], c1);

        return [...delta1, ...delta2];
      };

      const core = qx([], allConstraints);
      return {
        isFeasible: false,
        core: core.length > 0 ? core : allConstraints.slice(0, 1)
      };
    }
  }

  class SlackAnalyzer {
    static computeSlacks(platform, wcets, constraints) {
      const procs = (platform && platform.processors) || [];
      const totalCores = Math.max(1, procs.reduce((acc, p) => acc + (p.count || 1), 0));
      const totalWorkload = (wcets || []).reduce((acc, w) => acc + (parseInt(w.wcet) || 10), 0);
      const minPeriodBound = Math.ceil(totalWorkload / totalCores);

      const minStaticPower = procs.reduce((acc, p) => acc + (((p.modes && p.modes[0] && p.modes[0].staticPower) || 2) * (p.count || 1)), 0);
      const totalMem = procs.reduce((acc, p) => acc + (((p.modes && p.modes[0] && p.modes[0].mem) || 4096) * (p.count || 1)), 0);

      const slacks = [];

      (constraints || []).forEach(c => {
        if (c.period !== undefined && c.period !== null) {
          const pVal = parseInt(c.period, 10);
          const slack = pVal - minPeriodBound;
          slacks.push({
            constraint: `Period (${c.appName || 'App'})`,
            required: minPeriodBound,
            specified: pVal,
            slack,
            isViolated: slack < 0,
            unit: 'cycles'
          });
        }
      });

      if (platform && platform.sysPower !== undefined && platform.sysPower !== null) {
        const pwrVal = parseInt(platform.sysPower, 10);
        const pwrSlack = pwrVal - minStaticPower;
        slacks.push({
          constraint: 'System Power Ceiling',
          required: minStaticPower,
          specified: pwrVal,
          slack: pwrSlack,
          isViolated: pwrSlack < 0,
          unit: 'mW'
        });
      }

      return slacks;
    }

    static synthesizeRepairs(slacks, platform, wcets) {
      const repairs = [];
      slacks.forEach(s => {
        if (s.isViolated) {
          const deficit = Math.abs(s.slack);
          if (s.constraint.startsWith('Period')) {
            const recommended = s.specified + deficit + 5;
            repairs.push({
              type: 'RELAX_PERIOD',
              label: `Relax ${s.constraint} from ${s.specified} to >= ${recommended} ${s.unit}`,
              diff: deficit + 5,
              score: 95
            });
            repairs.push({
              type: 'SCALE_PROCESSORS',
              label: `Add 1 additional processor core to meet current period (${s.specified} ${s.unit})`,
              diff: 1,
              score: 85
            });
          } else if (s.constraint.includes('Power')) {
            const recommendedPwr = s.specified + deficit + 10;
            repairs.push({
              type: 'EXPAND_POWER_BUDGET',
              label: `Increase power ceiling from ${s.specified} to >= ${recommendedPwr} ${s.unit}`,
              diff: deficit + 10,
              score: 90
            });
          }
        }
      });
      return repairs;
    }
  }

  return {
    QuickXplain,
    SlackAnalyzer
  };
}));
