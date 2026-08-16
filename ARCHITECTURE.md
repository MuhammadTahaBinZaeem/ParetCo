# ParetoCo Architecture

ParetoCo uses one native solver bridge for both normal DSE requests and AI-agent verification.

```text
Browser UI
   │
   ├── POST /api/launch ──────────────┐
   │                                  │
   ├── NL → DSE (Featherless)         │
   │                                  ▼
   ├── Auto-Optimize ── proposals ── engineBridge.runDseJob()
   │                                  │
   └── UNSAT Doctor ─ repair tests ───┤
                                      │
                                      ▼
                              structured validation
                                      │
                                      ▼
                         XML/config serializers
                                      │
                                      ▼
                           isolated temp workspace
                                      │
                                      ▼
                  paretoco-engine.exe (Wine on Linux)
                                      │
                                      ▼
                         native out.txt / out.csv
```

## Server modules

- `server.js` — small HTTP entrypoint and route dispatch only.
- `server/engine_bridge.js` — discovers Wine/native executable, builds an isolated job workspace, invokes the native solver, handles timeouts/errors, and cleans temporary files.
- `server/serializers.js` — converts structured platform/application/WCET/constraint/DSE objects into the native XML and `config.cfg` formats.
- `server/validation.js` — validates model references and supported native configuration before execution.
- `server/ai_routes.js` — Featherless HTTP endpoints. Agents propose or analyze; they do not manufacture solver results.
- `server/http_utils.js` — bounded request parsing and consistent JSON/error responses.
- `server/static_files.js` — safe dashboard/static asset serving.
- `server/presets.js` — built-in runnable examples.
- `server/analytical_engine.js` — explicitly approximate fallback used only when native execution is optional. Render sets `PARETOCO_REQUIRE_NATIVE=true`, so hosted verification cannot silently fall back to it.

## Native verification rule

A feature may call something **feasible**, **verified**, or **optimized** only after `engineBridge.runDseJob()` returns a real native solver result.

- **Auto-Optimize:** Featherless proposes compatible candidates; each candidate is run through the native solver. Only a feasible candidate that improves the requested objective can be selected.
- **UNSAT Doctor:** candidate constraint repairs are applied to cloned jobs and executed by the native solver. Only successful native runs are shown as verified repairs.
- **Normal Launch DSE:** errors remain errors. The UI does not replace a failed native run with fabricated browser solutions.

## Startup

Production startup is deliberately simple:

```text
Docker/Wine environment initialization
        ↓
node server.js
```

There is **no runtime source rewriting** and **no `child_process.spawn` monkey-patching**. The Docker image runs `npm run check` during build so JavaScript syntax failures stop the build instead of appearing after deployment.

## Advanced algorithm naming

The JavaScript advanced-algorithm suite includes a continuous canonical **Simplex LP solver**. It does not claim Gomory-cut or complete mixed-integer branch-and-bound support. Integer DSE decisions are handled by the packaged native constraint solver.
