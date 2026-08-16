const { executeAgentLoop } = require('./featherless');

const tools = [
  {
    type: "function",
    function: {
      name: "validate_platform",
      description: "Validates a proposed platform JSON structure. Returns success or lists missing required fields.",
      parameters: {
        type: "object",
        properties: {
          platform: { type: "object" }
        },
        required: ["platform"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "ask_user_clarification",
      description: "Ask the user a question to clarify missing requirements or unspecified parameters like WCETs. Use this if you cannot infer a value.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" }
        },
        required: ["question"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "finalize_dse_model",
      description: "Call this when the DSE model is completely and successfully built to return the final JSON.",
      parameters: {
        type: "object",
        properties: {
          platform: { type: "object" },
          applications: { type: "array" },
          wcets: { type: "array" },
          constraints: { type: "array" },
          dse: { type: "object" }
        },
        required: ["platform", "applications", "wcets", "constraints", "dse"]
      }
    }
  }
];

async function convertNlToDseAgent(messages, onLog) {
    const handlers = {
        validate_platform: (args) => {
            if (!args.platform.processors || args.platform.processors.length === 0) return { error: "Missing processors array" };
            return { status: "valid" };
        },
        ask_user_clarification: (args) => {
            throw new Error(`__ASK_USER__:${args.question}`);
        },
        finalize_dse_model: (args) => {
            throw new Error(`__FINAL__:${JSON.stringify(args)}`);
        }
    };

    try {
        await executeAgentLoop(messages, tools, handlers, onLog);
        return { error: "Agent did not call finalize_dse_model or ask_user_clarification" };
    } catch (e) {
        if (e.message.startsWith('__ASK_USER__:')) {
            return { question: e.message.substring(13) };
        } else if (e.message.startsWith('__FINAL__:')) {
            return { model: JSON.parse(e.message.substring(10)) };
        }
        throw e;
    }
}

module.exports = { convertNlToDseAgent };
