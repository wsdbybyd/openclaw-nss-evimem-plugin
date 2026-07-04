# CBSC-V2-HARD-SIMON32-DL-SEARCH-002 OpenClaw NSS-EviMem Case

This folder stores a minimal OpenClaw-style NSS-EviMem integration case for the Simon32/64 14-round differential-linear benchmark.

The case is intended to validate plugin evidence capture, task-contract validation, tool-capability registration, and artifact provenance. It is not a full cryptanalytic solver.

## Commands

Run the plugin-backed case harness:

```powershell
npm run case:cbsc-simon32-dl
```

Run the external evaluator. This evaluator is allowed to read the benchmark's hidden `oracle.json`; the tested Agent/tool flow is not.

```powershell
npm run case:cbsc-simon32-dl:evaluate
```

Verify that the case folder contains the expected inputs, artifacts, evidence, and evaluation outputs:

```powershell
npm run case:cbsc-simon32-dl:verify
```

## Output

The local case runner generates `inputs/` and writes the latest run to `outputs/latest/`. These directories are intentionally ignored by Git because they are benchmark/run artifacts rather than plugin source.

- `artifacts/`: sampled search output, final report, and run log.
- `evidence/`: NSS-EviMem tool calls, evidence index, contract, guard, capability, and memory files.
- `case_report.md`: case-level evidence summary.
- `case_evaluation.json`: machine-readable external evaluation.
- `evaluation_report.md`: human-readable external evaluation.
