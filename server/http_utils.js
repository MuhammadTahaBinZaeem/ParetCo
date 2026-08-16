'use strict';

const MAX_BODY_BYTES = Math.max(64 * 1024, Number(process.env.PARETOCO_MAX_REQUEST_BODY_BYTES) || 2 * 1024 * 1024);

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limitBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > limitBytes) {
        const error = new Error(`Request body exceeds ${limitBytes} byte limit.`);
        error.code = 'BODY_TOO_LARGE';
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req, limitBytes = MAX_BODY_BYTES) {
  const body = await readBody(req, limitBytes);
  try {
    return JSON.parse(body || '{}');
  } catch (_) {
    const error = new Error('Request body must be valid JSON.');
    error.code = 'INVALID_JSON';
    throw error;
  }
}

function errorStatus(error) {
  if (error?.code === 'BODY_TOO_LARGE') return 413;
  if (error?.code === 'INVALID_JSON' || error?.code === 'INVALID_JOB') return 400;
  if (error?.code === 'NATIVE_UNAVAILABLE') return 503;
  if (error?.code === 'NATIVE_TIMEOUT') return 504;
  return 500;
}

function sendError(res, error) {
  const payload = {
    success: false,
    error: error?.message || 'Internal server error.'
  };
  if (Array.isArray(error?.validationErrors)) payload.validationErrors = error.validationErrors;
  if (error?.exitCode !== undefined) payload.exitCode = error.exitCode;
  if (error?.stdout) payload.stdout = error.stdout;
  if (error?.stderr) payload.stderr = error.stderr;
  sendJson(res, errorStatus(error), payload);
}

module.exports = { MAX_BODY_BYTES, sendJson, readBody, readJson, sendError };
