/*
 * ParetoCo — DSE Run History & Change Tracking
 *
 * Stores native-run snapshots in IndexedDB and explains how the model changed
 * between runs. Previous solutions are comparison data only; this module does
 * not inject search seeds into the native solver.
 */
(() => {
  'use strict';

  const DB_NAME = 'paretoco_dse_history';
  const DB_VERSION = 1;
  const STORE_NAME = 'sessions';
  const MAX_SESSIONS = 50;

  const historyState = {
    db: null,
    sessions: [],
    currentSession: null,
    initialized: false
  };

  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

  function hash(text) {
    let value = 2166136261;
    for (let i = 0; i < text.length; i++) {
      value ^= text.charCodeAt(i);
      value = Math.imul(value, 16777619);
    }
    return (value >>> 0).toString(36);
  }

  function snapshot() {
    const app = window.paretoco?.state;
    if (!app) return null;
    return {
      timestamp: Date.now(),
      platform: clone(app.platform),
      applications: clone(app.applications),
      wcets: clone(app.wcets),
      constraints: clone(app.constraints),
      sysConstraints: clone(app.sysConstraints),
      dse: clone(app.dse),
      presolver: clone(app.presolver),
      output: clone(app.output),
      results: app.results ? {
        summary: clone(app.results.summary),
        rows: clone(app.results.rows || [])
      } : null
    };
  }

  function modelFingerprint(snap) {
    if (!snap) return '';
    return hash(JSON.stringify({
      platform: snap.platform,
      applications: snap.applications,
      wcets: snap.wcets,
      constraints: snap.constraints,
      sysConstraints: snap.sysConstraints,
      dse: snap.dse,
      presolver: snap.presolver,
      output: snap.output
    }));
  }

  function resultFingerprint(snap) {
    return snap?.results ? hash(JSON.stringify(snap.results.rows || [])) : '';
  }

  function openDb() {
    if (historyState.db) return Promise.resolve(historyState.db);
    return new Promise(resolve => {
      if (!window.indexedDB) return resolve(null);
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = event => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
      };
      request.onsuccess = event => {
        historyState.db = event.target.result;
        resolve(historyState.db);
      };
      request.onerror = () => resolve(null);
    });
  }

  async function loadSessions() {
    const db = await openDb();
    if (!db) return [];
    return new Promise(resolve => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => resolve([]);
    });
  }

  async function saveSession(session) {
    const db = await openDb();
    if (!db) return;
    await new Promise(resolve => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(session);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  }

  async function deleteSession(id) {
    const db = await openDb();
    if (!db) return;
    await new Promise(resolve => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  }

  async function enforceLimit() {
    const sessions = await loadSessions();
    if (sessions.length <= MAX_SESSIONS) return;
    sessions.sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0));
    for (const session of sessions.slice(0, sessions.length - MAX_SESSIONS)) await deleteSession(session.id);
  }

  function diffObjects(before, after) {
    const changes = [];
    const add = (category, impact, description) => changes.push({ category, impact, description });
    if (!before) return [{ category: 'baseline', impact: 'high', description: 'Initial model snapshot.' }];

    if (JSON.stringify(before.platform) !== JSON.stringify(after.platform)) add('platform', 'high', 'Platform processors, modes, or interconnect changed.');
    if (JSON.stringify(before.applications) !== JSON.stringify(after.applications)) add('workload', 'high', 'Application actors/channels changed.');
    if (JSON.stringify(before.wcets) !== JSON.stringify(after.wcets)) add('wcet', 'high', 'WCET mappings changed.');
    if (JSON.stringify(before.constraints) !== JSON.stringify(after.constraints)) add('constraints', 'medium', 'Application constraints changed.');
    if (JSON.stringify(before.sysConstraints) !== JSON.stringify(after.sysConstraints)) add('constraints', 'medium', 'System constraints changed.');
    if (JSON.stringify(before.dse) !== JSON.stringify(after.dse)) add('dse', 'medium', 'DSE search configuration changed.');
    if (JSON.stringify(before.presolver) !== JSON.stringify(after.presolver)) add('presolver', 'medium', 'Presolver configuration changed.');
    if (JSON.stringify(before.output) !== JSON.stringify(after.output)) add('output', 'low', 'Output/logging settings changed.');
    return changes;
  }

  function createSession() {
    const now = Date.now();
    return {
      id: `session_${now}`,
      name: `DSE Session ${new Date(now).toLocaleString()}`,
      createdAt: now,
      updatedAt: now,
      runs: []
    };
  }

  async function recordCurrentRun(force = false) {
    const snap = snapshot();
    if (!snap) return null;
    if (!historyState.currentSession) historyState.currentSession = createSession();
    const session = historyState.currentSession;
    const previous = session.runs[session.runs.length - 1] || null;
    const modelKey = modelFingerprint(snap);
    const resultKey = resultFingerprint(snap);
    if (!force && previous && previous.modelFingerprint === modelKey && previous.resultFingerprint === resultKey) return previous;

    const run = {
      id: `run_${Date.now()}_${session.runs.length + 1}`,
      timestamp: Date.now(),
      snapshot: snap,
      modelFingerprint: modelKey,
      resultFingerprint: resultKey,
      diff: diffObjects(previous?.snapshot, snap),
      nativeSolutions: snap.results?.rows?.length ?? null,
      priorSolutionCache: {
        count: previous?.snapshot?.results?.rows?.length || 0,
        injectedIntoNativeSolver: false
      }
    };
    session.runs.push(run);
    session.updatedAt = Date.now();
    await saveSession(session);
    await enforceLimit();
    await refreshSessions();
    render();
    return run;
  }

  async function refreshSessions() {
    historyState.sessions = (await loadSessions()).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    if (!historyState.currentSession && historyState.sessions[0]) historyState.currentSession = historyState.sessions[0];
  }

  function formatImpact(impact) {
    if (impact === 'high') return 'High impact';
    if (impact === 'medium') return 'Medium impact';
    if (impact === 'low') return 'Low impact';
    return 'Baseline';
  }

  function renderTimeline() {
    const target = document.getElementById('dse-timeline');
    if (!target) return;
    target.replaceChildren();
    const runs = historyState.currentSession?.runs || [];
    if (!runs.length) {
      const p = document.createElement('p');
      p.textContent = 'No recorded DSE snapshots yet.';
      target.appendChild(p);
      return;
    }

    for (const run of [...runs].reverse()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-outline';
      button.style.cssText = 'display:block;width:100%;text-align:left;margin-bottom:8px';
      const solutionText = run.nativeSolutions == null ? 'no result loaded' : `${run.nativeSolutions} native solution(s)`;
      button.textContent = `${new Date(run.timestamp).toLocaleString()} — ${solutionText}`;
      button.addEventListener('click', () => renderDelta(run));
      target.appendChild(button);
    }
  }

  function renderDelta(run) {
    const target = document.getElementById('dse-delta');
    if (!target) return;
    target.replaceChildren();

    const heading = document.createElement('h4');
    heading.textContent = 'Changes since previous run';
    target.appendChild(heading);

    if (!run.diff?.length) {
      const p = document.createElement('p');
      p.textContent = 'No model/configuration changes detected.';
      target.appendChild(p);
    } else {
      const list = document.createElement('ul');
      for (const change of run.diff) {
        const item = document.createElement('li');
        item.textContent = `${formatImpact(change.impact)} — ${change.description}`;
        list.appendChild(item);
      }
      target.appendChild(list);
    }

    const cache = document.createElement('p');
    cache.textContent = `Previous-result cache: ${run.priorSolutionCache.count} solution(s). These are retained for comparison only and are not injected into the native solver.`;
    target.appendChild(cache);
  }

  function renderSessions() {
    const target = document.getElementById('dse-sessions');
    if (!target) return;
    target.replaceChildren();
    for (const session of historyState.sessions) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px';
      const button = document.createElement('button');
      button.className = 'btn btn-outline btn-sm';
      button.textContent = `${session.name} (${session.runs?.length || 0} runs)`;
      button.addEventListener('click', () => {
        historyState.currentSession = session;
        render();
      });
      const del = document.createElement('button');
      del.className = 'btn btn-outline btn-sm';
      del.textContent = 'Delete';
      del.addEventListener('click', async () => {
        await deleteSession(session.id);
        if (historyState.currentSession?.id === session.id) historyState.currentSession = null;
        await refreshSessions();
        render();
      });
      row.append(button, del);
      target.appendChild(row);
    }
  }

  function renderBanner() {
    const target = document.getElementById('dse-status-banner');
    if (!target) return;
    target.replaceChildren();
    const info = document.createElement('div');
    info.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px';
    const text = document.createElement('span');
    text.textContent = 'Run history records model/configuration changes and native result snapshots. It is not a native warm-start mechanism.';
    const record = document.createElement('button');
    record.type = 'button';
    record.className = 'btn btn-primary btn-sm';
    record.textContent = 'Record Current Snapshot';
    record.addEventListener('click', () => recordCurrentRun(true));
    info.append(text, record);
    target.appendChild(info);
  }

  function render() {
    renderBanner();
    renderTimeline();
    renderSessions();
    const latest = historyState.currentSession?.runs?.at(-1);
    if (latest) renderDelta(latest);
  }

  async function init() {
    if (!historyState.initialized) {
      historyState.initialized = true;
      await refreshSessions();
      if (!historyState.currentSession) historyState.currentSession = createSession();
    }
    await recordCurrentRun(false);
    render();
  }

  window.IncrementalDSE = {
    init,
    recordCurrentRun,
    getState: () => historyState,
    computeDiff: diffObjects,
    purpose: 'run-history-and-change-tracking',
    nativeWarmStartInjection: false
  };
})();
