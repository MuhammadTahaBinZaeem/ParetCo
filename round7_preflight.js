'use strict';

/**
 * Seventh reliability pass: harden dynamic rendering and make the default
 * Results visualization show an engineering metric rather than Solution #.
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
    console.log(`[round7-preflight] patched ${relativePath}`);
  }
}

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  if (!source.includes(oldText)) {
    console.warn(`[round7-preflight] ${label}: target not found`);
    return source;
  }
  console.log(`[round7-preflight] ${label}: applied`);
  return source.replace(oldText, newText);
}

patchFile('ui/app.js', source => {
  source = replaceOnce(
    source,
    '  const $ = (sel) => document.querySelector(sel);\n  const $$ = (sel) => document.querySelectorAll(sel);',
    `  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);
  const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");`,
    'add HTML escaping helper for imported/AI/user model values'
  );

  const literalReplacements = [
    ['value="${p.model}" onchange="paretoco.updateProcessorModel', 'value="${escapeHtml(p.model)}" onchange="paretoco.updateProcessorModel', 'escape processor model in editable table'],
    ['value="${m.name}" onchange="paretoco.updateModeName', 'value="${escapeHtml(m.name)}" onchange="paretoco.updateModeName', 'escape mode name in editable table'],
    ['value="${ic.name}" onchange="paretoco.updateInterconnectName', 'value="${escapeHtml(ic.name)}" onchange="paretoco.updateInterconnectName', 'escape interconnect name in editable UI'],
    ['<strong>${p.model}</strong> × ${p.count}', '<strong>${escapeHtml(p.model)}</strong> × ${p.count}', 'escape processor name in summary'],
    ['<strong>${ic.name}</strong><br><span class="chip-sub">${ic.topology}', '<strong>${escapeHtml(ic.name)}</strong><br><span class="chip-sub">${escapeHtml(ic.topology)}', 'escape interconnect summary'],
    ['<h3>${app.name}</h3>', '<h3>${escapeHtml(app.name)}</h3>', 'escape application heading'],
    ['${a.name}</span>`).join("")}', '${escapeHtml(a.name)}</span>`).join("")}', 'escape actor chips'],
    ['value="${w.taskType}" oninput="paretoco.updateWcetTask', 'value="${escapeHtml(w.taskType)}" oninput="paretoco.updateWcetTask', 'escape WCET task name'],
    ['value="${w.processor || w.procModel || \'\'}" oninput="paretoco.updateWcetProc', 'value="${escapeHtml(w.processor || w.procModel || \'\')}" oninput="paretoco.updateWcetProc', 'escape WCET processor name'],
    ['value="${w.mode}" oninput="paretoco.updateWcetMode', 'value="${escapeHtml(w.mode)}" oninput="paretoco.updateWcetMode', 'escape WCET mode name'],
    ['value="${c.appName}" oninput="paretoco.updateConstraintApp', 'value="${escapeHtml(c.appName)}" oninput="paretoco.updateConstraintApp', 'escape constraint application name'],
    ['<span class="stat-value">${state.results.summary.solutions}</span>', '<span class="stat-value">${escapeHtml(state.results.summary.solutions)}</span>', 'escape results summary count'],
    ['<span class="stat-value">${state.results.summary.time}</span>', '<span class="stat-value">${escapeHtml(state.results.summary.time)}</span>', 'escape results search time'],
    ['state.results.headers.map(h => `<th>${h}</th>`)', 'state.results.headers.map(h => `<th>${escapeHtml(h)}</th>`)', 'escape imported result headers'],
    ['state.results.headers.map(h => `<td>${row[h] || ""}</td>`)', 'state.results.headers.map(h => `<td>${escapeHtml(row[h] || "")}</td>`)', 'escape imported result cells'],
    ['sel.innerHTML += `<option value="${i}">${a.name}</option>`;', 'sel.innerHTML += `<option value="${i}">${escapeHtml(a.name)}</option>`;', 'escape application selector labels']
  ];
  for (const [oldText, newText, label] of literalReplacements) source = replaceOnce(source, oldText, newText, label);

  const oldChart = `  function drawResultsChart() {
    const canvas = $("#results-chart");
    const ctx = canvas.getContext("2d");
    const canvasWidth = canvas.offsetWidth || 800;
    canvas.width = canvasWidth * 2;
    canvas.height = 600;
    ctx.scale(2, 2);
    const w = canvasWidth;
    const h = 300;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);

    if (!state.results || !state.results.rows.length) return;

    // Find numeric columns
    const numCols = state.results.headers.filter(hdr => {
      return state.results.rows.some(r => !isNaN(parseFloat(r[hdr])) && r[hdr] !== "");
    });
    if (numCols.length === 0) {
      ctx.fillStyle = "#9095a4";
      ctx.font = "13px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No numeric data to chart", w / 2, h / 2);
      return;
    }

    const col = numCols[0];
    const values = state.results.rows.map(r => parseFloat(r[col]) || 0);
    const max = Math.max(...values, 1);
    const barW = Math.max(6, (w - 80) / values.length - 4);
    const chartH = h - 60;

    ctx.fillStyle = "#5a5d6b";
    ctx.font = "500 12px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(col, w / 2, h - 8);

    values.forEach((v, i) => {
      const bh = (v / max) * chartH;
      const x = 40 + i * ((w - 80) / values.length);
      ctx.fillStyle = "#c9513e";
      ctx.fillRect(x, 25 + chartH - bh, barW, bh);
    });
  }`;

  const newChart = `  function drawResultsChart() {
    const canvas = $("#results-chart");
    if (!canvas || !state.results?.rows?.length) return;
    const ctx = canvas.getContext("2d");
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.max(320, canvas.offsetWidth || 800);
    const h = 300;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);

    const preferred = [
      { header: "Power (mW)", key: "_power", label: "Power (mW)" },
      { header: "Period", key: "_period", label: "Period (cycles)" },
      { header: "Utilization (%)", key: "_utilization", label: "Utilization (%)" },
      { header: "Area", key: "_area", label: "Area" },
      { header: "Cost ($)", key: "_cost", label: "Cost ($)" }
    ];
    let metric = preferred.find(candidate => state.results.rows.some(row => {
      const direct = Number(row[candidate.key]);
      const fallback = parseFloat(String(row[candidate.header] ?? "").replace(/[^0-9.-]/g, ""));
      return Number.isFinite(direct) ? direct > 0 : Number.isFinite(fallback) && fallback > 0;
    }));

    if (!metric) {
      const fallbackHeader = state.results.headers.find(header => header !== "Solution #" && state.results.rows.some(row => Number.isFinite(parseFloat(row[header]))));
      if (fallbackHeader) metric = { header: fallbackHeader, key: null, label: fallbackHeader };
    }
    if (!metric) {
      ctx.fillStyle = "#6b7280";
      ctx.font = "13px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No engineering metric available to chart", w / 2, h / 2);
      return;
    }

    const points = state.results.rows.slice(0, 100).map((row, index) => {
      const direct = metric.key ? Number(row[metric.key]) : NaN;
      const fallback = parseFloat(String(row[metric.header] ?? "").replace(/[^0-9.-]/g, ""));
      return { xIndex: index, value: Number.isFinite(direct) ? direct : (Number.isFinite(fallback) ? fallback : 0) };
    }).filter(point => Number.isFinite(point.value));
    if (!points.length) return;

    const pad = { left: 58, right: 24, top: 32, bottom: 48 };
    const plotW = Math.max(1, w - pad.left - pad.right);
    const plotH = Math.max(1, h - pad.top - pad.bottom);
    let minV = Math.min(...points.map(point => point.value));
    let maxV = Math.max(...points.map(point => point.value));
    if (minV === maxV) {
      const spread = Math.max(1, Math.abs(minV) * 0.1);
      minV -= spread;
      maxV += spread;
    } else {
      const spread = (maxV - minV) * 0.08;
      minV -= spread;
      maxV += spread;
    }

    const xFor = index => points.length === 1 ? pad.left + plotW / 2 : pad.left + (index / (points.length - 1)) * plotW;
    const yFor = value => pad.top + plotH - ((value - minV) / (maxV - minV)) * plotH;

    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#6b7280";
    ctx.font = "11px Inter, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let tick = 0; tick <= 4; tick++) {
      const value = minV + ((maxV - minV) * tick / 4);
      const y = yFor(value);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
      ctx.fillText(Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2), pad.left - 8, y);
    }

    ctx.strokeStyle = "#2563eb";
    ctx.fillStyle = "#2563eb";
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((point, index) => {
      const x = xFor(index);
      const y = yFor(point.value);
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    if (points.length > 1) ctx.stroke();

    points.forEach((point, index) => {
      const x = xFor(index);
      const y = yFor(point.value);
      ctx.beginPath();
      ctx.arc(x, y, points.length === 1 ? 5 : 3, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.fillStyle = "#374151";
    ctx.font = "600 12px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(metric.label, w / 2, h - 10);
    ctx.font = "11px Inter, sans-serif";
    ctx.fillStyle = "#6b7280";
    ctx.fillText(points.length === 1 ? `Solution #${state.results.rows[0]["Solution #"] || 1}` : `Solutions 1–${points.length}`, w / 2, 18);
  }`;
  source = replaceOnce(source, oldChart, newChart, 'replace giant Solution# bar chart with engineering metric plot');

  source = replaceOnce(source, '    ctx.fillStyle = "#f7f7f8";\n    ctx.fillRect(0, 0, w, h);', '    ctx.fillStyle = "#ffffff";\n    ctx.fillRect(0, 0, w, h);', 'use white SDF graph background');
  return source;
});

// Reject dangerous markup in identifier-bearing XML before the legacy renderers
// see it. XML values remain flexible (spaces/dashes/dots are allowed), but HTML
// metacharacters/control characters are not valid UI identifiers.
patchFile('ui/round3_runtime.js', source => {
  const helperMarker = `  function parseXml(text, label) {
    const doc = new DOMParser().parseFromString(String(text || ''), 'text/xml');`;
  const helperReplacement = `  function safeIdentifier(value, label) {
    const text = String(value ?? '').trim();
    if (!text) throw new Error(\`${'${label}'} cannot be empty.\`);
    if (/[<>"'&\\x00-\\x1F]/.test(text)) throw new Error(\`${'${label}'} contains unsupported markup/control characters.\`);
    if (text.length > 120) throw new Error(\`${'${label}'} is too long (max 120 characters).\`);
    return text;
  }

  function parseXml(text, label) {
    const doc = new DOMParser().parseFromString(String(text || ''), 'text/xml');`;
  source = replaceOnce(source, helperMarker, helperReplacement, 'add safe identifier validation for imported model names');

  source = replaceOnce(
    source,
    `      if (!proc.getAttribute('model')) throw new Error('Every processor must have a model name.');`,
    `      safeIdentifier(proc.getAttribute('model'), 'Processor model');`,
    'validate imported processor model identifier'
  );
  source = replaceOnce(
    source,
    `        if (!mode.getAttribute('name')) throw new Error(\`Processor ${'${proc.getAttribute(\'model\')}' } contains an unnamed mode.\`);`,
    `        safeIdentifier(mode.getAttribute('name'), 'Operating mode name');`,
    'validate imported operating mode identifier'
  );
  source = source.replace(
    `    const names = actors.map(actor => actor.getAttribute('name')).filter(Boolean);`,
    `    const names = actors.map(actor => safeIdentifier(actor.getAttribute('name'), 'Actor name'));`
  );
  source = source.replace(
    `      if (!mapping.getAttribute('task_type')) throw new Error('Every WCET mapping must define task_type.');`,
    `      safeIdentifier(mapping.getAttribute('task_type'), 'WCET task type');`
  );
  source = source.replace(
    `        if (!wcet.getAttribute('processor')) throw new Error('Every WCET row must define a processor.');
        if (!wcet.getAttribute('mode')) throw new Error('Every WCET row must define a mode.');`,
    `        safeIdentifier(wcet.getAttribute('processor'), 'WCET processor');
        safeIdentifier(wcet.getAttribute('mode'), 'WCET mode');`
  );
  return source;
});

require('./round6_preflight');
