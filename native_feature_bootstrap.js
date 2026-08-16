'use strict';

/**
 * Native-feature integration layer.
 * Runs before the round7→round6→round5→round4→round3→round2→app/preflight chain.
 * It repairs only web/UI/AI integration; the packaged native engine is untouched.
 */
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;

function patchFile(relativePath, transform) {
  const filePath = path.join(ROOT, relativePath);
  if (!fs.existsSync(filePath)) return;
  const before = fs.readFileSync(filePath, 'utf8');
  const after = transform(before);
  if (after !== before) {
    fs.writeFileSync(filePath, after, 'utf8');
    console.log(`[native-feature-bootstrap] patched ${relativePath}`);
  }
}

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  if (!source.includes(oldText)) {
    console.warn(`[native-feature-bootstrap] ${label}: target not found`);
    return source;
  }
  console.log(`[native-feature-bootstrap] ${label}: applied`);
  return source.replace(oldText, newText);
}

patchFile('preflight.js', source => {
  if (source.includes('escapeConstraintXmlAttr')) return source;
  if (!source.includes('escapeXmlAttr')) return source;
  console.log('[native-feature-bootstrap] isolate constraint XML escape helper name: applied');
  return source.replace(/\bescapeXmlAttr\b/g, 'escapeConstraintXmlAttr');
});

patchFile('ui/pareto_frontier.js', source => {
  source = replaceOnce(source, '        period:      parseFloat(row["Period"]) || 0,', '        period:      Number(row._period) || parseFloat(row["Period"]) || 0,', 'Pareto Explorer uses parsed native period values');
  source = replaceOnce(source, '        power:       parseFloat(row["Power (mW)"]) || 0,', '        power:       Number(row._power) || parseFloat(row["Power (mW)"]) || 0,', 'Pareto Explorer uses parsed native power intervals');
  source = replaceOnce(source, '        area:        parseFloat(row["Area"]) || 0,', '        area:        Number(row._area) || parseFloat(row["Area"]) || 0,', 'Pareto Explorer uses parsed native area intervals');
  source = replaceOnce(source, '        cost:        parseFloat(row["Cost ($)"]) || 0,', '        cost:        Number(row._cost) || parseFloat(row["Cost ($)"]) || 0,', 'Pareto Explorer uses parsed native cost intervals');
  source = replaceOnce(source, '        utilization: parseFloat(row["Utilization (%)"]) || 0,', '        utilization: Number(row._utilization) || parseFloat(row["Utilization (%)"]) || 0,', 'Pareto Explorer uses parsed native utilization values');
  source = replaceOnce(source, '        throughput:  row["Period"] ? (1000 / parseFloat(row["Period"])) : 0,', '        throughput:  (Number(row._period) || parseFloat(row["Period"])) > 0 ? (1 / (Number(row._period) || parseFloat(row["Period"]))) : 0,', 'remove invented 1000x throughput scale');
  source = replaceOnce(source, '    ctx.fillStyle = "#EBF4FA";', '    ctx.fillStyle = "#FFFFFF";', 'Pareto chart uses white background');
  return source;
});

patchFile('ui/incremental_dse.js', source => source
  .replace(/Warm-Start Payload/g, 'Prior-Solution Cache')
  .replace(/Seed solutions/g, 'Cached solutions')
  .replace(/Minimal impact, warm-start effective/g, 'Minimal impact; prior-solution cache retained')
  .replace(/warm-start seed/gi, 'prior-solution cache entry'));

patchFile('ui/index.html', source => source
  .replace('Max Utilization (%)', 'Min Utilization (%)')
  .replace('Max Active Processors', 'Active Processors (exact)')
  .replace('placeholder="e.g. I have four ARM cores and two NPUs. The vision pipeline has preprocessing, detection and tracking. Detection must run on the NPU and the frame deadline is 33 ms."', 'placeholder="e.g. At 1 GHz, I have four ARM cores and two NPUs. The vision pipeline has preprocessing, detection and tracking. The frame deadline is 33 ms and max power is 12 W."')
  .replace('placeholder="e.g. Find an architecture achieving >= 30 FPS, < 15 W and < $80 BOM. Optimize energy first and cost second."', 'placeholder="e.g. At 1 GHz, find an architecture achieving >= 30 FPS, < 15 W and < $80 BOM. Optimize energy first and cost second."')
  .replace('<span class="nav-icon">🔄</span> Continuous DSE', '<span class="nav-icon">🔄</span> DSE Run History')
  .replace('<div class="card-header"><h2>Continuous DSE</h2></div>', '<div class="card-header"><h2>DSE Run History & Change Tracking</h2></div>'));

patchFile('round2_preflight.js', source => {
  source = replaceOnce(source,
`    const auto = await requestJson('/api/ai/auto-optimize', {
      budgetPrompt: 'Reduce power while keeping the existing ARM model names and a runnable two-core platform.',
      platform: demoPayload().platform,
      resultsText: '1 solutions found; Period 25; sys power 22'
    }, 40_000);`,
`    const autoJob = demoPayload();
    const autoGoal = 'Reduce power while preserving feasibility and the existing ARM model/mode identifiers.';
    const auto = await requestJson('/api/ai/auto-optimize', {
      budgetPrompt: autoGoal,
      platform: autoJob.platform,
      resultsText: '1 solutions found\\nPeriod: {25}\\nsys power: 22',
      messages: [{ role: 'user', content: JSON.stringify({ goal: autoGoal, currentJob: autoJob, baselineResults: '1 solutions found\\nPeriod: {25}\\nsys power: 22' }) }]
    }, 90_000);`,
    'Auto-Optimize smoke tests native-verified power reduction');

  source = replaceOnce(source,
`    const unsat = await requestJson('/api/ai/unsat-doctor', {
      constraints: { application: [{ appName: 'TestApp', period: 1, latency: 0 }], system: { power: 1 }, wcets: demoPayload().wcets },
      platform: demoPayload().platform,
      applications: demoPayload().applications
    }, 40_000);`,
`    const unsatJob = demoPayload();
    unsatJob.constraints = [{ appName: 'TestApp', period: 1000, latency: 0 }];
    unsatJob.sysConstraints = { power: 1, utilization: -1, area: -1, cost: -1, procsUsed: -1 };
    const unsat = await requestJson('/api/ai/unsat-doctor', {
      messages: [{ role: 'user', content: JSON.stringify({ currentJob: unsatJob, baselineResults: '0 solutions found' }) }]
    }, 90_000);`,
    'UNSAT smoke isolates one impossible native power constraint');
  return source;
});

require('./round7_preflight');
