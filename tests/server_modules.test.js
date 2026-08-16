'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { serializeConfig, serializePlatform, serializeApplication, serializeWcets } = require('../server/serializers');
const { validateStructuredLaunchJob } = require('../server/validation');

function validJob() {
  return {
    platform: {
      processors: [{ model: 'ARM', count: 2, modes: [{ name: 'default', cycle: 1, mem: 4096, dynPower: 10, staticPower: 2, area: 5, monetary: 10 }] }],
      interconnects: [{ name: 'bus0', topology: 'TDMA-bus', xDim: 2, yDim: 1, flitSize: 32, slots: 2 }]
    },
    applications: [{
      name: 'TestApp',
      actors: [
        { name: 'a', type: 'a', ports: [{ name: 'p_in', type: 'in', rate: 1 }, { name: 'p_out', type: 'out', rate: 1 }] },
        { name: 'b', type: 'b', ports: [{ name: 'p_in', type: 'in', rate: 1 }, { name: 'p_out', type: 'out', rate: 1 }] }
      ],
      channels: [
        { name: 'ab', srcActor: 'a', srcPort: 'p_out', dstActor: 'b', dstPort: 'p_in', initialTokens: 0, size: 1 },
        { name: 'ba', srcActor: 'b', srcPort: 'p_out', dstActor: 'a', dstPort: 'p_in', initialTokens: 1, size: 1 }
      ]
    }],
    wcets: [
      { taskType: 'a', procModel: 'ARM', mode: 'default', wcet: 10 },
      { taskType: 'b', procModel: 'ARM', mode: 'default', wcet: 20 }
    ],
    constraints: [{ appName: 'TestApp', period: 1000, latency: 0 }],
    sysConstraints: { power: -1, utilization: -1, area: -1, cost: -1, procsUsed: -1 },
    dse: { model: 'SDF_PR_ONLINE', search: 'FIRST', criteria: 'THROUGHPUT', th_prop: 'SSE' },
    presolver: { model: 'NONE', search: 'NONESEARCH', heuristic: 'NONE', multiSearch: 'NONESEARCH' },
    output: { type: 'ALL_OUT', freq: 'ALL_SOL', logLevel: 'INFO' }
  };
}

test('structured job passes validation', () => {
  const result = validateStructuredLaunchJob(validJob());
  assert.equal(result.valid, true, result.errors.join('\n'));
});

test('config serializer emits actual line-oriented native config', () => {
  const cfg = serializeConfig(validJob(), ['sdfs/TestApp.xml'], true);
  const lines = cfg.split('\n');
  assert.ok(lines.includes('inputs = sdfs/TestApp.xml'));
  assert.ok(lines.includes('inputs = platform.xml'));
  assert.ok(lines.includes('inputs = wcets.xml'));
  assert.ok(lines.includes('inputs = desConst.xml'));
  assert.ok(lines.includes('[dse]'));
  assert.ok(lines.includes('model = SDF_PR_ONLINE'));
  assert.ok(lines.includes('search = FIRST'));
  assert.ok(lines.includes('criteria = THROUGHPUT'));
  assert.ok(lines.includes('[presolver]'));
  assert.equal(cfg.includes('xmlinputs ='), false, 'source-line continuation regression returned');
});

test('serializers preserve native model identifiers and SDF channel semantics', () => {
  const job = validJob();
  const platform = serializePlatform(job.platform);
  const app = serializeApplication(job.applications[0]);
  const wcets = serializeWcets(job.wcets);
  assert.match(platform, /processor model="ARM"/);
  assert.match(platform, /TDMA_bus/);
  assert.match(app, /actor name="a" type="a"/);
  assert.match(app, /channel name="ab"[^>]*initialTokens="0"[^>]*size="1"/);
  assert.match(app, /channel name="ba"[^>]*initialTokens="1"[^>]*size="1"/);
  assert.match(wcets, /task_type="a"/);
  assert.match(wcets, /processor="ARM"/);
});

test('application serializer never invents channels', () => {
  const job = validJob();
  job.applications[0].channels = [];
  const xml = serializeApplication(job.applications[0]);
  assert.equal(xml.includes('<channel '), false);
});

test('validation rejects fabricated or incomplete jobs before native spawn', () => {
  const job = validJob();
  job.wcets = [];
  const result = validateStructuredLaunchJob(job);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => /WCET/i.test(error)));
});

test('validation rejects missing, multiple, or unsupported interconnects instead of silently changing architecture', () => {
  const missing = validJob();
  missing.platform.interconnects = [];
  assert.equal(validateStructuredLaunchJob(missing).valid, false);

  const multiple = validJob();
  multiple.platform.interconnects.push({ name: 'bus1', topology: 'TDMA-bus', xDim: 2, yDim: 1, flitSize: 32, slots: 2 });
  assert.equal(validateStructuredLaunchJob(multiple).valid, false);

  const unsupported = validJob();
  unsupported.platform.interconnects[0].topology = 'Ring';
  const result = validateStructuredLaunchJob(unsupported);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => /topology/i.test(error)));
});

test('validation rejects invalid hardware and channel numeric values', () => {
  const badMode = validJob();
  badMode.platform.processors[0].modes[0].cycle = 0;
  assert.equal(validateStructuredLaunchJob(badMode).valid, false);

  const badChannel = validJob();
  badChannel.applications[0].channels[0].initialTokens = -1;
  assert.equal(validateStructuredLaunchJob(badChannel).valid, false);
});