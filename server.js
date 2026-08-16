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
