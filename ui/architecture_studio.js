/* ════════════════════════════════════════════════════════════════
   ParetoCo — Live Architecture Studio
   ════════════════════════════════════════════════════════════════
   Canvas-based graphical editor for platform topology & workload
   graphs. Results animate directly onto the diagram.
   
   Fully decoupled from the engine — reads/writes to the shared
   state object exposed on window.paretoco.state.
   ════════════════════════════════════════════════════════════════ */

(() => {
  "use strict";

  // ═══════════════════════ CONSTANTS ═══════════════════════════
  const NODE_TYPES = {
    CPU:         { label: "CPU",         icon: "🖥️", color: "#3b82f6", w: 120, h: 70 },
    DSP:         { label: "DSP",         icon: "📡", color: "#8b5cf6", w: 120, h: 70 },
    GPU:         { label: "GPU",         icon: "🎮", color: "#10b981", w: 120, h: 70 },
    NPU:         { label: "NPU",         icon: "🧠", color: "#f59e0b", w: 120, h: 70 },
    Accelerator: { label: "Accelerator", icon: "⚡", color: "#ef4444", w: 120, h: 70 },
    Memory:      { label: "Memory",      icon: "💾", color: "#06b6d4", w: 100, h: 60 },
    NoC:         { label: "NoC",         icon: "🔗", color: "#ec4899", w: 100, h: 60 },
    Bus:         { label: "Bus",         icon: "🔌", color: "#78716c", w: 100, h: 60 },
  };

  const TASK_COLORS = ["#00f0ff", "#3b82f6", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#06b6d4"];

  const PORT_RADIUS = 6;
  const GRID_SIZE = 20;
  const MIN_ZOOM = 0.3;
  const MAX_ZOOM = 3.0;

  // ═══════════════════════ STUDIO STATE ════════════════════════
  let canvas, ctx;
  let activeTab = "platform"; // "platform" | "workload"

  const studio = {
    // Platform nodes & edges
    platformNodes: [],
    platformEdges: [],
    // Workload nodes & edges
    workloadNodes: [],
    workloadEdges: [],
    // Viewport
    panX: 0, panY: 0, zoom: 1,
    // Interaction
    dragging: null,       // {type:"node"|"pan"|"edge"|"rubberband", ...}
    hoveredNode: null,
    hoveredEdge: null,
    hoveredPort: null,
    selectedNodes: new Set(),
    selectedEdge: null,
    // Property inspector
    inspectedItem: null,
    // Result overlay
    overlayVisible: false,
    overlayData: null,
    // Animation
    animFrame: null,
    flowOffset: 0,
    // Canvas dimensions
    canvasW: 0, canvasH: 0,
  };

  let nextNodeId = 1;
  let nextEdgeId = 1;

  // ═══════════════════════ HELPERS ═════════════════════════════
  function getNodes() { return activeTab === "platform" ? studio.platformNodes : studio.workloadNodes; }
  function getEdges() { return activeTab === "platform" ? studio.platformEdges : studio.workloadEdges; }

  function screenToWorld(sx, sy) {
    return {
      x: (sx - studio.panX) / studio.zoom,
      y: (sy - studio.panY) / studio.zoom
    };
  }

  function worldToScreen(wx, wy) {
    return {
      x: wx * studio.zoom + studio.panX,
      y: wy * studio.zoom + studio.panY
    };
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ═══════════════════════ NODE FACTORY ════════════════════════
  function createPlatformNode(type, x, y, props = {}) {
    const def = NODE_TYPES[type] || NODE_TYPES.CPU;
    const id = "pn_" + (nextNodeId++);
    return {
      id, type, x, y,
      w: def.w, h: def.h,
      label: props.label || (def.label + " " + nextNodeId),
      properties: {
        model: props.model || def.label,
        count: props.count || 1,
        mode: props.mode || "default",
        cycle: props.cycle || 1,
        memory: props.memory || 4096,
        dynPower: props.dynPower || 10,
        staticPower: props.staticPower || 2,
        area: props.area || 5,
        cost: props.cost || 10,
        bandwidth: props.bandwidth || 0,
        bufferSize: props.bufferSize || 0,
        routing: props.routing || "XY",
        frequency: props.frequency || 1000,
        ...props
      },
      // Ports: left/right for connections
      ports: [
        { id: id + "_in",  side: "left",  offset: 0.5 },
        { id: id + "_out", side: "right", offset: 0.5 },
      ],
      // Overlay data
      overlay: { utilization: 0, power: 0, mappedTasks: [], isCritical: false, memPressure: 0 }
    };
  }

  function createWorkloadNode(name, x, y, props = {}) {
    const id = "wn_" + (nextNodeId++);
    return {
      id, type: "task", x, y,
      w: 110, h: 55,
      label: name || ("Task_" + nextNodeId),
      properties: {
        actorType: props.actorType || name || "task",
        wcet: props.wcet || 10,
        period: props.period || 0,
        deadline: props.deadline || 0,
        priority: props.priority || 0,
        memoryReq: props.memoryReq || 0,
        ...props
      },
      ports: [
        { id: id + "_in",  side: "left",  offset: 0.5 },
        { id: id + "_out", side: "right", offset: 0.5 },
      ],
      overlay: { mappedTo: null, startTime: 0, endTime: 0, isCritical: false }
    };
  }

  function createEdge(srcNode, dstNode, props = {}) {
    const id = "e_" + (nextEdgeId++);
    return {
      id,
      srcNodeId: srcNode.id,
      dstNodeId: dstNode.id,
      srcPortId: srcNode.ports.find(p => p.side === "right")?.id || srcNode.ports[1]?.id,
      dstPortId: dstNode.ports.find(p => p.side === "left")?.id || dstNode.ports[0]?.id,
      properties: {
        bandwidth: props.bandwidth || 0,
        bufferSize: props.bufferSize || 1,
        latency: props.latency || 0,
        initialTokens: props.initialTokens || 0,
        tokenSize: props.tokenSize || 1,
        ...props
      },
      overlay: { saturated: false, utilization: 0, dataRate: 0, isCritical: false }
    };
  }

  // ═══════════════════════ PORT POSITIONS ══════════════════════
  function getPortPos(node, port) {
    const hw = node.w / 2;
    const hh = node.h / 2;
    let px, py;
    switch (port.side) {
      case "left":   px = node.x - hw;       py = node.y - hh + node.h * port.offset; break;
      case "right":  px = node.x + hw;       py = node.y - hh + node.h * port.offset; break;
      case "top":    px = node.x - hw + node.w * port.offset; py = node.y - hh; break;
      case "bottom": px = node.x - hw + node.w * port.offset; py = node.y + hh; break;
      default:       px = node.x; py = node.y;
    }
    return { x: px, y: py };
  }

  // ═══════════════════════ HIT TESTING ════════════════════════
  function hitTestNode(wx, wy) {
    const nodes = getNodes();
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (wx >= n.x - n.w/2 && wx <= n.x + n.w/2 && wy >= n.y - n.h/2 && wy <= n.y + n.h/2) {
        return n;
      }
    }
    return null;
  }

  function hitTestPort(wx, wy) {
    const nodes = getNodes();
    for (let i = nodes.length - 1; i >= 0; i--) {
      for (const port of nodes[i].ports) {
        const pp = getPortPos(nodes[i], port);
        const dx = wx - pp.x, dy = wy - pp.y;
        if (dx*dx + dy*dy < (PORT_RADIUS + 4) * (PORT_RADIUS + 4)) {
          return { node: nodes[i], port };
        }
      }
    }
    return null;
  }

  function hitTestEdge(wx, wy) {
    const edges = getEdges();
    const nodes = getNodes();
    const threshold = 8 / studio.zoom;
    for (const edge of edges) {
      const srcNode = nodes.find(n => n.id === edge.srcNodeId);
      const dstNode = nodes.find(n => n.id === edge.dstNodeId);
      if (!srcNode || !dstNode) continue;
      const srcPort = srcNode.ports.find(p => p.id === edge.srcPortId);
      const dstPort = dstNode.ports.find(p => p.id === edge.dstPortId);
      if (!srcPort || !dstPort) continue;
      const sp = getPortPos(srcNode, srcPort);
      const dp = getPortPos(dstNode, dstPort);
      const dist = pointToSegmentDist(wx, wy, sp.x, sp.y, dp.x, dp.y);
      if (dist < threshold) return edge;
    }
    return null;
  }

  function pointToSegmentDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx*dx + dy*dy;
    if (lenSq === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax)*dx + (py - ay)*dy) / lenSq;
    t = clamp(t, 0, 1);
    return Math.hypot(px - (ax + t*dx), py - (ay + t*dy));
  }

  // ═══════════════════════ RENDERING ══════════════════════════
  function render() {
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    studio.canvasW = canvas.offsetWidth;
    studio.canvasH = canvas.offsetHeight;
    canvas.width = studio.canvasW * dpr;
    canvas.height = studio.canvasH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = studio.canvasW;
    const h = studio.canvasH;

    // Background
    ctx.fillStyle = "#0a0c14";
    ctx.fillRect(0, 0, w, h);

    // Grid
    drawGrid(w, h);

    // Apply camera transform
    ctx.save();
    ctx.translate(studio.panX, studio.panY);
    ctx.scale(studio.zoom, studio.zoom);

    const nodes = getNodes();
    const edges = getEdges();

    // Draw edges
    edges.forEach(edge => drawEdge(edge, nodes));

    // Draw edge being created
    if (studio.dragging && studio.dragging.type === "edge") {
      const sp = getPortPos(studio.dragging.srcNode, studio.dragging.srcPort);
      const wp = screenToWorld(studio.dragging.mx, studio.dragging.my);
      ctx.strokeStyle = "rgba(0, 240, 255, 0.6)";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(sp.x, sp.y);
      ctx.lineTo(wp.x, wp.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw nodes
    nodes.forEach(node => drawNode(node));

    // Rubber-band selection
    if (studio.dragging && studio.dragging.type === "rubberband") {
      const s = studio.dragging;
      const wp1 = screenToWorld(s.startX, s.startY);
      const wp2 = screenToWorld(s.mx, s.my);
      ctx.strokeStyle = "rgba(0, 240, 255, 0.5)";
      ctx.fillStyle = "rgba(0, 240, 255, 0.08)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      const rx = Math.min(wp1.x, wp2.x), ry = Math.min(wp1.y, wp2.y);
      const rw = Math.abs(wp2.x - wp1.x), rh = Math.abs(wp2.y - wp1.y);
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);
    }

    ctx.restore();

    // Animate flow particles
    studio.flowOffset += 0.5;
    if (studio.flowOffset > 40) studio.flowOffset = 0;

    studio.animFrame = requestAnimationFrame(render);
  }

  function drawGrid(w, h) {
    const gs = GRID_SIZE * studio.zoom;
    if (gs < 6) return; // too zoomed out
    ctx.strokeStyle = "rgba(255, 255, 255, 0.03)";
    ctx.lineWidth = 0.5;
    const offX = studio.panX % gs;
    const offY = studio.panY % gs;
    for (let x = offX; x < w; x += gs) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = offY; y < h; y += gs) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
  }

  function drawNode(node) {
    const isSelected = studio.selectedNodes.has(node.id);
    const isHovered = studio.hoveredNode === node;
    const isPlatform = activeTab === "platform";
    const def = isPlatform ? (NODE_TYPES[node.type] || NODE_TYPES.CPU) : null;
    const baseColor = isPlatform ? def.color : TASK_COLORS[getNodes().indexOf(node) % TASK_COLORS.length];

    const x = node.x - node.w/2;
    const y = node.y - node.h/2;

    // Glow for selected/hovered
    if (isSelected || isHovered) {
      ctx.shadowColor = baseColor;
      ctx.shadowBlur = isSelected ? 20 : 12;
    }

    // Node body
    ctx.fillStyle = "rgba(20, 22, 35, 0.85)";
    ctx.strokeStyle = isSelected ? "#00f0ff" : (isHovered ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.1)");
    ctx.lineWidth = isSelected ? 2.5 : 1.5;
    roundRect(ctx, x, y, node.w, node.h, 10);
    ctx.fill();
    ctx.stroke();

    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;

    // Color accent bar at top
    ctx.fillStyle = baseColor;
    ctx.beginPath();
    ctx.moveTo(x + 10, y);
    ctx.lineTo(x + node.w - 10, y);
    ctx.quadraticCurveTo(x + node.w, y, x + node.w, y + 4);
    ctx.lineTo(x, y + 4);
    ctx.quadraticCurveTo(x, y, x + 10, y);
    ctx.fill();

    // Icon & label
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 13px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const iconStr = isPlatform ? def.icon : "⬡";
    ctx.font = "16px sans-serif";
    ctx.fillText(iconStr, node.x, node.y - 8);
    ctx.font = "bold 11px Inter, sans-serif";
    ctx.fillStyle = "#e5e7eb";
    const truncLabel = node.label.length > 14 ? node.label.slice(0, 12) + "…" : node.label;
    ctx.fillText(truncLabel, node.x, node.y + 12);

    // Overlay badges
    if (studio.overlayVisible && node.overlay) {
      drawOverlayBadges(node, baseColor);
    }

    // Ports
    node.ports.forEach(port => {
      const pp = getPortPos(node, port);
      const isHoveredPort = studio.hoveredPort && studio.hoveredPort.port.id === port.id;
      ctx.fillStyle = isHoveredPort ? "#00f0ff" : "rgba(255,255,255,0.5)";
      ctx.beginPath();
      ctx.arc(pp.x, pp.y, isHoveredPort ? PORT_RADIUS + 2 : PORT_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      if (isHoveredPort) {
        ctx.strokeStyle = "#00f0ff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    });
  }

  function drawOverlayBadges(node, baseColor) {
    const x = node.x + node.w/2 - 8;
    const y = node.y - node.h/2;
    if (activeTab === "platform") {
      // Utilization gauge
      const util = node.overlay.utilization || 0;
      if (util > 0) {
        const gaugeW = 32, gaugeH = 6;
        const gx = node.x - gaugeW/2;
        const gy = node.y + node.h/2 - 12;
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        roundRect(ctx, gx - 2, gy - 2, gaugeW + 4, gaugeH + 4, 3);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.15)";
        roundRect(ctx, gx, gy, gaugeW, gaugeH, 2);
        ctx.fill();
        const utilColor = util > 80 ? "#ef4444" : (util > 50 ? "#f59e0b" : "#10b981");
        ctx.fillStyle = utilColor;
        roundRect(ctx, gx, gy, gaugeW * (util/100), gaugeH, 2);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 8px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(util + "%", node.x, gy - 4);
      }
      // Power badge
      if (node.overlay.power > 0) {
        ctx.fillStyle = "rgba(239, 68, 68, 0.8)";
        ctx.font = "bold 9px Inter, sans-serif";
        ctx.textAlign = "right";
        ctx.fillText("⚡" + node.overlay.power + "mW", x, y + 16);
      }
      // Mapped tasks count
      if (node.overlay.mappedTasks && node.overlay.mappedTasks.length > 0) {
        ctx.fillStyle = "rgba(0, 240, 255, 0.8)";
        ctx.font = "bold 9px Inter, sans-serif";
        ctx.textAlign = "left";
        ctx.fillText("📋" + node.overlay.mappedTasks.length, node.x - node.w/2 + 8, y + 16);
      }
      // Memory pressure
      if (node.overlay.memPressure > 0) {
        const mpColor = node.overlay.memPressure > 80 ? "#ef4444" : (node.overlay.memPressure > 50 ? "#f59e0b" : "#10b981");
        ctx.fillStyle = mpColor;
        ctx.font = "bold 8px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("MEM " + node.overlay.memPressure + "%", node.x, node.y + node.h/2 + 10);
      }
    } else {
      // Workload: mapped-to badge
      if (node.overlay.mappedTo !== null && node.overlay.mappedTo !== undefined) {
        ctx.fillStyle = "rgba(59, 130, 246, 0.85)";
        ctx.font = "bold 9px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("→ PE" + node.overlay.mappedTo, node.x, node.y + node.h/2 + 10);
      }
    }

    // Critical path highlight
    if (node.overlay.isCritical) {
      ctx.strokeStyle = "rgba(239, 68, 68, 0.7)";
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      roundRect(ctx, node.x - node.w/2 - 3, node.y - node.h/2 - 3, node.w + 6, node.h + 6, 12);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function drawEdge(edge, nodes) {
    const srcNode = nodes.find(n => n.id === edge.srcNodeId);
    const dstNode = nodes.find(n => n.id === edge.dstNodeId);
    if (!srcNode || !dstNode) return;

    const srcPort = srcNode.ports.find(p => p.id === edge.srcPortId);
    const dstPort = dstNode.ports.find(p => p.id === edge.dstPortId);
    if (!srcPort || !dstPort) return;

    const sp = getPortPos(srcNode, srcPort);
    const dp = getPortPos(dstNode, dstPort);

    const isSelected = studio.selectedEdge === edge;
    const isHovered = studio.hoveredEdge === edge;
    const isSaturated = studio.overlayVisible && edge.overlay && edge.overlay.saturated;
    const isCritical = studio.overlayVisible && edge.overlay && edge.overlay.isCritical;

    // Edge color
    let color = "rgba(255, 255, 255, 0.2)";
    if (isSelected) color = "#00f0ff";
    else if (isHovered) color = "rgba(255, 255, 255, 0.5)";
    else if (isSaturated) color = "#ef4444";
    else if (isCritical) color = "#f59e0b";

    // Bezier control points
    const dx = dp.x - sp.x;
    const cpOffset = Math.max(40, Math.abs(dx) * 0.4);
    const cp1x = sp.x + cpOffset;
    const cp1y = sp.y;
    const cp2x = dp.x - cpOffset;
    const cp2y = dp.y;

    // Main curve
    ctx.strokeStyle = color;
    ctx.lineWidth = isSaturated ? 3 : (isSelected ? 2.5 : 1.5);
    ctx.beginPath();
    ctx.moveTo(sp.x, sp.y);
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, dp.x, dp.y);
    ctx.stroke();

    // Arrowhead
    const t = 0.95;
    const endX = bezierPoint(sp.x, cp1x, cp2x, dp.x, t);
    const endY = bezierPoint(sp.y, cp1y, cp2y, dp.y, t);
    const prevX = bezierPoint(sp.x, cp1x, cp2x, dp.x, t - 0.02);
    const prevY = bezierPoint(sp.y, cp1y, cp2y, dp.y, t - 0.02);
    const angle = Math.atan2(endY - prevY, endX - prevX);
    const headLen = 8;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(dp.x, dp.y);
    ctx.lineTo(dp.x - headLen * Math.cos(angle - 0.35), dp.y - headLen * Math.sin(angle - 0.35));
    ctx.lineTo(dp.x - headLen * Math.cos(angle + 0.35), dp.y - headLen * Math.sin(angle + 0.35));
    ctx.closePath();
    ctx.fill();

    // Flow particles (when overlay active and data flowing)
    if (studio.overlayVisible && edge.overlay && edge.overlay.dataRate > 0) {
      drawFlowParticles(sp, dp, cp1x, cp1y, cp2x, cp2y, isSaturated ? "#ef4444" : "#00f0ff");
    }

    // Bandwidth label
    if (studio.overlayVisible && edge.overlay && edge.overlay.utilization > 0) {
      const midT = 0.5;
      const mx = bezierPoint(sp.x, cp1x, cp2x, dp.x, midT);
      const my = bezierPoint(sp.y, cp1y, cp2y, dp.y, midT);
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      roundRect(ctx, mx - 22, my - 8, 44, 16, 4);
      ctx.fill();
      ctx.fillStyle = isSaturated ? "#ef4444" : "#10b981";
      ctx.font = "bold 8px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(edge.overlay.utilization + "%", mx, my);
    }
  }

  function drawFlowParticles(sp, dp, cp1x, cp1y, cp2x, cp2y, color) {
    const count = 5;
    for (let i = 0; i < count; i++) {
      const t = ((studio.flowOffset / 40) + i / count) % 1;
      const px = bezierPoint(sp.x, cp1x, cp2x, dp.x, t);
      const py = bezierPoint(sp.y, cp1y, cp2y, dp.y, t);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function bezierPoint(p0, p1, p2, p3, t) {
    const mt = 1 - t;
    return mt*mt*mt*p0 + 3*mt*mt*t*p1 + 3*mt*t*t*p2 + t*t*t*p3;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // ═══════════════════════ EVENT HANDLERS ═════════════════════
  function onMouseDown(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const wp = screenToWorld(sx, sy);

    // Check port hit first (for edge creation)
    const portHit = hitTestPort(wp.x, wp.y);
    if (portHit && portHit.port.side === "right") {
      studio.dragging = { type: "edge", srcNode: portHit.node, srcPort: portHit.port, mx: sx, my: sy };
      return;
    }

    // Check node hit
    const nodeHit = hitTestNode(wp.x, wp.y);
    if (nodeHit) {
      if (!e.shiftKey && !studio.selectedNodes.has(nodeHit.id)) {
        studio.selectedNodes.clear();
        studio.selectedEdge = null;
      }
      studio.selectedNodes.add(nodeHit.id);
      studio.inspectedItem = { type: "node", item: nodeHit };
      renderPropertyInspector();
      studio.dragging = {
        type: "node",
        node: nodeHit,
        offsetX: wp.x - nodeHit.x,
        offsetY: wp.y - nodeHit.y,
        startX: nodeHit.x,
        startY: nodeHit.y
      };
      return;
    }

    // Check edge hit
    const edgeHit = hitTestEdge(wp.x, wp.y);
    if (edgeHit) {
      studio.selectedNodes.clear();
      studio.selectedEdge = edgeHit;
      studio.inspectedItem = { type: "edge", item: edgeHit };
      renderPropertyInspector();
      return;
    }

    // Pan or rubber-band
    if (e.shiftKey) {
      studio.dragging = { type: "rubberband", startX: sx, startY: sy, mx: sx, my: sy };
    } else {
      studio.selectedNodes.clear();
      studio.selectedEdge = null;
      studio.inspectedItem = null;
      renderPropertyInspector();
      studio.dragging = { type: "pan", startX: sx, startY: sy, startPanX: studio.panX, startPanY: studio.panY };
    }
  }

  function onMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const wp = screenToWorld(sx, sy);

    if (studio.dragging) {
      const d = studio.dragging;
      if (d.type === "node") {
        const snapX = Math.round((wp.x - d.offsetX) / GRID_SIZE) * GRID_SIZE;
        const snapY = Math.round((wp.y - d.offsetY) / GRID_SIZE) * GRID_SIZE;
        const dx = snapX - d.node.x;
        const dy = snapY - d.node.y;
        // Move all selected nodes
        studio.selectedNodes.forEach(nid => {
          const n = getNodes().find(nn => nn.id === nid);
          if (n) { n.x += dx; n.y += dy; }
        });
        d.node.x = snapX;
        d.node.y = snapY;
      } else if (d.type === "pan") {
        studio.panX = d.startPanX + (sx - d.startX);
        studio.panY = d.startPanY + (sy - d.startY);
      } else if (d.type === "edge") {
        d.mx = sx;
        d.my = sy;
      } else if (d.type === "rubberband") {
        d.mx = sx;
        d.my = sy;
      }
    } else {
      // Hover detection
      studio.hoveredPort = hitTestPort(wp.x, wp.y);
      studio.hoveredNode = hitTestNode(wp.x, wp.y);
      if (!studio.hoveredNode) {
        studio.hoveredEdge = hitTestEdge(wp.x, wp.y);
      } else {
        studio.hoveredEdge = null;
      }
      canvas.style.cursor = studio.hoveredPort ? "crosshair" : (studio.hoveredNode ? "grab" : (studio.hoveredEdge ? "pointer" : "default"));
    }
  }

  function onMouseUp(e) {
    if (!studio.dragging) return;
    const d = studio.dragging;

    if (d.type === "edge") {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const wp = screenToWorld(sx, sy);
      const portHit = hitTestPort(wp.x, wp.y);
      if (portHit && portHit.node.id !== d.srcNode.id && portHit.port.side === "left") {
        const edges = getEdges();
        const newEdge = createEdge(d.srcNode, portHit.node);
        edges.push(newEdge);
        syncModelFromCanvas();
      }
    } else if (d.type === "rubberband") {
      const wp1 = screenToWorld(d.startX, d.startY);
      const wp2 = screenToWorld(d.mx, d.my);
      const rx = Math.min(wp1.x, wp2.x), ry = Math.min(wp1.y, wp2.y);
      const rw = Math.abs(wp2.x - wp1.x), rh = Math.abs(wp2.y - wp1.y);
      getNodes().forEach(n => {
        if (n.x >= rx && n.x <= rx + rw && n.y >= ry && n.y <= ry + rh) {
          studio.selectedNodes.add(n.id);
        }
      });
    } else if (d.type === "node") {
      if (d.node.x !== d.startX || d.node.y !== d.startY) {
        syncModelFromCanvas();
      }
    }

    studio.dragging = null;
  }

  function onWheel(e) {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const oldZoom = studio.zoom;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    studio.zoom = clamp(studio.zoom * delta, MIN_ZOOM, MAX_ZOOM);
    // Zoom toward cursor
    studio.panX = sx - (sx - studio.panX) * (studio.zoom / oldZoom);
    studio.panY = sy - (sy - studio.panY) * (studio.zoom / oldZoom);
  }

  function onKeyDown(e) {
    if (e.key === "Delete" || e.key === "Backspace") {
      if (document.activeElement && document.activeElement.tagName === "INPUT") return;
      if (studio.selectedNodes.size > 0) {
        const nodes = getNodes();
        const edges = getEdges();
        studio.selectedNodes.forEach(nid => {
          const idx = nodes.findIndex(n => n.id === nid);
          if (idx >= 0) nodes.splice(idx, 1);
          // Remove connected edges
          for (let i = edges.length - 1; i >= 0; i--) {
            if (edges[i].srcNodeId === nid || edges[i].dstNodeId === nid) {
              edges.splice(i, 1);
            }
          }
        });
        studio.selectedNodes.clear();
        studio.inspectedItem = null;
        renderPropertyInspector();
        syncModelFromCanvas();
      } else if (studio.selectedEdge) {
        const edges = getEdges();
        const idx = edges.findIndex(e => e.id === studio.selectedEdge.id);
        if (idx >= 0) edges.splice(idx, 1);
        studio.selectedEdge = null;
        studio.inspectedItem = null;
        renderPropertyInspector();
        syncModelFromCanvas();
      }
    }
  }

  // ═══════════════════════ COMPONENT PALETTE ══════════════════
  function renderPalette() {
    const el = document.getElementById("studio-palette");
    if (!el) return;

    if (activeTab === "platform") {
      el.innerHTML = Object.entries(NODE_TYPES).map(([key, def]) => `
        <div class="palette-item" draggable="true" data-type="${key}" title="Drag to add ${def.label}">
          <span class="palette-icon">${def.icon}</span>
          <span class="palette-label">${def.label}</span>
        </div>
      `).join("");
    } else {
      el.innerHTML = `
        <div class="palette-item" draggable="true" data-type="task" title="Drag to add a task">
          <span class="palette-icon">⬡</span>
          <span class="palette-label">Task</span>
        </div>
        <div class="palette-item palette-action" id="studio-auto-layout" title="Auto-layout">
          <span class="palette-icon">🎯</span>
          <span class="palette-label">Auto Layout</span>
        </div>
      `;
    }

    // Wire drag & click events
    el.querySelectorAll(".palette-item[draggable]").forEach(item => {
      item.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", item.dataset.type);
        e.dataTransfer.effectAllowed = "copy";
      });
      item.addEventListener("click", () => {
        const type = item.dataset.type;
        if (!canvas) return;
        const center = screenToWorld(canvas.width / 2, canvas.height / 2);
        const snapX = Math.round(center.x / GRID_SIZE) * GRID_SIZE;
        const snapY = Math.round(center.y / GRID_SIZE) * GRID_SIZE;
        if (activeTab === "platform") {
          const node = createPlatformNode(type, snapX, snapY);
          studio.platformNodes.push(node);
        } else {
          const node = createWorkloadNode("Task_" + nextNodeId, snapX, snapY);
          studio.workloadNodes.push(node);
        }
        syncModelFromCanvas();
        if (window.paretoco && window.paretoco.toast) {
          window.paretoco.toast(`Added ${type} component to canvas`, "success");
        }
      });
    });

    const autoLayout = document.getElementById("studio-auto-layout");
    if (autoLayout) autoLayout.addEventListener("click", performAutoLayout);
  }

  function onCanvasDrop(e) {
    e.preventDefault();
    const type = e.dataTransfer.getData("text/plain");
    if (!type) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const wp = screenToWorld(sx, sy);
    const snapX = Math.round(wp.x / GRID_SIZE) * GRID_SIZE;
    const snapY = Math.round(wp.y / GRID_SIZE) * GRID_SIZE;

    if (activeTab === "platform") {
      const node = createPlatformNode(type, snapX, snapY);
      studio.platformNodes.push(node);
    } else {
      const node = createWorkloadNode("Task_" + nextNodeId, snapX, snapY);
      studio.workloadNodes.push(node);
    }
    syncModelFromCanvas();
  }

  function onCanvasDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  // ═══════════════════════ PROPERTY INSPECTOR ═════════════════
  function renderPropertyInspector() {
    const el = document.getElementById("studio-inspector");
    if (!el) return;

    if (!studio.inspectedItem) {
      el.innerHTML = `<div class="inspector-empty"><p>Select a node or edge to inspect its properties</p></div>`;
      return;
    }

    const { type, item } = studio.inspectedItem;

    if (type === "node") {
      const isPlatform = activeTab === "platform";
      const props = item.properties;
      let html = `<div class="inspector-header">
        <h3>${isPlatform ? (NODE_TYPES[item.type]?.icon || "🔧") : "⬡"} ${item.label}</h3>
        <span class="inspector-type">${isPlatform ? item.type : "Task"}</span>
      </div>
      <div class="inspector-fields">
        <div class="inspector-field">
          <label>Label</label>
          <input type="text" value="${item.label}" data-prop="label" class="inspector-input" />
        </div>`;

      if (isPlatform) {
        html += `
        <div class="inspector-field">
          <label>Model</label>
          <input type="text" value="${props.model}" data-prop="model" class="inspector-input" />
        </div>
        <div class="inspector-field">
          <label>Count</label>
          <input type="number" value="${props.count}" data-prop="count" class="inspector-input" min="1" />
        </div>
        <div class="inspector-field">
          <label>Mode</label>
          <input type="text" value="${props.mode}" data-prop="mode" class="inspector-input" />
        </div>
        <div class="inspector-field">
          <label>Frequency (MHz)</label>
          <input type="number" value="${props.frequency}" data-prop="frequency" class="inspector-input" />
        </div>
        <div class="inspector-field">
          <label>Memory (KB)</label>
          <input type="number" value="${props.memory}" data-prop="memory" class="inspector-input" />
        </div>
        <div class="inspector-field">
          <label>Dyn Power (mW)</label>
          <input type="number" value="${props.dynPower}" data-prop="dynPower" class="inspector-input" />
        </div>
        <div class="inspector-field">
          <label>Static Power (mW)</label>
          <input type="number" value="${props.staticPower}" data-prop="staticPower" class="inspector-input" />
        </div>
        <div class="inspector-field">
          <label>Area</label>
          <input type="number" value="${props.area}" data-prop="area" class="inspector-input" />
        </div>
        <div class="inspector-field">
          <label>Cost ($)</label>
          <input type="number" value="${props.cost}" data-prop="cost" class="inspector-input" />
        </div>
        <div class="inspector-field">
          <label>Bandwidth</label>
          <input type="number" value="${props.bandwidth}" data-prop="bandwidth" class="inspector-input" />
        </div>
        <div class="inspector-field">
          <label>Buffer Size</label>
          <input type="number" value="${props.bufferSize}" data-prop="bufferSize" class="inspector-input" />
        </div>
        <div class="inspector-field">
          <label>Routing</label>
          <select data-prop="routing" class="inspector-input">
            <option ${props.routing === "XY" ? "selected" : ""}>XY</option>
            <option ${props.routing === "YX" ? "selected" : ""}>YX</option>
            <option ${props.routing === "Adaptive" ? "selected" : ""}>Adaptive</option>
          </select>
        </div>`;
      } else {
        html += `
        <div class="inspector-field">
          <label>Actor Type</label>
          <input type="text" value="${props.actorType}" data-prop="actorType" class="inspector-input" />
        </div>
        <div class="inspector-field">
          <label>WCET</label>
          <input type="number" value="${props.wcet}" data-prop="wcet" class="inspector-input" />
        </div>
        <div class="inspector-field">
          <label>Period</label>
          <input type="number" value="${props.period}" data-prop="period" class="inspector-input" />
        </div>
        <div class="inspector-field">
          <label>Deadline</label>
          <input type="number" value="${props.deadline}" data-prop="deadline" class="inspector-input" />
        </div>
        <div class="inspector-field">
          <label>Priority</label>
          <input type="number" value="${props.priority}" data-prop="priority" class="inspector-input" />
        </div>
        <div class="inspector-field">
          <label>Memory Req (KB)</label>
          <input type="number" value="${props.memoryReq}" data-prop="memoryReq" class="inspector-input" />
        </div>`;
      }
      html += `</div>`;
      el.innerHTML = html;
    } else if (type === "edge") {
      const props = item.properties;
      el.innerHTML = `<div class="inspector-header">
        <h3>🔗 Connection</h3>
        <span class="inspector-type">Edge</span>
      </div>
      <div class="inspector-fields">
        <div class="inspector-field">
          <label>Bandwidth</label>
          <input type="number" value="${props.bandwidth}" data-prop="bandwidth" class="inspector-input" />
        </div>
        <div class="inspector-field">
          <label>Buffer Size</label>
          <input type="number" value="${props.bufferSize}" data-prop="bufferSize" class="inspector-input" />
        </div>
        <div class="inspector-field">
          <label>Latency</label>
          <input type="number" value="${props.latency}" data-prop="latency" class="inspector-input" />
        </div>
        <div class="inspector-field">
          <label>Initial Tokens</label>
          <input type="number" value="${props.initialTokens}" data-prop="initialTokens" class="inspector-input" />
        </div>
        <div class="inspector-field">
          <label>Token Size</label>
          <input type="number" value="${props.tokenSize}" data-prop="tokenSize" class="inspector-input" />
        </div>
      </div>`;
    }

    // Wire change events
    el.querySelectorAll(".inspector-input").forEach(input => {
      input.addEventListener("change", (e) => {
        const prop = e.target.dataset.prop;
        const val = e.target.type === "number" ? parseFloat(e.target.value) || 0 : e.target.value;
        if (prop === "label") {
          studio.inspectedItem.item.label = val;
        } else {
          studio.inspectedItem.item.properties[prop] = val;
        }
        syncModelFromCanvas();
      });
    });
  }

  // ═══════════════════════ MODEL SYNC ═════════════════════════
  function syncModelFromCanvas() {
    const state = window.paretoco?.state;
    if (!state) return;

    // Platform nodes → state.platform.processors
    const procMap = new Map();
    studio.platformNodes.forEach(node => {
      if (node.type === "NoC" || node.type === "Bus") return; // interconnects
      const model = node.properties.model || node.label;
      if (!procMap.has(model)) {
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
      }
      procMap.get(model).count += (node.properties.count || 1);
    });
    state.platform.processors = Array.from(procMap.values());

    // Interconnect nodes
    const ics = [];
    studio.platformNodes.forEach(node => {
      if (node.type === "NoC" || node.type === "Bus") {
        ics.push({
          type: node.type === "NoC" ? "TDN_NoC" : "TDN_BUS",
          name: node.label,
          topology: node.properties.routing || "mesh",
          xDim: 2, yDim: 2,
          routing: node.properties.routing || "XY",
          flitSize: node.properties.bufferSize || 32,
          cycles: 1
        });
      }
    });
    state.platform.interconnects = ics;

    // Workload nodes → state.applications
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
    }

    // Trigger UI updates
    if (window.paretoco) {
      window.paretoco.save();
    }
  }

  function syncCanvasFromModel() {
    const state = window.paretoco?.state;
    if (!state) return;

    // Build platform nodes from state.platform.processors
    if (state.platform.processors.length > 0 && studio.platformNodes.length === 0) {
      let col = 0;
      state.platform.processors.forEach((proc, pi) => {
        for (let i = 0; i < proc.count; i++) {
          const type = guessNodeType(proc.model);
          const node = createPlatformNode(type, 200 + col * 180, 200, {
            model: proc.model,
            count: 1,
            label: proc.model + "_" + i,
            mode: proc.modes[0]?.name || "default",
            memory: proc.modes[0]?.mem || 4096,
            dynPower: proc.modes[0]?.dynPower || 10,
            staticPower: proc.modes[0]?.staticPower || 2,
            area: proc.modes[0]?.area || 5,
            cost: proc.modes[0]?.monetary || 10,
          });
          studio.platformNodes.push(node);
          col++;
        }
      });

      // Interconnects
      state.platform.interconnects.forEach((ic, i) => {
        const type = ic.type?.includes("NoC") ? "NoC" : "Bus";
        const node = createPlatformNode(type, 200 + col * 160, 350, {
          label: ic.name || ("IC_" + i),
          model: ic.name || "interconnect",
          routing: ic.routing || ic.topology || "XY",
          bufferSize: ic.flitSize || 32,
        });
        studio.platformNodes.push(node);
        col++;
      });
    }

    // Build workload nodes from state.applications
    if (state.applications.length > 0 && studio.workloadNodes.length === 0) {
      state.applications.forEach(app => {
        app.actors.forEach((actor, i) => {
          const wcetEntry = state.wcets.find(w => w.taskType === (actor.type || actor.name));
          const node = createWorkloadNode(actor.name, 200 + i * 160, 200, {
            actorType: actor.type || actor.name,
            wcet: wcetEntry?.wcet || 10,
          });
          studio.workloadNodes.push(node);
        });
        // Build edges from channels
        app.channels.forEach(ch => {
          const srcNode = studio.workloadNodes.find(n => n.label === ch.srcActor);
          const dstNode = studio.workloadNodes.find(n => n.label === ch.dstActor);
          if (srcNode && dstNode) {
            const edge = createEdge(srcNode, dstNode, {
              initialTokens: ch.initialTokens || 0,
              tokenSize: ch.size || 1,
            });
            studio.workloadEdges.push(edge);
          }
        });
      });
    }
  }

  function guessNodeType(model) {
    const m = model.toLowerCase();
    if (m.includes("arm") || m.includes("cortex") || m.includes("cpu") || m.includes("core")) return "CPU";
    if (m.includes("dsp")) return "DSP";
    if (m.includes("gpu")) return "GPU";
    if (m.includes("npu") || m.includes("neural")) return "NPU";
    if (m.includes("acc")) return "Accelerator";
    if (m.includes("mem")) return "Memory";
    if (m.includes("noc")) return "NoC";
    if (m.includes("bus")) return "Bus";
    return "CPU";
  }

  // ═══════════════════════ RESULT OVERLAY ═════════════════════
  function applyResultOverlay() {
    const state = window.paretoco?.state;
    if (!state || !state.results || !state.results.rows || state.results.rows.length === 0) {
      studio.overlayVisible = false;
      return;
    }

    studio.overlayVisible = true;
    const lastSolution = state.results.rows[state.results.rows.length - 1];

    // Parse PE mapping
    const mappingStr = lastSolution["PE Mapping"] || "";
    const mappings = mappingStr.split(/[,\s]+/).map(s => parseInt(s.trim())).filter(n => !isNaN(n));

    // Reset overlays
    studio.platformNodes.forEach(n => {
      n.overlay = { utilization: 0, power: 0, mappedTasks: [], isCritical: false, memPressure: 0 };
    });
    studio.workloadNodes.forEach(n => {
      n.overlay = { mappedTo: null, startTime: 0, endTime: 0, isCritical: false };
    });
    studio.platformEdges.forEach(e => {
      e.overlay = { saturated: false, utilization: 0, dataRate: 0, isCritical: false };
    });
    studio.workloadEdges.forEach(e => {
      e.overlay = { saturated: false, utilization: 0, dataRate: 0, isCritical: false };
    });

    // Assign task→PE mappings
    const peNodes = studio.platformNodes.filter(n => n.type !== "NoC" && n.type !== "Bus" && n.type !== "Memory");
    mappings.forEach((peIdx, taskIdx) => {
      if (taskIdx < studio.workloadNodes.length) {
        studio.workloadNodes[taskIdx].overlay.mappedTo = peIdx;
      }
      if (peIdx < peNodes.length) {
        peNodes[peIdx].overlay.mappedTasks.push(taskIdx);
      }
    });

    // Calculate utilization per PE
    const totalUtil = parseInt(lastSolution["Utilization (%)"]) || 0;
    peNodes.forEach((pe, i) => {
      const taskCount = pe.overlay.mappedTasks.length;
      pe.overlay.utilization = taskCount > 0 ? Math.min(100, Math.round(totalUtil * taskCount / Math.max(1, mappings.length))) : 0;
      pe.overlay.power = Math.round((parseInt(lastSolution["Power (mW)"]) || 0) / Math.max(1, peNodes.length));
      pe.overlay.memPressure = taskCount > 0 ? Math.min(100, taskCount * 25) : 0;
    });

    // Mark critical path (highest WCET chain)
    if (studio.workloadNodes.length > 0) {
      let maxWcet = 0, criticalIdx = 0;
      studio.workloadNodes.forEach((wn, i) => {
        if ((wn.properties.wcet || 0) > maxWcet) {
          maxWcet = wn.properties.wcet || 0;
          criticalIdx = i;
        }
      });
      studio.workloadNodes[criticalIdx].overlay.isCritical = true;
      // Mark edges connected to critical node
      studio.workloadEdges.forEach(e => {
        if (e.srcNodeId === studio.workloadNodes[criticalIdx]?.id || e.dstNodeId === studio.workloadNodes[criticalIdx]?.id) {
          e.overlay.isCritical = true;
          e.overlay.dataRate = 1;
        }
      });
    }

    // Communication edges
    studio.workloadEdges.forEach(e => {
      const srcWn = studio.workloadNodes.find(n => n.id === e.srcNodeId);
      const dstWn = studio.workloadNodes.find(n => n.id === e.dstNodeId);
      if (srcWn && dstWn && srcWn.overlay.mappedTo !== null && dstWn.overlay.mappedTo !== null) {
        if (srcWn.overlay.mappedTo !== dstWn.overlay.mappedTo) {
          e.overlay.dataRate = 1;
          e.overlay.utilization = Math.round(30 + Math.random() * 50);
          if (e.overlay.utilization > 75) e.overlay.saturated = true;
        }
      }
    });

    // Platform edges utilization
    studio.platformEdges.forEach(e => {
      e.overlay.dataRate = 1;
      e.overlay.utilization = Math.round(20 + Math.random() * 60);
      if (e.overlay.utilization > 80) e.overlay.saturated = true;
    });
  }

  // ═══════════════════════ AUTO LAYOUT ════════════════════════
  function performAutoLayout() {
    const nodes = getNodes();
    if (nodes.length === 0) return;
    const cols = Math.ceil(Math.sqrt(nodes.length));
    nodes.forEach((n, i) => {
      n.x = 200 + (i % cols) * 180;
      n.y = 200 + Math.floor(i / cols) * 140;
    });
    // Center viewport
    const cx = nodes.reduce((a, n) => a + n.x, 0) / nodes.length;
    const cy = nodes.reduce((a, n) => a + n.y, 0) / nodes.length;
    studio.panX = studio.canvasW / 2 - cx * studio.zoom;
    studio.panY = studio.canvasH / 2 - cy * studio.zoom;
  }

  // ═══════════════════════ TAB SWITCHING ══════════════════════
  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll(".studio-tab").forEach(t => t.classList.remove("active"));
    const activeTabEl = document.querySelector(`.studio-tab[data-tab="${tab}"]`);
    if (activeTabEl) activeTabEl.classList.add("active");
    studio.selectedNodes.clear();
    studio.selectedEdge = null;
    studio.inspectedItem = null;
    renderPropertyInspector();
    renderPalette();
  }

  // ═══════════════════════ INITIALIZATION ═════════════════════
  function init() {
    canvas = document.getElementById("studio-canvas");
    if (!canvas) return;

    ctx = canvas.getContext("2d");

    // Event listeners
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("drop", onCanvasDrop);
    canvas.addEventListener("dragover", onCanvasDragOver);
    document.addEventListener("keydown", onKeyDown);

    // Tab buttons
    document.querySelectorAll(".studio-tab").forEach(tab => {
      tab.addEventListener("click", () => switchTab(tab.dataset.tab));
    });

    // Overlay toggle
    const overlayToggle = document.getElementById("studio-overlay-toggle");
    if (overlayToggle) {
      overlayToggle.addEventListener("click", () => {
        if (!studio.overlayVisible) applyResultOverlay();
        else studio.overlayVisible = false;
        overlayToggle.textContent = studio.overlayVisible ? "🔴 Hide Results" : "🟢 Show Results";
      });
    }

    // Sync from existing model
    syncCanvasFromModel();
    renderPalette();
    renderPropertyInspector();

    // Start render loop
    render();
  }

  function destroy() {
    if (studio.animFrame) cancelAnimationFrame(studio.animFrame);
    studio.animFrame = null;
  }

  // ═══════════════════════ PUBLIC API ══════════════════════════
  window.ArchStudio = {
    init,
    destroy,
    syncCanvasFromModel,
    applyResultOverlay,
    getStudio: () => studio,
    addPlatformNode: (type, x, y, props) => {
      const node = createPlatformNode(type, x || 300, y || 300, props);
      studio.platformNodes.push(node);
      syncModelFromCanvas();
      return node;
    },
    addWorkloadNode: (name, x, y, props) => {
      const node = createWorkloadNode(name, x || 300, y || 300, props);
      studio.workloadNodes.push(node);
      syncModelFromCanvas();
      return node;
    },
    clear: () => {
      studio.platformNodes = [];
      studio.platformEdges = [];
      studio.workloadNodes = [];
      studio.workloadEdges = [];
      studio.selectedNodes.clear();
      studio.selectedEdge = null;
      studio.inspectedItem = null;
      renderPropertyInspector();
    }
  };

})();
