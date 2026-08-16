/*
 * ParetoCo Architecture Studio
 *
 * Interactive platform/workload model editor backed directly by
 * window.paretoco.state. The native-result overlay displays only task→PE
 * mappings present in solver output. It does not fabricate per-link traffic,
 * per-PE utilization/power, memory pressure, or critical paths.
 */
(() => {
  'use strict';

  const studio = {
    initialized: false,
    canvas: null,
    ctx: null,
    canvasW: 0,
    canvasH: 0,
    tab: 'platform',
    zoom: 1,
    panX: 0,
    panY: 0,
    nodes: [],
    edges: [],
    selectedId: null,
    draggingId: null,
    dragOffsetX: 0,
    dragOffsetY: 0,
    overlayVisible: false
  };

  const state = () => window.paretoco?.state;
  const api = () => window.paretoco;
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

  function nodeId(kind, index, subIndex = 0) {
    return `${kind}:${index}:${subIndex}`;
  }

  function totalCores(platform) {
    return (platform?.processors || []).reduce((sum, proc) => sum + Math.max(1, Number(proc.count) || 1), 0);
  }

  function rebuildFromState() {
    const appState = state();
    if (!appState) return;
    const nodes = [];
    const edges = [];

    if (studio.tab === 'platform') {
      let x = 140;
      let y = 150;
      (appState.platform?.processors || []).forEach((processor, processorIndex) => {
        const count = Math.max(1, Number(processor.count) || 1);
        for (let instance = 0; instance < count; instance++) {
          nodes.push({
            id: nodeId('processor', processorIndex, instance),
            kind: 'processor',
            processorIndex,
            instance,
            label: `${processor.model}_${instance}`,
            subtitle: processor.modes?.[0]?.name || 'default',
            x,
            y,
            w: 150,
            h: 70,
            overlay: { mappedTasks: [] }
          });
          x += 190;
          if (x > 720) { x = 140; y += 120; }
        }
      });

      (appState.platform?.interconnects || []).forEach((interconnect, index) => {
        nodes.push({
          id: nodeId('interconnect', index),
          kind: 'interconnect',
          interconnectIndex: index,
          label: interconnect.name || `bus_${index}`,
          subtitle: interconnect.topology || interconnect.type || 'interconnect',
          x: 160 + index * 210,
          y: Math.max(330, y + 80),
          w: 170,
          h: 60,
          overlay: {}
        });
      });

      const processors = nodes.filter(node => node.kind === 'processor');
      const interconnects = nodes.filter(node => node.kind === 'interconnect');
      for (const interconnect of interconnects) {
        for (const processor of processors) {
          edges.push({ id: `${interconnect.id}->${processor.id}`, from: interconnect.id, to: processor.id, kind: 'platform' });
        }
      }
    } else {
      let globalActorIndex = 0;
      (appState.applications || []).forEach((application, appIndex) => {
        const actorNodeByName = new Map();
        (application.actors || []).forEach((actor, actorIndex) => {
          const name = typeof actor === 'string' ? actor : (actor.name || actor.type || `actor_${actorIndex}`);
          const type = typeof actor === 'string' ? actor : (actor.type || actor.name || name);
          const wcet = (appState.wcets || []).find(row => row.taskType === type || row.taskType === name)?.wcet;
          const node = {
            id: nodeId('actor', appIndex, actorIndex),
            kind: 'actor',
            appIndex,
            actorIndex,
            globalActorIndex,
            label: name,
            subtitle: wcet ? `${type} · WCET ${wcet}` : type,
            x: 120 + (globalActorIndex % 4) * 190,
            y: 130 + Math.floor(globalActorIndex / 4) * 120,
            w: 155,
            h: 70,
            overlay: { mappedTo: null }
          };
          nodes.push(node);
          actorNodeByName.set(name, node);
          globalActorIndex += 1;
        });

        (application.channels || []).forEach((channel, channelIndex) => {
          const from = actorNodeByName.get(channel.srcActor || channel.src);
          const to = actorNodeByName.get(channel.dstActor || channel.dst);
          if (!from || !to) return;
          edges.push({
            id: nodeId('channel', appIndex, channelIndex),
            kind: 'channel',
            appIndex,
            channelIndex,
            from: from.id,
            to: to.id,
            label: channel.name || `ch_${channelIndex + 1}`,
            tokens: Number(channel.initialTokens ?? channel.tokens) || 0,
            size: Number(channel.size) || 1
          });
        });
      });
    }

    const previousPositions = new Map(studio.nodes.map(node => [node.id, { x: node.x, y: node.y }]));
    for (const node of nodes) {
      const old = previousPositions.get(node.id);
      if (old) { node.x = old.x; node.y = old.y; }
    }
    studio.nodes = nodes;
    studio.edges = edges;
    if (studio.selectedId && !nodes.some(node => node.id === studio.selectedId)) studio.selectedId = null;
    applyResultOverlay();
    renderPalette();
    renderInspector();
    draw();
  }

  function selectedNode() {
    return studio.nodes.find(node => node.id === studio.selectedId) || null;
  }

  function screenToWorld(clientX, clientY) {
    const rect = studio.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - studio.panX) / studio.zoom,
      y: (clientY - rect.top - studio.panY) / studio.zoom
    };
  }

  function hitNode(worldX, worldY) {
    for (let i = studio.nodes.length - 1; i >= 0; i--) {
      const node = studio.nodes[i];
      if (worldX >= node.x && worldX <= node.x + node.w && worldY >= node.y && worldY <= node.y + node.h) return node;
    }
    return null;
  }

  function nodeCenter(node) {
    return { x: node.x + node.w / 2, y: node.y + node.h / 2 };
  }

  function resizeCanvas() {
    if (!studio.canvas) return;
    const rect = studio.canvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    studio.canvasW = Math.max(320, Math.floor(rect.width || studio.canvas.clientWidth || 900));
    studio.canvasH = Math.max(420, Math.floor(rect.height || studio.canvas.clientHeight || 560));
    studio.canvas.width = Math.floor(studio.canvasW * dpr);
    studio.canvas.height = Math.floor(studio.canvasH * dpr);
    studio.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawGrid(ctx, width, height) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#eef2f7';
    ctx.lineWidth = 1;
    const spacing = 32;
    for (let x = ((studio.panX % (spacing * studio.zoom)) + spacing * studio.zoom) % (spacing * studio.zoom); x < width; x += spacing * studio.zoom) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let y = ((studio.panY % (spacing * studio.zoom)) + spacing * studio.zoom) % (spacing * studio.zoom); y < height; y += spacing * studio.zoom) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
  }

  function draw() {
    if (!studio.ctx || !studio.canvas) return;
    resizeCanvas();
    const ctx = studio.ctx;
    drawGrid(ctx, studio.canvasW, studio.canvasH);

    ctx.save();
    ctx.translate(studio.panX, studio.panY);
    ctx.scale(studio.zoom, studio.zoom);

    for (const edge of studio.edges) {
      const from = studio.nodes.find(node => node.id === edge.from);
      const to = studio.nodes.find(node => node.id === edge.to);
      if (!from || !to) continue;
      const a = nodeCenter(from);
      const b = nodeCenter(to);
      ctx.strokeStyle = edge.kind === 'channel' ? '#64748b' : '#94a3b8';
      ctx.lineWidth = edge.kind === 'channel' ? 2 : 1.5;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      if (edge.kind === 'channel') {
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        ctx.fillStyle = '#64748b';
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x - 10 * Math.cos(angle - Math.PI / 6), b.y - 10 * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(b.x - 10 * Math.cos(angle + Math.PI / 6), b.y - 10 * Math.sin(angle + Math.PI / 6));
        ctx.closePath(); ctx.fill();
        if (edge.label) {
          ctx.fillStyle = '#475569';
          ctx.font = '11px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(edge.label, (a.x + b.x) / 2, (a.y + b.y) / 2 - 6);
        }
      }
    }

    for (const node of studio.nodes) {
      const selected = node.id === studio.selectedId;
      const mapped = node.kind === 'actor' && Number.isInteger(node.overlay?.mappedTo);
      ctx.fillStyle = node.kind === 'interconnect' ? '#f1f5f9' : mapped ? '#eff6ff' : '#ffffff';
      ctx.strokeStyle = selected ? '#2563eb' : mapped ? '#3b82f6' : '#94a3b8';
      ctx.lineWidth = selected ? 3 : 1.5;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(node.x, node.y, node.w, node.h, 8);
      else ctx.rect(node.x, node.y, node.w, node.h);
      ctx.fill(); ctx.stroke();

      ctx.fillStyle = '#0f172a';
      ctx.font = '600 13px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(node.label, node.x + 10, node.y + 25, node.w - 20);
      ctx.fillStyle = '#64748b';
      ctx.font = '11px sans-serif';
      ctx.fillText(node.subtitle || '', node.x + 10, node.y + 45, node.w - 20);
      if (mapped) {
        ctx.fillStyle = '#1d4ed8';
        ctx.font = '600 10px sans-serif';
        ctx.fillText(`Native PE ${node.overlay.mappedTo}`, node.x + 10, node.y + node.h - 8);
      }
      if (node.kind === 'processor' && node.overlay?.mappedTasks?.length) {
        ctx.fillStyle = '#1d4ed8';
        ctx.font = '600 10px sans-serif';
        ctx.fillText(`${node.overlay.mappedTasks.length} mapped task(s)`, node.x + 10, node.y + node.h - 8);
      }
    }
    ctx.restore();
  }

  function makeField(container, labelText, value, onChange, type = 'text') {
    const wrapper = document.createElement('div');
    wrapper.className = 'inspector-field';
    const label = document.createElement('label');
    label.textContent = labelText;
    const input = document.createElement('input');
    input.className = 'inspector-input';
    input.type = type;
    input.value = value ?? '';
    input.addEventListener('change', () => onChange(type === 'number' ? Number(input.value) : input.value));
    wrapper.append(label, input);
    container.appendChild(wrapper);
  }

  function renderInspector() {
    const target = document.getElementById('studio-inspector');
    if (!target) return;
    target.replaceChildren();
    const node = selectedNode();
    if (!node) {
      const p = document.createElement('p');
      p.textContent = 'Select a node to edit model properties.';
      target.appendChild(p);
      return;
    }
    const appState = state();
    const title = document.createElement('h3');
    title.textContent = node.label;
    target.appendChild(title);

    if (node.kind === 'processor') {
      const processor = appState.platform.processors[node.processorIndex];
      const mode = processor?.modes?.[0];
      if (!processor || !mode) return;
      makeField(target, 'Model', processor.model, value => { processor.model = String(value).trim() || processor.model; saveAndRebuild(); });
      makeField(target, 'Instances', processor.count, value => { processor.count = Math.max(1, Math.round(value || 1)); saveAndRebuild(); }, 'number');
      makeField(target, 'Mode', mode.name, value => { mode.name = String(value).trim() || mode.name; saveAndRebuild(); });
      makeField(target, 'Memory (KB)', mode.mem, value => { mode.mem = Math.max(1, value || 1); saveAndRebuild(); }, 'number');
      makeField(target, 'Dynamic power', mode.dynPower, value => { mode.dynPower = Math.max(0, value || 0); saveAndRebuild(); }, 'number');
      makeField(target, 'Static power', mode.staticPower, value => { mode.staticPower = Math.max(0, value || 0); saveAndRebuild(); }, 'number');
      makeField(target, 'Area', mode.area, value => { mode.area = Math.max(0, value || 0); saveAndRebuild(); }, 'number');
      makeField(target, 'Cost', mode.monetary, value => { mode.monetary = Math.max(0, value || 0); saveAndRebuild(); }, 'number');
    } else if (node.kind === 'interconnect') {
      const interconnect = appState.platform.interconnects[node.interconnectIndex];
      if (!interconnect) return;
      makeField(target, 'Name', interconnect.name, value => { interconnect.name = String(value).trim() || interconnect.name; saveAndRebuild(); });
      makeField(target, 'Topology', interconnect.topology, value => { interconnect.topology = String(value).trim() || interconnect.topology; saveAndRebuild(); });
      makeField(target, 'Flit size', interconnect.flitSize, value => { interconnect.flitSize = Math.max(1, value || 1); saveAndRebuild(); }, 'number');
      makeField(target, 'TDMA slots', interconnect.slots, value => { interconnect.slots = Math.max(1, Math.round(value || 1)); saveAndRebuild(); }, 'number');
    } else if (node.kind === 'actor') {
      const application = appState.applications[node.appIndex];
      const actor = application?.actors?.[node.actorIndex];
      if (!application || actor == null) return;
      const actorObj = typeof actor === 'string' ? { name: actor, type: actor, ports: [] } : actor;
      if (typeof actor === 'string') application.actors[node.actorIndex] = actorObj;
      makeField(target, 'Actor name', actorObj.name, value => {
        const previous = actorObj.name;
        actorObj.name = String(value).trim() || previous;
        for (const channel of application.channels || []) {
          if (channel.srcActor === previous) channel.srcActor = actorObj.name;
          if (channel.dstActor === previous) channel.dstActor = actorObj.name;
        }
        saveAndRebuild();
      });
      makeField(target, 'Actor type', actorObj.type || actorObj.name, value => {
        const previous = actorObj.type || actorObj.name;
        actorObj.type = String(value).trim() || previous;
        for (const wcet of appState.wcets || []) if (wcet.taskType === previous) wcet.taskType = actorObj.type;
        saveAndRebuild();
      });
      const wcet = (appState.wcets || []).find(row => row.taskType === (actorObj.type || actorObj.name));
      if (wcet) makeField(target, 'WCET (cycles)', wcet.wcet, value => { wcet.wcet = Math.max(1, Math.round(value || 1)); saveAndRebuild(); }, 'number');
    }
  }

  function saveAndRebuild() {
    api()?.save?.();
    rebuildFromState();
  }

  function addProcessor() {
    const appState = state();
    appState.platform.processors.push({
      model: `Processor_${appState.platform.processors.length + 1}`,
      count: 1,
      modes: [{ name: 'default', cycle: 1, mem: 4096, dynPower: 10, staticPower: 2, area: 5, monetary: 10 }]
    });
    saveAndRebuild();
  }

  function addInterconnect() {
    const appState = state();
    const cores = totalCores(appState.platform);
    appState.platform.interconnects.push({
      name: `bus_${appState.platform.interconnects.length + 1}`,
      topology: 'TDMA-bus',
      xDim: Math.max(1, cores),
      yDim: 1,
      flitSize: 32,
      slots: Math.max(2, cores)
    });
    saveAndRebuild();
  }

  function addActor() {
    const appState = state();
    if (!appState.applications.length) appState.applications.push({ name: 'StudioApp', actors: [], channels: [] });
    const application = appState.applications[0];
    const index = application.actors.length + 1;
    const name = `task_${index}`;
    application.actors.push({ name, type: name, ports: [{ name: 'p_in', type: 'in', rate: 1 }, { name: 'p_out', type: 'out', rate: 1 }] });
    const processor = appState.platform.processors[0];
    if (processor?.modes?.[0]) {
      appState.wcets.push({ taskType: name, procModel: processor.model, processor: processor.model, mode: processor.modes[0].name, wcet: 10 });
    }
    saveAndRebuild();
  }

  function addChannelBetweenSelectedActors() {
    const selected = studio.nodes.filter(node => node.kind === 'actor' && node.selectedForChannel);
    if (selected.length !== 2) {
      api()?.toast?.('Mark exactly two tasks using “Use for Channel”, then add the channel.', 'info');
      return;
    }
    const [from, to] = selected;
    if (from.appIndex !== to.appIndex) {
      api()?.toast?.('Channels must connect actors in the same application.', 'error');
      return;
    }
    const application = state().applications[from.appIndex];
    application.channels = application.channels || [];
    application.channels.push({
      name: `ch_${application.channels.length + 1}`,
      srcActor: from.label,
      srcPort: 'p_out',
      dstActor: to.label,
      dstPort: 'p_in',
      initialTokens: 0,
      size: 1
    });
    for (const node of studio.nodes) node.selectedForChannel = false;
    saveAndRebuild();
  }

  function renderPalette() {
    const target = document.getElementById('studio-palette');
    if (!target) return;
    target.replaceChildren();
    const addButton = (label, handler) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-outline btn-sm';
      button.style.cssText = 'display:block;width:100%;margin-bottom:8px';
      button.textContent = label;
      button.addEventListener('click', handler);
      target.appendChild(button);
    };
    if (studio.tab === 'platform') {
      addButton('Add Processor', addProcessor);
      addButton('Add TDMA Bus', addInterconnect);
    } else {
      addButton('Add Task', addActor);
      addButton('Use Selected for Channel', () => {
        const node = selectedNode();
        if (!node || node.kind !== 'actor') return;
        node.selectedForChannel = !node.selectedForChannel;
        draw();
      });
      addButton('Add Channel Between Marked Tasks', addChannelBetweenSelectedActors);
    }
  }

  function applyResultOverlay() {
    for (const node of studio.nodes) {
      node.overlay = node.kind === 'processor' ? { mappedTasks: [] } : node.kind === 'actor' ? { mappedTo: null } : {};
    }
    const rows = state()?.results?.rows || [];
    if (!rows.length) {
      studio.overlayVisible = false;
      return;
    }
    studio.overlayVisible = true;
    const mapping = String(rows[rows.length - 1]['PE Mapping'] || '')
      .split(/[,\s]+/)
      .map(Number)
      .filter(Number.isInteger);
    const actors = studio.nodes.filter(node => node.kind === 'actor').sort((a, b) => a.globalActorIndex - b.globalActorIndex);
    const processors = studio.nodes.filter(node => node.kind === 'processor');
    mapping.forEach((peIndex, taskIndex) => {
      if (actors[taskIndex]) actors[taskIndex].overlay.mappedTo = peIndex;
      if (processors[peIndex]) processors[peIndex].overlay.mappedTasks.push(taskIndex);
    });
  }

  function onMouseDown(event) {
    const point = screenToWorld(event.clientX, event.clientY);
    const node = hitNode(point.x, point.y);
    studio.selectedId = node?.id || null;
    if (node) {
      studio.draggingId = node.id;
      studio.dragOffsetX = point.x - node.x;
      studio.dragOffsetY = point.y - node.y;
    }
    renderInspector();
    draw();
  }

  function onMouseMove(event) {
    if (!studio.draggingId) return;
    const node = studio.nodes.find(item => item.id === studio.draggingId);
    if (!node) return;
    const point = screenToWorld(event.clientX, event.clientY);
    node.x = point.x - studio.dragOffsetX;
    node.y = point.y - studio.dragOffsetY;
    draw();
  }

  function onMouseUp() {
    studio.draggingId = null;
  }

  function onWheel(event) {
    event.preventDefault();
    const before = screenToWorld(event.clientX, event.clientY);
    const factor = event.deltaY < 0 ? 1.1 : 0.9;
    studio.zoom = Math.min(2.2, Math.max(0.45, studio.zoom * factor));
    const rect = studio.canvas.getBoundingClientRect();
    studio.panX = event.clientX - rect.left - before.x * studio.zoom;
    studio.panY = event.clientY - rect.top - before.y * studio.zoom;
    draw();
  }

  function switchTab(tab) {
    studio.tab = tab;
    document.querySelectorAll('.studio-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
    studio.selectedId = null;
    rebuildFromState();
  }

  function bindEvents() {
    studio.canvas.addEventListener('mousedown', onMouseDown);
    studio.canvas.addEventListener('mousemove', onMouseMove);
    studio.canvas.addEventListener('mouseup', onMouseUp);
    studio.canvas.addEventListener('mouseleave', onMouseUp);
    studio.canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', draw);
    document.querySelectorAll('.studio-tab').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));
    document.getElementById('studio-overlay-toggle')?.addEventListener('click', () => {
      applyResultOverlay();
      draw();
    });
  }

  function init() {
    const canvas = document.getElementById('studio-canvas');
    if (!canvas) return;
    if (!studio.initialized || studio.canvas !== canvas) {
      studio.canvas = canvas;
      studio.ctx = canvas.getContext('2d');
      studio.initialized = true;
      bindEvents();
    }
    rebuildFromState();
  }

  function clear() {
    studio.nodes = [];
    studio.edges = [];
    studio.selectedId = null;
    draw();
  }

  window.ArchStudio = {
    init,
    clear,
    syncCanvasFromModel: rebuildFromState,
    applyResultOverlay,
    getStudio: () => studio
  };
})();
