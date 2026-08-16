'use strict';

/**
 * Fifth reliability pass: make Architecture Studio edits lossless with respect
 * to the shared ParetoCo experiment model. Native engine untouched.
 */
const fs = require('fs');
const path = require('path');

const studioPath = path.join(__dirname, 'ui', 'architecture_studio.js');

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  if (!source.includes(oldText)) {
    console.warn(`[round5-preflight] ${label}: target not found`);
    return source;
  }
  console.log(`[round5-preflight] ${label}: applied`);
  return source.replace(oldText, newText);
}

if (fs.existsSync(studioPath)) {
  let source = fs.readFileSync(studioPath, 'utf8');

  source = replaceOnce(
    source,
    `      if (!procMap.has(model)) {
        procMap.set(model, {
          model,
          count: 0,
          modes: [{
            name: node.properties.mode || "default",
            cycle: node.properties.cycle || 1,
            mem: node.properties.memory || 4096,
            dynPower: node.properties.dynPower || 10,
            staticPower: node.properties.staticPower || 2,
            area: node.properties.area || 5,
            monetary: node.properties.cost || 10
          }]
        });
      }`,
    `      if (!procMap.has(model)) {
        const preservedModes = Array.isArray(node.properties.allModes) && node.properties.allModes.length
          ? JSON.parse(JSON.stringify(node.properties.allModes))
          : [{}];
        preservedModes[0] = {
          ...(preservedModes[0] || {}),
          name: node.properties.mode || preservedModes[0]?.name || "default",
          cycle: node.properties.cycle || preservedModes[0]?.cycle || 1,
          mem: node.properties.memory ?? preservedModes[0]?.mem ?? 4096,
          dynPower: node.properties.dynPower ?? preservedModes[0]?.dynPower ?? 10,
          staticPower: node.properties.staticPower ?? preservedModes[0]?.staticPower ?? 2,
          area: node.properties.area ?? preservedModes[0]?.area ?? 5,
          monetary: node.properties.cost ?? preservedModes[0]?.monetary ?? 10
        };
        procMap.set(model, { model, count: 0, modes: preservedModes });
      }`,
    'preserve all processor modes when Studio writes platform state'
  );

  source = replaceOnce(
    source,
    `        ics.push({
          type: node.type === "NoC" ? "TDN_NoC" : "TDN_BUS",
          name: node.label,
          topology: node.properties.routing || "mesh",
          xDim: 2, yDim: 2,
          routing: node.properties.routing || "XY",
          flitSize: node.properties.bufferSize || 32,
          cycles: 1
        });`,
    `        const preserved = node.properties.sourceInterconnect
          ? JSON.parse(JSON.stringify(node.properties.sourceInterconnect))
          : {};
        ics.push({
          ...preserved,
          type: preserved.type || (node.type === "NoC" ? "TDN_NoC" : "TDN_BUS"),
          name: node.label || preserved.name || "interconnect",
          topology: node.properties.routing || preserved.topology || "mesh",
          xDim: preserved.xDim || preserved["x-dimension"] || 2,
          yDim: preserved.yDim || preserved["y-dimension"] || 1,
          routing: node.properties.routing || preserved.routing || "XY",
          flitSize: node.properties.bufferSize || preserved.flitSize || 32,
          slots: preserved.slots || preserved.tdma_slots || 2,
          maxSlotsPerProc: preserved.maxSlotsPerProc || preserved.slots || 2,
          cycles: preserved.cycles || 1,
          mode: preserved.mode || null
        });`,
    'preserve TDMA/interconnect quantitative fields during Studio edits'
  );

  const oldWorkloadBlock = `    // Workload nodes → state.applications
    if (studio.workloadNodes.length > 0) {
      const actors = studio.workloadNodes.map(n => ({
        name: n.label,
        type: n.properties.actorType || n.label,
        ports: [
          { name: "p_in", type: "in", rate: 1 },
          { name: "p_out", type: "out", rate: 1 }
        ]
      }));
      const channels = studio.workloadEdges.map((e, i) => {
        const srcNode = studio.workloadNodes.find(n => n.id === e.srcNodeId);
        const dstNode = studio.workloadNodes.find(n => n.id === e.dstNodeId);
        return {
          name: "ch_" + (i + 1),
          srcActor: srcNode?.label || "",
          srcPort: "p_out",
          dstActor: dstNode?.label || "",
          dstPort: "p_in",
          initialTokens: e.properties.initialTokens || 0,
          size: e.properties.tokenSize || 1
        };
      });
      // Replace or add application
      const appName = "StudioApp";
      const existing = state.applications.findIndex(a => a.name === appName);
      const app = { name: appName, actors, channels };
      if (existing >= 0) state.applications[existing] = app;
      else state.applications.push(app);

      // Update WCETs
      const newWcets = [];
      studio.workloadNodes.forEach(wn => {
        state.platform.processors.forEach(proc => {
          proc.modes.forEach(mode => {
            newWcets.push({
              taskType: wn.properties.actorType || wn.label,
              processor: proc.model,
              mode: mode.name,
              wcet: wn.properties.wcet || 10
            });
          });
        });
      });
      // Merge: keep existing entries not from studio, add studio entries
      state.wcets = state.wcets.filter(w => !studio.workloadNodes.some(wn => (wn.properties.actorType || wn.label) === w.taskType));
      state.wcets.push(...newWcets);
    }`;

  const newWorkloadBlock = `    // Workload nodes → state.applications. Preserve original application identity,
    // actor ports and WCET mappings instead of collapsing everything into StudioApp.
    if (studio.workloadNodes.length > 0) {
      const existingApps = new Map((state.applications || []).map(app => [String(app.name || ""), app]));
      const groups = new Map();
      studio.workloadNodes.forEach(node => {
        const appName = String(node.properties.sourceAppName || "StudioApp");
        if (!groups.has(appName)) groups.set(appName, { nodes: [], edges: [] });
        groups.get(appName).nodes.push(node);
      });
      studio.workloadEdges.forEach(edge => {
        const srcNode = studio.workloadNodes.find(node => node.id === edge.srcNodeId);
        const dstNode = studio.workloadNodes.find(node => node.id === edge.dstNodeId);
        const srcApp = String(srcNode?.properties?.sourceAppName || "StudioApp");
        const dstApp = String(dstNode?.properties?.sourceAppName || "StudioApp");
        if (srcApp === dstApp && groups.has(srcApp)) groups.get(srcApp).edges.push(edge);
      });

      const rebuiltApps = [];
      groups.forEach((group, appName) => {
        const actors = group.nodes.map(node => ({
          name: node.label,
          type: node.properties.actorType || node.label,
          ports: Array.isArray(node.properties.sourcePorts) && node.properties.sourcePorts.length
            ? JSON.parse(JSON.stringify(node.properties.sourcePorts))
            : [{ name: "p_in", type: "in", rate: 1 }, { name: "p_out", type: "out", rate: 1 }]
        }));
        const channels = group.edges.map((edge, index) => {
          const srcNode = group.nodes.find(node => node.id === edge.srcNodeId);
          const dstNode = group.nodes.find(node => node.id === edge.dstNodeId);
          return {
            name: edge.properties.channelName || ("ch_" + (index + 1)),
            srcActor: srcNode?.label || "",
            srcPort: edge.properties.srcPort || "p_out",
            dstActor: dstNode?.label || "",
            dstPort: edge.properties.dstPort || "p_in",
            initialTokens: Math.max(0, parseInt(edge.properties.initialTokens, 10) || 0),
            size: Math.max(1, parseInt(edge.properties.tokenSize, 10) || 1)
          };
        });
        rebuiltApps.push({ ...(existingApps.get(appName) || {}), name: appName, actors, channels });
      });
      state.applications = rebuiltApps;

      const studioSourceTasks = new Set();
      studio.workloadNodes.forEach(node => {
        if (node.properties.sourceActorName) studioSourceTasks.add(String(node.properties.sourceActorName));
        if (node.properties.sourceActorType) studioSourceTasks.add(String(node.properties.sourceActorType));
      });
      const preservedOutsideStudio = (state.wcets || []).filter(row => !studioSourceTasks.has(String(row.taskType || "")));
      const rebuiltWcets = [];
      studio.workloadNodes.forEach(node => {
        const taskType = node.properties.actorType || node.label;
        const sourceRows = Array.isArray(node.properties.sourceWcets)
          ? JSON.parse(JSON.stringify(node.properties.sourceWcets))
          : [];
        if (sourceRows.length) {
          sourceRows.forEach(row => {
            row.taskType = taskType;
            if (sourceRows.length === 1) row.wcet = Math.max(1, parseInt(node.properties.wcet, 10) || parseInt(row.wcet, 10) || 10);
            rebuiltWcets.push(row);
          });
        } else {
          const proc = state.platform.processors[0];
          const mode = proc?.modes?.[0];
          if (proc && mode) rebuiltWcets.push({ taskType, processor: proc.model, procModel: proc.model, mode: mode.name, wcet: Math.max(1, parseInt(node.properties.wcet, 10) || 10) });
        }
      });
      state.wcets = [...preservedOutsideStudio, ...rebuiltWcets];
    }`;

  source = replaceOnce(source, oldWorkloadBlock, newWorkloadBlock, 'preserve application identity, ports and WCET mappings in Studio');

  source = replaceOnce(
    source,
    `            cost: proc.modes[0]?.monetary || 10,
          });`,
    `            cost: proc.modes[0]?.monetary || 10,
            allModes: JSON.parse(JSON.stringify(proc.modes || [])),
            sourceProcessorModel: proc.model,
          });`,
    'retain complete processor mode list on Studio nodes'
  );

  source = replaceOnce(
    source,
    `          routing: ic.routing || ic.topology || "XY",
          bufferSize: ic.flitSize || 32,
        });`,
    `          routing: ic.routing || ic.topology || "XY",
          bufferSize: ic.flitSize || 32,
          sourceInterconnect: JSON.parse(JSON.stringify(ic)),
        });`,
    'retain complete interconnect model on Studio nodes'
  );

  source = replaceOnce(
    source,
    `          const wcetEntry = state.wcets.find(w => w.taskType === (actor.type || actor.name));
          const node = createWorkloadNode(actor.name, 200 + i * 160, 200, {
            actorType: actor.type || actor.name,
            wcet: wcetEntry?.wcet || 10,
          });`,
    `          const actorTask = actor.type || actor.name;
          const sourceWcets = state.wcets.filter(w => w.taskType === actorTask || w.taskType === actor.name);
          const wcetEntry = sourceWcets[0];
          const sourcePorts = Array.isArray(actor.ports) && actor.ports.length
            ? actor.ports
            : [
                ...((actor.inPorts || []).map(port => ({ ...port, type: "in" }))),
                ...((actor.outPorts || []).map(port => ({ ...port, type: "out" })))
              ];
          const node = createWorkloadNode(actor.name, 200 + i * 160, 200, {
            actorType: actorTask,
            wcet: wcetEntry?.wcet || 10,
            sourceAppName: app.name,
            sourceActorName: actor.name,
            sourceActorType: actorTask,
            sourcePorts: sourcePorts.length ? JSON.parse(JSON.stringify(sourcePorts)) : [{ name: "p_in", type: "in", rate: 1 }, { name: "p_out", type: "out", rate: 1 }],
            sourceWcets: JSON.parse(JSON.stringify(sourceWcets)),
          });`,
    'retain workload source application, ports and WCET rows on Studio nodes'
  );

  source = replaceOnce(
    source,
    `          const srcNode = studio.workloadNodes.find(n => n.label === ch.srcActor);
          const dstNode = studio.workloadNodes.find(n => n.label === ch.dstActor);`,
    `          const srcNode = studio.workloadNodes.find(n => n.label === ch.srcActor && String(n.properties.sourceAppName || "") === String(app.name || ""));
          const dstNode = studio.workloadNodes.find(n => n.label === ch.dstActor && String(n.properties.sourceAppName || "") === String(app.name || ""));`,
    'scope Studio channel matching to the source application'
  );

  source = replaceOnce(
    source,
    `            const edge = createEdge(srcNode, dstNode, {
              initialTokens: ch.initialTokens || 0,
              tokenSize: ch.size || 1,
            });`,
    `            const edge = createEdge(srcNode, dstNode, {
              initialTokens: ch.initialTokens || 0,
              tokenSize: ch.size || 1,
              sourceAppName: app.name,
              channelName: ch.name,
              srcPort: ch.srcPort || "p_out",
              dstPort: ch.dstPort || "p_in",
            });`,
    'retain channel names and port identities on Studio edges'
  );

  fs.writeFileSync(studioPath, source, 'utf8');
}

require('./round4_preflight');
