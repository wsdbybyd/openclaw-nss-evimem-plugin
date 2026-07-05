# CBSC-V2-HARD-SIMON32-DL-SEARCH-002 Experiment

This experiment compares a no-plugin baseline answer with the NSS-EviMem plugin-backed case run.

The experiment answers one narrow question: does the plugin improve trustworthiness, evidence traceability, and claim discipline for this benchmark task?

## Commands

Run the experiment:

```powershell
npm run experiment:cbsc-simon32-dl
```

Verify the generated experiment bundle:

```powershell
npm run experiment:cbsc-simon32-dl:verify
```

Run both:

```powershell
npm run experiment:cbsc-simon32-dl:all
```

Run a real local OpenClaw baseline-vs-plugin experiment:

```powershell
npm run experiment:cbsc-simon32-dl:openclaw-real:all
```

## Local Artifacts

The controlled experiment is written to `runs/latest/`. The real OpenClaw experiment is written to `runs/openclaw-real-latest/`. These directories are ignored by Git because they contain local evaluation artifacts, model outputs, logs, and oracle-derived labels.
