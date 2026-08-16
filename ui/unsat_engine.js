/**
 * ParetoCo local UNSAT precheck.
 *
 * This module intentionally does NOT claim to prove satisfiability or compute a
 * true minimal unsatisfiable core. The authoritative UNSAT Doctor lives on the
 * server and verifies every repair with the packaged native ParetoCo solver.
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

  function totalCores(platform) {
    return ((platform && platform.processors) || [])
      .reduce((sum, proc) => sum + Math.max(1, Number(proc.count) || 1), 0);
  }

  function workloadLowerBound(wcets, cores) {
    const workload = (wcets || []).reduce((sum, row) => sum + Math.max(0, Number(row.wcet) || 0), 0);
    return cores > 0 ? Math.ceil(workload / cores) : Infinity;
  }

  function minimumStaticPower(platform) {
    return ((platform && platform.processors) || []).reduce((sum, proc) => {
      const count = Math.max(1, Number(proc.count) || 1);
      const modes = Array.isArray(proc.modes) && proc.modes.length ? proc.modes : [{}];
      const minStatic = Math.min(...modes.map(mode => Math.max(0, Number(mode.staticPower) || 0)));
      return sum + count * minStatic;
    }, 0);
  }

  class LocalConstraintPrecheck {
    static analyze({ platform, wcets, constraints, sysConstraints } = {}) {
      const cores = totalCores(platform);
      const periodLowerBound = workloadLowerBound(wcets, cores);
      const staticPowerLowerBound = minimumStaticPower(platform);
      const findings = [];

      if (cores <= 0) {
        findings.push({
          kind: 'platform',
          severity: 'certain',
          message: 'The platform contains no processing cores.'
        });
      }

      for (const constraint of constraints || []) {
        const period = Number(constraint.period);
        if (Number.isFinite(period) && period > 0 && Number.isFinite(periodLowerBound) && period < periodLowerBound) {
          findings.push({
            kind: 'period-lower-bound',
            severity: 'necessary-bound',
            appName: constraint.appName || constraint.app_name || 'App',
            specified: period,
            lowerBound: periodLowerBound,
            message: `Period ${period} is below the coarse workload/core lower bound ${periodLowerBound}.`
          });
        }
      }

      const power = Number(sysConstraints && (sysConstraints.power ?? sysConstraints.maxPower));
      if (Number.isFinite(power) && power > 0 && power < staticPowerLowerBound) {
        findings.push({
          kind: 'power-lower-bound',
          severity: 'necessary-bound',
          specified: power,
          lowerBound: staticPowerLowerBound,
          message: `Power ceiling ${power} is below the minimum configured static processor power ${staticPowerLowerBound}.`
        });
      }

      return {
        authoritative: false,
        canProveFeasible: false,
        findings,
        assumptions: [
          'Period precheck uses only summed WCET divided by processor count.',
          'Power precheck uses only configured processor static power.',
          'Communication, scheduling, mapping, memory, and solver constraints are not modeled here.'
        ],
        recommendation: 'Use the server UNSAT Doctor for native-solver verification.'
      };
    }
  }

  // Compatibility surface for older callers. These aliases deliberately return
  // non-authoritative information rather than fabricated feasibility proofs.
  class QuickXplain {
    static isConsistent(constraintSubset, platform, wcets) {
      const findings = LocalConstraintPrecheck.analyze({
        platform,
        wcets,
        constraints: (constraintSubset || []).filter(c => c && (c.period !== undefined || c.appName)),
        sysConstraints: {}
      }).findings;
      return findings.length === 0 ? null : false;
    }

    static findMinimalUnsatCore(allConstraints, platform, wcets) {
      const analysis = LocalConstraintPrecheck.analyze({
        platform,
        wcets,
        constraints: allConstraints || [],
        sysConstraints: {}
      });
      return {
        isFeasible: null,
        core: [],
        authoritative: false,
        findings: analysis.findings,
        message: 'A true minimal UNSAT core requires native solver checks; use the server UNSAT Doctor.'
      };
    }
  }

  class SlackAnalyzer {
    static computeSlacks(platform, wcets, constraints, sysConstraints = {}) {
      const analysis = LocalConstraintPrecheck.analyze({ platform, wcets, constraints, sysConstraints });
      return analysis.findings.map(finding => ({
        constraint: finding.kind,
        specified: finding.specified ?? null,
        requiredLowerBound: finding.lowerBound ?? null,
        isViolated: true,
        authoritative: false,
        explanation: finding.message
      }));
    }

    static synthesizeRepairs() {
      return [];
    }
  }

  return {
    LocalConstraintPrecheck,
    QuickXplain,
    SlackAnalyzer
  };
}));
