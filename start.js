'use strict';

/**
 * ParetoCo production bootstrap.
 * Keeps Wine/native stderr visible and runs end-to-end search-mode probes after boot.
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
  return isWineCommand(command) && (args || []).some(arg => /paretoco-engine\.exe$/i.test(String(arg)));
}

function formatNativeDiagnostic({ command, args, cwd, code, signal, stdout, stderr }) {
  return [
    '[native-diagnostics]',
    `command: ${[command, ...(args || [])].join(' ')}`,
    `cwd: ${cwd || process.cwd()}`,
    `platform: ${process.platform}/${process.arch}`,
    `wineDebug: ${WINE_DEBUG}`,
    `winePrefix: ${process.env.WINEPREFIX || path.join(os.tmpdir(), 'paretoco-wine')}`,
    `exitCode: ${code}`,
    `signal: ${signal || 'none'}`,
    '--- native stdout (tail) ---',
    tail(stdout).trim() || '<empty>',
    '--- wine/native stderr (tail) ---',
    tail(stderr).trim() || '<empty>',
    '[/native-diagnostics]'
  ].join('\n');
}

// Patch spawn before server.js captures child_process.spawn.
const originalSpawn = childProcess.spawn;
childProcess.spawn = function patchedSpawn(command, args = [], options = {}) {
  const launchOptions = isWineCommand(command)
    ? { ...options, env: { ...(options.env || process.env), WINEDEBUG: WINE_DEBUG } }
    : options;

  const child = originalSpawn.call(childProcess, command, args, launchOptions);
  if (!isParetoCoInvocation(command, args)) return child;

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => { stdout = tail(stdout + chunk.toString(), DIAGNOSTIC_TAIL * 2); });
  child.stderr?.on('data', chunk => { stderr = tail(stderr + chunk.toString(), DIAGNOSTIC_TAIL * 2); });

  child.on('close', (code, signal) => {
    if (code === 0) return;
    const diagnostic = formatNativeDiagnostic({ command, args, cwd: launchOptions.cwd, code, signal, stdout, stderr });
    console.error(diagnostic);
    // server.js already returns child stderr to the browser; inject the richer block.
    child.stderr?.emit?.('data', Buffer.from(`\n${diagnostic}\n`));
  });

  return child;
};

function smokeJob(search) {
  return {
    platform: {
      processors: [{
        model: 'ARM', count: 2,
        modes: [{ name: 'default', cycle: 1, mem: 4096, dynPower: 10, staticPower: 2, area: 5, monetary: 10 }]
      }]
    },
    applications: [{
      name: 'SmokeApp',
      actors: ['src_node', 'proc_node', 'snk_node'],
      channels: [
        { name: 'ch1', src: 'src_node', dst: 'proc_node', tokens: 0 },
        { name: 'ch2', src: 'proc_node', dst: 'snk_node', tokens: 0 },
        { name: 'ch3', src: 'snk_node', dst: 'src_node', tokens: 1 }
      ]
    }],
    wcets: [
      { taskType: 'src_node', procModel: 'ARM', mode: 'default', wcet: 10 },
      { taskType: 'proc_node', procModel: 'ARM', mode: 'default', wcet: 25 },
      { taskType: 'snk_node', procModel: 'ARM', mode: 'default', wcet: 15 }
    ],
    constraints: [{ appName: 'SmokeApp', period: 1000, latency: 0 }],
    dse: { model: 'SDF_PR_ONLINE', criteria: 'POWER', search, th_prop: 'SSE' }
  };
}

function postLaunch(search) {
  return new Promise(resolve => {
    const payload = JSON.stringify(smokeJob(search));
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const request = http.request({
      hostname: '127.0.0.1', port: Number(PORT), path: '/api/launch', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 20_000
    }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk.toString(); });
      response.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch (_) {}
        const output = String(parsed.outTxt || parsed.log || parsed.stdout || '');
        const found = [...output.matchAll(/(?:Solution number:|solution found so far|solutions found)[^\d]*(\d+)/gi)];
        const solutions = found.length ? Number(found[found.length - 1][1]) : 0;
        finish({ search, status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300 && parsed.success !== false, solutions, parsed });
      });
    });

    request.on('timeout', () => { request.destroy(); finish({ search, ok: false, timeout: true, solutions: 0 }); });
    request.on('error', err => finish({ search, ok: false, error: err.message, solutions: 0 }));
    request.write(payload);
    request.end();
  });
}

async function runSearchModeProbes() {
  for (const search of ['FIRST', 'ALL', 'OPTIMIZE', 'OPTIMIZE_IT']) {
    const result = await postLaunch(search);
    if (result.ok) {
      console.log(`[search-probe] ${search}: PASS HTTP ${result.status}, solutions=${result.solutions}`);
    } else {
      console.error(`[search-probe] ${search}: FAIL ${result.timeout ? 'timeout' : `HTTP ${result.status || 'n/a'}`}, solutions-before-failure=${result.solutions}`);
      const stdout = result.parsed?.stdout;
      if (stdout) console.error(`[search-probe] ${search} stdout:\n${tail(stdout, 3000)}`);
    }
  }
}

const server = require('./server');

server.listen(PORT, HOST, () => {
  console.log('====================================================');
  console.log('  ParetoCo Web Dashboard & Engine Server');
  console.log(`  Running on http://${HOST}:${PORT}`);
  console.log(`  Wine diagnostics: ${WINE_DEBUG}`);
  console.log('====================================================');
  setTimeout(() => runSearchModeProbes().catch(err => console.error(`[search-probe] fatal: ${err.message}`)), 500).unref?.();
});
