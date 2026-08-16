/* ParetoCo feature DOM scaffolds.
 * The feature engines were implemented before their required HTML surfaces were
 * added to index.html. Build those surfaces once at runtime so the modules can
 * actually initialize and remain responsive.
 */
(() => {
  'use strict';

  function ensureArchitectureStudio() {
    const root = document.getElementById('architecture-studio-container');
    if (!root || document.getElementById('studio-canvas')) return;
    root.innerHTML = `
      <div class="studio-layout">
        <aside class="studio-left">
          <div class="studio-tabs">
            <button type="button" class="studio-tab active" data-tab="platform">Platform</button>
            <button type="button" class="studio-tab" data-tab="workload">Workload</button>
          </div>
          <div class="studio-palette-container">
            <div class="studio-palette-title">Components</div>
            <div id="studio-palette"></div>
          </div>
          <div class="studio-inspector-container" style="overflow:auto; flex:1; border-top:1px solid var(--border-color);">
            <div class="studio-inspector-title">Inspector</div>
            <div id="studio-inspector"></div>
          </div>
        </aside>
        <section class="studio-center">
          <div class="studio-toolbar">
            <button type="button" class="btn btn-sm btn-outline" id="studio-overlay-toggle">🟢 Show Results</button>
            <span class="studio-zoom-label">Drag nodes · drag ports to connect · wheel to zoom</span>
          </div>
          <canvas id="studio-canvas" class="studio-canvas" style="min-height:560px;"></canvas>
        </section>
      </div>`;
  }

  function ensureParetoExplorer() {
    const root = document.getElementById('pareto-frontier-container');
    if (!root || document.getElementById('pareto-scatter-canvas')) return;
    root.innerHTML = `
      <div class="pareto-layout">
        <div>
          <div class="card">
            <div class="card-header"><h3>Pareto Frontier</h3><div id="pareto-dims" style="display:flex; gap:10px;"></div></div>
            <div class="card-body"><canvas id="pareto-scatter-canvas" style="width:100%; min-height:420px; height:420px;"></canvas></div>
          </div>
          <div class="card">
            <div class="card-header"><h3>Parallel Coordinates</h3></div>
            <div class="card-body"><canvas id="pareto-pc-canvas" style="width:100%; min-height:340px; height:340px;"></canvas></div>
          </div>
        </div>
        <div>
          <div class="card"><div class="card-body" id="pareto-constraints"></div></div>
          <div class="card"><div class="card-body" id="pareto-detail"></div></div>
          <div class="card"><div class="card-body" id="pareto-sensitivity"></div></div>
        </div>
      </div>`;
  }

  function ensureContinuousDse() {
    const root = document.getElementById('incremental-dse-container');
    if (!root || document.getElementById('dse-timeline')) return;
    root.innerHTML = `
      <div id="dse-status-banner" style="margin-bottom:16px;"></div>
      <div class="dse-layout">
        <div class="card">
          <div class="card-header"><h3>Run Timeline</h3></div>
          <div class="card-body" id="dse-timeline"></div>
        </div>
        <div class="card">
          <div class="card-header"><h3>Run Delta</h3></div>
          <div class="card-body" id="dse-delta"><div class="inspector-empty"><p>Select or create a DSE run to inspect changes.</p></div></div>
        </div>
      </div>`;
  }

  ensureArchitectureStudio();
  ensureParetoExplorer();
  ensureContinuousDse();

  const api = window.paretoco;
  function rebuildArchitectureFromState() {
    if (!window.ArchStudio) return;
    try {
      window.ArchStudio.clear?.();
      window.ArchStudio.syncCanvasFromModel?.();
      window.ArchStudio.applyResultOverlay?.();
    } catch (error) {
      console.warn('[ParetoCo scaffold] Architecture refresh failed:', error);
    }
  }

  if (api) {
    for (const methodName of ['loadPlatformXml', 'loadSdfXml', 'loadDemoPreset']) {
      const original = api[methodName];
      if (typeof original !== 'function') continue;
      api[methodName] = function wrappedModelLoader(...args) {
        const result = original.apply(this, args);
        rebuildArchitectureFromState();
        return result;
      };
    }
  }

  // Architecture Studio stores every edit back into the shared model. Clearing
  // its transient canvas before navigation therefore gives a fresh, current view
  // without losing user changes or showing stale nodes after an AI/demo update.
  document.getElementById('nav-arch-studio')?.addEventListener('click', () => {
    try { window.ArchStudio?.clear?.(); } catch (_) {}
  }, { capture: true });

  console.info('[ParetoCo scaffold] Architecture Studio, Pareto Explorer, and Continuous DSE surfaces are ready.');
})();
