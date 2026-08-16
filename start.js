'use strict';

/**
 * ParetoCo production bootstrap.
 *
 * - Enables useful Wine error diagnostics without noisy fixme/trace output.
 * - Captures native-engine stdout + stderr on non-zero exits.
 * - Injects a concise diagnostic block into stderr so the existing API/UI
 *   displays the real failure instead of only the generic exit-code message.
 * - Runs a real /api/launch request after startup, including a design
 *   constraint, so Render validates the exact production code path.
 */

const http = require('http');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DIAGNOSTIC_TAIL = 12_000;
const WINE_DEBUG = process.env.PARETOCO_WINEDEBUG || '-all,err+all';

function tail(text, limit = DIAGNOSTIC_TAIL) {
  const value = String(text || '');
  return value.length > limit ? value.slice(-limit) : value;
}

function isWineCommand(command) {
  const base = path.basename(String(command || '')).toLowerCase();
  return base === 'wine' || base === 'wine64';
}

function isParetoCoInvocation(command, args) {
  if (!isWineCommand(command)) return false;
  return (args || []).some(arg => /paretoco-engine\.exe$/i.test(String(arg)));
}

function formatNativeDiagnostic({ command, args, cwd, code, signal, stdout, stderr }) {
  const commandLine = [command, ...(args || [])].map(value => String(value)).join(' ');
  const lines = [
    '[native-diagnostics]',
    `command: ${commandLine}`,
    `cwd: ${cwd || process.cwd()}`,
    `platform: ${process.platform}/${process.arch}`,
    `wineDebug: ${WINE_DEBUG}`,
    `winePrefix: ${process.env.WINEPREFIX || path.join(os.tmpdir(), 'paretoco-wine')}`,
    `exitCode: ${code}`,
    `signal: ${signal || 'none'}`
  ];

  const cleanStdout = tail(stdout).trim();
  const cleanStderr = tail(stderr).trim();

  lines.push('--- native stdout (tail) ---');
  lines.push(cleanStdout || '<empty>');
  lines.push('--- wine/native stderr (tail) ---');
  lines.push(cleanStderr || '<empty>');
  lines.push('[/native-diagnostics]');

  return lines.join('\n');
}

// Patch spawn before server.js imports { spawn }. This keeps the native bridge
// implementation intact while making failures observable in Render and in the UI.
const originalSpawn = childProcess.spawn;
childProcess.spawn = function patchedSpawn(command, args = [], options = {}) {
  let launchOptions = options;

  if (isWineCommand(command)) {
    launchOptions = {
      ...options,
      env: {
        ...(options.env || process.env),
        WINEDEBUG: WINE_DEBUG
      }
    };
  }

  const child = originalSpawn.call(childProcess, command, args, launchOptions);

  if (!isParetoCoInvocation(command, args)) return child;

  let stdout = '';
  let stderr = '';

  child.stdout?.on('data', chunk => {
    stdout += chunk.toString();
    if (stdout.length > DIAGNOSTIC_TAIL * 2) stdout = tail(stdout);
  });

  child.stderr?.on('data', chunk => {
    stderr += chunk.toString();
    if (stderr.length > DIAGNOSTIC_TAIL * 2) stderr = tail(stderr);
  });

  child.on('close', (code, signal) => {
    if (code === 0) return;

    const diagnostic = formatNativeDiagnostic({
      command,
      args,
      cwd: launchOptions.cwd,
      code,
      signal,
      stdout,
      stderr
    });

    console.error(diagnostic);

    // server.js already accumulates child.stderr and returns it in the API error.
    // Emit the diagnostic before its close handler runs so the existing frontend
    // can display Wine errors, native stdout, and the exit context immediately.
    if (child.stderr && typeof child.stderr.emit === 'function') {
      child.stderr.emit('data', Buffer.from(`\n${diagnostic}\n`));
    }
  });

  return child;
};

function runApiSmokeTest() {
  const payload = JSON.stringify({
    platform: {
      processors: [
        {
          model: 'ARM',
          count: 2,
          modes: [
            {
              name: 'default',
              cycle: 1,
              mem: 4096,
              dynPower: 10,
              staticPower: 2,
              area: 5,
              monetary: 10
            }
          ]
        }
      ]
    },
    applications: [
      {
        name: 'SmokeApp',
        actors: ['src_node', 'proc_node', 'snk_node'],
        channels: [
          { name: 'ch1', src: 'src_node', dst: 'proc_node', tokens: 0 },
          { name: 'ch2', src: 'proc_node', dst: 'snk_node', tokens: 0 },
          { name: 'ch3', src: 'snk_node', dst: 'src_node', tokens: 1 }
        ]
      }
    ],
    wcets: [
      { taskType: 'src_node', procModel: 'ARM', mode: 'default', wcet: 10 },
      { taskType: 'proc_node', procModel: 'ARM', mode: 'default', wcet: 25 },
      { taskType: 'snk_node', procModel: 'ARM', mode: 'default', wcet: 15 }
    ],
    // Include a design constraint on purpose: this validates the same desConst.xml
    // path that previously failed because of the unsupported design_constraints_file key.
    constraints: [
      { appName: 'SmokeApp', period: 1000, latency: 0 }
    ],
    dse: {
      model: 'SDF_PR_ONLINE',
      criteria: 'THROUGHPUT',
      search: 'FIRST',
      th_prop: 'SSE'
    }
  });

  const request = http.request({
    hostname: '127.0.0.1',
    port: Number(PORT),
    path: '/api/launch',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    },
    timeout: 30_000
  }, response => {
    let body = '';
    response.on('data', chunk => { body += chunk.toString(); });
    response.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (_) {}

      if (response.statusCode >= 200 && response.statusCode < 300 && parsed.success !== false) {
        const output = String(parsed.outTxt || parsed.log || '');
        const matches = [...output.matchAll(/(\d+)\s+solutions?/gi)];
        const solutions = matches.length ? Number(matches[matches.length - 1][1]) : 'unknown';
        console.log(`[api-smoke] PASS: /api/launch HTTP ${response.statusCode}, solutions=${solutions}`);
        return;
      }

      console.error(`[api-smoke] FAIL: /api/launch HTTP ${response.statusCode}`);
      if (parsed.error) console.error(`[api-smoke] error: ${parsed.error}`);
      if (parsed.stdout) console.error(`[api-smoke] stdout:\n${tail(parsed.stdout)}`);
      if (parsed.stderr) console.error(`[api-smoke] stderr:\n${tail(parsed.stderr)}`);
      if (!parsed.error && !parsed.stdout && !parsed.stderr) {
        console.error(`[api-smoke] body:\n${tail(body)}`);
      }
    });
  });

  request.on('timeout', () => {
    console.error('[api-smoke] FAIL: /api/launch timed out after 30s');
    request.destroy();
  });

  request.on('error', err => {
    console.error(`[api-smoke] FAIL: ${err.message}`);
  });

  request.write(payload);
  request.end();
}

const server = require('./server');

server.listen(PORT, HOST, () => {
  console.log('====================================================');
  console.log('  ParetoCo Web Dashboard & Engine Server');
  console.log(`  Running on http://${HOST}:${PORT}`);
  console.log(`  Wine diagnostics: ${WINE_DEBUG}`);
  console.log('====================================================');

  // Keep the HTTP service available while the end-to-end smoke test runs asynchronously.
  setTimeout(runApiSmokeTest, 500).unref?.();
});
