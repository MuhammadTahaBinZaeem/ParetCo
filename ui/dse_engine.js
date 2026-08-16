/**
 * ParetoCo Continuous DSE Engine (dse_engine.js)
 * Semantic AST Diffing, Invalidation Dependency Graphs, Warm-Start Synthesis, and Exploration Branching.
 */

(function(root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DseEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  const MAX_SOLUTION_LIMIT = 200;
  const LIMIT_EXCEEDED_MSG = "200 solutions found, more possible stopping due to limit.";

  class InvalidationGraph {
    constructor() {
      this.nodes = new Map();
      this.edges = new Map();
    }
    registerParameter(paramName, level = 'LOW', affects = []) {
      this.nodes.set(paramName, { level, affects });
      this.edges.set(paramName, affects);
    }
    evaluateInvalidationCascade(changedParams) {
      const affectedSet = new Set();
      const queue = [...changedParams];
      let maxImpact = 'LOW';

      while (queue.length > 0) {
        const param = queue.shift();
        affectedSet.add(param);
        const node = this.nodes.get(param);
        if (node) {
          if (node.level === 'HIGH') maxImpact = 'HIGH';
          else if (node.level === 'MEDIUM' && maxImpact !== 'HIGH') maxImpact = 'MEDIUM';

          const outEdges = this.edges.get(param) || [];
          for (let i = 0; i < outEdges.length; i++) {
            const nextParam = outEdges[i];
            if (!affectedSet.has(nextParam)) {
              affectedSet.add(nextParam);
              queue.push(nextParam);
            }
          }
        }
      }
      return {
        impact: maxImpact,
        affectedParameters: Array.from(affectedSet),
        requiresFullRestart: maxImpact === 'HIGH'
      };
    }
  }

  class SemanticModelDiffer {
    static diffPlatforms(prevPlatform, nextPlatform) {
      const diffs = [];
      const prevProcs = (prevPlatform && prevPlatform.processors) || [];
      const nextProcs = (nextPlatform && nextPlatform.processors) || [];

      if (prevProcs.length !== nextProcs.length) {
        diffs.push({
          type: 'PROCESSOR_COUNT',
          impact: 'HIGH',
          desc: `Total processing units changed from ${prevProcs.length} to ${nextProcs.length}`
        });
      }

      const prevProcMap = new Map();
      prevProcs.forEach(p => prevProcMap.set(p.model, p));

      nextProcs.forEach(np => {
        const pp = prevProcMap.get(np.model);
        if (!pp) {
          diffs.push({ type: 'PROCESSOR_ADDED', impact: 'HIGH', desc: `New processor model added: ${np.model}` });
        } else {
          if (pp.count !== np.count) {
            diffs.push({ type: 'CORE_COUNT_CHANGED', impact: 'HIGH', desc: `Core count for ${np.model} changed from ${pp.count} to ${np.count}` });
          }
          const pMode = (pp.modes && pp.modes[0]) || {};
          const nMode = (np.modes && np.modes[0]) || {};
          if (pMode.dynPower !== nMode.dynPower || pMode.staticPower !== nMode.staticPower) {
            diffs.push({ type: 'POWER_PARAMS_CHANGED', impact: 'MEDIUM', desc: `Power characteristics updated for ${np.model}` });
          }
        }
      });
      return diffs;
    }

    static diffWorkloads(prevApps, nextApps) {
      const diffs = [];
      const pApps = prevApps || [];
      const nApps = nextApps || [];

      if (pApps.length !== nApps.length) {
        diffs.push({ type: 'APPLICATION_COUNT', impact: 'HIGH', desc: `Application graph count changed from ${pApps.length} to ${nApps.length}` });
      }

      const pAppMap = new Map();
      pApps.forEach(a => pAppMap.set(a.name, a));

      nApps.forEach(na => {
        const pa = pAppMap.get(na.name);
        if (!pa) {
          diffs.push({ type: 'APPLICATION_ADDED', impact: 'HIGH', desc: `New application graph added: ${na.name}` });
        } else {
          const pActors = pa.actors || [];
          const nActors = na.actors || [];
          if (pActors.length !== nActors.length) {
            diffs.push({ type: 'ACTOR_COUNT_CHANGED', impact: 'HIGH', desc: `Actor count for ${na.name} changed from ${pActors.length} to ${nActors.length}` });
          }
        }
      });
      return diffs;
    }

    static diffConstraints(prevConstraints, nextConstraints) {
      const diffs = [];
      const pConsts = prevConstraints || [];
      const nConsts = nextConstraints || [];

      const pMap = new Map();
      pConsts.forEach(c => pMap.set(c.appName, c));

      nConsts.forEach(nc => {
        const pc = pMap.get(nc.appName);
        if (!pc) {
          diffs.push({ type: 'CONSTRAINT_ADDED', impact: 'MEDIUM', desc: `New constraint for ${nc.appName}` });
        } else {
          if (pc.period !== nc.period) {
            diffs.push({ type: 'PERIOD_CONSTRAINT_CHANGED', impact: 'MEDIUM', desc: `Period constraint for ${nc.appName} changed from ${pc.period} to ${nc.period}` });
          }
          if (pc.latency !== nc.latency) {
            diffs.push({ type: 'LATENCY_CONSTRAINT_CHANGED', impact: 'MEDIUM', desc: `Latency constraint for ${nc.appName} changed from ${pc.latency} to ${nc.latency}` });
          }
        }
      });
      return diffs;
    }
  }

  class WarmStartSynthesizer {
    static generateSeedPool(previousSolutions, currentPlatform, currentWorkload) {
      if (!Array.isArray(previousSolutions) || previousSolutions.length === 0) {
        return { seeds: [], noGoods: [], strategy: 'COLD_START' };
      }

      const validSeeds = [];
      const seen = new Set();

      const totalActors = (currentWorkload || []).reduce((acc, a) => acc + ((a.actors && a.actors.length) || 0), 0);
      const totalCores = ((currentPlatform && currentPlatform.processors) || []).reduce((acc, p) => acc + (p.count || 1), 0);

      for (let i = 0; i < previousSolutions.length; i++) {
        if (validSeeds.length >= MAX_SOLUTION_LIMIT) break;
        const sol = previousSolutions[i];
        const mappingStr = sol['PE Mapping'] || sol.procMapping;
        if (!mappingStr) continue;

        const mappingArr = typeof mappingStr === 'string'
          ? mappingStr.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
          : (Array.isArray(mappingStr) ? mappingStr : []);

        const isCompatible = (totalActors === 0 || mappingArr.length === totalActors) &&
                             mappingArr.every(peIdx => peIdx < totalCores);

        const key = `${sol.period}_${sol.power}_${mappingArr.join(',')}`;
        if (isCompatible && !seen.has(key)) {
          seen.add(key);
          validSeeds.push({
            solutionIndex: i + 1,
            period: sol.period,
            power: sol.power,
            mapping: mappingArr,
            order: sol.Order || sol.order || ''
          });
        }
      }

      return {
        seeds: validSeeds,
        count: validSeeds.length,
        strategy: validSeeds.length > 0 ? 'WARM_START_HEURISTIC' : 'COLD_START'
      };
    }
  }

  class ExplorationBranchManager {
    constructor() {
      this.branches = new Map();
      this.branches.set('main', { name: 'main', history: [], head: null });
      this.activeBranch = 'main';
    }
    createBranch(branchName, fromBranch = 'main') {
      if (this.branches.has(branchName)) return false;
      const source = this.branches.get(fromBranch) || this.branches.get('main');
      this.branches.set(branchName, {
        name: branchName,
        history: [...source.history],
        head: source.head
      });
      return true;
    }
    commitRun(sessionData) {
      const branch = this.branches.get(this.activeBranch);
      if (!branch) return null;
      const node = {
        id: `commit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        timestamp: Date.now(),
        data: sessionData,
        parent: branch.head
      };
      branch.history.push(node);
      branch.head = node.id;
      return node;
    }
    switchBranch(branchName) {
      if (this.branches.has(branchName)) {
        this.activeBranch = branchName;
        return true;
      }
      return false;
    }
    getHistory() {
      const branch = this.branches.get(this.activeBranch);
      return (branch && branch.history) || [];
    }
  }

  return {
    InvalidationGraph,
    SemanticModelDiffer,
    WarmStartSynthesizer,
    ExplorationBranchManager,
    MAX_SOLUTION_LIMIT,
    LIMIT_EXCEEDED_MSG
  };
}));
