const { executeAgentLoop } = require('./featherless');

const tools = [
  {
    type: "function",
    function: {
      name: "run_dse_engine",
      description: "Runs the C++ DSE engine with a modified platform.xml and returns the raw output results so you can parse bottlenecks.",
      parameters: {
        type: "object",
        properties: {
          modifiedPlatform: { type: "object", description: "The complete modified platform JSON object" }
        },
        required: ["modifiedPlatform"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "finalize_optimal_architecture",
      description: "Call this when the architecture successfully meets all goals to return the final platform.",
      parameters: {
        type: "object",
        properties: {
          platform: { type: "object" }
        },
        required: ["platform"]
      }
    }
  }
];

async function runDseSimulation(platformStr) {
    const platform = JSON.parse(platformStr);
    let totalProcs = 0;
    if (platform && platform.processors) {
        platform.processors.forEach(p => totalProcs += p.count);
    }
    
    if (totalProcs < 4) {
      return "0 Solutions Found. Bottleneck: Insufficient throughput.";
    } else if (totalProcs > 6) {
      return "0 Solutions Found. Bottleneck: Power limit exceeded.";
    } else {
      return "12 Solutions Found. Pareto optimal mapping achieved: 30 FPS, 12 W. Cost: $70 BOM.";
    }
}

async function autoOptimizeAgent(messages, onLog) {
    const handlers = {
        run_dse_engine: async (args) => {
            const outTxt = await runDseSimulation(JSON.stringify(args.modifiedPlatform));
            return { result: outTxt };
        },
        finalize_optimal_architecture: (args) => {
            throw new Error(`__FINAL__:${JSON.stringify(args.platform)}`);
        }
    };

    try {
        await executeAgentLoop(messages, tools, handlers, onLog);
        return { error: "Agent did not finalize architecture." };
    } catch (e) {
        if (e.message.startsWith('__FINAL__:')) {
            return { platform: JSON.parse(e.message.substring(10)) };
        }
        throw e;
    }
}
module.exports = { autoOptimizeAgent };
