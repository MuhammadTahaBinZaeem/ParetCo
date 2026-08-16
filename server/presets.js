'use strict';

const PRESETS = {
  demo: {
    name: 'ParetoCo Native Demo (Dual ARM + TestApp)',
    description: 'Exact stable model used by the Load Demo button and production native smoke test.',
    platform: {
      name: 'dual_arm_demo',
      processors: [
        { model: 'ARM', count: 2, modes: [{ name: 'default', cycle: 1, mem: 4096, dynPower: 10, staticPower: 2, area: 5, monetary: 10 }] }
      ],
      interconnects: [{ name: 'bus0', topology: 'TDMA-bus', xDim: 2, yDim: 1, flitSize: 32, slots: 2, maxSlotsPerProc: 2 }]
    },
    applications: [{
      name: 'TestApp',
      actors: [
        { name: 'src_node', type: 'src_node', ports: [{ name: 'p_in', type: 'in', rate: 1 }, { name: 'p_out', type: 'out', rate: 1 }] },
        { name: 'proc_node', type: 'proc_node', ports: [{ name: 'p_in', type: 'in', rate: 1 }, { name: 'p_out', type: 'out', rate: 1 }] },
        { name: 'snk_node', type: 'snk_node', ports: [{ name: 'p_in', type: 'in', rate: 1 }, { name: 'p_out', type: 'out', rate: 1 }] }
      ],
      channels: [
        { name: 'ch1', srcActor: 'src_node', srcPort: 'p_out', dstActor: 'proc_node', dstPort: 'p_in', initialTokens: 0, size: 1 },
        { name: 'ch2', srcActor: 'proc_node', srcPort: 'p_out', dstActor: 'snk_node', dstPort: 'p_in', initialTokens: 0, size: 1 },
        { name: 'ch3', srcActor: 'snk_node', srcPort: 'p_out', dstActor: 'src_node', dstPort: 'p_in', initialTokens: 1, size: 1 }
      ]
    }],
    wcets: [
      { taskType: 'src_node', procModel: 'ARM', mode: 'default', wcet: 10 },
      { taskType: 'proc_node', procModel: 'ARM', mode: 'default', wcet: 25 },
      { taskType: 'snk_node', procModel: 'ARM', mode: 'default', wcet: 15 }
    ],
    constraints: [],
    sysConstraints: { power: -1, utilization: -1, area: -1, cost: -1, procsUsed: -1 },
    dse: { model: 'SDF_PR_ONLINE', criteria: 'THROUGHPUT', search: 'FIRST', th_prop: 'SSE', threads: 0, timeout1: 0, timeout2: 0, lubyScale: 0, noGoodDepth: 75 },
    presolver: { model: 'NONE', search: 'NONESEARCH', heuristic: 'NONE', multiSearch: 'NONESEARCH', timeout1: 0, timeout2: 0 },
    output: { type: 'ALL_OUT', freq: 'ALL_SOL', logLevel: 'INFO' }
  },
  sobel: {
    name: 'Sobel Filter (Dual-Core ARM Platform)',
    description: 'Classic edge detection image pipeline mapped onto a 2-core ARM platform with TDMA bus interconnect.',
    platform: {
      name: 'arm_dual_core',
      processors: [
        { model: 'ARM_CortexA7', count: 2, modes: [{ name: 'default', cycle: 1, mem: 4096, dynPower: 12, staticPower: 2, area: 4, monetary: 8 }] }
      ],
      interconnects: [{ name: 'bus0', topology: 'TDMA-bus', xDim: 2, yDim: 1, flitSize: 32, slots: 2 }]
    },
    applications: [{
      name: 'SobelFilter',
      actors: ['img_source', 'gx_filter', 'gy_filter', 'magnitude_calc', 'img_sink'],
      channels: [
        { name: 'c1', src: 'img_source', dst: 'gx_filter', tokens: 0 },
        { name: 'c2', src: 'img_source', dst: 'gy_filter', tokens: 0 },
        { name: 'c3', src: 'gx_filter', dst: 'magnitude_calc', tokens: 0 },
        { name: 'c4', src: 'gy_filter', dst: 'magnitude_calc', tokens: 0 },
        { name: 'c5', src: 'magnitude_calc', dst: 'img_sink', tokens: 0 },
        { name: 'c6', src: 'img_sink', dst: 'img_source', tokens: 1 }
      ]
    }],
    wcets: [
      { taskType: 'img_source', procModel: 'ARM_CortexA7', mode: 'default', wcet: 8 },
      { taskType: 'gx_filter', procModel: 'ARM_CortexA7', mode: 'default', wcet: 22 },
      { taskType: 'gy_filter', procModel: 'ARM_CortexA7', mode: 'default', wcet: 22 },
      { taskType: 'magnitude_calc', procModel: 'ARM_CortexA7', mode: 'default', wcet: 14 },
      { taskType: 'img_sink', procModel: 'ARM_CortexA7', mode: 'default', wcet: 6 }
    ],
    constraints: [{ appName: 'SobelFilter', period: 1000, latency: 0 }],
    sysConstraints: { power: -1, utilization: -1, area: -1, cost: -1, procsUsed: -1 },
    dse: { model: 'SDF_PR_ONLINE', criteria: 'THROUGHPUT', search: 'FIRST', th_prop: 'SSE' }
  },
  susan: {
    name: 'Susan Edge & Corner Detector (Quad-Core Heterogeneous Platform)',
    description: 'High-performance video processing pipeline explored across high-efficiency and high-performance processor clusters.',
    platform: {
      name: 'hetero_quad',
      processors: [
        { model: 'Fast_Core', count: 2, modes: [{ name: 'boost', cycle: 0.8, mem: 8192, dynPower: 25, staticPower: 5, area: 8, monetary: 15 }] },
        { model: 'Eco_Core', count: 2, modes: [{ name: 'eco', cycle: 1.2, mem: 4096, dynPower: 8, staticPower: 1, area: 3, monetary: 5 }] }
      ],
      interconnects: [{ name: 'bus0', topology: 'TDMA-bus', xDim: 4, yDim: 1, flitSize: 64, slots: 4 }]
    },
    applications: [{
      name: 'SusanDetector',
      actors: ['frame_in', 'get_usan', 'thinning', 'edge_draw', 'frame_out'],
      channels: [
        { name: 'c1', src: 'frame_in', dst: 'get_usan', tokens: 0 },
        { name: 'c2', src: 'get_usan', dst: 'thinning', tokens: 0 },
        { name: 'c3', src: 'thinning', dst: 'edge_draw', tokens: 0 },
        { name: 'c4', src: 'edge_draw', dst: 'frame_out', tokens: 0 },
        { name: 'c5', src: 'frame_out', dst: 'frame_in', tokens: 1 }
      ]
    }],
    wcets: [
      { taskType: 'frame_in', procModel: 'Fast_Core', mode: 'boost', wcet: 5 },
      { taskType: 'frame_in', procModel: 'Eco_Core', mode: 'eco', wcet: 9 },
      { taskType: 'get_usan', procModel: 'Fast_Core', mode: 'boost', wcet: 30 },
      { taskType: 'get_usan', procModel: 'Eco_Core', mode: 'eco', wcet: 55 },
      { taskType: 'thinning', procModel: 'Fast_Core', mode: 'boost', wcet: 18 },
      { taskType: 'thinning', procModel: 'Eco_Core', mode: 'eco', wcet: 32 },
      { taskType: 'edge_draw', procModel: 'Fast_Core', mode: 'boost', wcet: 12 },
      { taskType: 'edge_draw', procModel: 'Eco_Core', mode: 'eco', wcet: 20 },
      { taskType: 'frame_out', procModel: 'Fast_Core', mode: 'boost', wcet: 4 },
      { taskType: 'frame_out', procModel: 'Eco_Core', mode: 'eco', wcet: 7 }
    ],
    constraints: [{ appName: 'SusanDetector', period: 1000, latency: 0 }],
    sysConstraints: { power: -1, utilization: -1, area: -1, cost: -1, procsUsed: -1 },
    dse: { model: 'SDF_PR_ONLINE', criteria: 'POWER', search: 'FIRST', th_prop: 'MCR' }
  }
};

module.exports = { PRESETS };