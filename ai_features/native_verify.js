'use strict';

const { runDseJob } = require('../server/engine_bridge');

const DEFAULT_TIMEOUT_MS = Math.max(10_000, Number(process.env.PARETOCO_NATIVE_VERIFY_TIMEOUT_MS) || 35_000);

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

async function runNativeDse(job, options = {}) {
  const timeoutMs = Math.max(5_000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  try {
    const result = await runDseJob(job, { timeoutMs, requireNative: true });
    const nativeText = result.outTxt || result.log || result.stdout || '';
    return {
      ok: result.success !== false && result.approximate !== true,
      statusCode: 200,
      result,
      summary: summarizeNativeText(nativeText)
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: error.code === 'INVALID_JOB' ? 400 : error.code === 'NATIVE_TIMEOUT' ? 504 : 500,
      result: {
        success: false,
        error: error.message,
        exitCode: error.exitCode,
        stdout: error.stdout || '',
        stderr: error.stderr || ''
      },
      summary: summarizeNativeText(error.stdout || '')
    };
  }
}

module.exports = { runNativeDse, countSolutions, summarizeNativeText };
