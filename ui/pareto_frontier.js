/*
 * ParetoCo — Native Result Pareto Explorer
 *
 * Visualizes only metrics present in the current native result set. Throughput
 * is represented as inverse period (1/cycle) unless an explicit throughput
 * field exists; no arbitrary frequency scale is introduced.
 */
(() => {
  'use strict';

  const DIMENSIONS = [
    { key: 'period', label: 'Period', unit: 'cycles', lowerBetter: true },
    { key: 'power', label: 'Power', unit: 'mW', lowerBetter: true },
    { key: 'area', label: 'Area', unit: '', lowerBetter: true },
    { key: 'cost', label: 'Cost', unit: '', lowerBetter: true },
    { key: 'utilization', label: 'Utilization', unit: '%', lowerBetter: false },
    { key: 'throughput', label: 'Inverse Period', unit: '1/cycle', lowerBetter: false },
    { key: 'processors', label: 'Processors Used', unit: '', lowerBetter: true }
  ];

  const explorer = {
    solutions: [],
    paretoFront: [],
    xDim: 'period',
    yDim: 'power',
    selected: null,
    constraints: {}
  };

  function numeric(row, internalKey, displayKey) {
    const direct = Number(row?.[internalKey]);
    if (Number.isFinite(direct)) return direct;
    const text = String(row?.[displayKey] ?? '');
    const interval = text.match(/\[\s*(-?\d+(?:\.\d+)?)(?:\.\.(-?\d+(?:\.\d+)?))?\s*\]/);
    if (interval) return Number(interval[1]);
    const value = Number.parseFloat(text.replace(/[^0-9+-.]/g, ''));
    return Number.isFinite(value) ? value : 0;
  }

  function parseSolutions() {
    const rows = window.paretoco?.state?.results?.rows || [];
    explorer.solutions = rows.map((row, index) => {
      const period = numeric(row, '_period', 'Period');
      const explicitThroughput = numeric(row, '_throughput', 'Throughput');
      const mapping = String(row['PE Mapping'] || '')
        .split(/[,\s]+/)
        .map(Number)
        .filter(Number.isInteger);
      return {
        id: index,
        label: `Design #${row['Solution #'] || index + 1}`,
        period,
        power: numeric(row, '_power', 'Power (mW)'),
        area: numeric(row, '_area', 'Area'),
        cost: numeric(row, '_cost', 'Cost ($)'),
        utilization: numeric(row, '_utilization', 'Utilization (%)'),
        throughput: explicitThroughput > 0 ? explicitThroughput : (period > 0 ? 1 / period : 0),
        processors: new Set(mapping).size,
        mapping,
        raw: row
      };
    });
    computeParetoFront();
    initializeConstraints();
  }

  function activeDimensions() {
    return DIMENSIONS.filter(dim => explorer.solutions.some(solution => Number.isFinite(solution[dim.key]) && solution[dim.key] > 0));
  }

  function dominates(a, b) {
    let strictlyBetter = false;
    for (const dim of activeDimensions()) {
      const av = Number(a[dim.key]);
      const bv = Number(b[dim.key]);
      if (!(av > 0) || !(bv > 0)) continue;
      if (dim.lowerBetter) {
        if (av > bv) return false;
        if (av < bv) strictlyBetter = true;
      } else {
        if (av < bv) return false;
        if (av > bv) strictlyBetter = true;
      }
    }
    return strictlyBetter;
  }

  function computeParetoFront() {
    explorer.paretoFront = [];
    for (let i = 0; i < explorer.solutions.length; i++) {
      let isDominated = false;
      for (let j = 0; j < explorer.solutions.length; j++) {
        if (i !== j && dominates(explorer.solutions[j], explorer.solutions[i])) {
          isDominated = true;
          break;
        }
      }
      if (!isDominated) explorer.paretoFront.push(i);
    }
  }

  function initializeConstraints() {
    explorer.constraints = {};
    for (const dim of activeDimensions()) {
      const values = explorer.solutions.map(solution => solution[dim.key]).filter(value => value > 0);
      explorer.constraints[dim.key] = {
        min: Math.min(...values),
        max: Math.max(...values),
        enabled: false
      };
    }
  }

  function filteredSolutions() {
    return explorer.solutions.filter(solution => {
      for (const [key, constraint] of Object.entries(explorer.constraints)) {
        if (!constraint.enabled) continue;
        const dim = DIMENSIONS.find(item => item.key === key);
        const value = solution[key];
        if (!(value > 0)) continue;
        if (dim.lowerBetter && value > constraint.max) return false;
        if (!dim.lowerBetter && value < constraint.min) return false;
      }
      return true;
    });
  }

  function ensureCanvas(canvas, fallbackHeight) {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.max(320, canvas.clientWidth || 800);
    const height = Math.max(240, canvas.clientHeight || fallbackHeight);
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width, height };
  }

  function renderScatter() {
    const canvas = document.getElementById('pareto-scatter-canvas');
    if (!canvas) return;
    const { ctx, width, height } = ensureCanvas(canvas, 420);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    const visible = filteredSolutions();
    if (!visible.length) {
      ctx.fillStyle = '#6b7280';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No native solutions match the active filters.', width / 2, height / 2);
      return;
    }

    const dims = activeDimensions();
    const xDim = DIMENSIONS.find(dim => dim.key === explorer.xDim) || dims[0];
    const yDim = DIMENSIONS.find(dim => dim.key === explorer.yDim) || dims[1] || xDim;
    const xValues = visible.map(solution => solution[xDim.key]).filter(value => value > 0);
    const yValues = visible.map(solution => solution[yDim.key]).filter(value => value > 0);
    if (!xValues.length || !yValues.length) return;

    const pad = { left: 70, right: 30, top: 30, bottom: 60 };
    const minMax = values => {
      const min = Math.min(...values);
      const max = Math.max(...values);
      if (min === max) return [min ? min * 0.9 : -1, max ? max * 1.1 : 1];
      const margin = (max - min) * 0.08;
      return [min - margin, max + margin];
    };
    const [xMin, xMax] = minMax(xValues);
    const [yMin, yMax] = minMax(yValues);
    const x = value => pad.left + ((value - xMin) / (xMax - xMin)) * (width - pad.left - pad.right);
    const y = value => height - pad.bottom - ((value - yMin) / (yMax - yMin)) * (height - pad.top - pad.bottom);

    ctx.strokeStyle = '#d1d5db';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top);
    ctx.lineTo(pad.left, height - pad.bottom);
    ctx.lineTo(width - pad.right, height - pad.bottom);
    ctx.stroke();

    for (const solution of visible) {
      const isPareto = explorer.paretoFront.includes(solution.id);
      ctx.beginPath();
      ctx.arc(x(solution[xDim.key]), y(solution[yDim.key]), explorer.selected === solution.id ? 6 : 4, 0, Math.PI * 2);
      ctx.fillStyle = isPareto ? '#2563eb' : '#9ca3af';
      ctx.fill();
    }

    ctx.fillStyle = '#374151';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${xDim.label}${xDim.unit ? ` (${xDim.unit})` : ''}`, width / 2, height - 18);
    ctx.save();
    ctx.translate(18, height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(`${yDim.label}${yDim.unit ? ` (${yDim.unit})` : ''}`, 0, 0);
    ctx.restore();

    canvas.onclick = event => {
      const rect = canvas.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      let nearest = null;
      let distance = Infinity;
      for (const solution of visible) {
        const d = Math.hypot(x(solution[xDim.key]) - mx, y(solution[yDim.key]) - my);
        if (d < distance) { distance = d; nearest = solution; }
      }
      if (nearest && distance < 15) {
        explorer.selected = nearest.id;
        renderDetail();
        renderScatter();
      }
    };
  }

  function renderDimensionControls() {
    const target = document.getElementById('pareto-dims');
    if (!target) return;
    target.replaceChildren();
    const dims = activeDimensions();
    if (!dims.length) return;
    const makeSelect = (value, onChange) => {
      const select = document.createElement('select');
      select.className = 'form-control';
      for (const dim of dims) {
        const option = document.createElement('option');
        option.value = dim.key;
        option.textContent = dim.label;
        select.appendChild(option);
      }
      select.value = dims.some(dim => dim.key === value) ? value : dims[0].key;
      select.addEventListener('change', () => onChange(select.value));
      return select;
    };
    target.append('X: ', makeSelect(explorer.xDim, value => { explorer.xDim = value; renderScatter(); }));
    target.append(' Y: ', makeSelect(explorer.yDim, value => { explorer.yDim = value; renderScatter(); }));
  }

  function renderConstraints() {
    const target = document.getElementById('pareto-constraints');
    if (!target) return;
    target.replaceChildren();
    const title = document.createElement('h3');
    title.textContent = 'What-if Filters';
    target.appendChild(title);
    for (const dim of activeDimensions()) {
      const constraint = explorer.constraints[dim.key];
      const row = document.createElement('div');
      row.style.cssText = 'margin-bottom:12px';
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = constraint.enabled;
      checkbox.addEventListener('change', () => { constraint.enabled = checkbox.checked; renderAll(); });
      label.append(checkbox, document.createTextNode(` ${dim.label}`));
      row.appendChild(label);
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'form-control';
      input.step = 'any';
      input.value = dim.lowerBetter ? constraint.max : constraint.min;
      input.addEventListener('change', () => {
        const value = Number(input.value);
        if (!Number.isFinite(value)) return;
        if (dim.lowerBetter) constraint.max = value; else constraint.min = value;
        renderAll();
      });
      row.appendChild(input);
      const help = document.createElement('small');
      help.textContent = dim.lowerBetter ? 'Maximum allowed value' : 'Minimum required value';
      row.appendChild(help);
      target.appendChild(row);
    }
  }

  function renderDetail() {
    const target = document.getElementById('pareto-detail');
    if (!target) return;
    target.replaceChildren();
    const solution = explorer.solutions[explorer.selected];
    const title = document.createElement('h3');
    title.textContent = solution ? solution.label : 'Solution Detail';
    target.appendChild(title);
    if (!solution) {
      const p = document.createElement('p');
      p.textContent = 'Select a point to inspect its native metrics.';
      target.appendChild(p);
      return;
    }
    const list = document.createElement('dl');
    for (const dim of activeDimensions()) {
      const dt = document.createElement('dt');
      dt.textContent = dim.label;
      const dd = document.createElement('dd');
      dd.textContent = `${solution[dim.key]}${dim.unit ? ` ${dim.unit}` : ''}`;
      list.append(dt, dd);
    }
    const pareto = document.createElement('p');
    pareto.textContent = explorer.paretoFront.includes(solution.id)
      ? 'Non-dominated in the current native result set.'
      : 'Dominated by at least one current native solution.';
    target.append(list, pareto);
  }

  function renderObservedRanges() {
    const target = document.getElementById('pareto-sensitivity');
    if (!target) return;
    target.replaceChildren();
    const title = document.createElement('h3');
    title.textContent = 'Observed Native Ranges';
    target.appendChild(title);
    const note = document.createElement('p');
    note.textContent = 'This reports observed ranges only; it does not infer causal sensitivity from sparse design points.';
    target.appendChild(note);
    const list = document.createElement('ul');
    for (const dim of activeDimensions()) {
      const values = explorer.solutions.map(solution => solution[dim.key]).filter(value => value > 0);
      const item = document.createElement('li');
      item.textContent = `${dim.label}: ${Math.min(...values)} to ${Math.max(...values)}${dim.unit ? ` ${dim.unit}` : ''}`;
      list.appendChild(item);
    }
    target.appendChild(list);
  }

  function renderParallelCoordinates() {
    const canvas = document.getElementById('pareto-pc-canvas');
    if (!canvas) return;
    const { ctx, width, height } = ensureCanvas(canvas, 340);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    const dims = activeDimensions().slice(0, 6);
    const visible = filteredSolutions();
    if (dims.length < 2 || !visible.length) return;
    const pad = 40;
    const axisX = index => pad + index * ((width - 2 * pad) / (dims.length - 1));
    const ranges = Object.fromEntries(dims.map(dim => {
      const values = visible.map(solution => solution[dim.key]).filter(value => value > 0);
      return [dim.key, [Math.min(...values), Math.max(...values)]];
    }));

    dims.forEach((dim, index) => {
      const x = axisX(index);
      ctx.strokeStyle = '#d1d5db';
      ctx.beginPath(); ctx.moveTo(x, pad); ctx.lineTo(x, height - pad); ctx.stroke();
      ctx.fillStyle = '#374151';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(dim.label, x, 18);
    });

    for (const solution of visible) {
      ctx.strokeStyle = explorer.paretoFront.includes(solution.id) ? 'rgba(37,99,235,.55)' : 'rgba(156,163,175,.25)';
      ctx.beginPath();
      dims.forEach((dim, index) => {
        const [min, max] = ranges[dim.key];
        const ratio = max === min ? 0.5 : (solution[dim.key] - min) / (max - min);
        const x = axisX(index);
        const y = height - pad - ratio * (height - 2 * pad);
        if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }

  function renderAll() {
    renderDimensionControls();
    renderConstraints();
    renderDetail();
    renderObservedRanges();
    renderScatter();
    renderParallelCoordinates();
  }

  function init() {
    parseSolutions();
    const dims = activeDimensions();
    if (dims.length) explorer.xDim = dims.some(dim => dim.key === 'period') ? 'period' : dims[0].key;
    if (dims.length > 1) explorer.yDim = dims.some(dim => dim.key === 'power') ? 'power' : dims[1].key;
    renderAll();
  }

  window.ParetoFrontier = {
    init,
    parseSolutions,
    computeParetoFront,
    dominates,
    getState: () => explorer
  };
})();
