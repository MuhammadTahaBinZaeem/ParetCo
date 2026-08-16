'use strict';

const { sendJson, readJson, sendError } = require('./http_utils');

function nativeContractError(message) {
  const error = new Error(message);
  error.code = 'NATIVE_UNAVAILABLE';
  return error;
}

async function handleInsights(req, res) {
  try {
    const data = await readJson(req);
    const { askFeatherless } = require('../ai_features/featherless');
    const systemPrompt = 'You are a Principal Embedded Systems Architect and Design Space Exploration analyst. Base every claim on the supplied platform, constraints, and DSE results. Do not invent percentages, bottlenecks, or verified improvements that are not supported by the data. Use concise Markdown.';
    const userPrompt = [
      `Application: ${data.appName || 'Active workload'}`,
      `Hardware Platform: ${data.platformSummary || 'Not supplied'}`,
      `Active Constraints: ${data.constraintsSummary || 'None supplied'}`,
      `Solutions Evaluated: ${data.solutionsCount ?? 'N/A'}`,
      '',
      'Current solver data:',
      typeof data.solutionsSummary === 'string' ? data.solutionsSummary : JSON.stringify(data.solutionsSummary || null),
      data.outTxt || data.outCsv || '',
      '',
      'Summarize real Pareto trade-offs, constraints, and evidence-backed recommendations.'
    ].join('\n');
    const insights = await askFeatherless(systemPrompt, userPrompt);
    sendJson(res, 200, { insights });
  } catch (error) {
    // Insights are advisory and the UI has a deterministic data-only fallback.
    sendJson(res, 200, { error: error.message, fallback: true });
  }
}

async function handleNlToDse(req, res) {
  try {
    const { prompt, messages } = await readJson(req);
    const { convertNlToDseAgent } = require('../ai_features/nl_to_model');
    const chatMessages = Array.isArray(messages) && messages.length
      ? messages
      : [{ role: 'user', content: String(prompt || '') }];
    const logs = [];
    const result = await convertNlToDseAgent(chatMessages, log => logs.push(log));

    // Preserve the actual clarification turn so a follow-up answer has the
    // same conversational context that produced the question.
    const nextMessages = [...chatMessages];
    if (result.question) nextMessages.push({ role: 'assistant', content: String(result.question) });

    sendJson(res, 200, { ...result, logs, messages: nextMessages });
  } catch (error) {
    sendError(res, error);
  }
}

function currentJobFrom(data) {
  return data.currentJob || {
    platform: data.platform,
    applications: data.applications,
    wcets: data.wcets,
    constraints: data.constraints,
    sysConstraints: data.sysConstraints,
    dse: data.dse,
    presolver: data.presolver,
    output: data.output
  };
}

async function handleAutoOptimize(req, res) {
  try {
    const data = await readJson(req);
    const { autoOptimizeAgent } = require('../ai_features/auto_optimize');
    const messages = Array.isArray(data.messages) && data.messages.length
      ? data.messages
      : [{
          role: 'user',
          content: JSON.stringify({
            goal: data.budgetPrompt || '',
            currentJob: currentJobFrom(data),
            baselineResults: data.resultsText || ''
          })
        }];
    const logs = [];
    const result = await autoOptimizeAgent(messages, log => logs.push(log));

    // Defense in depth: the route itself refuses to publish an architecture
    // unless the agent returned evidence from the native engine bridge.
    if (!result?.verification?.native || !(Number(result.verification.solutionCount) > 0)) {
      throw nativeContractError('Auto-Optimize refused to return an architecture because no successful native verification accompanied the proposal.');
    }

    sendJson(res, 200, { ...result, logs, messages });
  } catch (error) {
    sendError(res, error);
  }
}

async function handleUnsatDoctor(req, res) {
  try {
    const data = await readJson(req);
    const { analyzeUnsatAgent } = require('../ai_features/unsat_doctor');
    const currentJob = data.currentJob || {
      platform: data.platform,
      applications: data.applications,
      wcets: data.wcets,
      constraints: data.constraints?.application || data.constraints,
      sysConstraints: data.constraints?.system || data.sysConstraints,
      dse: data.dse,
      presolver: data.presolver,
      output: data.output
    };
    const messages = Array.isArray(data.messages) && data.messages.length
      ? data.messages
      : [{
          role: 'user',
          content: JSON.stringify({
            currentJob,
            baselineResults: data.baselineResults || '0 solutions found'
          })
        }];
    const logs = [];
    const result = await analyzeUnsatAgent(messages, log => logs.push(log));

    if (!result?.alreadyFeasible) {
      const options = Array.isArray(result?.options) ? result.options : [];
      const verifiedOptions = options.filter(option =>
        option?.verified === true &&
        option?.verificationEngine === 'native' &&
        Number(option?.verifiedSolutions) > 0
      );
      if (verifiedOptions.length !== options.length) {
        console.warn(`[unsat-doctor] Dropped ${options.length - verifiedOptions.length} repair option(s) that lacked native verification evidence.`);
      }
      result.options = verifiedOptions;
    }

    sendJson(res, 200, { ...result, logs, messages });
  } catch (error) {
    sendError(res, error);
  }
}

async function handleAiRoute(pathname, req, res) {
  if (req.method !== 'POST') return false;
  if (pathname === '/api/ai/insights') { await handleInsights(req, res); return true; }
  if (pathname === '/api/ai/nl-to-dse') { await handleNlToDse(req, res); return true; }
  if (pathname === '/api/ai/auto-optimize') { await handleAutoOptimize(req, res); return true; }
  if (pathname === '/api/ai/unsat-doctor') { await handleUnsatDoctor(req, res); return true; }
  return false;
}

module.exports = { handleAiRoute };