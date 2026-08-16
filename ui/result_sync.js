/* ParetoCo native-result UI synchronizer.
 * Keeps every result-driven view consistent with the real native output.
 * In particular, negative sentinel values such as maxPower=-1 mean
 * "Unlimited" and must never filter valid native solutions.
 */
(() => {
  'use strict';

  const api = window.paretoco;
  if (!api?.state || typeof api.loadResults !== 'function') return;
  const state = api.state;
  const originalLoadResults = api.loadResults.bind(api);

  const HEADERS = [
    'Solution #', 'Period', 'Utilization (%)', 'Power (mW)',
    'Area', 'Cost ($)', 'PE Mapping', 'Order'
  ];

  function clearInactiveSentinels() {
    state.sysConstraints = state.sysConstraints || {};
    const aliases = [
      ['maxPower', 'power'],
      ['maxUtil', 'utilization']
    ];
    for (const [alias, canonical] of aliases) {
      const canonicalValue = Number(state.sysConstraints[canonical]);
      const aliasValue = Number(state.sysConstraints[alias]);
      if (!(canonicalValue > 0) && !(aliasValue > 0)) delete state.sysConstraints[alias];
    }
  }

  function nativeSolutionCount(text) {
    const source = String(text || '');
    const summaries = [...source.matchAll(/(\d+)\s+solutions?\s+found/gi)];
    const summaryCount = summaries.length ? Number(summaries[summaries.length - 1][1]) : 0;
    const blockCount = (source.match(/\*{3}\s*Solution number\s*:/gi) || []).length;
    return Math.max(summaryCount, blockCount);
  }

  function extract(block, regex) {
    const match = String(block || '').match(regex);
    return match ? String(match[1]).trim() : '—';
  }

  function numericLowerBound(value) {
    const match = String(value ?? '').match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : 0;
  }

  function parseNativeRows(text) {
    const parts = String(text || '').split(/\*{3}\s*Solution number\s*:\s*/i).slice(1);
    return parts.map((block, index) => {
      const solutionNumber = extract(block, /^(\d+)/);
      const period = extract(block, /Period:\s*(?:\{)?(.*?)(?:\})?(?:\r?\n|$)/i);
      const utilization = extract(block, /Sys utilization:\s*(.*?)(?:\r?\n|$)/i);
      const power = extract(block, /sys power(?:\s*\(only used parts\))?:\s*(.*?)(?:\r?\n|$)/i);
      const area = extract(block, /sys area(?:\s*\(only used parts\))?:\s*(.*?)(?:\r?\n|$)/i);
      const cost = extract(block, /sys cost(?:\s*\(only used parts\))?:\s*(.*?)(?:\r?\n|$)/i);
      const mapping = extract(block, /Proc:\s*\{(.*?)\}/i);
      const order = extract(block, /Next:\s*(.*?)(?:\r?\n|$)/i);
      return {
        'Solution #': solutionNumber === '—' ? String(index + 1) : solutionNumber,
        'Period': period,
        'Utilization (%)': utilization,
        'Power (mW)': power,
        'Area': area,
        'Cost ($)': cost,
        'PE Mapping': mapping,
        'Order': order,
        _period: numericLowerBound(period),
        _power: numericLowerBound(power),
        _area: numericLowerBound(area),
        _cost: numericLowerBound(cost),
        _utilization: numericLowerBound(utilization)
      };
    });
  }

  function searchTime(text) {
    const match = String(text || '').match(/search ended after:\s*([^\r\n]+)/i);
    return match ? match[1].trim() : '—';
  }

  function formatCount(count) {
    return `${count} solution${count === 1 ? '' : 's'} found`;
  }

  function normalizeResultState(text, filename) {
    const isCsv = String(filename || '').toLowerCase().endsWith('.csv');
    const fallbackRows = isCsv ? [] : parseNativeRows(text);
    const count = isCsv
      ? (Array.isArray(state.results?.rows) ? state.results.rows.length : 0)
      : nativeSolutionCount(text);

    if (!state.results) {
      state.results = {
        headers: HEADERS.slice(),
        rows: fallbackRows,
        raw: String(text || ''),
        summary: { solutions: formatCount(count), time: isCsv ? '—' : searchTime(text) }
      };
    } else {
      if (!isCsv && (!Array.isArray(state.results.rows) || state.results.rows.length === 0) && fallbackRows.length) {
        state.results.headers = HEADERS.slice();
        state.results.rows = fallbackRows;
      }
      state.results.raw = String(text || state.results.raw || '');
      state.results.summary = state.results.summary || {};
      state.results.summary.solutions = formatCount(count);
      if (!isCsv && (!state.results.summary.time || state.results.summary.time === '< 1s')) {
        state.results.summary.time = searchTime(text);
      }
    }

    // A successful native output containing explicit solution blocks is
    // authoritative. Never leave the state saying UNSAT when rows exist.
    if (!isCsv && fallbackRows.length && state.results.rows.length === 0) {
      state.results.rows = fallbackRows;
      state.results.headers = HEADERS.slice();
    }

    return count;
  }

  function rebuildSummary(count) {
    const kpi = document.getElementById('kpi-solutions');
    if (kpi) kpi.textContent = formatCount(count);

    const summary = document.getElementById('results-summary');
    if (summary && state.results) {
      summary.replaceChildren();
      const entries = [
        ['Solutions', formatCount(count)],
        ['Search Time', state.results.summary?.time || '—'],
        ['Rows', String(state.results.rows?.length || 0)]
      ];
      for (const [labelText, valueText] of entries) {
        const stat = document.createElement('div');
        stat.className = 'stat';
        const label = document.createElement('span');
        label.className = 'stat-label';
        label.textContent = labelText;
        const value = document.createElement('span');
        value.className = 'stat-value';
        value.textContent = valueText;
        stat.append(label, value);
        summary.appendChild(stat);
      }
    }

    const hasSolutions = count > 0 && (state.results?.rows?.length || 0) > 0;
    document.getElementById('results-empty')?.classList.toggle('hidden', Boolean(state.results));
    document.getElementById('results-content')?.classList.toggle('hidden', !state.results);
    document.getElementById('unsat-doctor-container')?.classList.toggle('hidden', hasSolutions);
    document.getElementById('results-chart')?.classList.toggle('hidden', !hasSolutions);
    document.getElementById('results-table')?.classList.toggle('hidden', !hasSolutions);
  }

  function rebuildResultTable() {
    const rows = state.results?.rows || [];
    const headers = state.results?.headers || HEADERS;
    const thead = document.getElementById('results-thead');
    const tbody = document.getElementById('results-tbody');
    if (!thead || !tbody) return;

    thead.replaceChildren();
    tbody.replaceChildren();
    if (!rows.length) return;

    const headerRow = document.createElement('tr');
    headers.forEach(header => {
      const th = document.createElement('th');
      th.textContent = header;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);

    rows.slice(0, 100).forEach(row => {
      const tr = document.createElement('tr');
      headers.forEach(header => {
        const td = document.createElement('td');
        td.textContent = row[header] ?? '';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  function drawPeriodChart() {
    const canvas = document.getElementById('results-chart');
    const rows = state.results?.rows || [];
    if (!canvas || !rows.length) return;

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = Math.max(320, canvas.clientWidth || 900);
    const cssHeight = 300;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    const values = rows.map(row => Number(row._period || numericLowerBound(row.Period))).filter(Number.isFinite);
    if (!values.length) return;
    const max = Math.max(...values, 1);
    const left = 50;
    const right = 20;
    const top = 28;
    const bottom = 46;
    const chartW = cssWidth - left - right;
    const chartH = cssHeight - top - bottom;
    const slotW = chartW / values.length;
    const barW = Math.min(70, Math.max(10, slotW * 0.65));

    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(left, top + chartH);
    ctx.lineTo(left + chartW, top + chartH);
    ctx.stroke();

    values.forEach((value, index) => {
      const height = (value / max) * (chartH - 18);
      const x = left + index * slotW + (slotW - barW) / 2;
      const y = top + chartH - height;
      ctx.fillStyle = '#c9513e';
      ctx.fillRect(x, y, barW, height);
      ctx.fillStyle = '#475569';
      ctx.font = '11px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(value), x + barW / 2, Math.max(14, y - 5));
      ctx.fillText(`#${rows[index]?.['Solution #'] || index + 1}`, x + barW / 2, top + chartH + 18);
    });

    ctx.fillStyle = '#475569';
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Native period (cycles)', left + chartW / 2, cssHeight - 8);
  }

  function refreshAllResultViews(text, filename = 'out.txt') {
    const count = normalizeResultState(text, filename);
    rebuildSummary(count);
    rebuildResultTable();
    drawPeriodChart();

    // These modules read the same state.results object, so refresh them only
    // after the authoritative native state has been reconciled.
    window.ParetoFrontier?.refresh?.();
    window.ArchStudio?.applyResultOverlay?.();

    // Keep the dashboard's non-result KPIs consistent too.
    const processors = (state.platform?.processors || []).reduce((sum, proc) => sum + Math.max(0, Number(proc.count) || 0), 0);
    const actors = (state.applications || []).reduce((sum, app) => sum + (app.actors?.length || 0), 0);
    const processorKpi = document.getElementById('kpi-processors');
    const applicationKpi = document.getElementById('kpi-applications');
    const actorKpi = document.getElementById('kpi-actors');
    if (processorKpi) processorKpi.textContent = String(processors);
    if (applicationKpi) applicationKpi.textContent = String(state.applications?.length || 0);
    if (actorKpi) actorKpi.textContent = String(actors);
  }

  api.loadResults = function synchronizedLoadResults(text, filename = 'out.txt') {
    // Fix the legacy sentinel bug before its parser evaluates constraints.
    clearInactiveSentinels();
    originalLoadResults(text, filename);
    refreshAllResultViews(text, filename);
  };

  function installResultFileImportBridge() {
    const button = document.getElementById('btn-load-results');
    const input = document.getElementById('file-results');
    if (!button || !input) return;
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      input.value = '';
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => api.loadResults(String(reader.result || ''), file.name || 'out.txt');
        reader.onerror = () => api.toast?.('Could not read the selected result file.', 'error');
        reader.readAsText(file);
      };
      input.click();
    }, { capture: true });
  }

  installResultFileImportBridge();

  // If a page was restored from localStorage with existing results, reconcile
  // the visible cards once on load as well.
  if (state.results?.raw) {
    clearInactiveSentinels();
    refreshAllResultViews(state.results.raw, 'out.txt');
  }
})();
