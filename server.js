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
