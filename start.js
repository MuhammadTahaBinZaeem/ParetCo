'use strict';

/**
 * ParetoCo production bootstrap.
 *
 * - Enables useful Wine error diagnostics without noisy fixme/trace output.
 * - Captures native-engine stdout + stderr on non-zero exits.
 * - Injects a concise diagnostic block into stderr so the existing API/UI
 *   displays the real failure instead of only the generic exit-code message.
 * - Runs one retained native regression fixture after startup as a deployment
 *   smoke test, proving that the packaged .exe can execute under Wine.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const ROOT_DIR = __dirname;
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

    // Render captures console.error as application logs.
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

function findWineBinary() {
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
      const probe = childProcess.spawnSync(candidate, ['--version'], {
        encoding: 'utf8',
        timeout: 3000,
        env: { ...process.env, WINEDEBUG: WINE_DEBUG }
      });
      if (!probe.error && probe.status === 0) return candidate;
    } catch (_) {}
  }

  return null;
}

function runNativeSmokeTest() {
  const enginePath = path.resolve(
    process.env.PARETOCO_ENGINE || path.join(ROOT_DIR, 'paretoco-engine-release', 'paretoco-engine.exe')
  );
  const fixtureDir = path.join(ROOT_DIR, 'tests', 'fixtures', 'generated', 'run_0');
  const configPath = path.join(fixtureDir, 'config.cfg');

  if (!fs.existsSync(enginePath)) {
    console.error(`[native-smoke] FAIL: engine missing: ${enginePath}`);
    return;
  }
  if (!fs.existsSync(configPath)) {
    console.error(`[native-smoke] SKIP: fixture missing: ${configPath}`);
    return;
  }

  const wine = process.platform === 'win32' ? null : findWineBinary();
  if (process.platform !== 'win32' && !wine) {
    console.error('[native-smoke] FAIL: Wine executable not found.');
    return;
  }

  const command = process.platform === 'win32' ? enginePath : wine;
  const args = process.platform === 'win32'
    ? ['--config', 'config.cfg']
    : [enginePath, '--config', 'config.cfg'];

  console.log(`[native-smoke] launching retained regression fixture via ${process.platform === 'win32' ? 'native Windows' : path.basename(wine)}`);

  let stdout = '';
  let stderr = '';
  let timedOut = false;

  const child = childProcess.spawn(command, args, {
    cwd: fixtureDir,
    env: {
      ...process.env,
      WINEDEBUG: WINE_DEBUG,
      WINEARCH: process.env.WINEARCH || 'win64',
      WINEPREFIX: process.env.WINEPREFIX || path.join(os.tmpdir(), 'paretoco-wine')
    }
  });

  child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr?.on('data', chunk => { stderr += chunk.toString(); });

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 30_000);
  timer.unref?.();

  child.on('close', (code, signal) => {
    clearTimeout(timer);
    const combined = `${stdout}\n${stderr}`;
    const matches = [...combined.matchAll(/(\d+)\s+solutions?/gi)];
    const solutions = matches.length ? Number(matches[matches.length - 1][1]) : 0;

    if (!timedOut && code === 0) {
      console.log(`[native-smoke] PASS: exit 0, solutions=${solutions}`);
      return;
    }

    console.error(`[native-smoke] FAIL: ${timedOut ? 'timeout' : `exit ${code}`}, signal=${signal || 'none'}, solutions=${solutions}`);
  });
}

const server = require('./server');

server.listen(PORT, HOST, () => {
  console.log('====================================================');
  console.log('  ParetoCo Web Dashboard & Engine Server');
  console.log(`  Running on http://${HOST}:${PORT}`);
  console.log(`  Wine diagnostics: ${WINE_DEBUG}`);
  console.log('====================================================');

  // Keep the HTTP service available while the smoke test runs asynchronously.
  setTimeout(runNativeSmokeTest, 250).unref?.();
});
