/**
 * ParetoCo Advanced Computational Algorithms & System Modeling Suite
 *
 * Implemented algorithms:
 * 1. DVFS energy/delay frequency allocation.
 * 2. Scratchpad allocation via 0/1 dynamic programming and NUMA contention analysis.
 * 3. Fixed-priority response-time analysis and hyperbolic schedulability bound.
 * 4. Reliability/MTTF and primary-backup schedule calculations.
 * 5. SPEA2 fitness, density, dominance and IGD metrics.
 * 6. Deterministic XY-routing NoC traffic/load analysis.
 * 7. Revised Simplex solver for continuous canonical linear programs.
 *
 * Important: this file does NOT claim to implement Gomory cuts or a complete
 * mixed-integer/ILP branch-and-bound solver. Integer design decisions are handled
 * by ParetoCo's native constraint solver, not by the JavaScript Simplex helper.
 */
(function(root, factory) {
  if (typeof define === 'function' && define.amd) define([], factory);
  else if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AdvancedAlgorithms = factory();
}(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  class DvfsEnergyOptimizer {
    static optimizeTaskFrequencies(tasks, availableCores, totalDeadline, powerModels = {}) {
      const totalCycles = (tasks || []).reduce((sum, task) => sum + Math.max(0, Number(task.cycles) || 0), 0);
      if (!(totalDeadline > 0) || !(totalCycles > 0)) return { error: 'Invalid parameters' };
      const allocations = {};
      let totalEnergy = 0;
      let totalTime = 0;

      for (const task of tasks || []) {
        const model = powerModels[task.coreType] || { cEff: 1.2e-9, vTh: 0.7, gamma: 0.5e-9, pStatic: 0.05, fMin: 200e6, fMax: 1500e6 };
        const cycles = Math.max(0, Number(task.cycles) || 0);
        const targetTime = (cycles / totalCycles) * totalDeadline;
        let frequency = targetTime > 0 ? cycles / targetTime : model.fMax;
        frequency = Math.max(model.fMin, Math.min(model.fMax, frequency));
        const voltage = model.vTh + model.gamma * frequency;
        const dynamicPower = model.cEff * voltage * voltage * frequency;
        const duration = cycles / frequency;
        const energy = (model.pStatic + dynamicPower) * duration;
        allocations[task.id] = {
          frequencyHz: frequency,
          voltageV: Number(voltage.toFixed(3)),
          dynPowerW: Number(dynamicPower.toFixed(4)),
          staticPowerW: model.pStatic,
          durationSec: Number(duration.toFixed(6)),
          energyJoules: Number(energy.toFixed(6))
        };
        totalEnergy += energy;
        totalTime += duration;
      }

      return {
        totalEnergyJoules: Number(totalEnergy.toFixed(6)),
        totalTimeSec: Number(totalTime.toFixed(6)),
        energyDelayProduct: Number((totalEnergy * totalTime).toFixed(6)),
        taskAllocations: allocations
      };
    }

    static calculateTransitionOverhead(fromOpp, toOpp, penaltyCoeffs = { latencySec: 15e-6, energyJ: 4.5e-6 }) {
      const deltaF = Math.abs(Number(fromOpp.freq) - Number(toOpp.freq)) / 1e9;
      const deltaV = Math.abs(Number(fromOpp.volt) - Number(toOpp.volt));
      return {
        latencyPenaltySec: penaltyCoeffs.latencySec * (1 + deltaF),
        energyPenaltyJoules: penaltyCoeffs.energyJ * (1 + deltaV * deltaV)
      };
    }
  }

  class MemoryHierarchyBufferSizer {
    static allocateScratchpad(buffers, capacityBytes) {
      const items = (buffers || []).map(buffer => ({
        ...buffer,
        benefit: Math.max(0, (Number(buffer.dramLatency) - Number(buffer.spmLatency)) * Number(buffer.accessCount || 0))
      }));
      const capacity = Math.max(0, Math.floor(Number(capacityBytes) || 0));
      if (!items.length || !capacity) return { selectedBuffers: [], totalCycleSavings: 0, spmUsedBytes: 0, spmCapacityBytes: capacity, utilizationPct: 0 };

      const dp = Array.from({ length: items.length + 1 }, () => new Float64Array(capacity + 1));
      for (let i = 1; i <= items.length; i++) {
        const weight = Math.max(1, Math.ceil(Number(items[i - 1].sizeBytes) || 1));
        const value = items[i - 1].benefit;
        for (let w = 0; w <= capacity; w++) {
          dp[i][w] = weight <= w ? Math.max(dp[i - 1][w], dp[i - 1][w - weight] + value) : dp[i - 1][w];
        }
      }

      const selected = [];
      let used = 0;
      let w = capacity;
      for (let i = items.length; i > 0; i--) {
        if (Math.abs(dp[i][w] - dp[i - 1][w]) > 1e-9) {
          selected.push(items[i - 1]);
          const weight = Math.max(1, Math.ceil(Number(items[i - 1].sizeBytes) || 1));
          used += Number(items[i - 1].sizeBytes) || 0;
          w -= weight;
        }
      }
      return {
        selectedBuffers: selected.map(item => item.id),
        totalCycleSavings: dp[items.length][capacity],
        spmUsedBytes: used,
        spmCapacityBytes: capacity,
        utilizationPct: capacity ? Number(((used / capacity) * 100).toFixed(2)) : 0
      };
    }

    static computeNumaBankContention(accessMatrix, bankBandwidthBps) {
      if (!Array.isArray(accessMatrix) || !accessMatrix.length || !Array.isArray(accessMatrix[0])) return { bankContentionFactors: [], coreLatencyMultipliers: [] };
      const numBanks = accessMatrix[0].length;
      const factors = Array(numBanks).fill(0);
      for (let bank = 0; bank < numBanks; bank++) {
        const traffic = accessMatrix.reduce((sum, row) => sum + (Number(row[bank]) || 0), 0);
        factors[bank] = traffic > bankBandwidthBps ? traffic / bankBandwidthBps : 0;
      }
      const multipliers = accessMatrix.map(row => {
        let max = 1;
        row.forEach((traffic, bank) => { if (traffic > 0 && factors[bank] > max) max = factors[bank]; });
        return Number(max.toFixed(3));
      });
      return { bankContentionFactors: factors, coreLatencyMultipliers: multipliers };
    }
  }

  class RealTimeSchedulabilityAnalyzer {
    static performRta(taskList) {
      const sorted = [...(taskList || [])].sort((a, b) => Number(b.priority) - Number(a.priority));
      const results = {};
      let allSchedulable = true;
      for (let i = 0; i < sorted.length; i++) {
        const task = sorted[i];
        const execution = Number(task.wcet) || 0;
        const blocking = Number(task.blockingTime) || 0;
        const deadline = Number(task.deadline || task.period) || 0;
        let response = execution + blocking;
        let iterations = 0;
        while (iterations++ < 100) {
          let interference = 0;
          for (let j = 0; j < i; j++) {
            const hp = sorted[j];
            interference += Math.ceil(response / Number(hp.period)) * Number(hp.wcet);
          }
          const next = execution + blocking + interference;
          if (next === response || next > deadline) { response = next; break; }
          response = next;
        }
        const schedulable = response <= deadline;
        allSchedulable &&= schedulable;
        results[task.id] = { wcet: execution, period: task.period, deadline, responseTime: response, blocking, isSchedulable: schedulable, slack: deadline - response, iterations };
      }
      let hyperbolic = 1;
      let utilization = 0;
      for (const task of taskList || []) {
        const u = Number(task.wcet) / Number(task.period);
        if (Number.isFinite(u)) { utilization += u; hyperbolic *= 1 + u; }
      }
      return {
        allSchedulable,
        totalUtilization: Number(utilization.toFixed(4)),
        hyperbolicBoundPassed: hyperbolic <= 2,
        hyperbolicValue: Number(hyperbolic.toFixed(4)),
        taskAnalysis: results
      };
    }
  }

  class FaultToleranceReliabilityEngine {
    static computeTaskReliability(durationSec, freqNorm, lambda0 = 1e-6, dFactor = 2) {
      const lambda = lambda0 * Math.pow(10, dFactor * (1 - freqNorm));
      const reliability = Math.exp(-lambda * durationSec);
      return { failureRateLambda: lambda, taskReliability: Number(reliability.toFixed(8)), unreliability: Number((1 - reliability).toExponential(4)) };
    }

    static synthesizePrimaryBackupSchedule(tasks) {
      return (tasks || []).flatMap(task => [
        { taskId: task.id, type: 'PRIMARY', processorId: task.primaryCore, startTime: task.startTime, endTime: task.startTime + task.duration },
        { taskId: task.id, type: 'BACKUP', processorId: task.backupCore, startTime: task.startTime + task.duration, endTime: task.startTime + 2 * task.duration }
      ]);
    }

    static calculateSystemMttf(componentFailureRatesPerHour) {
      const lambda = (componentFailureRatesPerHour || []).reduce((sum, value) => sum + Number(value || 0), 0);
      if (lambda <= 0) return Infinity;
      const hours = 1 / lambda;
      return { totalFailureRatePerHour: lambda, mttfHours: Number(hours.toFixed(2)), mttfYears: Number((hours / (24 * 365.25)).toFixed(2)) };
    }
  }

  class Spea2MultiObjectiveOptimizer {
    static dominates(a, b) {
      let better = false;
      for (let i = 0; i < a.length; i++) {
        if (a[i] > b[i]) return false;
        if (a[i] < b[i]) better = true;
      }
      return better;
    }

    static euclideanDistance(a, b) {
      return Math.sqrt(a.reduce((sum, value, index) => sum + Math.pow(value - b[index], 2), 0));
    }

    static computeSpea2Fitness(population, kNeighbor = 1) {
      const n = population?.length || 0;
      if (!n) return [];
      const strength = new Int32Array(n);
      const raw = new Float64Array(n);
      const fitness = new Float64Array(n);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j && this.dominates(population[i].objectives, population[j].objectives)) strength[i]++;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j && this.dominates(population[j].objectives, population[i].objectives)) raw[i] += strength[j];
      for (let i = 0; i < n; i++) {
        const distances = [];
        for (let j = 0; j < n; j++) if (i !== j) distances.push(this.euclideanDistance(population[i].objectives, population[j].objectives));
        distances.sort((a, b) => a - b);
        const kth = distances[Math.min(Math.max(0, kNeighbor - 1), distances.length - 1)] || 0;
        fitness[i] = raw[i] + 1 / (kth + 2);
      }
      return population.map((individual, index) => ({ ...individual, spea2Fitness: Number(fitness[index].toFixed(6)), rawFitness: raw[index], isNonDominated: raw[index] === 0 }));
    }

    static calculateIgd(obtainedFront, referenceFront) {
      if (!obtainedFront?.length || !referenceFront?.length) return 0;
      const total = referenceFront.reduce((sum, ref) => {
        const point = ref.objectives || ref;
        const minDistance = Math.min(...obtainedFront.map(sol => this.euclideanDistance(sol.objectives || sol, point)));
        return sum + minDistance;
      }, 0);
      return Number((total / referenceFront.length).toFixed(6));
    }
  }

  class NocWormholeSimulator {
    static simulateMeshTraffic(dimX, dimY, packetFlows, virtualChannelsPerPort = 2) {
      const linkUtilization = {};
      let totalHops = 0;
      for (const flow of packetFlows || []) {
        let x = flow.src.x;
        let y = flow.src.y;
        let hops = 0;
        while (x !== flow.dst.x) {
          const nx = x < flow.dst.x ? x + 1 : x - 1;
          const key = `(${x},${y})->(${nx},${y})`;
          linkUtilization[key] = (linkUtilization[key] || 0) + flow.packetSizeBytes * flow.injectionRate;
          x = nx; hops++;
        }
        while (y !== flow.dst.y) {
          const ny = y < flow.dst.y ? y + 1 : y - 1;
          const key = `(${x},${y})->(${x},${ny})`;
          linkUtilization[key] = (linkUtilization[key] || 0) + flow.packetSizeBytes * flow.injectionRate;
          y = ny; hops++;
        }
        totalHops += hops;
      }
      const loads = Object.values(linkUtilization);
      const maxLinkLoad = loads.length ? Math.max(...loads) : 0;
      return {
        dimension: `${dimX}x${dimY}`,
        totalFlows: packetFlows?.length || 0,
        averageHopCount: packetFlows?.length ? Number((totalHops / packetFlows.length).toFixed(2)) : 0,
        bisectionBandwidthGBps: Number((dimX * 32 * 1.5).toFixed(1)),
        maxLinkLoadBytesPerSec: maxLinkLoad,
        congestedLinksCount: loads.filter(load => maxLinkLoad > 0 && load > maxLinkLoad * 0.8).length,
        virtualChannelsPerPort
      };
    }
  }

  class LinearProgrammingSimplexSolver {
    /** Solve max c^T x subject to A x <= b and x >= 0. Continuous LP only. */
    static solveSimplex(c, A, b) {
      const m = A.length;
      const n = c.length;
      if (b.some(value => Number(value) < 0)) return { status: 'UNSUPPORTED_INITIAL_BASIS', objective: null, solution: [] };
      const tableau = Array.from({ length: m + 1 }, () => new Float64Array(n + m + 1));
      for (let i = 0; i < m; i++) {
        for (let j = 0; j < n; j++) tableau[i][j] = Number(A[i][j]) || 0;
        tableau[i][n + i] = 1;
        tableau[i][n + m] = Number(b[i]) || 0;
      }
      for (let j = 0; j < n; j++) tableau[m][j] = -(Number(c[j]) || 0);

      let iterations = 0;
      while (iterations++ < 200) {
        let pivotCol = -1;
        let mostNegative = -1e-9;
        for (let j = 0; j < n + m; j++) {
          if (tableau[m][j] < mostNegative) { mostNegative = tableau[m][j]; pivotCol = j; }
        }
        if (pivotCol === -1) break;

        let pivotRow = -1;
        let ratio = Infinity;
        for (let i = 0; i < m; i++) {
          if (tableau[i][pivotCol] > 1e-9) {
            const candidate = tableau[i][n + m] / tableau[i][pivotCol];
            if (candidate < ratio) { ratio = candidate; pivotRow = i; }
          }
        }
        if (pivotRow === -1) return { status: 'UNBOUNDED', objective: Infinity, solution: [] };

        const pivot = tableau[pivotRow][pivotCol];
        for (let j = 0; j <= n + m; j++) tableau[pivotRow][j] /= pivot;
        for (let i = 0; i <= m; i++) {
          if (i === pivotRow) continue;
          const factor = tableau[i][pivotCol];
          for (let j = 0; j <= n + m; j++) tableau[i][j] -= factor * tableau[pivotRow][j];
        }
      }

      const solution = Array(n).fill(0);
      for (let j = 0; j < n; j++) {
        let row = -1;
        let basic = true;
        for (let i = 0; i < m; i++) {
          if (Math.abs(tableau[i][j] - 1) < 1e-6 && row === -1) row = i;
          else if (Math.abs(tableau[i][j]) > 1e-6) { basic = false; break; }
        }
        if (basic && row !== -1) solution[j] = Number(tableau[row][n + m].toFixed(4));
      }
      return { status: 'OPTIMAL', objective: Number(tableau[m][n + m].toFixed(4)), solution, iterations };
    }
  }

  return {
    DvfsEnergyOptimizer,
    MemoryHierarchyBufferSizer,
    RealTimeSchedulabilityAnalyzer,
    FaultToleranceReliabilityEngine,
    Spea2MultiObjectiveOptimizer,
    NocWormholeSimulator,
    LinearProgrammingSimplexSolver,
    // Backward-compatible alias; deprecated because this helper is not a full ILP solver.
    IlpExactSynthesizer: LinearProgrammingSimplexSolver
  };
}));
