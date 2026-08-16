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

