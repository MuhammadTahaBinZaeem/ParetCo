'use strict';

/**
 * ParetoCo HTTP entrypoint.
 *
 * Runtime responsibilities live in explicit modules under ./server:
 * - engine_bridge: native ParetoCo/Wine execution
 * - serializers: structured model -> native XML/config
 * - validation: launch contract validation
 * - ai_routes: Featherless agent endpoints
 * - static_files: dashboard asset serving
 * - presets: built-in runnable examples
 *
 * No source rewriting or child_process monkey-patching occurs at startup.
 */
const http = require('http');
const { URL } = require('url');
const { runDseJob, engineStatus } = require('./server/engine_bridge');
const { PRESETS } = require('./server/presets');
const { handleAiRoute } = require('./server/ai_routes');
const { serveStatic } = require('./server/static_files');
const { readJson, sendJson, sendError } = require('./server/http_utils');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function nativeSolutionCount(text) {
  const matches = [...String(text || '').matchAll(/(\d+)\s+solutions?\s+found/gi)];
  return matches.length ? Number(matches[matches.length - 1][1]) : 0;
}

async function runDemoSmoke() {
  if (String(process.env.PARETOCO_DEMO_SMOKE || 'true').toLowerCase() === 'false') return;
  try {
    const result = await runDseJob(PRESETS.demo, { requireNative: true, timeoutMs: 45_000 });
    const text = result.outTxt || result.log || result.stdout || '';
    const count = nativeSolutionCount(text);
    if (!result.success || result.approximate || count < 1) {
      throw new Error(`Demo completed without a verified native solution (solutions=${count}).`);
    }
    console.log(`[demo-smoke] PASS: exact UI demo completed natively with ${count} solution(s).`);
  } catch (error) {
    console.error(`[demo-smoke] FAIL: ${error.message}`);
    if (error.stdout) console.error('[demo-smoke stdout]', String(error.stdout).slice(-12000));
    if (error.stderr) console.error('[demo-smoke stderr]', String(error.stderr).slice(-12000));
  }
}

async function handleApi(pathname, req, res) {
  if (pathname === '/api/health' || pathname === '/healthz') {
    const status = engineStatus();
    sendJson(res, status.ready ? 200 : 503, {
      status: status.ready ? 'ok' : 'native-engine-unavailable',
      time: new Date().toISOString(),
      ...status
    });
    return true;
  }

  if (pathname === '/api/status') {
    const status = engineStatus();
    sendJson(res, status.ready ? 200 : 503, {
      status: status.ready ? 'ready' : 'native-engine-unavailable',
      ...status
    });
    return true;
  }

  if (pathname === '/api/presets' && req.method === 'GET') {
    sendJson(res, 200, PRESETS);
    return true;
  }

  if (pathname === '/api/launch' && req.method === 'POST') {
    try {
      const job = await readJson(req);
      const result = await runDseJob(job);
      sendJson(res, 200, result);
    } catch (error) {
      console.error('[native-launch]', error.message);
      if (error.stderr) console.error('[native-launch stderr]', String(error.stderr).slice(-8000));
      if (error.stdout) console.error('[native-launch stdout]', String(error.stdout).slice(-8000));
      sendError(res, error);
    }
    return true;
  }

  return handleAiRoute(pathname, req, res);
}

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (parsed.pathname.startsWith('/api/') || parsed.pathname === '/healthz') {
      const handled = await handleApi(parsed.pathname, req, res);
      if (!handled) sendJson(res, 404, { error: 'API endpoint not found.' });
      return;
    }
    serveStatic(parsed.pathname, res);
  } catch (error) {
    console.error('[http]', error);
    if (!res.headersSent) sendError(res, error);
    else res.end();
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const status = engineStatus();
    console.log('====================================================');
    console.log('  ParetoCo Web Dashboard & Native DSE Server');
    console.log(`  Running on http://${HOST}:${PORT}`);
    console.log(`  Native Engine: ${status.nativeEngine}`);
    console.log(`  Native Required: ${status.nativeRequired}`);
    console.log('  Architecture: modular source, no runtime rewrites');
    console.log('====================================================');
    setImmediate(() => runDemoSmoke());
  });
}

module.exports = server;