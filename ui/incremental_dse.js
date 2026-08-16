/* ════════════════════════════════════════════════════════════════
   ParetoCo — Incremental / Warm-Start DSE
   ════════════════════════════════════════════════════════════════
   Continuous Design-Space Exploration with session management,
   change detection, selective invalidation, and persistent caching.
   
   Fully decoupled — reads/writes window.paretoco.state.
   ════════════════════════════════════════════════════════════════ */

(() => {
  "use strict";

  // ═══════════════════════ CONSTANTS ═══════════════════════════
  const DB_NAME = "paretoco_dse_sessions";
  const DB_VERSION = 1;
  const STORE_NAME = "sessions";
  const MAX_SESSIONS = 50;

  // ═══════════════════════ STATE ══════════════════════════════
  const dseState = {
    currentSession: null,     // Active DSESession
    sessions: [],             // All loaded sessions (summary)
    runs: [],                 // Runs in current session
    lastSnapshot: null,       // Last parameter snapshot for diff
    db: null,                 // IndexedDB handle
    initialized: false,
  };

  // ═══════════════════════ DATA STRUCTURES ════════════════════
  // DSESession: {
  //   id: string,
  //   name: string,
  //   createdAt: timestamp,
  //   updatedAt: timestamp,
  //   runs: DSERun[],
  //   fingerprint: string,  // content hash of initial config
  // }
  //
  // DSERun: {
  //   id: string,
  //   timestamp: timestamp,
  //   paramSnapshot: object,
  //   diff: ParameterDiff | null,
  //   results: { solutions: [], paretoFront: [], summary: {} },
  //   warmStartPayload: object | null,
  //   status: "complete" | "invalidated" | "partial",
  //   validSolutions: number[],    // indices of still-valid solutions
  //   invalidatedSolutions: number[], // indices invalidated by param change
  //   newSolutions: number[],      // indices of newly found solutions
  // }
  //
  // ParameterDiff: {
  //   type: "platform" | "constraint" | "workload" | "dse_config",
  //   changes: Change[],
  //   impact: "high" | "medium" | "low",
  //   description: string,
  // }

  // ═══════════════════════ INDEXEDDB CACHE ════════════════════
  function openDB() {
    return new Promise((resolve, reject) => {
      if (dseState.db) { resolve(dseState.db); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
          store.createIndex("updatedAt", "updatedAt", { unique: false });
        }
      };
      req.onsuccess = (e) => {
        dseState.db = e.target.result;
        resolve(dseState.db);
      };
      req.onerror = () => resolve(null); // Graceful fallback
    });
  }

  async function saveSession(session) {
    try {
      const db = await openDB();
      if (!db) return;
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(session);
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    } catch (e) { /* Silent fail */ }
  }

  async function loadAllSessions() {
    try {
      const db = await openDB();
      if (!db) return [];
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      return new Promise((resolve) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    } catch (e) { return []; }
  }

  async function deleteSession(id) {
    try {
      const db = await openDB();
      if (!db) return;
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(id);
    } catch (e) { /* Silent fail */ }
  }

  async function enforceLRU() {
    const all = await loadAllSessions();
    if (all.length > MAX_SESSIONS) {
      all.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
      const toDelete = all.slice(0, all.length - MAX_SESSIONS);
      for (const s of toDelete) {
        await deleteSession(s.id);
      }
    }
  }

  // ═══════════════════════ FINGERPRINTING ═════════════════════
  function computeFingerprint(state) {
    const obj = {
      platform: state.platform,
      applications: state.applications?.map(a => ({ name: a.name, actors: a.actors?.length, channels: a.channels?.length })),
      wcets: state.wcets?.length,
      constraints: state.constraints,
      sysConstraints: state.sysConstraints,
      dse: state.dse,
    };
    return simpleHash(JSON.stringify(obj));
  }

  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return "fp_" + Math.abs(hash).toString(36);
  }

  // ═══════════════════════ SNAPSHOT & DIFF ════════════════════
  function safeClone(obj) {
    if (obj === undefined) return null;
    return JSON.parse(JSON.stringify(obj));
  }

  function takeSnapshot() {
    const state = window.paretoco?.state;
    if (!state) return null;
    return {
      timestamp: Date.now(),
      platform: safeClone(state.platform),
      applications: safeClone(state.applications),
      wcets: safeClone(state.wcets),
      constraints: safeClone(state.constraints),
      sysConstraints: safeClone(state.sysConstraints),
      dse: safeClone(state.dse),
      presolver: safeClone(state.presolver),
    };
  }

  function computeDiff(oldSnap, newSnap) {
    if (!oldSnap || !newSnap) return null;

    const changes = [];
    let type = null;
    let impact = "low";

    // Platform changes
    const oldPlatStr = JSON.stringify(oldSnap.platform);
    const newPlatStr = JSON.stringify(newSnap.platform);
    if (oldPlatStr !== newPlatStr) {
      type = "platform";
      impact = "high";
      // Detailed diff
      const oldProcs = oldSnap.platform?.processors || [];
      const newProcs = newSnap.platform?.processors || [];
      if (oldProcs.length !== newProcs.length) {
        changes.push({ field: "processor_count", old: oldProcs.length, new: newProcs.length, description: `Processor types: ${oldProcs.length} → ${newProcs.length}` });
      }
      oldProcs.forEach((op, i) => {
        const np = newProcs[i];
        if (!np) return;
        if (op.count !== np.count) {
          changes.push({ field: "processor_instances", old: op.count, new: np.count, description: `${op.model} count: ${op.count} → ${np.count}` });
        }
        if (op.modes && np.modes) {
          op.modes.forEach((om, mi) => {
            const nm = np.modes[mi];
            if (!nm) return;
            if (om.mem !== nm.mem) {
              changes.push({ field: "memory", old: om.mem, new: nm.mem, description: `${op.model} memory: ${om.mem} → ${nm.mem} KB` });
              if (impact === "low") impact = "medium";
            }
            if (om.dynPower !== nm.dynPower) {
              changes.push({ field: "dynPower", old: om.dynPower, new: nm.dynPower, description: `${op.model} dynPower: ${om.dynPower} → ${nm.dynPower} mW` });
            }
          });
        }
      });
    }

    // Constraint changes
    const oldConstStr = JSON.stringify(oldSnap.constraints);
    const newConstStr = JSON.stringify(newSnap.constraints);
    if (oldConstStr !== newConstStr) {
      if (!type) type = "constraint";
      if (impact === "low") impact = "medium";
      const oldConsts = oldSnap.constraints || [];
      const newConsts = newSnap.constraints || [];
      oldConsts.forEach((oc, i) => {
        const nc = newConsts[i];
        if (!nc) return;
        if (oc.period !== nc.period) {
          changes.push({ field: "period", old: oc.period, new: nc.period, description: `${oc.appName} period: ${oc.period} → ${nc.period}` });
        }
        if (oc.latency !== nc.latency) {
          changes.push({ field: "latency", old: oc.latency, new: nc.latency, description: `${oc.appName} latency: ${oc.latency} → ${nc.latency}` });
        }
      });
    }

    // System constraint changes
    const oldSysStr = JSON.stringify(oldSnap.sysConstraints);
    const newSysStr = JSON.stringify(newSnap.sysConstraints);
    if (oldSysStr !== newSysStr) {
      if (!type) type = "constraint";
      if (impact === "low") impact = "medium";
      for (const key of ["power", "area", "cost", "utilization", "procsUsed"]) {
        const ov = oldSnap.sysConstraints?.[key];
        const nv = newSnap.sysConstraints?.[key];
        if (ov !== nv) {
          changes.push({ field: key, old: ov, new: nv, description: `System ${key}: ${ov} → ${nv}` });
        }
      }
    }

    // Workload changes
    const oldAppsStr = JSON.stringify(oldSnap.applications);
    const newAppsStr = JSON.stringify(newSnap.applications);
    if (oldAppsStr !== newAppsStr) {
      if (!type) type = "workload";
      impact = "high";
      changes.push({ field: "applications", description: "Application graph structure changed" });
    }

    // WCET changes
    const oldWcetStr = JSON.stringify(oldSnap.wcets);
    const newWcetStr = JSON.stringify(newSnap.wcets);
    if (oldWcetStr !== newWcetStr) {
      if (!type) type = "workload";
      if (impact === "low") impact = "medium";
      changes.push({ field: "wcets", description: "WCET mappings changed" });
    }

    // DSE config changes
    const oldDseStr = JSON.stringify(oldSnap.dse);
    const newDseStr = JSON.stringify(newSnap.dse);
    if (oldDseStr !== newDseStr) {
      if (!type) type = "dse_config";
      changes.push({ field: "dse_config", description: "Search configuration changed" });
    }

    if (changes.length === 0) return null;

    return {
      type: type || "unknown",
      changes,
      impact,
      description: changes.map(c => c.description).join("; "),
    };
  }

  // ═══════════════════════ INVALIDATION ENGINE ═══════════════
  function computeInvalidation(diff, previousResults) {
    if (!diff || !previousResults || !previousResults.solutions) {
      return { validIndices: [], invalidatedIndices: [], allInvalid: true };
    }

    const solutions = previousResults.solutions;
    const valid = [];
    const invalidated = [];

    solutions.forEach((sol, idx) => {
      let isValid = true;

      // High impact (platform/workload structure change) → all invalid
      if (diff.impact === "high" && (diff.type === "platform" || diff.type === "workload")) {
        isValid = false;
      }

      // Medium impact — check specific changes
      if (diff.impact === "medium" || diff.impact === "low") {
        diff.changes.forEach(change => {
          // Memory change: invalidate solutions that were memory-bound
          if (change.field === "memory") {
            const oldMem = change.old || 0;
            const newMem = change.new || 0;
            if (newMem > oldMem) {
              // Relaxed constraint → previous solutions remain valid
              // but new solutions may now be feasible
            } else {
              // Tightened constraint → solutions using more than newMem are invalid
              isValid = false; // conservative
            }
          }

          // Power change
          if (change.field === "power" || change.field === "dynPower") {
            const solPower = parseFloat(sol["Power (mW)"] || sol.power) || 0;
            const newLimit = change.new || Infinity;
            if (solPower > newLimit) isValid = false;
          }

          // Period/latency constraint tightened
          if (change.field === "period" || change.field === "latency") {
            if (change.new < change.old) {
              // Tightened → check if solution satisfies
              const solPeriod = parseFloat(sol["Period"] || sol.period) || 0;
              const solLatency = parseFloat(sol["Latency"] || sol.latency) || 0;
              if (change.field === "period" && solPeriod > change.new) isValid = false;
              if (change.field === "latency" && solLatency > change.new) isValid = false;
            }
            // Relaxed → all previous solutions still valid
          }
        });
      }

      if (isValid) valid.push(idx);
      else invalidated.push(idx);
    });

    return {
      validIndices: valid,
      invalidatedIndices: invalidated,
      allInvalid: valid.length === 0,
    };
  }

  // ═══════════════════════ WARM-START PAYLOAD ═════════════════
  function generateWarmStartPayload(session) {
    if (!session || !session.runs || session.runs.length === 0) return null;

    const lastRun = session.runs[session.runs.length - 1];
    if (!lastRun.results || !lastRun.results.solutions) return null;

    // Collect all valid solutions from all runs
    const validSolutionsMap = new Map();
    session.runs.forEach(run => {
      if (run.results && run.results.solutions) {
        (run.validSolutions || []).forEach(idx => {
          const sol = run.results.solutions[idx];
          if (sol) {
            // Deduplicate by stringified representation to prevent duplicates across runs
            validSolutionsMap.set(JSON.stringify(sol), sol);
          }
        });
      }
    });
    
    const validSolutions = Array.from(validSolutionsMap.values());

    // Compute tight bounds from existing Pareto front
    const bounds = {};
    const paretoSols = lastRun.results.paretoFront?.map(i => lastRun.results.solutions[i]).filter(Boolean) || [];
    if (paretoSols.length > 0) {
      ["period", "power", "area", "cost", "utilization"].forEach(key => {
        const vals = paretoSols.map(s => parseFloat(s[key] || s[key.charAt(0).toUpperCase() + key.slice(1)] || 0)).filter(v => v > 0);
        if (vals.length > 0) {
          bounds[key] = { min: Math.min(...vals), max: Math.max(...vals) };
        }
      });
    }

    return {
      previousSolutions: validSolutions.slice(0, 50), // Cap at 50 seed points
      bounds,
      previousParetoSize: paretoSols.length,
      runCount: session.runs.length,
    };
  }

  // ═══════════════════════ SESSION MANAGEMENT ═════════════════
  function createSession(name) {
    const state = window.paretoco?.state;
    const session = {
      id: "sess_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
      name: name || "Session " + (dseState.sessions.length + 1),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runs: [],
      fingerprint: state ? computeFingerprint(state) : "",
    };
    dseState.currentSession = session;
    dseState.lastSnapshot = takeSnapshot();
    return session;
  }

  function recordRun() {
    const state = window.paretoco?.state;
    if (!state || !state.results) return null;

    if (!dseState.currentSession) {
      createSession();
    }

    const currentSnapshot = takeSnapshot();
    const diff = computeDiff(dseState.lastSnapshot, currentSnapshot);

    // Compute invalidation against previous run
    let invalidation = null;
    const prevRun = dseState.currentSession.runs[dseState.currentSession.runs.length - 1];
    if (prevRun && diff) {
      invalidation = computeInvalidation(diff, prevRun.results);
    }

    // Parse current results
    const solutions = state.results.rows || [];
    const allIndices = solutions.map((_, i) => i);

    const run = {
      id: "run_" + Date.now().toString(36),
      timestamp: Date.now(),
      paramSnapshot: currentSnapshot,
      diff,
      results: {
        solutions,
        paretoFront: [], // Will compute from ParetoFrontier if available
        summary: state.results.summary || {},
      },
      warmStartPayload: generateWarmStartPayload(dseState.currentSession),
      status: "complete",
      validSolutions: allIndices,
      invalidatedSolutions: invalidation ? invalidation.invalidatedIndices : [],
      newSolutions: prevRun ? allIndices : [], // All are "new" for first run
    };

    // If we have the Pareto module, use its front
    if (window.ParetoFrontier) {
      const pf = window.ParetoFrontier.getFrontier();
      if (pf && pf.paretoFront) {
        run.results.paretoFront = [...pf.paretoFront];
      }
    }

    // Determine which solutions are truly new vs carried over
    if (prevRun && prevRun.results.solutions.length > 0) {
      const prevSolSet = new Set(prevRun.results.solutions.map(s => JSON.stringify(s)));
      run.newSolutions = allIndices.filter(i => !prevSolSet.has(JSON.stringify(solutions[i])));
    }

    dseState.currentSession.runs.push(run);
    dseState.currentSession.updatedAt = Date.now();
    dseState.lastSnapshot = currentSnapshot;

    // Persist
    saveSession(dseState.currentSession);
    enforceLRU();

    return run;
  }

  // ═══════════════════════ RENDERING: TIMELINE ═══════════════
  function renderTimeline() {
    const el = document.getElementById("dse-timeline");
    if (!el) return;

    if (!dseState.currentSession || dseState.currentSession.runs.length === 0) {
      el.innerHTML = `<div class="inspector-empty"><p>No DSE runs in this session yet. Run DSE to start building a timeline.</p></div>`;
      return;
    }

    const runs = dseState.currentSession.runs;
    let html = `<div class="timeline-header">
      <h3>📅 Session: ${dseState.currentSession.name}</h3>
      <span class="timeline-count">${runs.length} run(s)</span>
    </div>
    <div class="timeline-strip">`;

    runs.forEach((run, idx) => {
      const time = new Date(run.timestamp).toLocaleTimeString();
      const solCount = run.results?.solutions?.length || 0;
      const pfCount = run.results?.paretoFront?.length || 0;
      const newCount = run.newSolutions?.length || 0;
      const invalidCount = run.invalidatedSolutions?.length || 0;
      const impactClass = run.diff ? `impact-${run.diff.impact}` : "impact-none";

      html += `
        <div class="timeline-node ${impactClass}" data-run-idx="${idx}">
          <div class="timeline-marker">
            <div class="timeline-dot"></div>
            ${idx < runs.length - 1 ? '<div class="timeline-line"></div>' : ''}
          </div>
          <div class="timeline-card">
            <div class="timeline-card-header">
              <span class="timeline-run-label">Run #${idx + 1}</span>
              <span class="timeline-time">${time}</span>
            </div>
            <div class="timeline-card-body">
              <div class="timeline-stat">
                <span class="timeline-stat-value">${solCount}</span>
                <span class="timeline-stat-label">solutions</span>
              </div>
              <div class="timeline-stat">
                <span class="timeline-stat-value">${pfCount}</span>
                <span class="timeline-stat-label">Pareto</span>
              </div>
              ${newCount > 0 ? `<div class="timeline-stat new">
                <span class="timeline-stat-value">+${newCount}</span>
                <span class="timeline-stat-label">new</span>
              </div>` : ""}
              ${invalidCount > 0 ? `<div class="timeline-stat invalid">
                <span class="timeline-stat-value">-${invalidCount}</span>
                <span class="timeline-stat-label">invalidated</span>
              </div>` : ""}
            </div>
            ${run.diff ? `<div class="timeline-diff">
              <span class="diff-badge ${impactClass}">${run.diff.impact.toUpperCase()}</span>
              <span class="diff-desc">${run.diff.description.slice(0, 80)}${run.diff.description.length > 80 ? "…" : ""}</span>
            </div>` : ""}
          </div>
        </div>
      `;
    });

    html += `</div>`;
    el.innerHTML = html;

    // Wire click events
    el.querySelectorAll(".timeline-node").forEach(node => {
      node.addEventListener("click", () => {
        const idx = parseInt(node.dataset.runIdx);
        renderDeltaVisualizer(idx);
      });
    });
  }

  // ═══════════════════════ RENDERING: DELTA VISUALIZER ═══════
  function renderDeltaVisualizer(runIdx) {
    const el = document.getElementById("dse-delta");
    if (!el || !dseState.currentSession) return;

    const runs = dseState.currentSession.runs;
    if (runIdx >= runs.length) return;

    const run = runs[runIdx];
    const prevRun = runIdx > 0 ? runs[runIdx - 1] : null;

    let html = `<div class="delta-header">
      <h3>🔄 Run #${runIdx + 1} Delta Analysis</h3>
    </div>`;

    // Parameter changes
    if (run.diff) {
      html += `<div class="delta-section">
        <h4>Parameter Changes</h4>
        <div class="delta-changes">
          ${run.diff.changes.map(c => `
            <div class="delta-change">
              <span class="delta-icon">${c.old !== undefined ? "📝" : "➕"}</span>
              <span class="delta-desc">${c.description}</span>
            </div>
          `).join("")}
        </div>
      </div>`;
    } else if (runIdx === 0) {
      html += `<div class="delta-section"><p class="delta-first-run">Initial run — no previous parameters to compare</p></div>`;
    }

    // Solution delta visualization
    const solCount = run.results?.solutions?.length || 0;
    const newCount = run.newSolutions?.length || 0;
    const invalidCount = run.invalidatedSolutions?.length || 0;
    const validCount = run.validSolutions?.length || 0;
    const total = solCount + invalidCount;

    if (total > 0) {
      html += `<div class="delta-section">
        <h4>Solution Changes</h4>
        <div class="delta-bar-container">
          <div class="delta-bar">
            ${validCount > 0 ? `<div class="delta-bar-segment valid" style="width:${(validCount/total)*100}%" title="${validCount} unchanged"></div>` : ""}
            ${newCount > 0 ? `<div class="delta-bar-segment new" style="width:${(newCount/total)*100}%" title="${newCount} new"></div>` : ""}
            ${invalidCount > 0 ? `<div class="delta-bar-segment invalid" style="width:${(invalidCount/total)*100}%" title="${invalidCount} invalidated"></div>` : ""}
          </div>
          <div class="delta-bar-legend">
            ${validCount > 0 ? `<span class="delta-legend-item"><span class="delta-legend-dot valid"></span> ${validCount} unchanged</span>` : ""}
            ${newCount > 0 ? `<span class="delta-legend-item"><span class="delta-legend-dot new"></span> ${newCount} new</span>` : ""}
            ${invalidCount > 0 ? `<span class="delta-legend-item"><span class="delta-legend-dot invalid"></span> ${invalidCount} invalidated</span>` : ""}
          </div>
        </div>
      </div>`;
    }

    // Warm-start info
    if (run.warmStartPayload) {
      const ws = run.warmStartPayload;
      html += `<div class="delta-section">
        <h4>🔥 Warm-Start Payload</h4>
        <div class="delta-warmstart">
          <div class="ws-stat"><span class="ws-label">Seed solutions</span><span class="ws-value">${ws.previousSolutions?.length || 0}</span></div>
          <div class="ws-stat"><span class="ws-label">Previous Pareto size</span><span class="ws-value">${ws.previousParetoSize || 0}</span></div>
          <div class="ws-stat"><span class="ws-label">Run history</span><span class="ws-value">${ws.runCount || 0} runs</span></div>
        </div>
      </div>`;
    }

    // Pareto front evolution (comparing current vs previous)
    if (prevRun && prevRun.results?.paretoFront && run.results?.paretoFront) {
      const prevPF = prevRun.results.paretoFront.length;
      const currPF = run.results.paretoFront.length;
      const pfDelta = currPF - prevPF;
      const pfChange = prevPF > 0 ? ((pfDelta / prevPF) * 100).toFixed(1) : "—";
      html += `<div class="delta-section">
        <h4>📈 Pareto Front Evolution</h4>
        <div class="delta-pf-evolution">
          <div class="pf-evo-item">
            <span class="pf-evo-label">Previous front</span>
            <span class="pf-evo-value">${prevPF} solutions</span>
          </div>
          <div class="pf-evo-arrow">→</div>
          <div class="pf-evo-item">
            <span class="pf-evo-label">Current front</span>
            <span class="pf-evo-value">${currPF} solutions</span>
          </div>
          <div class="pf-evo-delta ${pfDelta >= 0 ? 'positive' : 'negative'}">
            ${pfDelta >= 0 ? "+" : ""}${pfDelta} (${pfChange}%)
          </div>
        </div>
      </div>`;
    }

    el.innerHTML = html;
  }

  // ═══════════════════════ RENDERING: SESSION LIST ════════════
  function renderSessionList() {
    const el = document.getElementById("dse-sessions");
    if (!el) return;

    let html = `<div class="session-list-header">
      <h3>💾 Saved Sessions</h3>
      <button class="btn btn-sm btn-primary" id="btn-new-session">+ New Session</button>
    </div>
    <div class="session-list">`;

    if (dseState.sessions.length === 0) {
      html += `<div class="inspector-empty"><p>No saved sessions. Run DSE to create one automatically.</p></div>`;
    } else {
      dseState.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      dseState.sessions.forEach(session => {
        const isActive = dseState.currentSession && dseState.currentSession.id === session.id;
        const date = new Date(session.updatedAt || session.createdAt).toLocaleString();
        const runCount = session.runs?.length || 0;
        html += `
          <div class="session-item ${isActive ? "active" : ""}" data-session-id="${session.id}">
            <div class="session-item-header">
              <span class="session-name">${session.name}</span>
              ${isActive ? '<span class="badge green">Active</span>' : ''}
            </div>
            <div class="session-item-meta">
              <span>${runCount} run(s)</span>
              <span>${date}</span>
            </div>
            <div class="session-item-actions">
              <button class="btn btn-xs btn-outline session-load" data-id="${session.id}">Load</button>
              <button class="btn btn-xs btn-danger session-delete" data-id="${session.id}">Delete</button>
            </div>
          </div>
        `;
      });
    }

    html += `</div>`;
    el.innerHTML = html;

    // Wire events
    document.getElementById("btn-new-session")?.addEventListener("click", () => {
      const name = prompt("Session name:", "Session " + (dseState.sessions.length + 1));
      if (name) {
        const session = createSession(name);
        dseState.sessions.push(session);
        saveSession(session);
        renderSessionList();
        renderTimeline();
        if (window.paretoco) window.paretoco.toast("New session created: " + name, "success");
      }
    });

    el.querySelectorAll(".session-load").forEach(btn => {
      btn.addEventListener("click", async () => {
        const session = dseState.sessions.find(s => s.id === btn.dataset.id);
        if (session) {
          dseState.currentSession = session;
          dseState.lastSnapshot = takeSnapshot();
          renderSessionList();
          renderTimeline();
          if (session.runs.length > 0) {
            renderDeltaVisualizer(session.runs.length - 1);
          }
          if (window.paretoco) window.paretoco.toast("Session loaded: " + session.name, "success");
        }
      });
    });

    el.querySelectorAll(".session-delete").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (confirm("Delete this session?")) {
          await deleteSession(btn.dataset.id);
          dseState.sessions = dseState.sessions.filter(s => s.id !== btn.dataset.id);
          if (dseState.currentSession?.id === btn.dataset.id) {
            dseState.currentSession = null;
          }
          renderSessionList();
          renderTimeline();
        }
      });
    });
  }

  // ═══════════════════════ RENDERING: STATUS BANNER ═══════════
  function renderStatusBanner() {
    const el = document.getElementById("dse-status-banner");
    if (!el) return;

    if (!dseState.currentSession) {
      el.innerHTML = `<div class="dse-banner idle">
        <span class="banner-icon">💤</span>
        <span>No active session. DSE results will create a new session automatically.</span>
      </div>`;
      return;
    }

    const session = dseState.currentSession;
    const runCount = session.runs.length;
    const currentSnapshot = takeSnapshot();
    const diff = computeDiff(dseState.lastSnapshot, currentSnapshot);

    if (diff) {
      const icon = diff.impact === "high" ? "🔴" : (diff.impact === "medium" ? "🟡" : "🟢");
      el.innerHTML = `<div class="dse-banner changed">
        <span class="banner-icon">${icon}</span>
        <div class="banner-content">
          <strong>Parameters changed since last run</strong>
          <span class="banner-detail">${diff.description}</span>
          <span class="banner-impact">Impact: ${diff.impact} — ${diff.impact === "high" ? "Full re-exploration needed" : (diff.impact === "medium" ? "Partial invalidation" : "Minimal impact, warm-start effective")}</span>
        </div>
      </div>`;
    } else {
      el.innerHTML = `<div class="dse-banner ready">
        <span class="banner-icon">✅</span>
        <span>Session active: ${session.name} · ${runCount} run(s) · Parameters unchanged</span>
      </div>`;
    }
  }

  // ═══════════════════════ CHANGE WATCHER ════════════════════
  let watchInterval = null;

  function startWatching() {
    if (watchInterval) return;
    watchInterval = setInterval(() => {
      renderStatusBanner();
    }, 3000);
  }

  function stopWatching() {
    if (watchInterval) {
      clearInterval(watchInterval);
      watchInterval = null;
    }
  }

  // ═══════════════════════ INITIALIZATION ═════════════════════
  async function init() {
    // Load sessions from IndexedDB
    dseState.sessions = await loadAllSessions();

    // Auto-create session if none exists
    if (dseState.sessions.length === 0) {
      createSession("Default Session");
      dseState.sessions.push(dseState.currentSession);
      await saveSession(dseState.currentSession);
    } else {
      // Load most recent session
      dseState.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      dseState.currentSession = dseState.sessions[0];
    }

    dseState.lastSnapshot = takeSnapshot();
    dseState.initialized = true;

    renderSessionList();
    renderTimeline();
    renderStatusBanner();
    if (dseState.currentSession && dseState.currentSession.runs.length > 0) {
      renderDeltaVisualizer(dseState.currentSession.runs.length - 1);
    }

    startWatching();
  }

  // ═══════════════════════ PUBLIC API ══════════════════════════
  window.IncrementalDSE = {
    init,
    recordRun,
    createSession,
    getState: () => dseState,
    getCurrentSession: () => dseState.currentSession,
    getWarmStartPayload: () => generateWarmStartPayload(dseState.currentSession),
    refresh: () => {
      renderTimeline();
      renderStatusBanner();
      renderSessionList();
    },
    destroy: () => {
      stopWatching();
    },
  };

})();
