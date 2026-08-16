'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { validateStructuredLaunchJob } = require('./validation');
const {
  serializePlatform,
  serializeApplication,
  serializeWcets,
  serializeConstraints,
  serializeConfig
} = require('./serializers');
const { runAnalyticalDse } = require('./analytical_engine');

const ROOT_DIR = path.resolve(__dirname, '..');
const MAX_CAPTURE_BYTES = Math.max(1_000_000, Number(process.env.PARETOCO_NATIVE_MAX_CAPTURE_BYTES) || 8_000_000);
let cachedWineBinary;
let cachedEngine;

function nativeRequired() {
  return String(process.env.PARETOCO_REQUIRE_NATIVE || '').toLowerCase() === 'true';
}

function findWineBinary() {
  if (cachedWineBinary !== undefined) return cachedWineBinary;
  const candidates = [process.env.PARETOCO_WINE, '/usr/bin/wine64', '/usr/bin/wine', 'wine64', 'wine'].filter(Boolean);
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
    try {
      const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore', timeout: 3000 });
      if (!probe.error && probe.status === 0) return (cachedWineBinary = candidate);
    } catch (_) {}
  }
  return (cachedWineBinary = null);
}

function findNativeEngine() {
  if (cachedEngine !== undefined) return cachedEngine;
  const candidates = [
    process.env.PARETOCO_ENGINE,
    path.join(ROOT_DIR, 'paretoco-engine-release', 'paretoco-engine.exe'),
    path.join(ROOT_DIR, 'dist', process.platform === 'win32' ? 'paretoco-engine.exe' : 'paretoco-engine'),
    path.join(ROOT_DIR, 'bin', process.platform === 'win32' ? 'paretoco-engine.exe' : 'paretoco-engine')
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) continue;
    const windowsExe = resolved.toLowerCase().endsWith('.exe');
    if (process.platform === 'win32' || !windowsExe) {
      return (cachedEngine = { enginePath: resolved, command: resolved, prefixArgs: [], mode: process.platform === 'win32' ? 'native-windows' : 'native-linux' });
    }
    const wine = findWineBinary();
    if (wine) return (cachedEngine = { enginePath: resolved, command: wine, prefixArgs: [resolved], mode: 'wine' });
  }
  return (cachedEngine = null);
}

function nativeEngineLabel(engine = findNativeEngine()) {
  if (!engine) return 'unavailable';
  return engine.mode === 'wine'
    ? `${path.basename(engine.enginePath)} via ${path.basename(engine.command)}`
    : path.basename(engine.enginePath);
}

function writeWorkspace(job, tempDir) {
  const sdfsDir = path.join(tempDir, 'sdfs');
  fs.mkdirSync(sdfsDir, { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'platform.xml'), serializePlatform(job.platform), 'utf8');
  fs.writeFileSync(path.join(tempDir, 'wcets.xml'), serializeWcets(job.wcets), 'utf8');

  const sdfFiles = [];
  for (const app of job.applications || []) {
    const safeName = String(app.name || 'App').replace(/[^A-Za-z0-9._-]/g, '_');
    const relative = `sdfs/${safeName}.xml`;
    fs.writeFileSync(path.join(tempDir, relative), serializeApplication(app), 'utf8');
    sdfFiles.push(relative);
  }

  const constraintsXml = serializeConstraints(job.constraints, job.sysConstraints);
  if (constraintsXml) fs.writeFileSync(path.join(tempDir, 'desConst.xml'), constraintsXml, 'utf8');
  fs.writeFileSync(path.join(tempDir, 'config.cfg'), serializeConfig(job, sdfFiles, Boolean(constraintsXml)), 'utf8');
}

function appendBounded(current, chunk) {
  const next = current + String(chunk || '');
  return next.length > MAX_CAPTURE_BYTES ? next.slice(-MAX_CAPTURE_BYTES) : next;
}

function buildExecutionEnv(engine) {
  const env = { ...process.env };
  const engineDir = path.dirname(engine.enginePath);
  if (process.platform === 'win32') env.PATH = `${engineDir}${path.delimiter}${env.PATH || ''}`;
  if (engine.mode === 'wine') {
    env.WINEDEBUG = process.env.PARETOCO_WINEDEBUG || env.WINEDEBUG || '-all,err+all';
    env.WINEARCH = env.WINEARCH || 'win64';
    env.WINEPREFIX = env.WINEPREFIX || path.join(os.tmpdir(), 'paretoco-wine');
  }
  return env;
}

function executeNative(job, options = {}) {
  const engine = findNativeEngine();
  if (!engine) return Promise.reject(Object.assign(new Error('Native ParetoCo engine is unavailable.'), { code: 'NATIVE_UNAVAILABLE' }));
  const timeoutMs = Math.max(5_000, Number(options.timeoutMs) || Number(process.env.PARETOCO_NATIVE_TIMEOUT_MS) || 60_000);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paretoco_job_'));

  try {
    writeWorkspace(job, tempDir);
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(engine.command, [...engine.prefixArgs, '--config', 'config.cfg'], {
      cwd: tempDir,
      env: buildExecutionEnv(engine),
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (_) {}
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', chunk => { stdout = appendBounded(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = appendBounded(stderr, chunk); });

    child.once('error', error => {
      clearTimeout(timer);
      fs.rmSync(tempDir, { recursive: true, force: true });
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });

    child.once('close', code => {
      clearTimeout(timer);
      let outTxt = '';
      let outCsv = '';
      try {
        const txtPath = path.join(tempDir, 'out', 'out.txt');
        const csvPath = path.join(tempDir, 'out', 'out.csv');
        if (fs.existsSync(txtPath)) outTxt = fs.readFileSync(txtPath, 'utf8');
        if (fs.existsSync(csvPath)) outCsv = fs.readFileSync(csvPath, 'utf8');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }

      if (timedOut) {
        const error = new Error(`Native ParetoCo engine timed out after ${timeoutMs} ms.`);
        error.code = 'NATIVE_TIMEOUT';
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      if (code !== 0) {
        const error = new Error('Native ParetoCo engine returned a non-zero exit code.');
        error.code = 'NATIVE_EXIT';
        error.exitCode = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      if (!outTxt && !outCsv) {
        const error = new Error('Native ParetoCo engine completed without producing an output file.');
        error.code = 'NATIVE_NO_OUTPUT';
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      resolve({
        success: true,
        approximate: false,
        engine: nativeEngineLabel(engine),
        executionMode: engine.mode,
        exitCode: code,
        stdout,
        stderr,
        outTxt,
        outCsv,
        log: outTxt || stdout
      });
    });
  });
}

async function runDseJob(job, options = {}) {
  const validation = validateStructuredLaunchJob(job);
  if (!validation.valid) {
    const error = new Error(validation.errors.join(' '));
    error.code = 'INVALID_JOB';
    error.validationErrors = validation.errors;
    throw error;
  }

  try {
    return await executeNative(job, options);
  } catch (error) {
    if (nativeRequired() || options.requireNative === true) throw error;
    const fallback = runAnalyticalDse(job);
    return { ...fallback, nativeError: error.message };
  }
}

function engineStatus() {
  const engine = findNativeEngine();
  return {
    nativeRequired: nativeRequired(),
    ready: !nativeRequired() || Boolean(engine),
    nativeEngine: nativeEngineLabel(engine),
    enginePath: engine?.enginePath || null,
    executionMode: engine?.mode || null,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version
  };
}

module.exports = {
  findWineBinary,
  findNativeEngine,
  nativeEngineLabel,
  nativeRequired,
  runDseJob,
  engineStatus
};
