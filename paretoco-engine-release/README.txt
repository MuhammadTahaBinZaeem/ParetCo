ParetoCo Native Design Space Exploration Engine
================================================

This directory is the packaged native solver runtime used by ParetoCo.

Primary binary:
  paretoco-engine.exe

Execution:
  Windows: paretoco-engine.exe --config <config.cfg>
  Linux/Render: wine paretoco-engine.exe --config <config.cfg>

Keep the DLL files in this directory beside the executable. They provide the
Gecode, Boost, libxml2, iconv and zlib runtime dependencies used by the engine.
Windows also requires the Microsoft Visual C++ runtime (normally supplied by
the Visual C++ 2015-2022 Redistributable). Wine supplies compatible runtime
implementations for the Render/Linux deployment path.

Regression:
  The repository contains a portable 30-run native regression suite at:
    tests/run_30_tests.py

  It launches this exact executable directly on Windows and through Wine on
  Linux, using tests/expected_30.json and the retained run_0..run_29 fixtures.
