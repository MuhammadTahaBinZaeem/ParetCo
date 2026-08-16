/**
 * ParetoCo Architecture Studio Engine (arch_engine.js)
 * Production Architecture Modeling, Graph Algorithms, NoC Routing, Thermal RC Networks & Cache Simulation.
 */

(function(root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ArchEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  class MinHeap {
    constructor(compareFn = (a, b) => a - b) {
      this.heap = [];
      this.compare = compareFn;
    }
    size() { return this.heap.length; }
    isEmpty() { return this.heap.length === 0; }
    peek() { return this.heap[0]; }
    push(item) {
      this.heap.push(item);
      this._bubbleUp(this.heap.length - 1);
    }
    pop() {
      if (this.isEmpty()) return null;
      const top = this.heap[0];
      const bottom = this.heap.pop();
      if (this.heap.length > 0) {
        this.heap[0] = bottom;
        this._sinkDown(0);
      }
      return top;
    }
    _bubbleUp(idx) {
      while (idx > 0) {
        const parentIdx = Math.floor((idx - 1) / 2);
        if (this.compare(this.heap[idx], this.heap[parentIdx]) < 0) {
          [this.heap[idx], this.heap[parentIdx]] = [this.heap[parentIdx], this.heap[idx]];
          idx = parentIdx;
        } else break;
      }
    }
    _sinkDown(idx) {
      const len = this.heap.length;
      while (true) {
        const left = 2 * idx + 1;
        const right = 2 * idx + 2;
        let smallest = idx;
        if (left < len && this.compare(this.heap[left], this.heap[smallest]) < 0) smallest = left;
        if (right < len && this.compare(this.heap[right], this.heap[smallest]) < 0) smallest = right;
        if (smallest !== idx) {
          [this.heap[idx], this.heap[smallest]] = [this.heap[smallest], this.heap[idx]];
          idx = smallest;
        } else break;
      }
    }
  }

  class DisjointSetUnion {
    constructor(elements = []) {
      this.parent = new Map();
      this.rank = new Map();
      elements.forEach(el => this.makeSet(el));
    }
    makeSet(x) {
      if (!this.parent.has(x)) {
        this.parent.set(x, x);
        this.rank.set(x, 0);
      }
    }
    find(x) {
      if (!this.parent.has(x)) this.makeSet(x);
      if (this.parent.get(x) !== x) {
        this.parent.set(x, this.find(this.parent.get(x)));
      }
      return this.parent.get(x);
    }
    union(x, y) {
      const rootX = this.find(x);
      const rootY = this.find(y);
      if (rootX === rootY) return false;
      const rankX = this.rank.get(rootX);
      const rankY = this.rank.get(rootY);
      if (rankX < rankY) {
        this.parent.set(rootX, rootY);
      } else if (rankX > rankY) {
        this.parent.set(rootY, rootX);
      } else {
        this.parent.set(rootY, rootX);
        this.rank.set(rootX, rankX + 1);
      }
      return true;
    }
  }

  class DirectedGraph {
    constructor() {
      this.adj = new Map();
      this.inAdj = new Map();
      this.edges = [];
      this.nodes = new Map();
    }
    addNode(id, data = {}) {
      if (!this.adj.has(id)) {
        this.adj.set(id, []);
        this.inAdj.set(id, []);
        this.nodes.set(id, Object.assign({ id }, data));
      }
      return this;
    }
    addEdge(src, dst, weight = 1, metadata = {}) {
      this.addNode(src);
      this.addNode(dst);
      const edge = { src, dst, weight, metadata, id: `${src}->${dst}_${this.edges.length}` };
      this.adj.get(src).push(edge);
      this.inAdj.get(dst).push(edge);
      this.edges.push(edge);
      return edge;
    }
    getNodeCount() { return this.nodes.size; }
    getEdgeCount() { return this.edges.length; }
    getNeighbors(id) { return this.adj.get(id) || []; }
    getInNeighbors(id) { return this.inAdj.get(id) || []; }

    tarjanSCC() {
      let index = 0;
      const stack = [];
      const inStack = new Set();
      const indices = new Map();
      const lowlinks = new Map();
      const sccs = [];

      const strongConnect = (v) => {
        indices.set(v, index);
        lowlinks.set(v, index);
        index++;
        stack.push(v);
        inStack.add(v);

        const neighbors = this.getNeighbors(v);
        for (let i = 0; i < neighbors.length; i++) {
          const w = neighbors[i].dst;
          if (!indices.has(w)) {
            strongConnect(w);
            lowlinks.set(v, Math.min(lowlinks.get(v), lowlinks.get(w)));
          } else if (inStack.has(w)) {
            lowlinks.set(v, Math.min(lowlinks.get(v), indices.get(w)));
          }
        }

        if (lowlinks.get(v) === indices.get(v)) {
          const scc = [];
          while (true) {
            const w = stack.pop();
            inStack.delete(w);
            scc.push(w);
            if (w === v) break;
          }
          sccs.push(scc);
        }
      };

      for (const node of this.nodes.keys()) {
        if (!indices.has(node)) {
          strongConnect(node);
        }
      }
      return sccs;
    }

    findSimpleCycles() {
      const sccs = this.tarjanSCC();
      const allCycles = [];

      for (let s = 0; s < sccs.length; s++) {
        const scc = sccs[s];
        if (scc.length < 2) {
          const v = scc[0];
          const selfLoop = (this.adj.get(v) || []).some(e => e.dst === v);
          if (selfLoop) allCycles.push([v]);
          continue;
        }
        const sccSet = new Set(scc);
        const subAdj = new Map();
        scc.forEach(node => {
          subAdj.set(node, (this.adj.get(node) || []).filter(e => sccSet.has(e.dst)).map(e => e.dst));
        });

        const blocked = new Set();
        const blockMap = new Map();
        const stack = [];

        const unblock = (u) => {
          blocked.delete(u);
          const list = blockMap.get(u) || [];
          while (list.length > 0) {
            const w = list.pop();
            if (blocked.has(w)) unblock(w);
          }
        };

        const circuit = (v, startNode) => {
          let f = false;
          stack.push(v);
          blocked.add(v);

          const neighbors = subAdj.get(v) || [];
          for (let i = 0; i < neighbors.length; i++) {
            const w = neighbors[i];
            if (w === startNode) {
              allCycles.push([...stack]);
              f = true;
            } else if (!blocked.has(w) && w >= startNode) {
              if (circuit(w, startNode)) f = true;
            }
          }

          if (f) {
            unblock(v);
          } else {
            for (let i = 0; i < neighbors.length; i++) {
              const w = neighbors[i];
              if (!blockMap.has(w)) blockMap.set(w, []);
              blockMap.get(w).push(v);
            }
          }
          stack.pop();
          return f;
        };

        for (let i = 0; i < scc.length; i++) {
          const start = scc[i];
          blocked.clear();
          blockMap.clear();
          circuit(start, start);
        }
      }
      return allCycles;
    }

    topologicalSort() {
      const inDegree = new Map();
      for (const node of this.nodes.keys()) inDegree.set(node, 0);
      for (let i = 0; i < this.edges.length; i++) {
        const dst = this.edges[i].dst;
        inDegree.set(dst, (inDegree.get(dst) || 0) + 1);
      }

      const queue = [];
      for (const [node, deg] of inDegree.entries()) {
        if (deg === 0) queue.push(node);
      }

      const result = [];
      while (queue.length > 0) {
        const u = queue.shift();
        result.push(u);
        const neighbors = this.getNeighbors(u);
        for (let i = 0; i < neighbors.length; i++) {
          const v = neighbors[i].dst;
          const newDeg = inDegree.get(v) - 1;
          inDegree.set(v, newDeg);
          if (newDeg === 0) queue.push(v);
        }
      }

      if (result.length !== this.nodes.size) {
        return { isDAG: false, order: [] };
      }
      return { isDAG: true, order: result };
    }

    dijkstra(src, dst = null) {
      const dist = new Map();
      const prev = new Map();
      for (const node of this.nodes.keys()) dist.set(node, Infinity);
      dist.set(src, 0);

      const heap = new MinHeap((a, b) => a.dist - b.dist);
      heap.push({ id: src, dist: 0 });

      while (!heap.isEmpty()) {
        const { id: u, dist: d } = heap.pop();
        if (d > dist.get(u)) continue;
        if (dst !== null && u === dst) break;

        const edges = this.getNeighbors(u);
        for (let i = 0; i < edges.length; i++) {
          const edge = edges[i];
          const v = edge.dst;
          const alt = d + edge.weight;
          if (alt < dist.get(v)) {
            dist.set(v, alt);
            prev.set(v, { node: u, edge });
            heap.push({ id: v, dist: alt });
          }
        }
      }

      const getPath = (target) => {
        if (!dist.has(target) || dist.get(target) === Infinity) return null;
        const path = [];
        let curr = target;
        while (curr !== src) {
          const p = prev.get(curr);
          if (!p) return null;
          path.unshift(p.edge);
          curr = p.node;
        }
        return path;
      };

      return { dist, prev, getPath };
    }

    floydWarshall() {
      const nodeArr = Array.from(this.nodes.keys());
      const n = nodeArr.length;
      const nodeIndex = new Map();
      nodeArr.forEach((node, idx) => nodeIndex.set(node, idx));

      const dist = Array.from({ length: n }, () => Array(n).fill(Infinity));
      const next = Array.from({ length: n }, () => Array(n).fill(null));

      for (let i = 0; i < n; i++) dist[i][i] = 0;

      for (let i = 0; i < this.edges.length; i++) {
        const edge = this.edges[i];
        const u = nodeIndex.get(edge.src);
        const v = nodeIndex.get(edge.dst);
        if (u !== undefined && v !== undefined) {
          if (edge.weight < dist[u][v]) {
            dist[u][v] = edge.weight;
            next[u][v] = v;
          }
        }
      }

      for (let k = 0; k < n; k++) {
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            if (dist[i][k] !== Infinity && dist[k][j] !== Infinity) {
              if (dist[i][k] + dist[k][j] < dist[i][j]) {
                dist[i][j] = dist[i][k] + dist[k][j];
                next[i][j] = next[i][k];
              }
            }
          }
        }
      }

      const getDistance = (uName, vName) => {
        const u = nodeIndex.get(uName);
        const v = nodeIndex.get(vName);
        if (u === undefined || v === undefined) return Infinity;
        return dist[u][v];
      };

      return { distMatrix: dist, nodeIndex, getDistance };
    }
  }

  class DinicMaxFlow {
    constructor() {
      this.nodes = new Map();
      this.edges = [];
      this.adj = new Map();
    }
    addNode(id) {
      if (!this.adj.has(id)) {
        this.adj.set(id, []);
        this.nodes.set(id, true);
      }
    }
    addEdge(u, v, cap) {
      this.addNode(u);
      this.addNode(v);
      const e1 = { u, v, cap, flow: 0, rev: null };
      const e2 = { u: v, v: u, cap: 0, flow: 0, rev: e1 };
      e1.rev = e2;
      this.adj.get(u).push(e1);
      this.adj.get(v).push(e2);
      this.edges.push(e1);
    }
    bfs(src, sink, level) {
      level.clear();
      for (const node of this.adj.keys()) level.set(node, -1);
      level.set(src, 0);
      const queue = [src];
      while (queue.length > 0) {
        const u = queue.shift();
        const neighbors = this.adj.get(u) || [];
        for (let i = 0; i < neighbors.length; i++) {
          const edge = neighbors[i];
          if (edge.cap - edge.flow > 0 && level.get(edge.v) === -1) {
            level.set(edge.v, level.get(u) + 1);
            queue.push(edge.v);
          }
        }
      }
      return level.get(sink) !== -1;
    }
    dfs(u, sink, pushed, level, ptr) {
      if (pushed === 0 || u === sink) return pushed;
      const neighbors = this.adj.get(u) || [];
      for (let cid = ptr.get(u) || 0; cid < neighbors.length; cid++) {
        ptr.set(u, cid);
        const edge = neighbors[cid];
        const tr = edge.v;
        if (level.get(u) + 1 !== level.get(tr) || edge.cap - edge.flow === 0) continue;
        const pushable = Math.min(pushed, edge.cap - edge.flow);
        const trPushed = this.dfs(tr, sink, pushable, level, ptr);
        if (trPushed === 0) continue;
        edge.flow += trPushed;
        edge.rev.flow -= trPushed;
        return trPushed;
      }
      return 0;
    }
    computeMaxFlow(src, sink) {
      let flow = 0;
      const level = new Map();
      const ptr = new Map();
      while (this.bfs(src, sink, level)) {
        ptr.clear();
        while (true) {
          const pushed = this.dfs(src, sink, Infinity, level, ptr);
          if (pushed === 0) break;
          flow += pushed;
        }
      }
      return flow;
    }
  }

  class CriticalPathMethod {
    static calculate(tasks, dependencies) {
      const g = new DirectedGraph();
      const durationMap = new Map();

      tasks.forEach(t => {
        const id = typeof t === 'string' ? t : t.id;
        const dur = typeof t === 'object' && t.duration !== undefined ? t.duration : 1;
        g.addNode(id);
        durationMap.set(id, dur);
      });

      dependencies.forEach(dep => {
        g.addEdge(dep.src, dep.dst, durationMap.get(dep.src) || 1);
      });

      const { isDAG, order } = g.topologicalSort();
      if (!isDAG) {
        return { isFeasible: false, error: 'Cyclic dependency in task graph' };
      }

      const est = new Map();
      const eft = new Map();
      order.forEach(id => {
        let maxEst = 0;
        const inEdges = g.getInNeighbors(id);
        for (let i = 0; i < inEdges.length; i++) {
          const pred = inEdges[i].src;
          maxEst = Math.max(maxEst, eft.get(pred) || 0);
        }
        est.set(id, maxEst);
        eft.set(id, maxEst + (durationMap.get(id) || 0));
      });

      const maxProjectTime = Array.from(eft.values()).reduce((max, val) => Math.max(max, val), 0);

      const lst = new Map();
      const lft = new Map();
      for (let i = order.length - 1; i >= 0; i--) {
        const id = order[i];
        const outEdges = g.getNeighbors(id);
        let minLst = maxProjectTime;
        if (outEdges.length === 0) {
          minLst = maxProjectTime;
        } else {
          for (let j = 0; j < outEdges.length; j++) {
            const succ = outEdges[j].dst;
            minLst = Math.min(minLst, lst.get(succ));
          }
        }
        lft.set(id, minLst);
        lst.set(id, minLst - (durationMap.get(id) || 0));
      }

      const totalFloat = new Map();
      const freeFloat = new Map();
      const criticalPath = [];

      order.forEach(id => {
        const tf = lst.get(id) - est.get(id);
        totalFloat.set(id, tf);

        const outEdges = g.getNeighbors(id);
        let minSuccEst = maxProjectTime;
        if (outEdges.length > 0) {
          for (let j = 0; j < outEdges.length; j++) {
            minSuccEst = Math.min(minSuccEst, est.get(outEdges[j].dst));
          }
          freeFloat.set(id, minSuccEst - eft.get(id));
        } else {
          freeFloat.set(id, maxProjectTime - eft.get(id));
        }

        if (Math.abs(tf) < 1e-6) {
          criticalPath.push(id);
        }
      });

      return {
        isFeasible: true,
        projectDuration: maxProjectTime,
        criticalPath,
        est: Object.fromEntries(est),
        eft: Object.fromEntries(eft),
        lst: Object.fromEntries(lst),
        lft: Object.fromEntries(lft),
        totalFloat: Object.fromEntries(totalFloat),
        freeFloat: Object.fromEntries(freeFloat)
      };
    }
  }

  class NoCRouter {
    static generateMeshTopology(dimX, dimY, bandwidthPerLink = 1000) {
      const graph = new DirectedGraph();
      const nodes = [];

      for (let y = 0; y < dimY; y++) {
        for (let x = 0; x < dimX; x++) {
          const id = `Router_${x}_${y}`;
          graph.addNode(id, { x, y, type: 'ROUTER' });
          nodes.push({ id, x, y });
        }
      }

      for (let y = 0; y < dimY; y++) {
        for (let x = 0; x < dimX; x++) {
          const curr = `Router_${x}_${y}`;
          if (x + 1 < dimX) {
            const east = `Router_${x + 1}_${y}`;
            graph.addEdge(curr, east, 1, { capacity: bandwidthPerLink, dir: 'EAST' });
            graph.addEdge(east, curr, 1, { capacity: bandwidthPerLink, dir: 'WEST' });
          }
          if (y + 1 < dimY) {
            const south = `Router_${x}_${y + 1}`;
            graph.addEdge(curr, south, 1, { capacity: bandwidthPerLink, dir: 'SOUTH' });
            graph.addEdge(south, curr, 1, { capacity: bandwidthPerLink, dir: 'NORTH' });
          }
        }
      }

      return { graph, nodes, dimX, dimY };
    }

    static routeXY(srcX, srcY, dstX, dstY) {
      const hops = [];
      let currX = srcX;
      let currY = srcY;

      while (currX !== dstX) {
        const nextX = currX < dstX ? currX + 1 : currX - 1;
        hops.push({
          src: `Router_${currX}_${currY}`,
          dst: `Router_${nextX}_${currY}`,
          dir: currX < dstX ? 'EAST' : 'WEST'
        });
        currX = nextX;
      }

      while (currY !== dstY) {
        const nextY = currY < dstY ? currY + 1 : currY - 1;
        hops.push({
          src: `Router_${currX}_${currY}`,
          dst: `Router_${currX}_${nextY}`,
          dir: currY < dstY ? 'SOUTH' : 'NORTH'
        });
        currY = nextY;
      }

      return { hops, hopCount: hops.length };
    }

    static computeSaturationMatrix(flows, mesh) {
      const linkUsage = new Map();
      const saturation = [];

      flows.forEach(flow => {
        const { srcX, srcY, dstX, dstY, rate } = flow;
        const { hops } = NoCRouter.routeXY(srcX, srcY, dstX, dstY);
        hops.forEach(hop => {
          const linkKey = `${hop.src}->${hop.dst}`;
          const currentLoad = (linkUsage.get(linkKey) || 0) + (rate || 10);
          linkUsage.set(linkKey, currentLoad);
        });
      });

      linkUsage.forEach((load, linkKey) => {
        const cap = 1000;
        const util = Math.min(100, Math.round((load / cap) * 100));
        saturation.push({ link: linkKey, load, capacity: cap, utilization: util, isBottleneck: util >= 90 });
      });

      return saturation;
    }
  }

  class ThermalModel {
    static computeSteadyState(processorLoads, ambientTempC = 25) {
      const results = [];
      processorLoads.forEach(proc => {
        const dynPower = (proc.dynPower || 10) * ((proc.utilization || 50) / 100);
        const staticPower = proc.staticPower || 2;
        const totalPower = dynPower + staticPower;
        const thermalResistance = proc.rThermal || 1.8;
        const tempC = ambientTempC + totalPower * thermalResistance;
        results.push({
          id: proc.id || proc.model,
          totalPower,
          dynPower,
          staticPower,
          temperatureC: parseFloat(tempC.toFixed(2)),
          isThrottled: tempC > 85
        });
      });
      return results;
    }

    static computeDvfsCurve(baseVoltage, baseFreqGHz, steps = 5) {
      const curve = [];
      for (let i = 0; i < steps; i++) {
        const scale = 1.0 - (i * 0.1);
        const freq = baseFreqGHz * scale;
        const voltage = baseVoltage * (0.8 + 0.2 * scale);
        const dynamicPowerFactor = Math.pow(voltage, 2) * freq;
        curve.push({
          step: i + 1,
          freqGHz: parseFloat(freq.toFixed(2)),
          voltageV: parseFloat(voltage.toFixed(2)),
          powerFactor: parseFloat(dynamicPowerFactor.toFixed(3)),
          energySavingsPercent: Math.round((1.0 - dynamicPowerFactor) * 100)
        });
      }
      return curve;
    }
  }

  class CacheHierarchySimulator {
    constructor(l1Config = { sizeKB: 32, lineBytes: 64, ways: 4 }, l2Config = { sizeKB: 512, lineBytes: 64, ways: 8 }) {
      this.l1 = {
        sets: (l1Config.sizeKB * 1024) / (l1Config.lineBytes * l1Config.ways),
        lineBytes: l1Config.lineBytes,
        ways: l1Config.ways,
        tags: new Map(),
        hits: 0,
        misses: 0
      };
      this.l2 = {
        sets: (l2Config.sizeKB * 1024) / (l2Config.lineBytes * l2Config.ways),
        lineBytes: l2Config.lineBytes,
        ways: l2Config.ways,
        tags: new Map(),
        hits: 0,
        misses: 0
      };
    }

    access(address, isWrite = false) {
      const l1Set = Math.floor(address / this.l1.lineBytes) % this.l1.sets;
      const l1Tag = Math.floor(address / (this.l1.lineBytes * this.l1.sets));

      let l1Lines = this.l1.tags.get(l1Set) || [];
      const l1HitIdx = l1Lines.indexOf(l1Tag);

      if (l1HitIdx !== -1) {
        this.l1.hits++;
        l1Lines.splice(l1HitIdx, 1);
        l1Lines.push(l1Tag);
        this.l1.tags.set(l1Set, l1Lines);
        return { l1Hit: true, l2Hit: false, cycles: 1 };
      }

      this.l1.misses++;
      if (l1Lines.length >= this.l1.ways) l1Lines.shift();
      l1Lines.push(l1Tag);
      this.l1.tags.set(l1Set, l1Lines);

      const l2Set = Math.floor(address / this.l2.lineBytes) % this.l2.sets;
      const l2Tag = Math.floor(address / (this.l2.lineBytes * this.l2.sets));
      let l2Lines = this.l2.tags.get(l2Set) || [];
      const l2HitIdx = l2Lines.indexOf(l2Tag);

      if (l2HitIdx !== -1) {
        this.l2.hits++;
        l2Lines.splice(l2HitIdx, 1);
        l2Lines.push(l2Tag);
        this.l2.tags.set(l2Set, l2Lines);
        return { l1Hit: false, l2Hit: true, cycles: 10 };
      }

      this.l2.misses++;
      if (l2Lines.length >= this.l2.ways) l2Lines.shift();
      l2Lines.push(l2Tag);
      this.l2.tags.set(l2Set, l2Lines);

      return { l1Hit: false, l2Hit: false, cycles: 100 };
    }

    getStats() {
      const l1Total = this.l1.hits + this.l1.misses;
      const l2Total = this.l2.hits + this.l2.misses;
      return {
        l1HitRate: l1Total > 0 ? parseFloat((this.l1.hits / l1Total).toFixed(4)) : 1,
        l2HitRate: l2Total > 0 ? parseFloat((this.l2.hits / l2Total).toFixed(4)) : 1,
        l1Misses: this.l1.misses,
        l2Misses: this.l2.misses
      };
    }
  }

  class TdmaBusArbiter {
    static allocateSlots(requests, totalSlots = 16) {
      const sorted = [...requests].sort((a, b) => (b.priority || 1) * (b.bandwidth || 1) - (a.priority || 1) * (a.bandwidth || 1));
      const slots = new Array(totalSlots).fill(null);
      let allocatedCount = 0;

      for (let i = 0; i < sorted.length; i++) {
        const req = sorted[i];
        const desiredSlots = Math.max(1, Math.min(totalSlots - allocatedCount, Math.round((req.bandwidth / 100) * totalSlots)));
        let granted = 0;
        const stride = Math.max(1, Math.floor(totalSlots / desiredSlots));
        for (let s = (i % stride); s < totalSlots && granted < desiredSlots; s += stride) {
          if (slots[s] === null) {
            slots[s] = req.procId;
            granted++;
            allocatedCount++;
          }
        }
      }
      return { slots, utilization: Math.round((allocatedCount / totalSlots) * 100) };
    }
  }

  return {
    DirectedGraph,
    MinHeap,
    DisjointSetUnion,
    DinicMaxFlow,
    CriticalPathMethod,
    NoCRouter,
    ThermalModel,
    CacheHierarchySimulator,
    TdmaBusArbiter
  };
}));
