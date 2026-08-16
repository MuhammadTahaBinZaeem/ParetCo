#!/usr/bin/env python3
"""Portable 30-run regression harness for the packaged ParetoCo native engine.

Windows: launches paretoco-engine.exe directly.
Linux/Render-style hosts: launches the same .exe through Wine.

Examples:
  python tests/run_30_tests.py
  python tests/run_30_tests.py 1,2,3
  python tests/run_30_tests.py --engine C:\\path\\paretoco-engine.exe
  PARETOCO_WINE=wine python tests/run_30_tests.py
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_ENGINE = ROOT_DIR / "paretoco-engine-release" / "paretoco-engine.exe"
EXPECTED_JSON = ROOT_DIR / "tests" / "expected_30.json"
RESULT_JSON = ROOT_DIR / "tests" / "run_30_results.json"


def find_wine(explicit: str | None = None) -> str | None:
    candidates = [explicit, os.environ.get("PARETOCO_WINE"), "wine64", "wine"]
    for candidate in candidates:
        if not candidate:
            continue
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
        p = Path(candidate)
        if p.is_file():
            return str(p.resolve())
    return None


def build_command(engine: Path, config_name: str, wine: str | None) -> tuple[list[str], str]:
    if os.name == "nt":
        return [str(engine), "--config", config_name], "native-windows"

    wine_bin = find_wine(wine)
    if not wine_bin:
        raise RuntimeError(
            "Wine was not found. Install Wine (wine64/wine) or set PARETOCO_WINE. "
            "The regression suite intentionally executes the packaged Windows .exe."
        )
    return [wine_bin, str(engine), "--config", config_name], f"wine:{Path(wine_bin).name}"


def count_solutions(text: str) -> int:
    matches = re.findall(r"(\d+)\s+solutions?", text, re.IGNORECASE)
    return int(matches[-1]) if matches else 0


def parse_selection(raw: str | None) -> set[int] | None:
    if not raw:
        return None
    selected: set[int] = set()
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        value = int(part)
        if value < 1 or value > 30:
            raise ValueError(f"Run number out of range: {value} (expected 1-30)")
        selected.add(value)
    return selected


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the ParetoCo packaged native engine against 30 regression fixtures.")
    parser.add_argument("runs", nargs="?", help="Optional comma-separated run IDs, e.g. 1,2,10")
    parser.add_argument("--engine", default=os.environ.get("PARETOCO_ENGINE"), help="Override paretoco-engine.exe path")
    parser.add_argument("--wine", default=None, help="Override Wine executable on non-Windows hosts")
    parser.add_argument("--timeout", type=int, default=None, help="Per-run timeout in seconds")
    parser.add_argument("--no-report", action="store_true", help="Do not write tests/run_30_results.json")
    args = parser.parse_args()

    expected_doc = json.loads(EXPECTED_JSON.read_text(encoding="utf-8"))
    timeout_seconds = args.timeout or int(os.environ.get("PARETOCO_TEST_TIMEOUT", expected_doc.get("timeout_seconds", 30)))
    selected = parse_selection(args.runs)

    engine = Path(args.engine).expanduser().resolve() if args.engine else DEFAULT_ENGINE.resolve()
    if not engine.is_file():
        print(f"ERROR: packaged engine not found: {engine}", file=sys.stderr)
        return 2

    # The DLLs live beside the executable. Windows searches this directory for dependent DLLs;
    # Wine does the same for the Windows module being launched.
    env = os.environ.copy()
    env["PATH"] = str(engine.parent) + os.pathsep + env.get("PATH", "")
    if os.name != "nt":
        env.setdefault("WINEDEBUG", "-all")
        env.setdefault("WINEARCH", "win64")
        env.setdefault("WINEPREFIX", str(ROOT_DIR / ".wine-prefix"))

    run_specs = [r for r in expected_doc["runs"] if selected is None or r["run"] in selected]
    if not run_specs:
        print("No runs selected.", file=sys.stderr)
        return 2

    # Resolve the execution mode once before the suite starts.
    try:
        probe_cmd, mode = build_command(engine, "config.cfg", args.wine)
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    print(f"ParetoCo native regression suite: {len(run_specs)} run(s)")
    print(f"Engine: {engine}")
    print(f"Execution mode: {mode}")
    print(f"Timeout: {timeout_seconds}s per run\n")

    results: list[dict] = []
    suite_start = time.time()

    for spec in run_specs:
        run_id = int(spec["run"])
        cfg = (ROOT_DIR / spec["fixture"]).resolve()
        if not cfg.is_file():
            result = {
                "run": run_id,
                "pass": False,
                "error": f"Missing fixture: {cfg}",
            }
            results.append(result)
            print(f"Run {run_id:02d}/30: FAIL -> missing fixture")
            continue

        # Run from the fixture directory and pass only config.cfg. This keeps all relative
        # SDF/platform paths valid for both native Windows and Wine execution.
        command, _ = build_command(engine, cfg.name, args.wine)
        started = time.time()
        timed_out = False
        stdout = ""
        stderr = ""
        return_code = -1

        try:
            proc = subprocess.run(
                command,
                cwd=str(cfg.parent),
                env=env,
                capture_output=True,
                text=True,
                errors="replace",
                timeout=timeout_seconds,
            )
            stdout = proc.stdout or ""
            stderr = proc.stderr or ""
            return_code = proc.returncode
        except subprocess.TimeoutExpired as exc:
            timed_out = True
            stdout = (exc.stdout.decode(errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or ""))
            stderr = (exc.stderr.decode(errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or ""))
            return_code = 124
        except Exception as exc:  # pragma: no cover - environment/launcher failures
            stderr = f"{type(exc).__name__}: {exc}"
            return_code = -1

        elapsed = time.time() - started
        solutions = count_solutions(stdout + "\n" + stderr)
        expected_solutions = int(spec["expected_solutions"])
        expected_exit = int(spec["expected_exit_code"])
        timeout_allowed = bool(spec.get("timeout_allowed", False))

        if timeout_allowed:
            # Historical baseline timed out. A current timeout still matches; a clean completion
            # also passes if it produces the same solution count, allowing performance improvements.
            passed = timed_out or (return_code == 0 and solutions == expected_solutions)
        else:
            passed = (not timed_out and return_code == expected_exit and solutions == expected_solutions)

        result = {
            "run": run_id,
            "pass": passed,
            "timed_out": timed_out,
            "return_code": return_code,
            "solutions": solutions,
            "expected_exit_code": expected_exit,
            "expected_solutions": expected_solutions,
            "timeout_allowed": timeout_allowed,
            "seconds": round(elapsed, 3),
            "fixture": str(cfg.relative_to(ROOT_DIR)),
            "stderr_tail": stderr[-1000:],
        }
        results.append(result)

        status = "PASS" if passed else "FAIL"
        timeout_note = " timeout" if timed_out else ""
        print(
            f"Run {run_id:02d}/30: {status}{timeout_note} -> "
            f"exit {return_code}, solutions {solutions} "
            f"(expected exit {expected_exit}, solutions {expected_solutions}) [{elapsed:.2f}s]"
        )

    elapsed_total = time.time() - suite_start
    passed_count = sum(1 for r in results if r.get("pass"))
    report = {
        "suite": expected_doc.get("suite"),
        "engine": str(engine),
        "execution_mode": mode,
        "timeout_seconds": timeout_seconds,
        "selected_runs": [r["run"] for r in results],
        "passed": passed_count,
        "total": len(results),
        "pass_rate_percent": round((passed_count / len(results)) * 100, 2),
        "elapsed_seconds": round(elapsed_total, 3),
        "results": results,
    }

    if not args.no_report:
        RESULT_JSON.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(f"\nReport: {RESULT_JSON.relative_to(ROOT_DIR)}")

    print(f"Result: {passed_count}/{len(results)} PASS ({report['pass_rate_percent']:.1f}%) in {elapsed_total:.2f}s")
    return 0 if passed_count == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
