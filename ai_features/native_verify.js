'use strict';

const http = require('http');

const PORT = Number(process.env.PORT || 8080);
const DEFAULT_TIMEOUT_MS = Math.max(10_000, Number(process.env.PARETOCO_NATIVE_VERIFY_TIMEOUT_MS) || 35_000);
const MAX_RESPONSE_BYTES = Math.max(1_000_000, Number(process.env.PARETOCO_NATIVE_VERIFY_MAX_BYTES) || 8_000_000);

function countSolutions(text) {
  const matches = String(text || '').match(/(\d+)\s+solutions?\s+found/gi) || [];
  if (matches.length === 0) return 0;
  const last = matches[matches.length - 1].match(/(\d+)/);
  return last ? Number(last[1]) : 0;
}

function metricValues(text, labelPattern) {
  const values = [];
  const re = new RegExp(`${labelPattern}\\s*:\\s*(?:\\{\\s*)?\\[?\\s*(-?\\d+(?:\\.\\d+)?)`, 'gi');
  for (const match of String(text || '').matchAll(re)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

function summarizeNativeText(text) {
  const source = String(text || '');
  const periods = metricValues(source, 'Period');
  const powers = metricValues(source, 'sys power(?:\\s*\\(only used parts\\))?');
  const areas = metricValues(source, 'sys area(?:\\s*\\(only used parts\\))?');
  const costs = metricValues(source, 'sys cost(?:\\s*\\(only used parts\\))?');
  const utilizations = metricValues(source, 'Sys utilization');
  const solutionCount = countSolutions(source);

  const min = values => values.length ? Math.min(...values) : null;
  const max = values => values.length ? Math.max(...values) : null;

  return {
    solutionCount,
    feasible: solutionCount > 0,
    minPeriod: min(periods),
    maxPeriod: max(periods),
    minPower: min(powers),
    maxPower: max(powers),
    minArea: min(areas),
    maxArea: max(areas),
    minCost: min(costs),
    maxCost: max(costs),
    minUtilization: min(utilizations),
    maxUtilization: max(utilizations)
  };
}

function runNativeDse(job, options = {}) {
  const timeoutMs = Math.max(5_000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const body = JSON.stringify(job || {});

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/api/launch',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: timeoutMs
    }, response => {
      let responseBody = '';
      let bytes = 0;

      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          response.destroy(new Error('Native verification response exceeded safety limit.'));
          return;
        }
        responseBody += chunk.toString();
      });

      response.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(responseBody || '{}');
        } catch (err) {
          reject(new Error(`Native verifier received invalid JSON (HTTP ${response.statusCode}).`));
          return;
        }

        const nativeText = parsed.outTxt || parsed.log || parsed.stdout || '';
        const summary = summarizeNativeText(nativeText);
        const okHttp = response.statusCode >= 200 && response.statusCode < 300;

        resolve({
          ok: okHttp && parsed.success !== false,
          statusCode: response.statusCode,
          result: parsed,
          summary
        });
      });
    });

    req.on('timeout', () => req.destroy(new Error(`Native verification timed out after ${timeoutMs} ms.`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = {
  runNativeDse,
  countSolutions,
  summarizeNativeText
};
