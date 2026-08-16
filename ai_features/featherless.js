require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { OpenAI } = require('openai');

const DEFAULT_MODEL = process.env.FEATHERLESS_MODEL || 'Qwen/Qwen2.5-7B-Instruct';
const REQUEST_TIMEOUT_MS = Math.max(5_000, Number(process.env.FEATHERLESS_TIMEOUT_MS) || 25_000);
const AGENT_MAX_ITERATIONS = Math.max(1, Math.min(6, Number(process.env.FEATHERLESS_AGENT_MAX_ITERATIONS) || 4));
let cachedClient = null;

function getApiKey() {
  return process.env.FEATHERLESS_API_KEY || process.env.featherless || '';
}

function getClient() {
  if (cachedClient) return cachedClient;
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('FEATHERLESS_API_KEY is not configured. Set it in Render Environment or in a local .env file.');
  }
  cachedClient = new OpenAI({
    baseURL: 'https://api.featherless.ai/v1',
    apiKey,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 1
  });
  return cachedClient;
}

async function askFeatherless(systemPrompt, userPrompt, model = DEFAULT_MODEL, options = {}) {
  const client = getClient();
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: options.temperature ?? 0.15,
    max_tokens: options.maxTokens ?? 2200
  });
  const text = response?.choices?.[0]?.message?.content;
  if (!text || !String(text).trim()) {
    throw new Error(`Featherless model ${model} returned an empty response.`);
  }
  return String(text).trim();
}

function extractJson(text) {
  const source = String(text || '').trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : source;
  try {
    return JSON.parse(candidate);
  } catch (_) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error('Featherless returned text instead of valid JSON.');
  }
}

async function askFeatherlessJson(systemPrompt, userPrompt, model = DEFAULT_MODEL) {
  const strictSystem = `${systemPrompt}\n\nReturn ONLY one valid JSON object. Do not use Markdown fences and do not add commentary outside the JSON.`;
  const first = await askFeatherless(strictSystem, userPrompt, model, { temperature: 0.1, maxTokens: 2600 });
  try {
    return extractJson(first);
  } catch (firstError) {
    const repair = await askFeatherless(
      'You repair malformed JSON. Return ONLY syntactically valid JSON, preserving the supplied meaning and keys.',
      `Repair this into valid JSON:\n${first}`,
      model,
      { temperature: 0, maxTokens: 2600 }
    );
    try {
      return extractJson(repair);
    } catch (_) {
      throw firstError;
    }
  }
}

/**
 * Bounded compatibility loop for older tool-based agents. Newer ParetoCo AI
 * features use askFeatherlessJson directly so they do not depend on tool-call
 * support from a particular hosted model.
 */
async function executeAgentLoop(messages, tools, handlers, onLog = () => {}, model = DEFAULT_MODEL) {
  const client = getClient();

  for (let iteration = 1; iteration <= AGENT_MAX_ITERATIONS; iteration++) {
    onLog(`[Agent] Thinking (${iteration}/${AGENT_MAX_ITERATIONS})...`);
    const completion = await client.chat.completions.create({
      model,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
      tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
      temperature: 0.1,
      max_tokens: 1800
    });

    const message = completion?.choices?.[0]?.message;
    if (!message) throw new Error('Featherless returned no assistant message.');
    messages.push(message);

    if (!message.tool_calls || message.tool_calls.length === 0) {
      onLog('[Agent] Finished.');
      return message.content || '';
    }

    for (const toolCall of message.tool_calls) {
      const fnName = toolCall.function?.name;
      const fnArgsStr = toolCall.function?.arguments || '{}';
      onLog(`[Agent] Executing tool: ${fnName}`);
      let args = {};
      try { args = JSON.parse(fnArgsStr); } catch (_) {}

      let result;
      try {
        result = handlers[fnName]
          ? await handlers[fnName](args)
          : { error: `Tool ${fnName} not found` };
      } catch (err) {
        result = { error: err.message };
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: fnName,
        content: typeof result === 'string' ? result : JSON.stringify(result)
      });
    }
  }

  throw new Error(`AI agent did not finish within ${AGENT_MAX_ITERATIONS} iterations.`);
}

module.exports = {
  getClient,
  getApiKey,
  askFeatherless,
  askFeatherlessJson,
  extractJson,
  executeAgentLoop,
  DEFAULT_MODEL,
  REQUEST_TIMEOUT_MS
};
