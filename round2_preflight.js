'use strict';

/**
 * Second-pass app/server integration repairs.
 * Runs before app_preflight.js. Native engine executable and DLLs are untouched.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8080);

function patchFile(relativePath, transform) {
  const filePath = path.join(ROOT, relativePath);
  if (!fs.existsSync(filePath)) return;
  const before = fs.readFileSync(filePath, 'utf8');
  const after = transform(before);
  if (after !== before) {
    fs.writeFileSync(filePath, after, 'utf8');
    console.log(`[round2-preflight] patched ${relativePath}`);
  }
}

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  if (!source.includes(oldText)) {
    console.warn(`[round2-preflight] ${label}: target not found`);
    return source;
  }
  console.log(`[round2-preflight] ${label}: applied`);
  return source.replace(oldText, newText);
}

patchFile('ui/app.js', source => {
  source = replaceOnce(
    source,
    `      channels.push({
        name: c.getAttribute("name"),
        srcActor: c.getAttribute("srcActor"),
        srcPort: c.getAttribute("srcPort"),
        dstActor: c.getAttribute("dstActor"),
        dstPort: c.getAttribute("dstPort"),
      });`,
    `      channels.push({
        name: c.getAttribute("name"),
        srcActor: c.getAttribute("srcActor"),
        srcPort: c.getAttribute("srcPort") || "p_out",
        dstActor: c.getAttribute("dstActor"),
        dstPort: c.getAttribute("dstPort") || "p_in",
        initialTokens: Math.max(0, parseInt(c.getAttribute("initialTokens"), 10) || 0),
        size: Math.max(1, parseInt(c.getAttribute("size"), 10) || 1),
      });`,
    'preserve imported SDF channel tokens, sizes, and port names'
  );
  return source;
});

patchFile('ui/incremental_dse.js', source => {
  source = replaceOnce(
    source,
    `    if (!dseState.currentSession) {
      createSession();
    }`,
    `    if (!dseState.currentSession) {
      const created = createSession();
      if (!dseState.sessions.some(session => session.id === created.id)) dseState.sessions.push(created);
    }`,
    'recorded runs register auto-created Continuous DSE sessions'
  );

  source = replaceOnce(
    source,
    `      newSolutions: prevRun ? allIndices : [], // All are "new" for first run`,
    `      newSolutions: prevRun ? allIndices : [...allIndices], // Every solution is new on the first run`,
    'mark first Continuous DSE run solutions as new'
  );

  source = replaceOnce(
    source,
    `            const solPower = parseFloat(sol["Power (mW)"] || sol.power) || 0;`,
    `            const solPower = Number(sol._power) || parseFloat(String(sol["Power (mW)"] || sol.power || "").replace(/[^0-9.-]/g, "")) || 0;`,
    'Continuous DSE invalidation understands native power intervals'
  );

  source = replaceOnce(
    source,
    `              const solPeriod = parseFloat(sol["Period"] || sol.period) || 0;`,
    `              const solPeriod = Number(sol._period) || parseFloat(String(sol["Period"] || sol.period || "").replace(/[^0-9.-]/g, "")) || 0;`,
    'Continuous DSE invalidation uses parsed period values'
  );
  return source;
});

patchFile('server.js', source => {
  source = replaceOnce(
    source,
    `const UI_DIR = path.join(ROOT_DIR, 'ui');`,
    `const UI_DIR = path.join(ROOT_DIR, 'ui');
const MAX_REQUEST_BODY_BYTES = Math.max(64 * 1024, Number(process.env.PARETOCO_MAX_REQUEST_BODY_BYTES) || 2 * 1024 * 1024);

function escapeXmlAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function safeFileStem(value, fallback = 'App') {
  const stem = String(value ?? fallback).replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^\.+/, '').slice(0, 100);
  return stem || fallback;
}`,
    'add XML escaping, safe temp filenames, and request-size limit'
  );

  source = replaceOnce(
    source,
    `      const appName = app.name || 'App';
      const actors = app.actors || ['src_node', 'proc_node', 'snk_node'];`,
    `      const appName = String(app.name || 'App');
      const appFileStem = safeFileStem(appName, 'App');
      const actors = app.actors || ['src_node', 'proc_node', 'snk_node'];`,
    'sanitize generated SDF filenames without changing application identity'
  );

  source = replaceOnce(
    source,
    `      actors.forEach(actName => {
        const aName = typeof actName === 'string' ? actName : (actName.name || 'act');
        appXml += \`      <actor name="\${aName}" type="\${aName}">\\n        <port name="p_in" type="in" rate="1" />\\n        <port name="p_out" type="out" rate="1" />\\n      </actor>\\n\`;
      });`,
    `      actors.forEach((actor, actorIndex) => {
        const aName = typeof actor === 'string' ? actor : (actor?.name || \`actor_\${actorIndex}\`);
        const aType = typeof actor === 'string' ? actor : (actor?.type || aName);
        const ports = typeof actor === 'object' && Array.isArray(actor?.ports) && actor.ports.length
          ? actor.ports
          : [
              { name: 'p_in', type: 'in', rate: 1 },
              { name: 'p_out', type: 'out', rate: 1 }
            ];
        appXml += \`      <actor name="\${escapeXmlAttr(aName)}" type="\${escapeXmlAttr(aType)}">\\n\`;
        ports.forEach((port, portIndex) => {
          const pName = port?.name || (portIndex === 0 ? 'p_in' : 'p_out');
          const pType = port?.type === 'out' ? 'out' : 'in';
          const rate = Math.max(1, parseInt(port?.rate, 10) || 1);
          appXml += \`        <port name="\${escapeXmlAttr(pName)}" type="\${pType}" rate="\${rate}" />\\n\`;
        });
        appXml += '      </actor>\\n';
      });`,
    'preserve imported actor types, ports, and rates in native SDF XML'
  );

  source = replaceOnce(
    source,
    `          appXml += \`      <channel name="\${ch.name || 'ch'+idx}" srcActor="\${src}" srcPort="p_out" dstActor="\${dst}" dstPort="p_in" initialTokens="\${tokens}" size="1" />\\n\`;`,
    `          const srcPort = ch.srcPort || 'p_out';
          const dstPort = ch.dstPort || 'p_in';
          const size = Math.max(1, parseInt(ch.size, 10) || 1);
          appXml += \`      <channel name="\${escapeXmlAttr(ch.name || 'ch'+idx)}" srcActor="\${escapeXmlAttr(src)}" srcPort="\${escapeXmlAttr(srcPort)}" dstActor="\${escapeXmlAttr(dst)}" dstPort="\${escapeXmlAttr(dstPort)}" initialTokens="\${Math.max(0, parseInt(tokens, 10) || 0)}" size="\${size}" />\\n\`;`,
    'preserve channel ports/tokens/sizes when invoking native engine'
  );

  source = replaceOnce(
    source,
    `      const fileName = \`\${appName}.xml\`;`,
    `      const fileName = \`\${appFileStem}.xml\`;`,
    'use safe SDF temp filename'
  );

  source = replaceOnce(
    source,
    `        const pModel = w.procModel || firstProcModel;`,
    `        const pModel = w.procModel || w.processor || firstProcModel;`,
    'server directly accepts both WCET processor field names'
  );

  source = replaceOnce(
    source,
    `  const pathname = parsedUrl.pathname;

  // API Endpoints`,
    `  const pathname = parsedUrl.pathname;

  if (req.method === 'POST') {
    const declaredLength = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: \`Request body exceeds \${MAX_REQUEST_BODY_BYTES} byte limit.\` }));
      return;
    }
    let streamedBytes = 0;
    req.on('data', chunk => {
      streamedBytes += chunk.length;
      if (streamedBytes > MAX_REQUEST_BODY_BYTES && !res.writableEnded) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: \`Request body exceeds \${MAX_REQUEST_BODY_BYTES} byte limit.\` }));
        req.destroy();
      }
    });
  }

  // API Endpoints`,
    'bound API POST request bodies'
  );

  source = replaceOnce(
    source,
    `           { role: "user", content: \`Goal: \${budgetPrompt}\\nCurrent Platform: \${JSON.stringify(platform)}\\nBaseline Results: \${resultsText}\\n\\nCall modify_architecture, then run_dse_engine, then inspect results.\` }`,
    `           { role: "user", content: \`Goal: \${budgetPrompt}\\nCurrent Platform: \${JSON.stringify(platform)}\\nBaseline Results: \${resultsText}\\n\\nPropose a complete modified platform. Do not claim it is feasible; the browser will verify it with the native DSE engine.\` }`,
    'remove stale nonexistent-tool instruction from architecture endpoint source'
  );

  source = replaceOnce(
    source,
    `           { role: "user", content: \`0 Solutions Found.\\nConstraints: \${JSON.stringify(constraints)}\\nPlatform: \${JSON.stringify(platform)}\\nApps: \${JSON.stringify(applications)}\\n\\nTest repairs using the tool before presenting.\` }`,
    `           { role: "user", content: \`0 Solutions Found.\\nConstraints: \${JSON.stringify(constraints)}\\nPlatform: \${JSON.stringify(platform)}\\nApps: \${JSON.stringify(applications)}\\n\\nPropose minimal candidate repairs. Do not claim feasibility; each candidate will be verified by a subsequent native DSE rerun.\` }`,
    'remove stale fake-tool instruction from UNSAT endpoint source'
  );

  return source;
});

function requestJson(pathname, payload, timeoutMs = 35_000) {
  return new Promise((resolve, reject) => {
    const body = payload == null ? '' : JSON.stringify(payload);
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: pathname,
      method: payload == null ? 'GET' : 'POST',
      headers: payload == null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs
    }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk.toString(); });
      response.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (_) {}
        resolve({ status: response.statusCode || 0, body: data, json: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('request timed out')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function demoPayload() {
  return {
    platform: {
      processors: [{ model: 'ARM', count: 2, modes: [{ name: 'default', cycle: 1, mem: 4096, dynPower: 10, staticPower: 2, area: 5, monetary: 10 }] }],
      interconnects: [{ name: 'bus0', topology: 'TDMA-bus', xDim: 2, yDim: 1, flitSize: 32, slots: 2 }]
    },
    applications: [{
      name: 'TestApp',
      actors: [
        { name: 'src_node', type: 'src_node', ports: [{ name: 'p_in', type: 'in', rate: 1 }, { name: 'p_out', type: 'out', rate: 1 }] },
        { name: 'proc_node', type: 'proc_node', ports: [{ name: 'p_in', type: 'in', rate: 1 }, { name: 'p_out', type: 'out', rate: 1 }] },
        { name: 'snk_node', type: 'snk_node', ports: [{ name: 'p_in', type: 'in', rate: 1 }, { name: 'p_out', type: 'out', rate: 1 }] }
      ],
      channels: [
        { name: 'ch1', srcActor: 'src_node', srcPort: 'p_out', dstActor: 'proc_node', dstPort: 'p_in', initialTokens: 0, size: 1 },
        { name: 'ch2', srcActor: 'proc_node', srcPort: 'p_out', dstActor: 'snk_node', dstPort: 'p_in', initialTokens: 0, size: 1 },
        { name: 'ch3', srcActor: 'snk_node', srcPort: 'p_out', dstActor: 'src_node', dstPort: 'p_in', initialTokens: 1, size: 1 }
      ]
    }],
    wcets: [
      { taskType: 'src_node', processor: 'ARM', mode: 'default', wcet: 10 },
      { taskType: 'proc_node', processor: 'ARM', mode: 'default', wcet: 25 },
      { taskType: 'snk_node', processor: 'ARM', mode: 'default', wcet: 15 }
    ],
    constraints: [{ appName: 'TestApp', period: 1000, latency: 0 }],
    sysConstraints: { power: -1, utilization: -1, area: -1, cost: -1, procsUsed: -1 },
    dse: { model: 'SDF_PR_ONLINE', criteria: 'THROUGHPUT', search: 'FIRST', thProp: 'SSE', th_prop: 'SSE' }
  };
}

async function runExtendedFeatureSmokes() {
  try {
    const demo = await requestJson('/api/launch', demoPayload(), 45_000);
    const demoOk = demo.status === 200 && demo.json?.success !== false && /\b[1-9]\d*\s+solutions?\s+found/i.test(String(demo.json?.outTxt || demo.json?.log || ''));
    console[demoOk ? 'log' : 'error'](`[demo-smoke] ${demoOk ? 'PASS' : 'FAIL'}${demoOk ? ': exact built-in demo completed natively.' : `: HTTP ${demo.status} ${demo.json?.error || demo.body.slice(-800)}`}`);
  } catch (error) {
    console.error(`[demo-smoke] FAIL: ${error.message}`);
  }

  const hasKey = Boolean(process.env.FEATHERLESS_API_KEY || process.env.featherless);
  if (!hasKey) {
    console.warn('[extended-ai-smoke] SKIP: Featherless API key is not configured.');
    return;
  }

  try {
    const insights = await requestJson('/api/ai/insights', {
      appName: 'SmokeApp', platformSummary: 'ARM x2', constraintsSummary: 'period <= 1000 cycles', solutionsCount: 1,
      solutionsSummary: 'Solution #1: Period=25 cycles, Power=22 mW'
    }, 40_000);
    const ok = insights.status === 200 && Boolean(insights.json?.insights);
    console[ok ? 'log' : 'error'](`[ai-insights-smoke] ${ok ? 'PASS' : 'FAIL'}${ok ? '' : `: HTTP ${insights.status} ${insights.json?.error || insights.body.slice(-500)}`}`);
  } catch (error) { console.error(`[ai-insights-smoke] FAIL: ${error.message}`); }

  try {
    const auto = await requestJson('/api/ai/auto-optimize', {
      budgetPrompt: 'Reduce power while keeping the existing ARM model names and a runnable two-core platform.',
      platform: demoPayload().platform,
      resultsText: '1 solutions found; Period 25; sys power 22'
    }, 40_000);
    const ok = auto.status === 200 && Array.isArray(auto.json?.platform?.processors) && auto.json.platform.processors.length > 0;
    console[ok ? 'log' : 'error'](`[ai-auto-optimize-smoke] ${ok ? 'PASS' : 'FAIL'}${ok ? '' : `: HTTP ${auto.status} ${auto.json?.error || auto.body.slice(-500)}`}`);
  } catch (error) { console.error(`[ai-auto-optimize-smoke] FAIL: ${error.message}`); }

  try {
    const unsat = await requestJson('/api/ai/unsat-doctor', {
      constraints: { application: [{ appName: 'TestApp', period: 1, latency: 0 }], system: { power: 1 }, wcets: demoPayload().wcets },
      platform: demoPayload().platform,
      applications: demoPayload().applications
    }, 40_000);
    const ok = unsat.status === 200 && Array.isArray(unsat.json?.options) && unsat.json.options.length > 0;
    console[ok ? 'log' : 'error'](`[ai-unsat-smoke] ${ok ? 'PASS' : 'FAIL'}${ok ? '' : `: HTTP ${unsat.status} ${unsat.json?.error || unsat.body.slice(-500)}`}`);
  } catch (error) { console.error(`[ai-unsat-smoke] FAIL: ${error.message}`); }
}

require('./app_preflight');
setTimeout(runExtendedFeatureSmokes, 5_000).unref?.();
