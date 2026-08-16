/* ════════════════════════════════════════════════════════════════
   ParetoCo — Interactive Pareto Frontier + What-If Engine
   ════════════════════════════════════════════════════════════════
   Multidimensional Pareto visualization with draggable constraints,
   dominance explanation, and sensitivity analysis.
   
   Fully decoupled — reads from window.paretoco.state.results.
   ════════════════════════════════════════════════════════════════ */

(() => {
  "use strict";

  // ═══════════════════════ CONSTANTS ═══════════════════════════
  const DIMENSIONS = [
    { key: "period",      label: "Latency (Period)", unit: "", lowerBetter: true  },
    { key: "power",       label: "Power (mW)",       unit: "mW", lowerBetter: true  },
    { key: "area",        label: "Area",             unit: "", lowerBetter: true  },
    { key: "cost",        label: "Cost ($)",         unit: "$", lowerBetter: true  },
    { key: "utilization", label: "Utilization (%)",  unit: "%", lowerBetter: false },
    { key: "throughput",  label: "Throughput",       unit: "", lowerBetter: false },
    { key: "processors",  label: "Processors Used",  unit: "", lowerBetter: true  },
    { key: "memory",      label: "Memory",           unit: "KB", lowerBetter: true  },
  ];

  const SCATTER_COLORS = {
    nonDominated: "#00f0ff",
    dominated:    "#6b7280",
    selected:     "#f59e0b",
    filtered:     "rgba(107, 114, 128, 0.2)",
    hovered:      "#ffffff",
  };

  const CHART_PADDING = { top: 40, right: 40, bottom: 60, left: 70 };

  // ═══════════════════════ STATE ══════════════════════════════
  const frontier = {
    solutions: [],        // Parsed solution objects with all dimensions
    paretoFront: [],      // Indices of non-dominated solutions
    filteredOut: new Set(), // Indices filtered by constraints
    xDim: "period",
    yDim: "power",
    constraints: {},      // { dimKey: { min, max, active } }
    selectedSolution: null,
    hoveredSolution: null,
    compareTarget: null,
    // Chart state
    chartCanvas: null,
    chartCtx: null,
    chartW: 0,
    chartH: 0,
    // Parallel coordinates
    pcCanvas: null,
    pcCtx: null,
    pcBrushes: {},        // { dimKey: { min, max } }
    // Sensitivity
    sensitivityData: [],
  };

  // ═══════════════════════ SOLUTION PARSING ═══════════════════
  function parseSolutions() {
    const state = window.paretoco?.state;
    if (!state || !state.results || !state.results.rows) {
      frontier.solutions = [];
      return;
    }

    frontier.solutions = state.results.rows.map((row, idx) => {
      const mapping = (row["PE Mapping"] || "").split(/[,\s]+/).map(Number).filter(n => !isNaN(n));
      const uniquePEs = new Set(mapping);
      return {
        id: idx,
        label: "Design #" + (row["Solution #"] || (idx + 1)),
        period:      parseFloat(row["Period"]) || 0,
        power:       parseFloat(row["Power (mW)"]) || 0,
        area:        parseFloat(row["Area"]) || 0,
        cost:        parseFloat(row["Cost ($)"]) || 0,
        utilization: parseFloat(row["Utilization (%)"]) || 0,
        throughput:  row["Period"] ? (1000 / parseFloat(row["Period"])) : 0,
        processors:  uniquePEs.size || mapping.length,
        memory:      0, // not in default output, derived if available
        mapping:     mapping,
        raw:         row,
      };
    });

    // Initialize constraints
    DIMENSIONS.forEach(dim => {
      if (!frontier.constraints[dim.key]) {
        const values = frontier.solutions.map(s => s[dim.key]).filter(v => v > 0);
        if (values.length > 0) {
          frontier.constraints[dim.key] = {
            min: Math.min(...values) * 0.5,
            max: Math.max(...values) * 1.5,
            active: false,
            globalMin: Math.min(...values),
            globalMax: Math.max(...values),
          };
        }
      }
    });

    computeParetoFront();
    applyConstraintFilters();
    computeSensitivity();
  }

  // ═══════════════════════ PARETO DOMINANCE ═══════════════════
  function dominates(a, b) {
    let dominated = false;
    for (const dim of DIMENSIONS) {
      const av = a[dim.key], bv = b[dim.key];
      if (av === 0 && bv === 0) continue;
      if (dim.lowerBetter) {
        if (av > bv) return false;
        if (av < bv) dominated = true;
      } else {
        if (av < bv) return false;
        if (av > bv) dominated = true;
      }
    }
    return dominated;
  }

  function computeParetoFront() {
    const sols = frontier.solutions;
    const n = sols.length;
    frontier.paretoFront = [];
    for (let i = 0; i < n; i++) {
      let isDominated = false;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        if (dominates(sols[j], sols[i])) {
          isDominated = true;
          break;
        }
      }
      if (!isDominated) frontier.paretoFront.push(i);
    }
  }

  function applyConstraintFilters() {
    frontier.filteredOut.clear();
    frontier.solutions.forEach((sol, idx) => {
      for (const dim of DIMENSIONS) {
        const c = frontier.constraints[dim.key];
        if (!c || !c.active) continue;
        const v = sol[dim.key];
        if (dim.lowerBetter) {
          if (v > c.max) { frontier.filteredOut.add(idx); break; }
        } else {
          if (v < c.min) { frontier.filteredOut.add(idx); break; }
        }
      }
    });
  }

  // ═══════════════════════ DOMINANCE EXPLANATION ═══════════════
  function explainDominance(solIdx) {
    const sol = frontier.solutions[solIdx];
    if (!sol) return null;

    // Find who dominates this solution
    const dominators = [];
    frontier.solutions.forEach((other, oi) => {
      if (oi === solIdx) return;
      if (dominates(other, sol)) {
        const comparison = {};
        DIMENSIONS.forEach(dim => {
          const sv = sol[dim.key], ov = other[dim.key];
          if (sv === 0 && ov === 0) return;
          const diff = sv !== 0 ? ((ov - sv) / sv * 100) : 0;
          comparison[dim.key] = {
            yours: sv,
            theirs: ov,
            diffPct: diff,
            better: dim.lowerBetter ? ov < sv : ov > sv,
            same: Math.abs(diff) < 1,
          };
        });
        dominators.push({ idx: oi, solution: other, comparison });
      }
    });

    return {
      solution: sol,
      isDominated: dominators.length > 0,
      isOnFrontier: frontier.paretoFront.includes(solIdx),
      dominatedBy: dominators,
    };
  }

  // ═══════════════════════ SENSITIVITY ANALYSIS ═══════════════
  function computeSensitivity() {
    frontier.sensitivityData = [];
    if (frontier.solutions.length < 2) return;

    const targetDims = ["throughput", "power", "period"];
    const paramDims = ["processors", "memory", "area", "cost"];

    targetDims.forEach(target => {
      const dim = DIMENSIONS.find(d => d.key === target);
      if (!dim) return;

      paramDims.forEach(param => {
        const paramDim = DIMENSIONS.find(d => d.key === param);
        if (!paramDim) return;

        const pairs = [];
        frontier.solutions.forEach(s => {
          if (s[param] > 0 && s[target] > 0) {
            pairs.push({ param: s[param], target: s[target] });
          }
        });

        if (pairs.length < 2) return;

        // Sort by param
        pairs.sort((a, b) => a.param - b.param);

        // Compute marginal gains
        const marginals = [];
        for (let i = 1; i < pairs.length; i++) {
          const dp = pairs[i].param - pairs[i-1].param;
          const dt = pairs[i].target - pairs[i-1].target;
          if (dp !== 0) {
            marginals.push({
              paramValue: pairs[i].param,
              deltaParam: dp,
              deltaTarget: dt,
              marginalPct: pairs[i-1].target !== 0 ? (dt / pairs[i-1].target * 100) : 0,
            });
          }
        }

        // Find saturation point
        let saturationPoint = null;
        for (let i = marginals.length - 1; i >= 0; i--) {
          if (Math.abs(marginals[i].marginalPct) < 2) {
            saturationPoint = marginals[i].paramValue;
            break;
          }
        }

        if (marginals.length > 0) {
          frontier.sensitivityData.push({
            param: paramDim.label,
            paramKey: param,
            target: dim.label,
            targetKey: target,
            marginals,
            avgMarginal: marginals.reduce((a, m) => a + m.marginalPct, 0) / marginals.length,
            saturationPoint,
            summary: generateSensitivitySummary(paramDim, dim, marginals, saturationPoint),
          });
        }
      });
    });

    // Sort by absolute impact
    frontier.sensitivityData.sort((a, b) => Math.abs(b.avgMarginal) - Math.abs(a.avgMarginal));
  }

  function generateSensitivitySummary(paramDim, targetDim, marginals, saturation) {
    if (marginals.length === 0) return "";
    const best = marginals.reduce((a, m) => Math.abs(m.marginalPct) > Math.abs(a.marginalPct) ? m : a, marginals[0]);
    let summary = `+${best.deltaParam} ${paramDim.label} → ${targetDim.label} ${best.marginalPct > 0 ? "+" : ""}${best.marginalPct.toFixed(1)}%`;
    if (saturation !== null) {
      summary += ` | No benefit beyond ${saturation} ${paramDim.label}`;
    }
    return summary;
  }

  function ensureCanvasDimensions(canvas, ctx) {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const w = Math.floor(canvas.offsetWidth || rect.width || 800);
    const h = Math.floor(canvas.offsetHeight || rect.height || 420);

    const targetW = Math.floor(w * dpr);
    const targetH = Math.floor(h * dpr);

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    return { W: w, H: h };
  }

  // ═══════════════════════ SCATTER CHART RENDERING ════════════
  function renderScatterChart() {
    const canvas = frontier.chartCanvas;
    if (!canvas) return;
    const ctx = frontier.chartCtx;
    if (!ctx) return;

    const { W, H } = ensureCanvasDimensions(canvas, ctx);
    frontier.chartW = W;
    frontier.chartH = H;
    if (W <= 0 || H <= 0) return;

    const P = CHART_PADDING;
    const plotW = W - P.left - P.right;
    const plotH = H - P.top - P.bottom;

    // Background
    ctx.fillStyle = "#EBF4FA";
    ctx.fillRect(0, 0, W, H);

    if (frontier.solutions.length === 0) {
      ctx.fillStyle = "#6b7280";
      ctx.font = "14px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("No results to display. Run a DSE or load results first.", W / 2, H / 2);
      return;
    }

    // Compute ranges
    const xDim = DIMENSIONS.find(d => d.key === frontier.xDim) || DIMENSIONS[0];
    const yDim = DIMENSIONS.find(d => d.key === frontier.yDim) || DIMENSIONS[1];
    const xVals = frontier.solutions.map(s => s[frontier.xDim]).filter(v => v > 0);
    const yVals = frontier.solutions.map(s => s[frontier.yDim]).filter(v => v > 0);
    if (xVals.length === 0 || yVals.length === 0) return;

    const xMin = Math.min(...xVals) * 0.9;
    const xMax = Math.max(...xVals) * 1.1;
    const yMin = Math.min(...yVals) * 0.9;
    const yMax = Math.max(...yVals) * 1.1;

    function toScreenX(v) { return P.left + ((v - xMin) / (xMax - xMin)) * plotW; }
    function toScreenY(v) { return P.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH; }

    // Grid lines
    ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
    ctx.lineWidth = 0.5;
    const xTicks = 6, yTicks = 5;
    for (let i = 0; i <= xTicks; i++) {
      const v = xMin + (xMax - xMin) * i / xTicks;
      const sx = toScreenX(v);
      ctx.beginPath(); ctx.moveTo(sx, P.top); ctx.lineTo(sx, P.top + plotH); ctx.stroke();
      ctx.fillStyle = "#6b7280";
      ctx.font = "10px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(v.toFixed(v >= 100 ? 0 : 1), sx, P.top + plotH + 16);
    }
    for (let i = 0; i <= yTicks; i++) {
      const v = yMin + (yMax - yMin) * i / yTicks;
      const sy = toScreenY(v);
      ctx.beginPath(); ctx.moveTo(P.left, sy); ctx.lineTo(P.left + plotW, sy); ctx.stroke();
      ctx.fillStyle = "#6b7280";
      ctx.font = "10px Inter, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(v.toFixed(v >= 100 ? 0 : 1), P.left - 8, sy);
    }

    // Axis labels
    ctx.fillStyle = "#a0a5b8";
    ctx.font = "bold 12px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(xDim.label, P.left + plotW / 2, H - 10);
    ctx.save();
    ctx.translate(16, P.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(yDim.label, 0, 0);
    ctx.restore();

    // Draw Pareto front line
    if (frontier.paretoFront.length > 1) {
      const pfSols = frontier.paretoFront
        .filter(i => !frontier.filteredOut.has(i))
        .map(i => frontier.solutions[i])
        .sort((a, b) => a[frontier.xDim] - b[frontier.xDim]);

      if (pfSols.length > 1) {
        ctx.strokeStyle = "rgba(0, 240, 255, 0.3)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(toScreenX(pfSols[0][frontier.xDim]), toScreenY(pfSols[0][frontier.yDim]));
        for (let i = 1; i < pfSols.length; i++) {
          // Step-wise line for Pareto front
          ctx.lineTo(toScreenX(pfSols[i][frontier.xDim]), toScreenY(pfSols[i-1][frontier.yDim]));
          ctx.lineTo(toScreenX(pfSols[i][frontier.xDim]), toScreenY(pfSols[i][frontier.yDim]));
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Draw constraint lines
    Object.entries(frontier.constraints).forEach(([key, c]) => {
      if (!c.active) return;
      const dim = DIMENSIONS.find(d => d.key === key);
      if (!dim) return;
      if (key === frontier.xDim) {
        const sx = toScreenX(dim.lowerBetter ? c.max : c.min);
        if (sx > P.left && sx < P.left + plotW) {
          ctx.strokeStyle = "rgba(239, 68, 68, 0.6)";
          ctx.lineWidth = 2;
          ctx.setLineDash([4, 4]);
          ctx.beginPath(); ctx.moveTo(sx, P.top); ctx.lineTo(sx, P.top + plotH); ctx.stroke();
          ctx.setLineDash([]);
          // Shade filtered region
          ctx.fillStyle = "rgba(239, 68, 68, 0.05)";
          if (dim.lowerBetter) {
            ctx.fillRect(sx, P.top, P.left + plotW - sx, plotH);
          } else {
            ctx.fillRect(P.left, P.top, sx - P.left, plotH);
          }
        }
      }
      if (key === frontier.yDim) {
        const sy = toScreenY(dim.lowerBetter ? c.max : c.min);
        if (sy > P.top && sy < P.top + plotH) {
          ctx.strokeStyle = "rgba(239, 68, 68, 0.6)";
          ctx.lineWidth = 2;
          ctx.setLineDash([4, 4]);
          ctx.beginPath(); ctx.moveTo(P.left, sy); ctx.lineTo(P.left + plotW, sy); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = "rgba(239, 68, 68, 0.05)";
          if (dim.lowerBetter) {
            ctx.fillRect(P.left, P.top, plotW, sy - P.top);
          } else {
            ctx.fillRect(P.left, sy, plotW, P.top + plotH - sy);
          }
        }
      }
    });

    // Draw solution points
    frontier.solutions.forEach((sol, idx) => {
      const x = toScreenX(sol[frontier.xDim]);
      const y = toScreenY(sol[frontier.yDim]);
      if (x < P.left || x > P.left + plotW || y < P.top || y > P.top + plotH) return;

      const isFiltered = frontier.filteredOut.has(idx);
      const isOnFrontier = frontier.paretoFront.includes(idx);
      const isSelected = frontier.selectedSolution === idx;
      const isHovered = frontier.hoveredSolution === idx;
      const isCompare = frontier.compareTarget === idx;

      let color, radius, filled;
      if (isFiltered) {
        color = SCATTER_COLORS.filtered;
        radius = 4;
        filled = false;
      } else if (isSelected) {
        color = SCATTER_COLORS.selected;
        radius = 8;
        filled = true;
      } else if (isCompare) {
        color = "#ef4444";
        radius = 7;
        filled = true;
      } else if (isHovered) {
        color = SCATTER_COLORS.hovered;
        radius = 7;
        filled = true;
      } else if (isOnFrontier) {
        color = SCATTER_COLORS.nonDominated;
        radius = 6;
        filled = true;
      } else {
        color = SCATTER_COLORS.dominated;
        radius = 4;
        filled = false;
      }

      // Glow for frontier points
      if (isOnFrontier && !isFiltered) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
      }

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      if (filled) {
        ctx.fillStyle = color;
        ctx.fill();
      } else {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;

      // Label for selected/hovered
      if (isSelected || isHovered || isCompare) {
        ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
        const labelText = sol.label;
        ctx.font = "bold 10px Inter, sans-serif";
        const tw = ctx.measureText(labelText).width + 12;
        roundRect(ctx, x - tw/2, y - radius - 22, tw, 18, 4);
        ctx.fill();
        ctx.fillStyle = color;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(labelText, x, y - radius - 13);
      }
    });

    // Legend
    drawLegend(ctx, W, P);

    // Stats
    const visible = frontier.solutions.length - frontier.filteredOut.size;
    const pfVisible = frontier.paretoFront.filter(i => !frontier.filteredOut.has(i)).length;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    roundRect(ctx, W - 200, 8, 192, 28, 6);
    ctx.fill();
    ctx.fillStyle = "#a0a5b8";
    ctx.font = "11px Inter, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`${visible}/${frontier.solutions.length} visible · ${pfVisible} on frontier`, W - 16, 26);
  }

  function drawLegend(ctx, W, P) {
    const items = [
      { color: SCATTER_COLORS.nonDominated, label: "Pareto-optimal", filled: true },
      { color: SCATTER_COLORS.dominated, label: "Dominated", filled: false },
      { color: SCATTER_COLORS.filtered, label: "Filtered out", filled: false },
    ];
    const lx = P.left + 8, ly = P.top + 8;
    ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
    roundRect(ctx, lx, ly, 140, items.length * 20 + 8, 6);
    ctx.fill();
    items.forEach((item, i) => {
      const cy = ly + 14 + i * 20;
      ctx.beginPath();
      ctx.arc(lx + 14, cy, 4, 0, Math.PI * 2);
      if (item.filled) { ctx.fillStyle = item.color; ctx.fill(); }
      else { ctx.strokeStyle = item.color; ctx.lineWidth = 1.5; ctx.stroke(); }
      ctx.fillStyle = "#d1d5db";
      ctx.font = "10px Inter, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(item.label, lx + 26, cy);
    });
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

  // ═══════════════════════ CHART INTERACTION ══════════════════
  function getCanvasCoords(e) {
    if (!frontier.chartCanvas) return { mx: 0, my: 0 };
    const rect = frontier.chartCanvas.getBoundingClientRect();
    const scaleX = (frontier.chartW || frontier.chartCanvas.offsetWidth) / Math.max(1, rect.width);
    const scaleY = (frontier.chartH || frontier.chartCanvas.offsetHeight) / Math.max(1, rect.height);
    return {
      mx: (e.clientX - rect.left) * scaleX,
      my: (e.clientY - rect.top) * scaleY
    };
  }

  function findClosestSolution(mx, my, maxDist = 35) {
    const xVals = frontier.solutions.map(s => s[frontier.xDim]).filter(v => v > 0);
    const yVals = frontier.solutions.map(s => s[frontier.yDim]).filter(v => v > 0);
    if (xVals.length === 0 || yVals.length === 0) return null;

    const P = CHART_PADDING;
    const plotW = frontier.chartW - P.left - P.right;
    const plotH = frontier.chartH - P.top - P.bottom;
    const xMin = Math.min(...xVals) * 0.9, xMax = Math.max(...xVals) * 1.1;
    const yMin = Math.min(...yVals) * 0.9, yMax = Math.max(...yVals) * 1.1;

    const toScreenX = (v) => P.left + ((v - xMin) / (xMax - xMin)) * plotW;
    const toScreenY = (v) => P.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

    let closestIdx = null, closestDist = maxDist;
    frontier.solutions.forEach((sol, idx) => {
      const sx = toScreenX(sol[frontier.xDim]);
      const sy = toScreenY(sol[frontier.yDim]);
      const d = Math.hypot(mx - sx, my - sy);
      if (d < closestDist) {
        closestDist = d;
        closestIdx = idx;
      }
    });

    return closestIdx;
  }

  function onChartMouseMove(e) {
    const { mx, my } = getCanvasCoords(e);
    const closestIdx = findClosestSolution(mx, my, 35);

    if (frontier.chartCanvas) {
      frontier.chartCanvas.style.cursor = closestIdx !== null ? "pointer" : "crosshair";
    }

    if (frontier.hoveredSolution !== closestIdx) {
      frontier.hoveredSolution = closestIdx;
      renderScatterChart();
      if (closestIdx !== null) showTooltip(closestIdx, e.clientX, e.clientY);
      else hideTooltip();
    }
  }

  function onChartClick(e) {
    const { mx, my } = getCanvasCoords(e);
    let targetIdx = findClosestSolution(mx, my, 45);
    if (targetIdx === null) targetIdx = frontier.hoveredSolution;

    if (targetIdx !== null) {
      if (e.shiftKey && frontier.selectedSolution !== null) {
        // Compare mode
        frontier.compareTarget = targetIdx;
        renderDominanceExplanation();
      } else {
        frontier.selectedSolution = targetIdx;
        frontier.compareTarget = null;
      }
      renderScatterChart();
      renderSolutionDetail();
    }
  }

  // ═══════════════════════ TOOLTIP ════════════════════════════
  function showTooltip(idx, clientX, clientY) {
    let tooltip = document.getElementById("pareto-tooltip");
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.id = "pareto-tooltip";
      tooltip.className = "pareto-tooltip";
      document.body.appendChild(tooltip);
    }
    const sol = frontier.solutions[idx];
    if (!sol) return;
    const isOnFrontier = frontier.paretoFront.includes(idx);
    tooltip.innerHTML = `
      <div class="tooltip-title"><span>${sol.label}</span> ${isOnFrontier ? '<span class="tooltip-badge">★ Pareto</span>' : ''}</div>
      <div class="tooltip-grid">
        ${DIMENSIONS.filter(d => sol[d.key] > 0).map(d =>
          `<div class="tooltip-dim"><span class="tooltip-dim-label">${d.label}</span><span class="tooltip-dim-value">${sol[d.key].toFixed(d.key === "throughput" ? 4 : 1)} ${d.unit}</span></div>`
        ).join("")}
      </div>
      <div class="tooltip-hint">${isOnFrontier ? "Click to inspect · Shift+Click to compare" : "Click to see why dominated"}</div>
    `;

    const tooltipWidth = 240;
    const tooltipHeight = 160;
    let posX = clientX + 16;
    let posY = clientY - 10;

    if (posX + tooltipWidth > window.innerWidth - 10) {
      posX = clientX - tooltipWidth - 16;
    }
    if (posY + tooltipHeight > window.innerHeight - 10) {
      posY = window.innerHeight - tooltipHeight - 10;
    }

    tooltip.style.position = "fixed";
    tooltip.style.pointerEvents = "none";
    tooltip.style.zIndex = "99999";
    tooltip.style.display = "block";
    tooltip.style.left = Math.max(10, posX) + "px";
    tooltip.style.top = Math.max(10, posY) + "px";
  }

  function hideTooltip() {
    const tooltip = document.getElementById("pareto-tooltip");
    if (tooltip) tooltip.style.display = "none";
  }

  // ═══════════════════════ CONSTRAINT SLIDERS ═════════════════
  function renderConstraintSliders() {
    const el = document.getElementById("pareto-constraints");
    if (!el) return;

    let html = `<div class="constraint-header">
      <h3>🎚️ Constraint Sliders</h3>
      <span class="constraint-count">${frontier.filteredOut.size} designs filtered</span>
    </div>`;

    DIMENSIONS.forEach(dim => {
      const c = frontier.constraints[dim.key];
      if (!c) return;
      const values = frontier.solutions.map(s => s[dim.key]).filter(v => v > 0);
      if (values.length === 0) return;

      const absMin = Math.min(...values);
      const absMax = Math.max(...values);
      const sliderVal = dim.lowerBetter ? c.max : c.min;
      const pct = absMax > absMin ? ((sliderVal - absMin) / (absMax - absMin)) * 100 : 50;

      html += `
        <div class="constraint-slider-group ${c.active ? "active" : ""}">
          <div class="constraint-slider-header">
            <label>${dim.label}</label>
            <div class="constraint-toggle">
              <input type="checkbox" id="cst-toggle-${dim.key}" ${c.active ? "checked" : ""} data-dim="${dim.key}" class="constraint-checkbox" />
              <span class="constraint-value" id="cst-val-${dim.key}">${dim.lowerBetter ? "≤" : "≥"} ${sliderVal.toFixed(1)} ${dim.unit}</span>
            </div>
          </div>
          <div class="constraint-slider-track">
            <input type="range" id="cst-range-${dim.key}" class="constraint-range"
              min="${absMin * 0.5}" max="${absMax * 1.5}" step="${(absMax - absMin) / 100 || 0.1}"
              value="${sliderVal}" data-dim="${dim.key}" />
            <div class="constraint-bar" style="width: ${pct}%; background: ${c.active ? (pct > 70 ? '#10b981' : '#f59e0b') : 'rgba(255,255,255,0.1)'}"></div>
          </div>
        </div>
      `;
    });

    el.innerHTML = html;

    // Wire events
    el.querySelectorAll(".constraint-range").forEach(range => {
      range.addEventListener("input", (e) => {
        const dim = DIMENSIONS.find(d => d.key === e.target.dataset.dim);
        const c = frontier.constraints[dim.key];
        const val = parseFloat(e.target.value);
        if (dim.lowerBetter) c.max = val;
        else c.min = val;
        const valLabel = document.getElementById(`cst-val-${dim.key}`);
        if (valLabel) valLabel.textContent = `${dim.lowerBetter ? "≤" : "≥"} ${val.toFixed(1)} ${dim.unit}`;
        if (c.active) {
          applyConstraintFilters();
          renderScatterChart();
          renderConstraintSliders();
          renderParallelCoordinates();
        }
      });
    });

    el.querySelectorAll(".constraint-checkbox").forEach(cb => {
      cb.addEventListener("change", (e) => {
        const c = frontier.constraints[e.target.dataset.dim];
        c.active = e.target.checked;
        applyConstraintFilters();
        renderScatterChart();
        renderConstraintSliders();
        renderParallelCoordinates();
      });
    });
  }

  // ═══════════════════════ DIMENSION SELECTOR ═════════════════
  function renderDimensionSelectors() {
    const el = document.getElementById("pareto-dims");
    if (!el) return;

    el.innerHTML = `
      <div class="dim-selector">
        <label>X Axis</label>
        <select id="pareto-x-dim" class="text-input">
          ${DIMENSIONS.map(d => `<option value="${d.key}" ${d.key === frontier.xDim ? "selected" : ""}>${d.label}</option>`).join("")}
        </select>
      </div>
      <div class="dim-selector">
        <label>Y Axis</label>
        <select id="pareto-y-dim" class="text-input">
          ${DIMENSIONS.map(d => `<option value="${d.key}" ${d.key === frontier.yDim ? "selected" : ""}>${d.label}</option>`).join("")}
        </select>
      </div>
    `;

    document.getElementById("pareto-x-dim")?.addEventListener("change", (e) => {
      frontier.xDim = e.target.value;
      renderScatterChart();
    });
    document.getElementById("pareto-y-dim")?.addEventListener("change", (e) => {
      frontier.yDim = e.target.value;
      renderScatterChart();
    });
  }

  // ═══════════════════════ SOLUTION DETAIL ════════════════════
  function renderSolutionDetail() {
    const el = document.getElementById("pareto-detail");
    if (!el) return;

    if (frontier.selectedSolution === null) {
      el.innerHTML = `<div class="inspector-empty"><p>Click a solution point to inspect it</p></div>`;
      return;
    }

    const sol = frontier.solutions[frontier.selectedSolution];
    const isOnFrontier = frontier.paretoFront.includes(frontier.selectedSolution);

    let html = `<div class="solution-detail-header">
      <h3>${sol.label}</h3>
      <span class="badge ${isOnFrontier ? "green" : "coral"}">${isOnFrontier ? "★ Pareto-Optimal" : "Dominated"}</span>
    </div>
    <div class="solution-detail-dims">
      ${DIMENSIONS.filter(d => sol[d.key] > 0).map(d =>
        `<div class="detail-dim">
          <span class="detail-dim-label">${d.label}</span>
          <span class="detail-dim-value">${sol[d.key].toFixed(d.key === "throughput" ? 4 : 1)} ${d.unit}</span>
        </div>`
      ).join("")}
    </div>`;

    if (!isOnFrontier) {
      html += `<button class="btn btn-sm btn-outline" id="btn-explain-dominance" style="margin-top: 12px;">🔍 Why is this dominated?</button>`;
    } else {
      html += `<p class="detail-hint" style="margin-top:12px;color:var(--text-muted);font-size:0.8rem;">Shift+Click another solution to compare</p>`;
    }

    html += `<div id="dominance-explanation"></div>`;

    el.innerHTML = html;

    document.getElementById("btn-explain-dominance")?.addEventListener("click", () => {
      renderDominanceExplanation();
    });
  }

  function renderDominanceExplanation() {
    const el = document.getElementById("dominance-explanation");
    if (!el) return;

    const targetIdx = frontier.compareTarget !== null ? frontier.compareTarget : frontier.selectedSolution;
    if (targetIdx === null) return;

    const explanation = explainDominance(targetIdx);
    if (!explanation) return;

    if (!explanation.isDominated) {
      el.innerHTML = `<div class="dominance-result success"><p>✅ This design is <strong>Pareto-optimal</strong> — no other design is better in all dimensions.</p></div>`;
      return;
    }

    let html = `<div class="dominance-result">
      <p>This design is dominated by <strong>${explanation.dominatedBy.length}</strong> solution(s):</p>`;

    explanation.dominatedBy.slice(0, 3).forEach(dom => {
      html += `<div class="dominance-card">
        <div class="dominance-card-header">${dom.solution.label}</div>
        <div class="dominance-card-body">
          ${Object.entries(dom.comparison).filter(([_, v]) => !v.same).map(([key, v]) => {
            const dim = DIMENSIONS.find(d => d.key === key);
            const icon = v.better ? "✅" : "⚠️";
            const color = v.better ? "#10b981" : "#f59e0b";
            return `<div class="dominance-dim" style="color:${color}">${icon} ${dim?.label || key}: ${v.diffPct > 0 ? "+" : ""}${v.diffPct.toFixed(1)}%</div>`;
          }).join("")}
        </div>
      </div>`;
    });

    html += `</div>`;
    el.innerHTML = html;
  }

  // ═══════════════════════ SENSITIVITY PANEL ══════════════════
  function renderSensitivityPanel() {
    const el = document.getElementById("pareto-sensitivity");
    if (!el) return;

    if (frontier.sensitivityData.length === 0) {
      el.innerHTML = `<div class="inspector-empty"><p>Not enough solution data for sensitivity analysis</p></div>`;
      return;
    }

    let html = `<div class="sensitivity-header"><h3>📊 Sensitivity Analysis</h3></div>`;

    frontier.sensitivityData.slice(0, 8).forEach(sd => {
      const barPct = Math.min(100, Math.abs(sd.avgMarginal) * 3);
      const barColor = sd.avgMarginal > 0 ? "#10b981" : "#ef4444";
      html += `
        <div class="sensitivity-item">
          <div class="sensitivity-summary">${sd.summary}</div>
          <div class="sensitivity-bar-track">
            <div class="sensitivity-bar" style="width: ${barPct}%; background: ${barColor}"></div>
          </div>
          <div class="sensitivity-meta">${sd.param} → ${sd.target} | Avg impact: ${sd.avgMarginal.toFixed(1)}%</div>
        </div>
      `;
    });

    el.innerHTML = html;
  }

  // ═══════════════════════ PARALLEL COORDINATES ═══════════════
  function renderParallelCoordinates() {
    const canvas = frontier.pcCanvas;
    if (!canvas) return;
    const ctx = frontier.pcCtx;
    if (!ctx) return;

    const { W, H } = ensureCanvasDimensions(canvas, ctx);
    if (W <= 0 || H <= 0) return;

    ctx.fillStyle = "#EBF4FA";
    ctx.fillRect(0, 0, W, H);

    if (frontier.solutions.length === 0) {
      ctx.fillStyle = "#6b7280";
      ctx.font = "12px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No data for parallel coordinates", W / 2, H / 2);
      return;
    }

    const activeDims = DIMENSIONS.filter(d => frontier.solutions.some(s => s[d.key] > 0));
    if (activeDims.length < 2) return;

    const padL = 50, padR = 30, padT = 40, padB = 30;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const axisSpacing = plotW / (activeDims.length - 1);

    // Compute ranges
    const ranges = {};
    activeDims.forEach(dim => {
      const vals = frontier.solutions.map(s => s[dim.key]);
      ranges[dim.key] = { min: Math.min(...vals), max: Math.max(...vals) };
    });

    // Draw axes
    activeDims.forEach((dim, i) => {
      const x = padL + i * axisSpacing;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.15)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      // Label
      ctx.fillStyle = "#334155";
      ctx.font = "bold 9px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(dim.label, x, padT - 8);
      // Min/Max
      ctx.fillStyle = "#6b7280";
      ctx.font = "9px Inter, sans-serif";
      ctx.fillText(ranges[dim.key].max.toFixed(0), x, padT - 18);
      ctx.fillText(ranges[dim.key].min.toFixed(0), x, padT + plotH + 16);
    });

    // Draw solution lines
    frontier.solutions.forEach((sol, idx) => {
      const isFiltered = frontier.filteredOut.has(idx);
      const isOnFrontier = frontier.paretoFront.includes(idx);
      const isSelected = frontier.selectedSolution === idx;

      if (isFiltered) {
        ctx.strokeStyle = "rgba(107, 114, 128, 0.08)";
        ctx.lineWidth = 0.5;
      } else if (isSelected) {
        ctx.strokeStyle = "#f59e0b";
        ctx.lineWidth = 3;
      } else if (isOnFrontier) {
        ctx.strokeStyle = "rgba(0, 150, 200, 0.6)";
        ctx.lineWidth = 1.5;
      } else {
        ctx.strokeStyle = "rgba(107, 114, 128, 0.25)";
        ctx.lineWidth = 0.8;
      }

      ctx.beginPath();
      activeDims.forEach((dim, i) => {
        const x = padL + i * axisSpacing;
        const r = ranges[dim.key];
        const norm = r.max > r.min ? (sol[dim.key] - r.min) / (r.max - r.min) : 0.5;
        const y = dim.lowerBetter ? (padT + norm * plotH) : (padT + (1 - norm) * plotH);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });

    // Highlight selected on top
    if (frontier.selectedSolution !== null && !frontier.filteredOut.has(frontier.selectedSolution)) {
      const sol = frontier.solutions[frontier.selectedSolution];
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 3;
      ctx.beginPath();
      activeDims.forEach((dim, i) => {
        const x = padL + i * axisSpacing;
        const r = ranges[dim.key];
        const norm = r.max > r.min ? (sol[dim.key] - r.min) / (r.max - r.min) : 0.5;
        const y = padT + plotH - norm * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        // Point marker
        ctx.fillStyle = "#f59e0b";
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.stroke();
    }
  }

  // ═══════════════════════ INITIALIZATION ═════════════════════
  let listenersBound = false;

  function init() {
    frontier.chartCanvas = document.getElementById("pareto-scatter-canvas");
    if (frontier.chartCanvas) {
      frontier.chartCtx = frontier.chartCanvas.getContext("2d");
      if (!listenersBound) {
        frontier.chartCanvas.addEventListener("mousemove", onChartMouseMove);
        frontier.chartCanvas.addEventListener("click", onChartClick);
        frontier.chartCanvas.addEventListener("mouseleave", () => {
          hideTooltip();
          frontier.hoveredSolution = null;
          renderScatterChart();
        });
        listenersBound = true;
      }
    }

    frontier.pcCanvas = document.getElementById("pareto-pc-canvas");
    if (frontier.pcCanvas) {
      frontier.pcCtx = frontier.pcCanvas.getContext("2d");
    }

    parseSolutions();

    // Auto-select first/Knee solution if available
    if (frontier.selectedSolution === null && frontier.solutions.length > 0) {
      frontier.selectedSolution = frontier.paretoFront.length > 0 ? frontier.paretoFront[0] : 0;
    }

    renderDimensionSelectors();
    renderConstraintSliders();
    renderScatterChart();
    renderParallelCoordinates();
    renderSensitivityPanel();
    renderSolutionDetail();
  }

  function refresh() {
    parseSolutions();
    renderConstraintSliders();
    renderScatterChart();
    renderParallelCoordinates();
    renderSensitivityPanel();
    renderSolutionDetail();
  }

  // ═══════════════════════ PUBLIC API ══════════════════════════
  window.ParetoFrontier = {
    init,
    refresh,
    getFrontier: () => frontier,
    setDimensions: (x, y) => {
      frontier.xDim = x;
      frontier.yDim = y;
      renderDimensionSelectors();
      renderScatterChart();
    },
  };

})();
