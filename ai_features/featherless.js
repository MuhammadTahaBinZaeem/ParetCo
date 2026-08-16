require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { OpenAI } = require('openai');

const DEFAULT_MODEL = process.env.FEATHERLESS_MODEL || 'Qwen/Qwen2.5-7B-Instruct';
let cachedClient = null;

function getApiKey() {
  // FEATHERLESS_API_KEY is the documented deployment variable. The lowercase
  // legacy name remains supported so existing local .env files do not break.
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
  });
  return cachedClient;
}

async function askFeatherless(systemPrompt, userPrompt, model = DEFAULT_MODEL) {
  const client = getClient();
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
  });
  return response.choices[0].message.content;
}

/**
 * Execute a bounded tool-calling agent loop. Tools are supplied by the feature
 * module (NL-to-DSE, auto-optimization, or UNSAT repair) and every tool result
 * is appended to the conversation before the model continues.
 */
async function executeAgentLoop(messages, tools, handlers, onLog = () => {}, model = DEFAULT_MODEL) {
  const client = getClient();
  let iterations = 0;

  while (iterations < 15) {
    iterations++;
    onLog('[Agent] Thinking...');

    const completion = await client.chat.completions.create({
      model,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
      tool_choice: tools && tools.length > 0 ? 'auto' : undefined
    });

    const message = completion.choices[0].message;
    messages.push(message);

    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        const fnName = toolCall.function.name;
        const fnArgsStr = toolCall.function.arguments;
        onLog(`[Agent] Executing tool: ${fnName}(${fnArgsStr})`);

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

        const resultStr = typeof result === 'object' ? JSON.stringify(result) : String(result);
        onLog(`[Agent] Tool ${fnName} returned: ${resultStr.substring(0, 100)}...`);

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: fnName,
          content: resultStr
        });
      }
    } else {
      onLog('[Agent] Finished thinking.');
      return message.content;
    }
  }

  throw new Error('Agent loop exceeded maximum iterations.');
}

module.exports = {
  getClient,
  askFeatherless,
  executeAgentLoop,
  DEFAULT_MODEL
};
