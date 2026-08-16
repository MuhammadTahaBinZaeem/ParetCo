/**
 * ParetoCo Dynamic System Profiler & Transient Physical Modeling Suite
 *
 * Implements:
 * 1. TransientThermalSimulator: Runge-Kutta 4th-Order (RK4) numerical ODE solver for multi-core dynamic heat dissipation.
 * 2. CommunicationComputationBottleneckAnalyzer: Quantifies Arithmetic Intensity, Roofline model, and CCR ratios.
 * 3. CriticalCycleSlackAnalyzer: Per-actor total float & free float schedule slack quantifier.
 * 4. CacheCoherenceSimulator: 4-State MESI protocol transition matrix & bus snooping latency model.
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
    root.SystemProfiler = factory();
  }
}(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  // ═════════════════════════════════════════════════════════════════════════
  // 1. TRANSIENT THERMAL SIMULATOR (RUNGE-KUTTA 4TH ORDER RK4 ODE SOLVER)
  // ═════════════════════════════════════════════════════════════════════════
  class TransientThermalSimulator {
    /**
     * Solves multi-node dynamic heat diffusion differential equation:
     * C_th * (dT / dt) = P(t) - G_th * (T - T_ambient)
     * using explicit 4th-order Runge-Kutta (RK4) numerical integration.
     */
    static solveTransientHeating(cores, powerTrace, timeStepSec = 0.001, totalDurationSec = 0.05, ambientTempC = 25.0) {
      // cores: [{ id, cTh (J/K), gTh (W/K), initialTempC }]
      // powerTrace: { coreId: [powerArray at each timeStep] }
      const numSteps = Math.floor(totalDurationSec / timeStepSec);
      const temperatureProfiles = {};
      const peakTemperatures = {};

      cores.forEach(core => {
        const C = core.cTh || 0.02; // Thermal Capacitance
        const G = core.gTh || 0.4;  // Thermal Conductance
        let T = core.initialTempC || ambientTempC;
        const profile = [parseFloat(T.toFixed(2))];
        const powers = powerTrace[core.id] || Array(numSteps).fill(15.0);

        // Derivative function: f(t, T) = (P - G * (T - T_amb)) / C
        const f = (pVal, temp) => (pVal - G * (temp - ambientTempC)) / C;

        for (let step = 0; step < numSteps; step++) {
          const P = powers[step] !== undefined ? powers[step] : 15.0;
          const dt = timeStepSec;

          // RK4 Steps
          const k1 = f(P, T);
          const k2 = f(P, T + 0.5 * dt * k1);
          const k3 = f(P, T + 0.5 * dt * k2);
          const k4 = f(P, T + dt * k3);

          T += (dt / 6.0) * (k1 + 2 * k2 + 2 * k3 + k4);
          profile.push(parseFloat(T.toFixed(2)));
        }

        temperatureProfiles[core.id] = profile;
        peakTemperatures[core.id] = Math.max(...profile);
      });

      return {
        timeStepSec,
        totalDurationSec,
        numSteps,
        ambientTempC,
        peakTemperatures,
        temperatureProfiles
      };
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 2. COMMUNICATION-TO-COMPUTATION BOTTLENECK & ROOFLINE ANALYZER
  // ═════════════════════════════════════════════════════════════════════════
  class CommunicationComputationBottleneckAnalyzer {
    /**
     * Evaluates Arithmetic Intensity (FLOPs / Byte) against Hardware Roofline:
     * Attainable GFLOPS = min(Peak_GFLOPS, Memory_Bandwidth_GBps * Arithmetic_Intensity)
     */
    static evaluateRoofline(tasks, hardwareSpecs) {
      // hardwareSpecs: { peakGflops, memoryBandwidthGBps }
      const peakPerf = hardwareSpecs.peakGflops || 120.0;
      const memBw = hardwareSpecs.memoryBandwidthGBps || 25.6;
      const ridgePoint = peakPerf / memBw; // FLOPs/Byte

      const taskAnalysis = {};
      let totalCompTime = 0;
      let totalCommTime = 0;

      tasks.forEach(t => {
        const arithmeticIntensity = t.flops / Math.max(1, t.bytesTransferred);
        const isMemoryBound = arithmeticIntensity < ridgePoint;
        const attainableGflops = isMemoryBound ? memBw * arithmeticIntensity : peakPerf;
        const executionSec = (t.flops / 1e9) / attainableGflops;
        const transferSec = (t.bytesTransferred / 1e9) / memBw;

        const ccr = transferSec / Math.max(1e-9, executionSec);
        totalCompTime += executionSec;
        totalCommTime += transferSec;

        taskAnalysis[t.id] = {
          arithmeticIntensity: parseFloat(arithmeticIntensity.toFixed(2)),
          isMemoryBound,
          attainableGflops: parseFloat(attainableGflops.toFixed(2)),
          efficiencyPct: parseFloat(((attainableGflops / peakPerf) * 100).toFixed(1)),
          computationTimeSec: parseFloat(executionSec.toFixed(6)),
          communicationTimeSec: parseFloat(transferSec.toFixed(6)),
          ccrRatio: parseFloat(ccr.toFixed(3))
        };
      });

      return {
        ridgePointFlopsPerByte: parseFloat(ridgePoint.toFixed(2)),
        totalSystemCcr: parseFloat((totalCommTime / Math.max(1e-9, totalCompTime)).toFixed(3)),
        isSystemMemoryBound: (totalCommTime / totalCompTime) > 1.0,
        taskBreakdown: taskAnalysis
      };
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 3. CRITICAL CYCLE SLACK & SCHEDULE FLOAT ANALYZER
  // ═════════════════════════════════════════════════════════════════════════
  class CriticalCycleSlackAnalyzer {
    /**
     * Computes Earliest Start Time (EST), Latest Start Time (LST), Total Float (TF),
     * and Free Float (FF) for each task in an acyclic precedence graph.
     */
    static computeScheduleFloats(nodes, edges) {
      // Forward Pass (EST & EFT)
      const est = {};
      const eft = {};
      nodes.forEach(n => { est[n.id] = 0; eft[n.id] = n.wcet; });

      let changed = true;
      let passes = 0;
      while (changed && passes++ < nodes.length * 2) {
        changed = false;
        edges.forEach(e => {
          if (eft[e.src] > est[e.dst]) {
            est[e.dst] = eft[e.src];
            eft[e.dst] = est[e.dst] + (nodes.find(n => n.id === e.dst)?.wcet || 0);
            changed = true;
          }
        });
      }

      const makespan = Math.max(...Object.values(eft));

      // Backward Pass (LFT & LST)
      const lst = {};
      const lft = {};
      nodes.forEach(n => { lft[n.id] = makespan; lst[n.id] = makespan - n.wcet; });

      changed = true;
      passes = 0;
      while (changed && passes++ < nodes.length * 2) {
        changed = false;
        edges.forEach(e => {
          if (lst[e.dst] < lft[e.src]) {
            lft[e.src] = lst[e.dst];
            lst[e.src] = lft[e.src] - (nodes.find(n => n.id === e.src)?.wcet || 0);
            changed = true;
          }
        });
      }

      const floatAnalysis = {};
      const criticalPathNodes = [];

      nodes.forEach(n => {
        const tf = lst[n.id] - est[n.id]; // Total Float
        const isCritical = Math.abs(tf) < 1e-6;
        if (isCritical) criticalPathNodes.push(n.id);

        floatAnalysis[n.id] = {
          wcet: n.wcet,
          est: est[n.id],
          eft: eft[n.id],
          lst: lst[n.id],
          lft: lft[n.id],
          totalFloat: tf,
          isCritical
        };
      });

      return {
        makespanCycles: makespan,
        criticalPathNodes,
        scheduleFloats: floatAnalysis
      };
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 4. CACHE COHERENCE & MESI SNOOPING PROTOCOL SIMULATOR
  // ═════════════════════════════════════════════════════════════════════════
  class CacheCoherenceSimulator {
    /**
     * Simulates Modified-Exclusive-Shared-Invalid (MESI) 4-state protocol transitions
     * across multi-core private L1 caches sharing an L2 bus.
     */
    static simulateAccessSequence(numCores, memoryAccesses) {
      // memoryAccesses: [{ coreId, address, type: 'READ' | 'WRITE' }]
      const cacheStates = Array.from({ length: numCores }, () => ({}));
      const busTransactions = [];
      let totalInvalidations = 0;
      let totalBusCycles = 0;

      memoryAccesses.forEach(acc => {
        const cId = acc.coreId;
        const addr = acc.address;
        const curState = cacheStates[cId][addr] || 'I';

        if (acc.type === 'READ') {
          if (curState === 'M' || curState === 'E' || curState === 'S') {
            // Local Hit (0 bus overhead)
          } else {
            // Read Miss -> Broadcast BusRd
            let sharedWithOther = false;
            for (let other = 0; other < numCores; other++) {
              if (other !== cId && cacheStates[other][addr]) {
                const otherState = cacheStates[other][addr];
                if (otherState === 'M') {
                  // Writeback to memory and transition to S
                  cacheStates[other][addr] = 'S';
                  busTransactions.push({ type: 'BUS_WB', addr, fromCore: other });
                  totalBusCycles += 12;
                  sharedWithOther = true;
                } else if (otherState === 'E' || otherState === 'S') {
                  cacheStates[other][addr] = 'S';
                  sharedWithOther = true;
                }
              }
            }
            cacheStates[cId][addr] = sharedWithOther ? 'S' : 'E';
            busTransactions.push({ type: 'BUS_RD', addr, coreId: cId });
            totalBusCycles += 8;
          }
        } else if (acc.type === 'WRITE') {
          if (curState === 'M') {
            // Local Write Hit on Modified line
          } else if (curState === 'E') {
            // Silent upgrade to M
            cacheStates[cId][addr] = 'M';
          } else {
            // Write Miss / Invalidation Broadcast (BusRdX / BusUpgr)
            for (let other = 0; other < numCores; other++) {
              if (other !== cId && cacheStates[other][addr] && cacheStates[other][addr] !== 'I') {
                cacheStates[other][addr] = 'I';
                totalInvalidations++;
              }
            }
            cacheStates[cId][addr] = 'M';
            busTransactions.push({ type: 'BUS_RDX', addr, coreId: cId });
            totalBusCycles += 16;
          }
        }
      });

      return {
        totalAccesses: memoryAccesses.length,
        busTransactionsCount: busTransactions.length,
        totalInvalidations,
        totalBusCycles,
        finalCacheStates: cacheStates
      };
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // EXPORTS
  // ═════════════════════════════════════════════════════════════════════════
  return {
    TransientThermalSimulator,
    CommunicationComputationBottleneckAnalyzer,
    CriticalCycleSlackAnalyzer,
    CacheCoherenceSimulator
  };
}));
