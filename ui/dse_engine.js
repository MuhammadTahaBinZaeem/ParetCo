/**
 * ParetoCo DSE History Utilities
 *
 * Provides semantic model diffing, invalidation analysis, compatible prior-
 * solution caching, and exploration history branching. It does NOT inject
 * warm-start seeds into the packaged native solver.
 */
(function(root, factory) {
  if (typeof define === 'function' && define.amd) define([], factory);
  else if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DseEngine = factory();
}(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  const MAX_SOLUTION_LIMIT = 200;
  const LIMIT_EXCEEDED_MSG = '200 solutions found, more possible stopping due to limit.';

  class InvalidationGraph {
    constructor() {
      this.nodes = new Map();
      this.edges = new Map();
    }

    registerParameter(paramName, level = 'LOW', affects = []) {
      this.nodes.set(paramName, { level, affects: [...affects] });
      this.edges.set(paramName, [...affects]);
    }

    evaluateInvalidationCascade(changedParams) {
      const affected = new Set();
      const queue = [...(changedParams || [])];
      let impact = 'LOW';
      while (queue.length) {
        const parameter = queue.shift();
        if (affected.has(parameter)) continue;
        affected.add(parameter);
        const node = this.nodes.get(parameter);
        if (!node) continue;
        if (node.level === 'HIGH') impact = 'HIGH';
        else if (node.level === 'MEDIUM' && impact !== 'HIGH') impact = 'MEDIUM';
        for (const next of this.edges.get(parameter) || []) if (!affected.has(next)) queue.push(next);
      }
      return {
        impact,
        affectedParameters: [...affected],
        requiresFullRestart: impact === 'HIGH'
      };
    }
  }

  class SemanticModelDiffer {
    static diffPlatforms(previous, next) {
      const diffs = [];
      const before = previous?.processors || [];
      const after = next?.processors || [];
      if (before.length !== after.length) {
        diffs.push({ type: 'PROCESSOR_TYPE_COUNT', impact: 'HIGH', desc: `Processor model count changed from ${before.length} to ${after.length}.` });
      }
      const byModel = new Map(before.map(proc => [proc.model, proc]));
      for (const proc of after) {
        const old = byModel.get(proc.model);
        if (!old) {
          diffs.push({ type: 'PROCESSOR_ADDED', impact: 'HIGH', desc: `Processor model added: ${proc.model}.` });
          continue;
        }
        if (Number(old.count) !== Number(proc.count)) diffs.push({ type: 'CORE_COUNT', impact: 'HIGH', desc: `${proc.model} count changed from ${old.count} to ${proc.count}.` });
        const oldModes = JSON.stringify(old.modes || []);
        const newModes = JSON.stringify(proc.modes || []);
        if (oldModes !== newModes) diffs.push({ type: 'PROCESSOR_MODE', impact: 'MEDIUM', desc: `${proc.model} operating-mode properties changed.` });
      }
      return diffs;
    }

    static diffWorkloads(previous, next) {
      const diffs = [];
      const before = previous || [];
      const after = next || [];
      if (before.length !== after.length) diffs.push({ type: 'APPLICATION_COUNT', impact: 'HIGH', desc: `Application count changed from ${before.length} to ${after.length}.` });
      const byName = new Map(before.map(app => [app.name, app]));
      for (const app of after) {
        const old = byName.get(app.name);
        if (!old) {
          diffs.push({ type: 'APPLICATION_ADDED', impact: 'HIGH', desc: `Application added: ${app.name}.` });
          continue;
        }
        if (JSON.stringify(old.actors || []) !== JSON.stringify(app.actors || [])) diffs.push({ type: 'ACTORS_CHANGED', impact: 'HIGH', desc: `${app.name} actors changed.` });
        if (JSON.stringify(old.channels || []) !== JSON.stringify(app.channels || [])) diffs.push({ type: 'CHANNELS_CHANGED', impact: 'HIGH', desc: `${app.name} channels changed.` });
      }
      return diffs;
    }

    static diffConstraints(previous, next) {
      const diffs = [];
      const before = new Map((previous || []).map(constraint => [constraint.appName || constraint.app_name, constraint]));
      for (const constraint of next || []) {
        const name = constraint.appName || constraint.app_name;
        const old = before.get(name);
        if (!old) {
          diffs.push({ type: 'CONSTRAINT_ADDED', impact: 'MEDIUM', desc: `Constraint added for ${name}.` });
          continue;
        }
        if (Number(old.period) !== Number(constraint.period)) diffs.push({ type: 'PERIOD_CHANGED', impact: 'MEDIUM', desc: `${name} period changed from ${old.period} to ${constraint.period}.` });
        if (Number(old.latency) !== Number(constraint.latency)) diffs.push({ type: 'LATENCY_CHANGED', impact: 'MEDIUM', desc: `${name} latency changed from ${old.latency} to ${constraint.latency}.` });
      }
      return diffs;
    }
  }

  class PriorSolutionCache {
    /**
     * Select previously observed mappings that are still structurally compatible.
     * These records are for comparison/reuse in the UI only; they are not passed
     * into the native solver as search seeds.
     */
    static selectCompatible(previousSolutions, currentPlatform, currentWorkload) {
      const totalActors = (currentWorkload || []).reduce((sum, app) => sum + (app.actors?.length || 0), 0);
      const totalCores = (currentPlatform?.processors || []).reduce((sum, proc) => sum + Math.max(1, Number(proc.count) || 1), 0);
      const compatible = [];
      const seen = new Set();

      for (const solution of previousSolutions || []) {
        if (compatible.length >= MAX_SOLUTION_LIMIT) break;
        const raw = solution['PE Mapping'] ?? solution.procMapping;
        if (raw == null) continue;
        const mapping = Array.isArray(raw)
          ? raw.map(Number).filter(Number.isInteger)
          : String(raw).split(/[,\s]+/).map(Number).filter(Number.isInteger);
        if (totalActors && mapping.length !== totalActors) continue;
        if (mapping.some(index => index < 0 || index >= totalCores)) continue;
        const key = mapping.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        compatible.push({
          period: Number(solution._period ?? solution.period ?? solution.Period) || null,
          power: Number(solution._power ?? solution.power) || null,
          mapping,
          source: 'previous-native-result'
        });
      }
      return { entries: compatible, count: compatible.length, purpose: 'comparison-cache', injectedIntoNativeSolver: false };
    }

    // Compatibility for older callers. The result explicitly says it is not a native seed pool.
    static generateSeedPool(previousSolutions, currentPlatform, currentWorkload) {
      const result = this.selectCompatible(previousSolutions, currentPlatform, currentWorkload);
      return {
        seeds: result.entries,
        count: result.count,
        strategy: result.count ? 'PRIOR_SOLUTION_CACHE' : 'EMPTY_CACHE',
        injectedIntoNativeSolver: false
      };
    }
  }

  class ExplorationBranchManager {
    constructor() {
      this.branches = new Map([['main', { name: 'main', history: [], head: null }]]);
      this.activeBranch = 'main';
      this.sequence = 0;
    }

    createBranch(name, from = 'main') {
      if (!name || this.branches.has(name)) return false;
      const source = this.branches.get(from) || this.branches.get('main');
      this.branches.set(name, { name, history: [...source.history], head: source.head });
      return true;
    }

    commitRun(sessionData) {
      const branch = this.branches.get(this.activeBranch);
      if (!branch) return null;
      this.sequence += 1;
      const node = {
        id: `run_${Date.now()}_${this.sequence}`,
        timestamp: Date.now(),
        data: sessionData,
        parent: branch.head
      };
      branch.history.push(node);
      branch.head = node.id;
      return node;
    }

    switchBranch(name) {
      if (!this.branches.has(name)) return false;
      this.activeBranch = name;
      return true;
    }

    getHistory() {
      return [...(this.branches.get(this.activeBranch)?.history || [])];
    }
  }

  return {
    InvalidationGraph,
    SemanticModelDiffer,
    PriorSolutionCache,
    // Deprecated compatibility alias; no native warm-start injection occurs.
    WarmStartSynthesizer: PriorSolutionCache,
    ExplorationBranchManager,
    MAX_SOLUTION_LIMIT,
    LIMIT_EXCEEDED_MSG
  };
}));
