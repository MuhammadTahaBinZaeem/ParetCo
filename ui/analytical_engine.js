/**
 * ParetoCo Analytical Engine (analytical_engine.js)
 * Maximum Cycle Ratio (MCR) Howard's Algorithm, Self-Timed Simulation & Buffer Sizing.
 */

(function(root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AnalyticalEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  class MaximumCycleRatio {
    static computeMcrHoward(nodes, edges) {
      const n = nodes.length;
      if (n === 0) return { mcr: 0, throughput: 0, criticalCycle: [] };

      const nodeIndex = new Map();
      nodes.forEach((node, idx) => nodeIndex.set(node, idx));

      const pi = new Array(n).fill(0);
      const policy = new Array(n).fill(-1);

      for (let i = 0; i < n; i++) {
        const outEdges = edges.filter(e => e.src === nodes[i]);
        if (outEdges.length > 0) policy[i] = edges.indexOf(outEdges[0]);
      }

      const maxIterations = 50;
      let lambda = 0;
      let criticalCycle = [];

      for (let iter = 0; iter < maxIterations; iter++) {
        let cycleFound = false;
        const visited = new Array(n).fill(0);

        for (let i = 0; i < n; i++) {
          if (visited[i] === 0) {
            let curr = i;
            const path = [];
            while (curr !== -1 && visited[curr] === 0) {
              visited[curr] = 1;
              path.push(curr);
              const edgeIdx = policy[curr];
              if (edgeIdx === -1) { curr = -1; break; }
              const e = edges[edgeIdx];
              curr = nodeIndex.get(e.dst) ?? -1;
            }

            if (curr !== -1 && visited[curr] === 1) {
              cycleFound = true;
              const cycleStartIdx = path.indexOf(curr);
              const cycleNodes = path.slice(cycleStartIdx);

              let totalExecutionTime = 0;
              let totalTokens = 0;

              for (let k = 0; k < cycleNodes.length; k++) {
                const u = cycleNodes[k];
                const edgeIdx = policy[u];
                const e = edges[edgeIdx];
                totalExecutionTime += (e.wcet || e.weight || 1);
                totalTokens += (e.tokens !== undefined ? e.tokens : (e.initialTokens !== undefined ? e.initialTokens : 0));
              }

              lambda = totalTokens > 0 ? (totalExecutionTime / totalTokens) : totalExecutionTime;
              criticalCycle = cycleNodes.map(idx => nodes[idx]);
              break;
            }

            path.forEach(idx => visited[idx] = 2);
          }
        }

        let improved = false;
        for (let eIdx = 0; eIdx < edges.length; eIdx++) {
          const e = edges[eIdx];
          const u = nodeIndex.get(e.src);
          const v = nodeIndex.get(e.dst);
          if (u !== undefined && v !== undefined) {
            const tok = (e.tokens !== undefined ? e.tokens : (e.initialTokens !== undefined ? e.initialTokens : 0));
            const delay = (e.wcet || e.weight || 1) - lambda * tok;
            if (pi[u] + delay > pi[v] + 1e-6) {
              pi[v] = pi[u] + delay;
              policy[u] = eIdx;
              improved = true;
            }
          }
        }

        if (!improved && cycleFound) break;
      }

      return {
        mcr: parseFloat(lambda.toFixed(4)),
        throughput: lambda > 0 ? parseFloat((1.0 / lambda).toFixed(6)) : 0,
        criticalCycle
      };
    }
  }

  class SelfTimedSimulator {
    static simulate(actors, channels, wcetMap, iterations = 10) {
      const schedule = [];
      const tokenState = new Map();
      channels.forEach(ch => tokenState.set(ch.name || `${ch.src}->${ch.dst}`, ch.initialTokens ?? (ch.tokens || 0)));

      let currentTime = 0;
      const actorEvents = [];

      for (let iter = 0; iter < iterations; iter++) {
        actors.forEach(act => {
          const inChannels = channels.filter(ch => ch.dst === act);
          const canFire = inChannels.every(ch => (tokenState.get(ch.name || `${ch.src}->${ch.dst}`) || 0) >= 1);
          if (canFire) {
            inChannels.forEach(ch => {
              const k = ch.name || `${ch.src}->${ch.dst}`;
              tokenState.set(k, tokenState.get(k) - 1);
            });
            const wcet = wcetMap[act] || 10;
            actorEvents.push({
              actor: act,
              start: currentTime,
              end: currentTime + wcet,
              iteration: iter
            });
            currentTime += wcet;
            const outChannels = channels.filter(ch => ch.src === act);
            outChannels.forEach(ch => {
              const k = ch.name || `${ch.src}->${ch.dst}`;
              tokenState.set(k, (tokenState.get(k) || 0) + 1);
            });
          }
        });
      }

      return {
        totalSimulatedTime: currentTime,
        events: actorEvents,
        avgPeriodPerIteration: iterations > 0 ? (currentTime / iterations) : 0
      };
    }
  }

  return {
    MaximumCycleRatio,
    SelfTimedSimulator
  };
}));
