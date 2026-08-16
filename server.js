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
