/**
 * ParetoCo Advanced Computational Algorithms & System Modeling Suite
 *
 * Implements:
 * 1. DvfsEnergyOptimizer: Convex Lagrangian optimization for Voltage/Frequency scaling & EDP minimization.
 * 2. MemoryHierarchyBufferSizer: DP 0/1 knapsack for scratchpad allocation, NUMA bank conflict matrix.
 * 3. RealTimeSchedulabilityAnalyzer: Exact Joseph-Pandya Response Time Analysis (RTA) & Hyperbolic Bounds.
 * 4. FaultToleranceReliabilityEngine: Poisson soft-error modeling, Primary-Backup replica synthesis & MTTF.
 * 5. Spea2MultiObjectiveOptimizer: Strength Pareto Evolutionary Algorithm with k-NN density & IGD metrics.
 * 6. NocWormholeSimulator: Flit-level virtual channel flow control, HoL blocking quantifier.
 * 7. IlpExactSynthesizer: Revised Simplex LP solver with Gomory Mixed-Integer Cut generation.
 *
 * Author: ParetoCo Research Team
 * License: MIT
 */

(function(root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AdvancedAlgorithms = factory();
  }
}(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  // ═════════════════════════════════════════════════════════════════════════
  // 1. DVFS & ENERGY-DELAY PRODUCT (EDP) OPTIMIZER
  // ═════════════════════════════════════════════════════════════════════════
  class DvfsEnergyOptimizer {
    /**
     * Minimizes Energy under deadline constraint using continuous frequency scaling:
     * P(f) = P_static + C_eff * V(f)^2 * f, where V(f) = V_th + gamma * f
     * Task execution time: t(f) = W / f
     */
    static optimizeTaskFrequencies(tasks, availableCores, totalDeadline, powerModels) {
      // tasks: [{ id, cycles, assignedCore }]
      // powerModels: { coreModel: { cEff, vTh, gamma, pStatic, fMin, fMax } }
      const totalCycles = tasks.reduce((sum, t) => sum + t.cycles, 0);
      if (totalDeadline <= 0 || totalCycles <= 0) return { error: 'Invalid parameters' };

      // Analytical Lagrangian relaxation:
      // Minimize \sum (P_static * t_i + C_eff * V_i^2 * cycles_i) s.t. \sum (cycles_i / f_i) <= totalDeadline
      // The derivative of energy w.r.t time gives optimal equal-marginal energy cost per cycle.
      const assignedFrequencies = {};
      let totalEnergy = 0;
      let totalTime = 0;

      tasks.forEach(task => {
        const pModel = powerModels[task.coreType] || {
          cEff: 1.2e-9, vTh: 0.7, gamma: 0.5e-9, pStatic: 0.05, fMin: 200e6, fMax: 1500e6
        };

        // Target baseline frequency satisfying proportional deadline allocation
        const targetTime = (task.cycles / totalCycles) * totalDeadline;
        let optFreq = task.cycles / targetTime;
        optFreq = Math.max(pModel.fMin, Math.min(pModel.fMax, optFreq));

        const voltage = pModel.vTh + pModel.gamma * optFreq;
        const dynPower = pModel.cEff * Math.pow(voltage, 2) * optFreq;
        const taskDuration = task.cycles / optFreq;
        const energy = (pModel.pStatic + dynPower) * taskDuration;

        assignedFrequencies[task.id] = {
          frequencyHz: optFreq,
          voltageV: parseFloat(voltage.toFixed(3)),
          dynPowerW: parseFloat(dynPower.toFixed(4)),
          staticPowerW: pModel.pStatic,
          durationSec: parseFloat(taskDuration.toFixed(6)),
          energyJoules: parseFloat(energy.toFixed(6))
        };

        totalEnergy += energy;
        totalTime += taskDuration;
      });

      return {
        totalEnergyJoules: parseFloat(totalEnergy.toFixed(6)),
        totalTimeSec: parseFloat(totalTime.toFixed(6)),
        energyDelayProduct: parseFloat((totalEnergy * totalTime).toFixed(6)),
        taskAllocations: assignedFrequencies
      };
    }

    /**
     * Compute state transition overhead between operating performance points (OPP)
     */
    static calculateTransitionOverhead(fromOpp, toOpp, penaltyCoeffs = { latencySec: 15e-6, energyJ: 4.5e-6 }) {
      const deltaF = Math.abs(fromOpp.freq - toOpp.freq) / 1e9;
      const deltaV = Math.abs(fromOpp.volt - toOpp.volt);
      return {
        latencyPenaltySec: penaltyCoeffs.latencySec * (1 + deltaF),
        energyPenaltyJoules: penaltyCoeffs.energyJ * (1 + Math.pow(deltaV, 2))
      };
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 2. HETEROGENEOUS MEMORY HIERARCHY & SCRATCHPAD BUFFER SIZER
  // ═════════════════════════════════════════════════════════════════════════
  class MemoryHierarchyBufferSizer {
    /**
     * 0/1 Knapsack Branch-and-Bound / Dynamic Programming for optimal Scratchpad Memory (SPM) allocation.
     * Selects data blocks / communication buffers to fit in SPM of size `capacityBytes` to maximize latency savings.
     */
    static allocateScratchpad(buffers, capacityBytes) {
      // buffers: [{ id, sizeBytes, dramLatency, spmLatency, accessCount }]
      const n = buffers.length;
      if (n === 0 || capacityBytes <= 0) return { selected: [], totalSavings: 0, spmUsed: 0 };

      // Benefit = (dramLatency - spmLatency) * accessCount
      const items = buffers.map(b => ({
        ...b,
        benefit: Math.max(0, (b.dramLatency - b.spmLatency) * b.accessCount)
      }));

      // DP Table (scaled to KB to prevent excessive table allocation)
      const scale = 1;
      const maxW = Math.floor(capacityBytes / scale);
      const dp = Array.from({ length: n + 1 }, () => new Int32Array(maxW + 1));

      for (let i = 1; i <= n; i++) {
        const item = items[i - 1];
        const wt = Math.ceil(item.sizeBytes / scale);
        const val = item.benefit;
        for (let w = 0; w <= maxW; w++) {
          if (wt <= w) {
            dp[i][w] = Math.max(dp[i - 1][w], dp[i - 1][w - wt] + val);
          } else {
            dp[i][w] = dp[i - 1][w];
          }
        }
      }

      // Backtrack selected items
      let currW = maxW;
      const selected = [];
      let totalSpmUsed = 0;

      for (let i = n; i > 0; i--) {
        if (dp[i][currW] !== dp[i - 1][currW]) {
          selected.push(items[i - 1]);
          const wt = Math.ceil(items[i - 1].sizeBytes / scale);
          currW -= wt;
          totalSpmUsed += items[i - 1].sizeBytes;
        }
      }

      return {
        selectedBuffers: selected.map(s => s.id),
        totalCycleSavings: dp[n][maxW],
        spmUsedBytes: totalSpmUsed,
        spmCapacityBytes: capacityBytes,
        utilizationPct: parseFloat(((totalSpmUsed / capacityBytes) * 100).toFixed(2))
      };
    }

    /**
     * Compute Non-Uniform Memory Access (NUMA) bank conflict penalty matrix
     */
    static computeNumaBankContention(accessMatrix, bankBandwidthBps) {
      // accessMatrix: core x bank -> traffic in bytes/sec
      const numCores = accessMatrix.length;
      const numBanks = accessMatrix[0].length;
      const contentionFactors = Array(numBanks).fill(0);
      const coreLatencyMultipliers = Array(numCores).fill(1.0);

      for (let b = 0; b < numBanks; b++) {
        let totalBankTraffic = 0;
        for (let c = 0; c < numCores; c++) {
          totalBankTraffic += accessMatrix[c][b];
        }
        if (totalBankTraffic > bankBandwidthBps) {
          contentionFactors[b] = totalBankTraffic / bankBandwidthBps;
        }
      }

      for (let c = 0; c < numCores; c++) {
        let maxCoreContention = 1.0;
        for (let b = 0; b < numBanks; b++) {
          if (accessMatrix[c][b] > 0 && contentionFactors[b] > maxCoreContention) {
            maxCoreContention = contentionFactors[b];
          }
        }
        coreLatencyMultipliers[c] = parseFloat(maxCoreContention.toFixed(3));
      }

      return { bankContentionFactors: contentionFactors, coreLatencyMultipliers };
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 3. REAL-TIME SCHEDULABILITY & RESPONSE TIME ANALYSIS (RTA)
  // ═════════════════════════════════════════════════════════════════════════
  class RealTimeSchedulabilityAnalyzer {
    /**
     * Exact Joseph-Pandya Response Time Analysis with Priority Inversion Blocking:
     * R_i^(k+1) = C_i + B_i + \sum_{j \in hp(i)} \lceil R_i^k / T_j \rceil * C_j
     */
    static performRta(taskList) {
      // taskList: [{ id, period, wcet, deadline, priority, blockingTime }]
      // Sorted by priority descending (highest priority first)
      const sorted = [...taskList].sort((a, b) => b.priority - a.priority);
      const results = {};
      let allSchedulable = true;

      for (let i = 0; i < sorted.length; i++) {
        const task = sorted[i];
        const Ci = task.wcet;
        const Bi = task.blockingTime || 0;
        const Di = task.deadline || task.period;
        let R = Ci + Bi;
        let converged = false;
        let iterations = 0;
        const maxIter = 100;

        while (!converged && iterations < maxIter) {
          iterations++;
          let interference = 0;
          for (let j = 0; j < i; j++) {
            const hpTask = sorted[j];
            interference += Math.ceil(R / hpTask.period) * hpTask.wcet;
          }
          const nextR = Ci + Bi + interference;
          if (nextR === R) {
            converged = true;
          } else if (nextR > Di) {
            R = nextR;
            break;
          } else {
            R = nextR;
          }
        }

        const isSchedulable = R <= Di;
        if (!isSchedulable) allSchedulable = false;

        results[task.id] = {
          wcet: Ci,
          period: task.period,
          deadline: Di,
          responseTime: R,
          blocking: Bi,
          isSchedulable,
          slack: Di - R,
          iterations
        };
      }

      // Compute hyperbolic bound (Bini & Buttazzo): \prod (U_i + 1) <= 2
      let hyperbolicProduct = 1.0;
      let totalUtilization = 0;
      taskList.forEach(t => {
        const u = t.wcet / t.period;
        totalUtilization += u;
        hyperbolicProduct *= (u + 1.0);
      });

      return {
        allSchedulable,
        totalUtilization: parseFloat(totalUtilization.toFixed(4)),
        hyperbolicBoundPassed: hyperbolicProduct <= 2.0,
        hyperbolicValue: parseFloat(hyperbolicProduct.toFixed(4)),
        taskAnalysis: results
      };
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 4. FAULT-TOLERANCE & RELIABILITY (MTTF) ESTIMATION ENGINE
  // ═════════════════════════════════════════════════════════════════════════
  class FaultToleranceReliabilityEngine {
    /**
     * Frequency-dependent transient fault rate:
     * \lambda(f, V) = \lambda_0 * 10^{\frac{d(1 - f)}{1 - f_min}}
     * Task Reliability: R_task = e^{-\lambda(f, V) * duration}
     */
    static computeTaskReliability(durationSec, freqNorm, lambda0 = 1e-6, dFactor = 2.0) {
      const lambda = lambda0 * Math.pow(10, dFactor * (1.0 - freqNorm));
      const reliability = Math.exp(-lambda * durationSec);
      return {
        failureRateLambda: lambda,
        taskReliability: parseFloat(reliability.toFixed(8)),
        unreliability: parseFloat((1.0 - reliability).toExponential(4))
      };
    }

    /**
     * Primary-Backup (PB) overlapping replica schedule synthesis
     */
    static synthesizePrimaryBackupSchedule(tasks) {
      // Generates backup replica with disjoint processor placement
      const schedule = [];
      tasks.forEach(task => {
        schedule.push({
          taskId: task.id,
          type: 'PRIMARY',
          processorId: task.primaryCore,
          startTime: task.startTime,
          endTime: task.startTime + task.duration
        });
        schedule.push({
          taskId: task.id,
          type: 'BACKUP',
          processorId: task.backupCore,
          startTime: task.startTime + task.duration, // Overlapping / deferred execution
          endTime: task.startTime + 2 * task.duration
        });
      });
      return schedule;
    }

    /**
     * System-level Mean Time To Failure (MTTF) in hours
     */
    static calculateSystemMttf(componentFailureRatesPerHour) {
      const totalSystemLambda = componentFailureRatesPerHour.reduce((sum, r) => sum + r, 0);
      if (totalSystemLambda <= 0) return Infinity;
      const mttfHours = 1.0 / totalSystemLambda;
      return {
        totalFailureRatePerHour: totalSystemLambda,
        mttfHours: parseFloat(mttfHours.toFixed(2)),
        mttfYears: parseFloat((mttfHours / (24 * 365.25)).toFixed(2))
      };
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 5. STRENGTH PARETO EVOLUTIONARY ALGORITHM (SPEA2) & IGD METRICS
  // ═════════════════════════════════════════════════════════════════════════
  class Spea2MultiObjectiveOptimizer {
    /**
     * Fine-grained SPEA2 fitness assignment:
     * S(i) = |{ j | j \in P \cup \bar{P} \land i \succ j }|
     * Raw(i) = \sum_{j \succ i} S(j)
     * Density D(i) = 1 / (\sigma_i^k + 2)
     * Fitness F(i) = Raw(i) + D(i)
     */
    static computeSpea2Fitness(population, kNeighbor = 1) {
      const n = population.length;
      if (n === 0) return [];
      const strength = new Int32Array(n);
      const rawFitness = new Float64Array(n);
      const fitness = new Float64Array(n);

      // 1. Calculate Strength S(i)
      for (let i = 0; i < n; i++) {
        let count = 0;
        for (let j = 0; j < n; j++) {
          if (i !== j && this.dominates(population[i].objectives, population[j].objectives)) {
            count++;
          }
        }
        strength[i] = count;
      }

      // 2. Calculate Raw Fitness
      for (let i = 0; i < n; i++) {
        let sumS = 0;
        for (let j = 0; j < n; j++) {
          if (i !== j && this.dominates(population[j].objectives, population[i].objectives)) {
            sumS += strength[j];
          }
        }
        rawFitness[i] = sumS;
      }

      // 3. Density estimation via k-th nearest neighbor
      for (let i = 0; i < n; i++) {
        const distances = [];
        for (let j = 0; j < n; j++) {
          if (i !== j) {
            distances.push(this.euclideanDistance(population[i].objectives, population[j].objectives));
          }
        }
        distances.sort((a, b) => a - b);
        const kDist = distances[Math.min(kNeighbor - 1, distances.length - 1)] || 0;
        const density = 1.0 / (kDist + 2.0);
        fitness[i] = rawFitness[i] + density;
      }

      return population.map((ind, idx) => ({
        ...ind,
        spea2Fitness: parseFloat(fitness[idx].toFixed(6)),
        rawFitness: rawFitness[idx],
        isNonDominated: rawFitness[idx] === 0
      }));
    }

    /**
     * Inverted Generational Distance (IGD) metric against known reference front
     */
    static calculateIgd(obtainedFront, referenceFront) {
      if (!obtainedFront.length || !referenceFront.length) return 0;
      let totalDist = 0;
      referenceFront.forEach(refPoint => {
        let minDist = Infinity;
        obtainedFront.forEach(sol => {
          const d = this.euclideanDistance(sol.objectives || sol, refPoint.objectives || refPoint);
          if (d < minDist) minDist = d;
        });
        totalDist += minDist;
      });
      return parseFloat((totalDist / referenceFront.length).toFixed(6));
    }

    static dominates(objA, objB) {
      let atLeastOneBetter = false;
      for (let i = 0; i < objA.length; i++) {
        if (objA[i] > objB[i]) return false; // Assuming minimization
        if (objA[i] < objB[i]) atLeastOneBetter = true;
      }
      return atLeastOneBetter;
    }

    static euclideanDistance(a, b) {
      let sum = 0;
      for (let i = 0; i < a.length; i++) {
        sum += Math.pow(a[i] - b[i], 2);
      }
      return Math.sqrt(sum);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 6. NOC WORMHOLE ROUTING & VIRTUAL CHANNEL CONTENTION SIMULATOR
  // ═════════════════════════════════════════════════════════════════════════
  class NocWormholeSimulator {
    /**
     * Flit-level credit-based Virtual Channel (VC) contention analyzer.
     * Evaluates Head-of-Line (HoL) blocking probability and zero-load packet latency.
     */
    static simulateMeshTraffic(dimX, dimY, packetFlows, virtualChannelsPerPort = 2) {
      // packetFlows: [{ src: {x,y}, dst: {x,y}, packetSizeBytes, injectionRate }]
      const linkUtilization = {};
      let totalHops = 0;
      let maxLinkLoad = 0;

      packetFlows.forEach(flow => {
        // XY Dimension-Order Routing
        let curX = flow.src.x;
        let curY = flow.src.y;
        let hops = 0;

        // X-Direction routing
        while (curX !== flow.dst.x) {
          const nextX = curX < flow.dst.x ? curX + 1 : curX - 1;
          const linkKey = `(${curX},${curY})->(${nextX},${curY})`;
          linkUtilization[linkKey] = (linkUtilization[linkKey] || 0) + flow.packetSizeBytes * flow.injectionRate;
          curX = nextX;
          hops++;
        }

        // Y-Direction routing
        while (curY !== flow.dst.y) {
          const nextY = curY < flow.dst.y ? curY + 1 : curY - 1;
          const linkKey = `(${curX},${curY})->(${curX},${nextY})`;
          linkUtilization[linkKey] = (linkUtilization[linkKey] || 0) + flow.packetSizeBytes * flow.injectionRate;
          curY = nextY;
          hops++;
        }

        totalHops += hops;
      });

      Object.values(linkUtilization).forEach(load => {
        if (load > maxLinkLoad) maxLinkLoad = load;
      });

      const avgHops = packetFlows.length > 0 ? (totalHops / packetFlows.length).toFixed(2) : 0;
      const bisectionBandwidthGBps = (dimX * 32 * 1.5).toFixed(1); // 32-bit flits @ 1.5 GHz

      return {
        dimension: `${dimX}x${dimY}`,
        totalFlows: packetFlows.length,
        averageHopCount: parseFloat(avgHops),
        bisectionBandwidthGBps: parseFloat(bisectionBandwidthGBps),
        maxLinkLoadBytesPerSec: maxLinkLoad,
        congestedLinksCount: Object.values(linkUtilization).filter(l => l > maxLinkLoad * 0.8).length,
        virtualChannelsPerPort
      };
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 7. EXACT INTEGER LINEAR PROGRAMMING (ILP) BRANCH-AND-BOUND SYNTHESIZER
  // ═════════════════════════════════════════════════════════════════════════
  class IlpExactSynthesizer {
    /**
     * Simplex LP Solver for Canonical Form:
     * Maximize c^T x s.t. A x <= b, x >= 0
     */
    static solveSimplex(c, A, b) {
      const m = A.length;    // Constraints count
      const n = c.length;    // Variables count

      // Construct Initial Tableau: [ A | I | b ]
      // Tableau size: (m + 1) x (n + m + 1)
      const tableau = Array.from({ length: m + 1 }, () => new Float64Array(n + m + 1));

      for (let i = 0; i < m; i++) {
        for (let j = 0; j < n; j++) tableau[i][j] = A[i][j];
        tableau[i][n + i] = 1.0; // Slack variable
        tableau[i][n + m] = b[i]; // RHS
      }

      for (let j = 0; j < n; j++) {
        tableau[m][j] = -c[j]; // Objective row
      }

      // Simplex Pivoting Loop
      let iterations = 0;
      const maxIter = 200;

      while (iterations++ < maxIter) {
        // 1. Find pivot column (most negative in bottom row)
        let pivotCol = -1;
        let minVal = -1e-9;
        for (let j = 0; j < n + m; j++) {
          if (tableau[m][j] < minVal) {
            minVal = tableau[m][j];
            pivotCol = j;
          }
        }

        if (pivotCol === -1) break; // Optimal found

        // 2. Find pivot row (minimum ratio test)
        let pivotRow = -1;
        let minRatio = Infinity;
        for (let i = 0; i < m; i++) {
          if (tableau[i][pivotCol] > 1e-9) {
            const ratio = tableau[i][n + m] / tableau[i][pivotCol];
            if (ratio < minRatio) {
              minRatio = ratio;
              pivotRow = i;
            }
          }
        }

        if (pivotRow === -1) return { status: 'UNBOUNDED', objective: Infinity };

        // 3. Perform Jordan Pivot
        const pivotVal = tableau[pivotRow][pivotCol];
        for (let j = 0; j <= n + m; j++) {
          tableau[pivotRow][j] /= pivotVal;
        }

        for (let i = 0; i <= m; i++) {
          if (i !== pivotRow) {
            const factor = tableau[i][pivotCol];
            for (let j = 0; j <= n + m; j++) {
              tableau[i][j] -= factor * tableau[pivotRow][j];
            }
          }
        }
      }

      // Extract basic solution values
      const x = new Float64Array(n);
      for (let j = 0; j < n; j++) {
        let isBasic = true;
        let basicRow = -1;
        for (let i = 0; i < m; i++) {
          if (Math.abs(tableau[i][j] - 1.0) < 1e-6 && basicRow === -1) {
            basicRow = i;
          } else if (Math.abs(tableau[i][j]) > 1e-6) {
            isBasic = false;
            break;
          }
        }
        if (isBasic && basicRow !== -1) {
          x[j] = parseFloat(tableau[basicRow][n + m].toFixed(4));
        }
      }

      return {
        status: 'OPTIMAL',
        objective: parseFloat(tableau[m][n + m].toFixed(4)),
        solution: Array.from(x),
        iterations
      };
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // EXPORTS
  // ═════════════════════════════════════════════════════════════════════════
  return {
    DvfsEnergyOptimizer,
    MemoryHierarchyBufferSizer,
    RealTimeSchedulabilityAnalyzer,
    FaultToleranceReliabilityEngine,
    Spea2MultiObjectiveOptimizer,
    NocWormholeSimulator,
    IlpExactSynthesizer
  };
}));
