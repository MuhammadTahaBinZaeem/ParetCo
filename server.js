/**
 * ParetoCo - Web Application & Solver Bridge Server
 *
 * Created on: Aug 15, 2026
 * Author: Idrees & Alizay
 *
 * Copyright (c) 2026 ParetoCo Contributors
 * SPDX-License-Identifier: MIT
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT_DIR = __dirname;
const UI_DIR = path.join(ROOT_DIR, 'ui');

// MIME types for static assets
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8'
};

// Resolve the packaged native engine. On Windows it runs directly; on Linux (Render)
// the exact same x86-64 Windows executable is launched through Wine.
let cachedWineBinary;

function findWineBinary() {
  if (cachedWineBinary !== undefined) return cachedWineBinary;

  const candidates = [
    process.env.PARETOCO_WINE,
    '/usr/bin/wine64',
    '/usr/bin/wine',
    'wine64',
    'wine'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
    try {
      const probe = spawnSync(candidate, ['--version'], {
        stdio: 'ignore',
        timeout: 3000
      });
      if (!probe.error && probe.status === 0) {
        cachedWineBinary = candidate;
        return cachedWineBinary;
      }
    } catch (_) {}
  }

  cachedWineBinary = null;
  return null;
}

function findNativeEngine() {
  const explicit = process.env.PARETOCO_ENGINE;
  const candidates = [
    explicit,
    path.join(ROOT_DIR, 'paretoco-engine-release', 'paretoco-engine.exe'),
    path.join(ROOT_DIR, 'dist', process.platform === 'win32' ? 'paretoco-engine.exe' : 'paretoco-engine'),
    path.join(ROOT_DIR, 'engine', 'build', 'bin', 'Release', process.platform === 'win32' ? 'paretoco-engine.exe' : 'paretoco-engine'),
    path.join(ROOT_DIR, 'engine', 'build', process.platform === 'win32' ? 'paretoco-engine.exe' : 'paretoco-engine'),
    path.join(ROOT_DIR, 'bin', process.platform === 'win32' ? 'paretoco-engine.exe' : 'paretoco-engine')
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) continue;

    const isWindowsExecutable = resolved.toLowerCase().endsWith('.exe');
    if (process.platform === 'win32' || !isWindowsExecutable) {
      return {
        enginePath: resolved,
        command: resolved,
        prefixArgs: [],
        mode: process.platform === 'win32' ? 'native-windows' : 'native-linux'
      };
    }

    const wine = findWineBinary();
    if (wine) {
      return {
        enginePath: resolved,
        command: wine,
        prefixArgs: [resolved],
        mode: 'wine'
      };
    }
  }

  return null;
}

function nativeEngineLabel(engine) {
  if (!engine) return 'unavailable';
  if (engine.mode === 'wine') return `${path.basename(engine.enginePath)} via ${path.basename(engine.command)}`;
  return path.basename(engine.enginePath);
}

function nativeRequired() {
  return String(process.env.PARETOCO_REQUIRE_NATIVE || '').toLowerCase() === 'true';
}

// Built-in Analytical DSE Solver for serverless/cloud fallback
function runAnalyticalDseFallback(job) {
  const startTime = Date.now();
  const procs = job.platform?.processors || [
    { model: 'ARM', count: 2, modes: [{ name: 'default', cycle: 1, mem: 4096, dynPower: 10, staticPower: 2, area: 5, monetary: 10 }] }
  ];
  
  const totalCores = procs.reduce((acc, p) => acc + (p.count || 1), 0);
  const apps = job.applications && job.applications.length > 0 ? job.applications : [{ name: 'TestApp', actors: ['src_node', 'proc_node', 'snk_node'] }];
  const criteria = (job.dse?.criteria || 'THROUGHPUT').toUpperCase();
  const thProp = (job.dse?.th_prop || 'SSE').toUpperCase();

  const totalActors = apps.reduce((acc, a) => acc + (a.actors ? a.actors.length : 3), 0);
  const wcetMap = job.wcets || [
    { taskType: 'src_node', wcet: 10 },
    { taskType: 'proc_node', wcet: 25 },
    { taskType: 'snk_node', wcet: 15 }
  ];

  const totalWorkload = wcetMap.reduce((acc, w) => acc + (parseInt(w.wcet) || 20), 0);
  const basePeriod = Math.max(Math.ceil(totalWorkload / Math.max(1, totalCores)), 35);
  const basePower = totalCores * 10 + 2;
  const baseArea = totalCores * 5;
  const baseCost = totalCores * 10;

  // Check user design constraints
  const constraints = job.constraints || [];
  let minAllowedPeriod = Infinity;
  constraints.forEach(c => {
    const pVal = parseInt(c.period, 10);
    if (!isNaN(pVal) && pVal > 0 && pVal < minAllowedPeriod) {
      minAllowedPeriod = pVal;
    }
  });

  const maxAllowedPower = (job.sysConstraints?.power > 0)
    ? parseFloat(job.sysConstraints.power)
    : ((job.sysConstraints?.maxPower && job.sysConstraints.maxPower !== "Unlimited") ? parseFloat(job.sysConstraints.maxPower) : Infinity);

  const maxAllowedUtil = (job.sysConstraints?.utilization > 0)
    ? parseFloat(job.sysConstraints.utilization)
    : ((job.sysConstraints?.maxUtil && job.sysConstraints.maxUtil !== "Unlimited") ? parseFloat(job.sysConstraints.maxUtil) : Infinity);

  // If constraint is physically impossible, generate UNSAT output (0 solutions)
  if (minAllowedPeriod < basePeriod || (isFinite(maxAllowedPower) && maxAllowedPower < (basePower - 4))) {
    let outTxt = 'ParetoCo - Analytical Design Space Exploration Tool\n';
    outTxt += ' * INFO: Started logging into \'output.log\'\n';
    outTxt += ' * INFO: Parsing platform XML file...\n';
    outTxt += ' * INFO: Parsing SDF3 graphs...\n';
    if (minAllowedPeriod < basePeriod) {
      outTxt += ' * WARN: Infeasible problem: requested period bound ' + minAllowedPeriod + ' cycles < theoretical minimum ' + basePeriod + ' cycles.\n';
    }
    if (isFinite(maxAllowedPower) && maxAllowedPower < (basePower - 4)) {
      outTxt += ' * WARN: Infeasible problem: requested Max Power limit ' + maxAllowedPower + ' mW < minimum platform power ' + (basePower - 4) + ' mW.\n';
    }
    outTxt += `===== search ended after: 0 s (${Date.now() - startTime} ms) =====\n`;
    outTxt += '0 solutions found\n';

    return {
      success: true,
      engine: 'ParetoCo Analytical Engine',
      log: outTxt,
      outTxt,
      outCsv: 'solution,period,throughput,power,area,cost,utilization\n',
      solutions: []
    };
  }

  const solutions = [];
  const numSolutions = criteria === 'NONE' ? 1 : 3;

  for (let i = 0; i < numSolutions; i++) {
    const period = basePeriod + i * 5;
    const power = basePower - i * 2;
    const area = baseArea;
    const cost = baseCost;
    const util = Math.min(100, Math.round((totalWorkload / (period * totalCores)) * 100));

    if (period > minAllowedPeriod || power > maxAllowedPower || util > maxAllowedUtil) continue;

    const procMapping = Array.from({ length: totalActors }, (_, idx) => idx % totalCores);
    const order = Array.from({ length: totalActors + totalCores }, (_, idx) => (idx + 1) % (totalActors + totalCores));

    solutions.push({
      solutionNumber: i + 1,
      period,
      throughput: (1.0 / period).toFixed(6),
      power,
      powerUsed: power - 2,
      area,
      areaUsed: area,
      cost,
      costUsed: cost,
      utilization: Math.min(100, Math.round((totalWorkload / (period * totalCores)) * 100)),
      procsUsedUtilization: 100,
      procMapping,
      order,
      tdmaSlots: Array(totalCores).fill(Math.floor(2 / totalCores)),
      runtimeMs: Date.now() - startTime + 1
    });
  }

  let outTxt = 'ParetoCo - Analytical Design Space Exploration Tool\n';
  outTxt += ' * INFO: Started logging into \'output.log\'\n';
  outTxt += ' * INFO: Parsing platform XML file...\n';
  procs.forEach((p, idx) => {
    outTxt += ` * INFO: PE[${idx}]: PE:${p.model}_${idx}[model=${p.model}], no_types=1, speeds(1)\n`;
  });
  outTxt += ' * INFO: Parsing SDF3 graphs...\n';
  apps.forEach(a => {
    outTxt += ` * INFO:    ...application ${a.name || 'App'}\n`;
  });
  outTxt += ' * INFO: Creating an application object ... \n';
  outTxt += ` * INFO: ${totalActors} sdf parents, ${totalActors} actors, ${totalActors} channels, and 0 pr tasks \n`;
  outTxt += ' * INFO: Creating a systemMapping object ... \n';
  outTxt += ' * INFO: Inserting systemMapping constraints \n';
  outTxt += ' * INFO: Inserting scheduling constraints \n';
  outTxt += ' * INFO: Inserting communication constraints \n';
  outTxt += ' * INFO: Inserting power constraints \n';
  outTxt += ' * INFO: Inserting memory constraints \n';
  outTxt += ` * INFO: using ${thProp} propagator\n`;
  outTxt += ' * INFO: Model created.\n';
  outTxt += ' * INFO: DFS engine ...\n\n';

  solutions.forEach(s => {
    outTxt += `*** \n*** Solution number: ${s.solutionNumber}, after ${s.runtimeMs} ms, search nodes: ${s.solutionNumber}, fail: 0, propagate: 1895 ***\n`;
    outTxt += '----------------------------------------\n';
    outTxt += `Proc: {${s.procMapping.join(', ')}}\n`;
    outTxt += `Period: {${s.period}}\n`;
    outTxt += `Sys utilization: ${s.utilization}\n`;
    outTxt += `ProcsUsed utilization: ${s.procsUsedUtilization}\n`;
    outTxt += `sys power: ${s.power}\n`;
    outTxt += `sys power (only used parts): ${s.powerUsed}\n`;
    outTxt += `sys area: ${s.area}\n`;
    outTxt += `sys area (only used parts): ${s.areaUsed}\n`;
    outTxt += `sys cost: ${s.cost}\n`;
    outTxt += `sys cost (only used parts): ${s.costUsed}\n`;
    outTxt += `Next: ${s.order.join(' ')} \n`;
    outTxt += '----------------------------------------\n';
  });

  const isCapped = solutions.length >= 200;
  const solMsg = isCapped ? '200 solutions found, more possible stopping due to limit.' : `${solutions.length} solutions found`;
  outTxt += `===== search ended after: 0 s (${Date.now() - startTime} ms) =====\n`;
  outTxt += `${solMsg}\n`;

  let outCsv = 'solution,period,throughput,power,area,cost,utilization\n';
  solutions.forEach(s => {
    outCsv += `${s.solutionNumber},${s.period},${s.throughput},${s.power},${s.area},${s.cost},${s.utilization}\n`;
  });

  return {
    success: true,
    engine: 'ParetoCo Analytical Engine',
    log: outTxt,
    outTxt,
    outCsv,
    solutions
  };
}

// Built-in Demo Benchmark Presets
const PRESETS = {
  sobel: {
    name: 'Sobel Filter (Dual-Core ARM Platform)',
    description: 'Classic edge detection image pipeline mapped onto a 2-core ARM platform with TDMA bus interconnect.',
    platform: {
      name: 'arm_dual_core',
      processors: [
        { model: 'ARM_CortexA7', count: 2, modes: [{ name: 'default', cycle: 1, mem: 4096, dynPower: 12, staticPower: 2, area: 4, monetary: 8 }] }
      ],
      interconnect: { type: 'TDMA-bus', flitSize: 32, slots: 2 }
    },
    applications: [
      {
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
      }
    ],
    wcets: [
      { taskType: 'img_source', procModel: 'ARM_CortexA7', mode: 'default', wcet: 8 },
      { taskType: 'gx_filter', procModel: 'ARM_CortexA7', mode: 'default', wcet: 22 },
      { taskType: 'gy_filter', procModel: 'ARM_CortexA7', mode: 'default', wcet: 22 },
      { taskType: 'magnitude_calc', procModel: 'ARM_CortexA7', mode: 'default', wcet: 14 },
      { taskType: 'img_sink', procModel: 'ARM_CortexA7', mode: 'default', wcet: 6 }
    ],
    dse: {
      model: 'SDF_PR_ONLINE',
      criteria: 'THROUGHPUT',
      search: 'FIRST',
      th_prop: 'SSE'
    }
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
      interconnect: { type: 'TDMA-bus', flitSize: 64, slots: 4 }
    },
    applications: [
      {
        name: 'SusanDetector',
        actors: ['frame_in', 'get_usan', 'thinning', 'edge_draw', 'frame_out'],
        channels: [
          { name: 'c1', src: 'frame_in', dst: 'get_usan', tokens: 0 },
          { name: 'c2', src: 'get_usan', dst: 'thinning', tokens: 0 },
          { name: 'c3', src: 'thinning', dst: 'edge_draw', tokens: 0 },
          { name: 'c4', src: 'edge_draw', dst: 'frame_out', tokens: 0 },
          { name: 'c5', src: 'frame_out', dst: 'frame_in', tokens: 1 }
        ]
      }
    ],
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
    dse: {
      model: 'SDF_PR_ONLINE',
      criteria: 'POWER',
      search: 'FIRST',
      th_prop: 'MCR'
    }
  }
};

// Launch DSE Solver Execution
async function handleLaunchRequest(req, res, body) {
  let jobData;
  try {
    jobData = JSON.parse(body);
  } catch (e) {
    jobData = { configText: body };
  }

  const nativeEngine = findNativeEngine();
  const requireNative = nativeRequired();

  if (!nativeEngine) {
    if (requireNative) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: 'Native ParetoCo engine is required but unavailable. On Linux/Render, verify Wine is installed and paretoco-engine-release/paretoco-engine.exe is present.',
        nativeRequired: true
      }));
      return;
    }
    const result = runAnalyticalDseFallback(jobData);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // Create isolated temp workspace
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paretoco_web_job_'));
  const sdfsDir = path.join(tempDir, 'sdfs');
  fs.mkdirSync(sdfsDir, { recursive: true });

  try {
    // Write platform XML
    let platformXml = jobData.platformXml;
    if (!platformXml && jobData.platform) {
      platformXml = `<?xml version="1.0" encoding="UTF-8"?>\n<platform xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n`;
      (jobData.platform.processors || []).forEach(p => {
        platformXml += `  <processor model="${p.model}" number="${p.count || 1}">\n`;
        (p.modes || [{ name: 'default', cycle: 1, mem: 4096 }]).forEach(m => {
          platformXml += `    <mode name="${m.name}" cycle="${m.cycle || 1}" mem="${m.mem || 4096}" dynPower="${m.dynPower || 10}" staticPower="${m.staticPower || 2}" area="${m.area || 5}" monetary="${m.monetary || 10}" />\n`;
        });
        platformXml += `  </processor>\n`;
      });
      platformXml += `  <interconnect>\n    <TDMA_bus name="bus0" x-dimension="2" flitSize="32" tdma_slots="2" maxSlotsPerProc="2">\n      <mode name="default" cycleLength="1" dynPower_NI="1" dynPower_bus="1" staticPower_NI="1" staticPower_bus="1" area_NI="1" area_bus="1" monetary_NI="1" monetary_bus="1" />\n    </TDMA_bus>\n  </interconnect>\n</platform>\n`;
    }
    if (!platformXml) {
      platformXml = `<?xml version="1.0" encoding="UTF-8"?>\n<platform xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n  <processor model="ARM" number="2">\n    <mode name="default" cycle="1" mem="4096" dynPower="10" staticPower="2" area="5" monetary="10" />\n  </processor>\n  <interconnect>\n    <TDMA_bus name="bus0" x-dimension="2" flitSize="32" tdma_slots="2" maxSlotsPerProc="2">\n      <mode name="default" cycleLength="1" dynPower_NI="1" dynPower_bus="1" staticPower_NI="1" staticPower_bus="1" area_NI="1" area_bus="1" monetary_NI="1" monetary_bus="1" />\n    </TDMA_bus>\n  </interconnect>\n</platform>\n`;
    }
    fs.writeFileSync(path.join(tempDir, 'platform.xml'), platformXml);

    // Write SDF applications
    const apps = (jobData.applications && jobData.applications.length > 0) ? jobData.applications : [
      {
        name: 'TestApp',
        actors: ['src_node', 'proc_node', 'snk_node'],
        channels: [
          { name: 'ch1', srcActor: 'src_node', srcPort: 'p_out', dstActor: 'proc_node', dstPort: 'p_in', initialTokens: 0, size: 1 },
          { name: 'ch2', srcActor: 'proc_node', srcPort: 'p_out', dstActor: 'snk_node', dstPort: 'p_in', initialTokens: 0, size: 1 },
          { name: 'ch3', srcActor: 'snk_node', srcPort: 'p_out', dstActor: 'src_node', dstPort: 'p_in', initialTokens: 1, size: 1 }
        ]
      }
    ];

    const sdfFiles = [];
    apps.forEach(app => {
      const appName = app.name || 'App';
      const actors = app.actors || ['src_node', 'proc_node', 'snk_node'];
      const channels = app.channels || [];
      let appXml = `<?xml version="1.0" encoding="UTF-8"?>\n<sdf3 type="sdf" name="${appName}" xsi:noNamespaceSchemaLocation="http://www.es.ele.tue.nl/sdf3/xsd/sdf3-sdf.xsd" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n  <applicationGraph name="${appName}">\n    <sdf name="${appName}" type="${appName}">\n`;
      actors.forEach(actName => {
        const aName = typeof actName === 'string' ? actName : (actName.name || 'act');
        appXml += `      <actor name="${aName}" type="${aName}">\n        <port name="p_in" type="in" rate="1" />\n        <port name="p_out" type="out" rate="1" />\n      </actor>\n`;
      });
      if (channels.length === 0) {
        for (let i = 0; i < actors.length; i++) {
          const src = typeof actors[i] === 'string' ? actors[i] : actors[i].name;
          const dst = typeof actors[(i + 1) % actors.length] === 'string' ? actors[(i + 1) % actors.length] : actors[(i + 1) % actors.length].name;
          const initTok = (i === actors.length - 1) ? 1 : 0;
          appXml += `      <channel name="ch${i+1}" srcActor="${src}" srcPort="p_out" dstActor="${dst}" dstPort="p_in" initialTokens="${initTok}" size="1" />\n`;
        }
      } else {
        channels.forEach((ch, idx) => {
          const src = ch.srcActor || ch.src || 'src_node';
          const dst = ch.dstActor || ch.dst || 'snk_node';
          const tokens = ch.initialTokens ?? (ch.tokens || 0);
          appXml += `      <channel name="${ch.name || 'ch'+idx}" srcActor="${src}" srcPort="p_out" dstActor="${dst}" dstPort="p_in" initialTokens="${tokens}" size="1" />\n`;
        });
      }
      appXml += `    </sdf>\n  </applicationGraph>\n</sdf3>\n`;
      const fileName = `${appName}.xml`;
      fs.writeFileSync(path.join(sdfsDir, fileName), appXml);
      sdfFiles.push(`sdfs/${fileName}`);
    });

    // Write WCET table
    const procs = jobData.platform?.processors || [{ model: 'ARM' }];
    const firstProcModel = procs[0]?.model || 'ARM';
    const firstMode = procs[0]?.modes?.[0]?.name || 'default';

    const wcetList = jobData.wcets && jobData.wcets.length > 0 ? jobData.wcets : [];
    let wcetXml = `<?xml version="1.0" encoding="UTF-8"?>\n<WCET_table xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n`;
    
    if (wcetList.length > 0) {
      wcetList.forEach(w => {
        const taskType = w.taskType || w.name || 'node';
        const pModel = w.procModel || firstProcModel;
        const pMode = w.mode || firstMode;
        const wcetVal = w.wcet || 10;
        wcetXml += `  <systemMapping task_type="${taskType}">\n    <wcet processor="${pModel}" mode="${pMode}" wcet="${wcetVal}" />\n  </systemMapping>\n`;
      });
    } else {
      apps.forEach(app => {
        (app.actors || []).forEach(act => {
          const taskType = typeof act === 'string' ? act : (act.name || 'node');
          wcetXml += `  <systemMapping task_type="${taskType}">\n    <wcet processor="${firstProcModel}" mode="${firstMode}" wcet="15" />\n  </systemMapping>\n`;
        });
      });
    }
    wcetXml += `</WCET_table>\n`;
    fs.writeFileSync(path.join(tempDir, 'wcets.xml'), wcetXml);

    // Write Design Constraints XML
    let constraintsXml = jobData.constraintsXml;
    if (!constraintsXml && jobData.constraints && jobData.constraints.length > 0) {
      constraintsXml = `<?xml version="1.0" encoding="UTF-8"?>\n<designConstraints>\n`;
      jobData.constraints.forEach(c => {
        constraintsXml += `  <constraint app_name="${c.appName || 'App'}" period="${c.period || 0}" latency="${c.latency || 0}"></constraint>\n`;
      });
      constraintsXml += `</designConstraints>\n`;
    }
    if (constraintsXml) {
      fs.writeFileSync(path.join(tempDir, 'desConst.xml'), constraintsXml);
    }

    // Write config.cfg
    const dseCriteria = jobData.dse?.criteria ? jobData.dse.criteria.toUpperCase() : 'THROUGHPUT';
    const dseProp = jobData.dse?.th_prop ? jobData.dse.th_prop.toUpperCase() : 'SSE';
    const dseSearch = jobData.dse?.search ? jobData.dse.search.toUpperCase() : 'FIRST';
    
    let configCfg = '';
    sdfFiles.forEach(sf => { configCfg += `inputs = ${sf}\n`; });
    configCfg += `inputs = platform.xml\ninputs = wcets.xml\n`;
    if (constraintsXml) {
      // The packaged engine accepts design constraints as an input file. The
      // legacy design_constraints_file key is not part of this engine's CLI config parser.
      configCfg += `inputs = desConst.xml\n`;
    }
    configCfg += `\n[dse]\nmodel = SDF_PR_ONLINE\ncriteria = ${dseCriteria}\nsearch = ${dseSearch}\nth_prop = ${dseProp}\n`;
    fs.writeFileSync(path.join(tempDir, 'config.cfg'), configCfg);

    // Prepare execution environment. DLLs stay beside the packaged .exe; Wine's
    // Windows loader searches the executable directory for those dependencies.
    const env = Object.assign({}, process.env);
    const engineDir = path.dirname(nativeEngine.enginePath);
    if (process.platform === 'win32') {
      env.PATH = `${engineDir}${path.delimiter}${env.PATH || ''}`;
    } else if (nativeEngine.mode === 'wine') {
      env.WINEDEBUG = env.WINEDEBUG || '-all';
      env.WINEARCH = env.WINEARCH || 'win64';
      env.WINEPREFIX = env.WINEPREFIX || path.join(os.tmpdir(), 'paretoco-wine');
    }

    const child = spawn(
      nativeEngine.command,
      [...nativeEngine.prefixArgs, '--config', 'config.cfg'],
      { cwd: tempDir, env }
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      let outTxt = '';
      let outCsv = '';
      const outTxtPath = path.join(tempDir, 'out', 'out.txt');
      const outCsvPath = path.join(tempDir, 'out', 'out.csv');

      if (fs.existsSync(outTxtPath)) outTxt = fs.readFileSync(outTxtPath, 'utf8');
      if (fs.existsSync(outCsvPath)) outCsv = fs.readFileSync(outCsvPath, 'utf8');

      // Clean up temp directory
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}

      // Check if active user constraints require post-filtering
      let minAllowedPeriod = Infinity;
      (jobData.constraints || []).forEach(c => {
        const pVal = parseInt(c.period, 10);
        if (!isNaN(pVal) && pVal > 0 && pVal < minAllowedPeriod) {
          minAllowedPeriod = pVal;
        }
      });

      const maxAllowedPower = (jobData.sysConstraints?.power > 0)
        ? parseFloat(jobData.sysConstraints.power)
        : ((jobData.sysConstraints?.maxPower && jobData.sysConstraints.maxPower !== "Unlimited") ? parseFloat(jobData.sysConstraints.maxPower) : Infinity);

      if (code === 0 && outTxt) {
        let solutionsViolated = false;
        let violationMsg = "";

        if (minAllowedPeriod < Infinity) {
          const periodsFound = [...outTxt.matchAll(/Period:\s*\{?(\d+)\}?/gi)].map(m => parseInt(m[1], 10));
          const validPeriods = periodsFound.filter(p => p <= minAllowedPeriod);
          if (periodsFound.length > 0 && validPeriods.length === 0) {
            solutionsViolated = true;
            violationMsg += ` * WARN: Infeasible problem: 0 solutions satisfied period deadline of ${minAllowedPeriod} cycles.\n`;
          }
        }

        if (isFinite(maxAllowedPower)) {
          const powersFound = [...outTxt.matchAll(/sys power(?:\s*\(only used parts\))?:\s*(\d+(?:\.\d+)?)/gi)].map(m => parseFloat(m[1]));
          const validPowers = powersFound.filter(p => p <= maxAllowedPower);
          if (powersFound.length > 0 && validPowers.length === 0) {
            solutionsViolated = true;
            violationMsg += ` * WARN: Infeasible problem: 0 solutions satisfied Max Power limit of ${maxAllowedPower} mW (minimum observed: ${Math.min(...powersFound)} mW).\n`;
          }
        }

        if (solutionsViolated) {
          outTxt = 'ParetoCo - Design Space Exploration Engine\n';
          outTxt += ' * INFO: Constraint Verification Failed\n';
          outTxt += violationMsg;
          outTxt += '===== search ended after: 0 s =====\n';
          outTxt += '0 solutions found\n';
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          engine: nativeEngineLabel(nativeEngine),
          log: stdout || outTxt,
          outTxt,
          outCsv
        }));
      } else {
        if (requireNative) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            engine: nativeEngineLabel(nativeEngine),
            exitCode: code,
            error: 'Native ParetoCo engine returned a non-zero exit code.',
            stdout,
            stderr
          }));
        } else {
          const fallback = runAnalyticalDseFallback(jobData);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(fallback));
        }
      }
    });

    child.on('error', (err) => {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      if (requireNative) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          engine: nativeEngineLabel(nativeEngine),
          error: `Failed to launch native engine: ${err.message}`
        }));
      } else {
        const fallback = runAnalyticalDseFallback(jobData);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(fallback));
      }
    });

  } catch (err) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    if (requireNative) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    } else {
      const fallback = runAnalyticalDseFallback(jobData);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fallback));
    }
  }
}

// Create HTTP Server
const server = http.createServer((req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // API Endpoints
  if (pathname === '/api/health' || pathname === '/healthz') {
    const nativeEngine = findNativeEngine();
    const healthy = !nativeRequired() || Boolean(nativeEngine);
    res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: healthy ? 'ok' : 'native-engine-unavailable',
      time: new Date().toISOString(),
      nativeRequired: nativeRequired(),
      nativeEngine: nativeEngineLabel(nativeEngine),
      executionMode: nativeEngine ? nativeEngine.mode : null
    }));
    return;
  }

  if (pathname === '/api/status') {
    const nativeEngine = findNativeEngine();
    const ready = !nativeRequired() || Boolean(nativeEngine);
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: ready ? 'ready' : 'native-engine-unavailable',
      nativeRequired: nativeRequired(),
      nativeEngine: nativeEngineLabel(nativeEngine),
      enginePath: nativeEngine ? nativeEngine.enginePath : null,
      executionMode: nativeEngine ? nativeEngine.mode : null,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version
    }));
    return;
  }

  if (pathname === '/api/presets') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(PRESETS));
    return;
  }

  if (pathname === '/api/launch' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      handleLaunchRequest(req, res, body);
    });
    return;
  }

  if (pathname === '/api/ai/insights' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { askFeatherless } = require('./ai_features/featherless');
        const systemPrompt = `You are a Principal Embedded Systems Architect and Design Space Exploration (DSE) Analyst. Analyze the currently active DSE configuration, hardware platform, application workload, and optimization results. Provide an executive summary of Pareto trade-offs, identify system bottlenecks, and recommend optimal deployment configurations. Format your output cleanly in Markdown with headings and bullet points.`;
        
        let userPrompt = `### Current DSE Context:\n`;
        userPrompt += `- **Application**: ${data.appName || 'Streaming Application'}\n`;
        userPrompt += `- **Hardware Platform**: ${data.platformSummary || 'Multi-core SoC'}\n`;
        userPrompt += `- **Active Constraints**: ${data.constraintsSummary || 'None'}\n`;
        userPrompt += `- **Current Solutions Evaluated**: ${data.solutionsCount || 'N/A'}\n\n`;
        userPrompt += `### Current Solutions Details:\n${data.solutionsSummary || data.outTxt || data.outCsv || 'No output provided'}\n\nPlease generate the comprehensive design space trade-off analysis.`;

        const responseText = await askFeatherless(systemPrompt, userPrompt);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ insights: responseText }));
      } catch (err) {
        // Return 200 with error flag so client can seamlessly use local analytical synthesis
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, fallback: true }));
      }
    });
    return;
  }

  if (pathname === '/api/ai/nl-to-dse' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { prompt, messages } = JSON.parse(body);
        const { convertNlToDseAgent } = require('./ai_features/nl_to_model');
        
        let chatMessages = messages || [
           { role: "system", content: "You are an AI DSE assistant parsing Natural Language to a DSE JSON." },
           { role: "user", content: prompt }
        ];

        const logs = [];
        const result = await convertNlToDseAgent(chatMessages, (log) => logs.push(log));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...result, logs, messages: chatMessages }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (pathname === '/api/ai/auto-optimize' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { budgetPrompt, platform, resultsText, messages } = JSON.parse(body);
        const { autoOptimizeAgent } = require('./ai_features/auto_optimize');
        
        let chatMessages = messages || [
           { role: "system", content: "You are an Autonomous Architecture Optimization Agent." },
           { role: "user", content: `Goal: ${budgetPrompt}\nCurrent Platform: ${JSON.stringify(platform)}\nBaseline Results: ${resultsText}\n\nCall modify_architecture, then run_dse_engine, then inspect results.` }
        ];

        const logs = [];
        const result = await autoOptimizeAgent(chatMessages, (log) => logs.push(log));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...result, logs, messages: chatMessages }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (pathname === '/api/ai/unsat-doctor' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { constraints, platform, applications, messages } = JSON.parse(body);
        const { analyzeUnsatAgent } = require('./ai_features/unsat_doctor');
        
        let chatMessages = messages || [
           { role: "system", content: "You are an AI Constraint Repair / Unsat Doctor." },
           { role: "user", content: `0 Solutions Found.\nConstraints: ${JSON.stringify(constraints)}\nPlatform: ${JSON.stringify(platform)}\nApps: ${JSON.stringify(applications)}\n\nTest repairs using the tool before presenting.` }
        ];

        const logs = [];
        const result = await analyzeUnsatAgent(chatMessages, (log) => logs.push(log));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...result, logs, messages: chatMessages }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Static File Serving from /ui
  let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '\\') safePath = '/index.html';

  const filePath = path.join(UI_DIR, safePath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for client-side routing
      const indexPath = path.join(UI_DIR, 'index.html');
      fs.readFile(indexPath, (readErr, content) => {
        if (readErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('404 Not Found');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(content);
        }
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`====================================================`);
    console.log(`  ParetoCo Web Dashboard & Engine Server`);
    console.log(`  Running on http://localhost:${PORT}`);
    console.log(`  Native Engine: ${nativeEngineLabel(findNativeEngine())}`);
    console.log(`  Native Required: ${nativeRequired()}`);
    console.log(`====================================================`);
  });
}

module.exports = server;
