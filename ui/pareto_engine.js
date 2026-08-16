/**
 * ParetoCo Interactive Pareto Engine (pareto_engine.js)
 * Multi-Objective Optimization, Deb's Fast Non-Dominated Sorting, Hypervolume, Knee Detection & Solution Capping.
 */

(function(root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ParetoEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  const MAX_SOLUTION_LIMIT = 200;
  const LIMIT_EXCEEDED_MSG = "200 solutions found, more possible stopping due to limit.";

  class MultiObjectiveOptimizer {
    static enforceHardLimit(solutions) {
      if (!Array.isArray(solutions)) return { solutions: [], wasCapped: false, message: '' };
      if (solutions.length > MAX_SOLUTION_LIMIT) {
        return {
          solutions: solutions.slice(0, MAX_SOLUTION_LIMIT),
          wasCapped: true,
          message: LIMIT_EXCEEDED_MSG,
          originalCount: solutions.length
        };
      }
      return {
        solutions: solutions,
        wasCapped: false,
        message: `${solutions.length} solutions found`,
        originalCount: solutions.length
      };
    }

    static dominates(a, b, dimensions) {
      let strictlyBetterInAtLeastOne = false;
      for (let i = 0; i < dimensions.length; i++) {
        const dim = dimensions[i];
        const valA = a[dim.key] !== undefined ? a[dim.key] : (a['_' + dim.key] ?? 0);
        const valB = b[dim.key] !== undefined ? b[dim.key] : (b['_' + dim.key] ?? 0);

        if (dim.minBetter) {
          if (valA > valB) return false;
          if (valA < valB) strictlyBetterInAtLeastOne = true;
        } else {
          if (valA < valB) return false;
          if (valA > valB) strictlyBetterInAtLeastOne = true;
        }
      }
      return strictlyBetterInAtLeastOne;
    }

    static fastNonDominatedSort(solutions, dimensions) {
      const { solutions: cappedSolutions } = MultiObjectiveOptimizer.enforceHardLimit(solutions);
      const n = cappedSolutions.length;
      if (n === 0) return { fronts: [], ranks: new Map() };

      const S = Array.from({ length: n }, () => []);
      const numDominatedBy = new Array(n).fill(0);
      const ranks = new Map();
      const fronts = [[]];

      for (let p = 0; p < n; p++) {
        for (let q = 0; q < n; q++) {
          if (p === q) continue;
          if (MultiObjectiveOptimizer.dominates(cappedSolutions[p], cappedSolutions[q], dimensions)) {
            S[p].push(q);
          } else if (MultiObjectiveOptimizer.dominates(cappedSolutions[q], cappedSolutions[p], dimensions)) {
            numDominatedBy[p]++;
          }
        }
        if (numDominatedBy[p] === 0) {
          ranks.set(p, 0);
          fronts[0].push(p);
        }
      }

      let currentFrontIdx = 0;
      while (fronts[currentFrontIdx] && fronts[currentFrontIdx].length > 0) {
        const nextFront = [];
        for (let i = 0; i < fronts[currentFrontIdx].length; i++) {
          const p = fronts[currentFrontIdx][i];
          for (let j = 0; j < S[p].length; j++) {
            const q = S[p][j];
            numDominatedBy[q]--;
            if (numDominatedBy[q] === 0) {
              ranks.set(q, currentFrontIdx + 1);
              nextFront.push(q);
            }
          }
        }
        currentFrontIdx++;
        if (nextFront.length > 0) {
          fronts.push(nextFront);
        }
      }

      const populatedFronts = fronts.map(frontIndices => frontIndices.map(idx => cappedSolutions[idx]));
      return { fronts: populatedFronts, rawFronts: fronts, ranks };
    }

    static computeCrowdingDistance(front, dimensions) {
      const len = front.length;
      if (len <= 2) {
        return front.map(sol => Object.assign({}, sol, { _crowdingDistance: Infinity }));
      }

      const distances = new Array(len).fill(0);

      for (let m = 0; m < dimensions.length; m++) {
        const dim = dimensions[m];
        const indexed = front.map((sol, originalIdx) => ({
          sol,
          originalIdx,
          val: sol[dim.key] !== undefined ? sol[dim.key] : (sol['_' + dim.key] ?? 0)
        }));

        indexed.sort((a, b) => a.val - b.val);

        distances[indexed[0].originalIdx] = Infinity;
        distances[indexed[len - 1].originalIdx] = Infinity;

        const range = indexed[len - 1].val - indexed[0].val;
        if (range > 1e-9) {
          for (let i = 1; i < len - 1; i++) {
            if (distances[indexed[i].originalIdx] !== Infinity) {
              distances[indexed[i].originalIdx] += (indexed[i + 1].val - indexed[i - 1].val) / range;
            }
          }
        }
      }

      return front.map((sol, idx) => Object.assign({}, sol, { _crowdingDistance: distances[idx] }));
    }

    static computeHypervolume2D(front, refPoint = { x: 1000, y: 1000 }, keyX = 'period', keyY = 'power') {
      if (!front || front.length === 0) return 0;
      const points = front.map(s => ({
        x: s[keyX] !== undefined ? s[keyX] : (s['_' + keyX] ?? 0),
        y: s[keyY] !== undefined ? s[keyY] : (s['_' + keyY] ?? 0)
      })).filter(p => p.x <= refPoint.x && p.y <= refPoint.y);

      if (points.length === 0) return 0;
      points.sort((a, b) => a.x - b.x);

      let volume = (refPoint.x - points[0].x) * (refPoint.y - points[0].y);
      for (let i = 1; i < points.length; i++) {
        const deltaX = refPoint.x - points[i].x;
        const deltaY = points[i - 1].y - points[i].y;
        if (deltaY > 0) {
          volume += deltaX * deltaY;
        }
      }
      return parseFloat(volume.toFixed(3));
    }

    static detectKneePoints(frontier, keyX = 'period', keyY = 'power') {
      if (!frontier || frontier.length < 3) return frontier || [];
      const points = frontier.map((s, idx) => ({
        sol: s,
        idx,
        x: s[keyX] !== undefined ? s[keyX] : (s['_' + keyX] ?? 0),
        y: s[keyY] !== undefined ? s[keyY] : (s['_' + keyY] ?? 0)
      }));

      points.sort((a, b) => a.x - b.x);

      const p1 = points[0];
      const p2 = points[points.length - 1];

      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const lineNorm = Math.sqrt(dx * dx + dy * dy);

      const withDistances = points.map(p => {
        let distance = 0;
        if (lineNorm > 1e-9) {
          distance = Math.abs(dy * p.x - dx * p.y + p2.x * p1.y - p2.y * p1.x) / lineNorm;
        }
        return { sol: p.sol, distance, x: p.x, y: p.y };
      });

      withDistances.sort((a, b) => b.distance - a.distance);
      return withDistances.map(item => Object.assign({}, item.sol, { _kneeScore: item.distance }));
    }

    static clusterSolutionsKMeans(solutions, k = 3, dimensions = [{ key: 'period', minBetter: true }, { key: 'power', minBetter: true }]) {
      const n = solutions.length;
      if (n === 0) return [];
      if (n <= k) return solutions.map((s, idx) => ({ clusterId: idx, solution: s }));

      const vectors = solutions.map(s => dimensions.map(d => s[d.key] ?? (s['_' + d.key] || 0)));
      const dims = dimensions.length;

      const mins = new Array(dims).fill(Infinity);
      const maxs = new Array(dims).fill(-Infinity);
      for (let i = 0; i < n; i++) {
        for (let d = 0; d < dims; d++) {
          mins[d] = Math.min(mins[d], vectors[i][d]);
          maxs[d] = Math.max(maxs[d], vectors[i][d]);
        }
      }

      const normalized = vectors.map(v => v.map((val, d) => {
        const range = maxs[d] - mins[d];
        return range > 1e-9 ? (val - mins[d]) / range : 0.5;
      }));

      let centroids = [];
      for (let i = 0; i < k; i++) {
        const sampleIdx = Math.floor((i / k) * n);
        centroids.push([...normalized[sampleIdx]]);
      }

      let assignments = new Array(n).fill(0);
      const maxIters = 20;

      for (let iter = 0; iter < maxIters; iter++) {
        let changed = false;
        for (let i = 0; i < n; i++) {
          let bestDist = Infinity;
          let bestC = 0;
          for (let c = 0; c < k; c++) {
            let distSq = 0;
            for (let d = 0; d < dims; d++) {
              const diff = normalized[i][d] - centroids[c][d];
              distSq += diff * diff;
            }
            if (distSq < bestDist) {
              bestDist = distSq;
              bestC = c;
            }
          }
          if (assignments[i] !== bestC) {
            assignments[i] = bestC;
            changed = true;
          }
        }

        if (!changed) break;

        const counts = new Array(k).fill(0);
        const sums = Array.from({ length: k }, () => new Array(dims).fill(0));
        for (let i = 0; i < n; i++) {
          const c = assignments[i];
          counts[c]++;
          for (let d = 0; d < dims; d++) sums[c][d] += normalized[i][d];
        }

        for (let c = 0; c < k; c++) {
          if (counts[c] > 0) {
            for (let d = 0; d < dims; d++) centroids[c][d] = sums[c][d] / counts[c];
          }
        }
      }

      return solutions.map((sol, idx) => ({
        clusterId: assignments[idx],
        solution: sol
      }));
    }
  }

  return {
    MultiObjectiveOptimizer,
    MAX_SOLUTION_LIMIT,
    LIMIT_EXCEEDED_MSG
  };
}));
