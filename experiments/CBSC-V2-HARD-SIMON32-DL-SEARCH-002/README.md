# CBSC-V2-HARD-SIMON32-DL-SEARCH-002 Experiment

This directory contains the NSS-EviMem evaluation harness for one OpenClaw benchmark case: a 14-round Simon32/64 differential-linear search task.

The experiment answers a narrow research question: when the original agent produces a partial or unreliable cryptanalytic answer, does the NSS-EviMem plugin make the failure easier to diagnose, replay, and turn into training data?

## Direction A Scope

Direction A is a dataset-building step, not a new OpenClaw rerun.

It consumes an existing local real-agent run from `runs/openclaw-real-rerun-latest/` and converts the observed baseline, plugin pass1, and plugin rerun trajectories into the failure-case dataset format required by the experiment design.

The goal is to align this single case with the failure-case experiment design:

- split the full run into trajectory-level and episode-level records;
- label failure types and recovery sources;
- compare hook/no-hook counterfactual groups;
- produce distillation samples from failure and repair episodes;
- keep the final correctness boundary explicit.

## Experiment Arms

The local real OpenClaw rerun experiment provides three trajectories:

| Trajectory | Dataset group | Meaning |
|---|---|---|
| `traj_baseline_no_hook` | `h1_no_hook_replay` | Raw OpenClaw agent without NSS-EviMem evidence hooks. |
| `traj_plugin_pass1` | `h2_evidence_only_hook` | Agent with evidence capture, task contract validation, tool capability registry, guard events, and failure diagnosis. |
| `traj_plugin_pass2_rerun` | `h3_full_htsg_hook` | Agent rerun with NSS-EviMem rerun context built from pass1 failure evidence. |

These groups correspond to the H-group counterfactual hook experiment in the design document. They do not prove that the plugin fully solves the cryptanalytic task; they show what the hook changes in observability, diagnosis, and recovery behavior.

## Direction A Inputs

The dataset builder expects a completed real rerun bundle:

```text
runs/openclaw-real-rerun-latest/
  baseline/
  plugin_pass1/
  plugin_rerun/
  experiment_summary.json
```

Important source artifacts include:

- `baseline/evaluation.json`
- `plugin_pass1/evaluation.json`
- `plugin_pass1/evidence_seed_used_for_rerun/failure_diagnosis.json`
- `plugin_rerun/evaluation.json`
- `plugin_rerun/evidence/failure_diagnosis.json`
- `plugin_rerun/evidence/task_contract.json`
- `plugin_rerun/evidence/tool_capabilities.json`
- `plugin_rerun/evidence/rerun_context.md`

To build from another local run directory, set `NSS_EVIMEM_FAILURE_CASE_SOURCE_DIR` before running the builder.

## Direction A Outputs

Run:

```powershell
npm run dataset:cbsc-simon32-dl:all
```

The output is written to:

```text
runs/failure-case-dataset-latest/
```

Generated files:

| File | Purpose |
|---|---|
| `failure_case_dataset.jsonl` | One case-level record with task, trajectories, labels, task contract, and tool registry snapshot. |
| `episode_labels.jsonl` | Episode-level failure, recovery, correctness, and evidence labels. |
| `counterfactual_hook_results.jsonl` | H-group hook/no-hook comparison records. |
| `distillation_samples.jsonl` | Failure detection, repair action, tool selection, evidence grounding, and contract generation samples. |
| `case_reports/CBSC-V2-HARD-SIMON32-DL-SEARCH-002.md` | Human-readable case report. |
| `evaluation_rubric.md` | Five-level correctness rubric used by this case. |
| `dataset_summary.json` | Machine-readable generation summary and counts. |

The verifier checks that the generated bundle contains:

- 1 case record;
- at least 3 trajectories;
- at least 5 episodes;
- failure types `search_timeout`, `candidate_statistical_noise`, and `tool_contract_mismatch`;
- recovery sources `hook_guided_recovery` and `tool_feedback_recovery`;
- H groups `h1_no_hook_replay`, `h2_evidence_only_hook`, and `h3_full_htsg_hook`;
- all 5 distillation sample types expected by the design.

## Commands

Run the controlled synthetic experiment:

```powershell
npm run experiment:cbsc-simon32-dl
```

Verify the controlled experiment bundle:

```powershell
npm run experiment:cbsc-simon32-dl:verify
```

Run both controlled steps:

```powershell
npm run experiment:cbsc-simon32-dl:all
```

Run a real local OpenClaw baseline-vs-plugin experiment:

```powershell
npm run experiment:cbsc-simon32-dl:openclaw-real:all
```

Run a real local OpenClaw pass2 rerun experiment seeded from `runs/openclaw-real-latest/`:

```powershell
npm run experiment:cbsc-simon32-dl:openclaw-rerun:all
```

Build and verify the Direction A failure-case dataset:

```powershell
npm run dataset:cbsc-simon32-dl:all
```

## Relation To The Failure-Case Design

The design document requires each case to preserve the full trajectory, split it into episodes, label failure and recovery, and produce outputs such as `failure_case_dataset.jsonl`, `episode_labels.jsonl`, `counterfactual_hook_results.jsonl`, and `distillation_samples.jsonl`.

This implementation maps the current case as follows:

| Design concept | This implementation |
|---|---|
| Trajectory | Baseline, plugin pass1, and plugin rerun arms. |
| Episode | Six labeled segments covering uninstrumented search, timeout boundary, contract guard, noise diagnosis, rerun context use, and rerun noise classification. |
| Failure type | `unsupported_claim`, `unverified_success`, `search_timeout`, `tool_contract_mismatch`, `candidate_statistical_noise`, `evidence_mismatch`, and `stale_context`. |
| Recovery source | `self_react_recovery`, `tool_feedback_recovery`, and `hook_guided_recovery`. |
| H-group counterfactual | No hook vs evidence/diagnosis hook vs full rerun-context hook. |
| Distillation data | Five sample types derived from the labeled failure and recovery episodes. |
| Correctness label | The final local result remains `partially_correct`, not `verified_correct`. |

## Current Interpretation

In this case, the plugin does not turn the benchmark into a verified cryptanalytic success. The strongest observed candidate is treated as statistical noise after multi-key verification, and the final answer still lacks oracle/reference alignment.

The plugin does improve the evaluation surface:

- the raw baseline has no structured NSS-EviMem evidence;
- pass1 records a task contract, tool capability registry, tool calls, guard events, failure diagnosis, and rerun plan;
- pass2 uses rerun context to preserve the previous failure boundary and avoid overclaiming;
- the final result can be audited as a bounded partial result instead of an unsupported success claim.

So the current conclusion is about trustworthiness and recovery traceability, not final cryptanalytic correctness.

## Limitations

- This is a single-case dataset view, not a multi-case benchmark.
- Direction A is post-hoc dataset construction from existing artifacts; online intervention is handled separately by the plugin-level `nss_evimem_build_intervention` tool.
- The case demonstrates failure diagnosis and rerun context more strongly than long-term EvidenceMemory retrieval.
- The H-group mapping is practical rather than perfectly controlled, because the three arms come from real local OpenClaw runs rather than a fully isolated randomized experiment.
- Generated `runs/` artifacts are local and intentionally ignored by Git.

## Local Artifacts

All experiment outputs are written under `runs/`:

| Directory | Meaning |
|---|---|
| `runs/latest/` | Controlled synthetic experiment output. |
| `runs/openclaw-real-latest/` | Real local OpenClaw baseline-vs-plugin output. |
| `runs/openclaw-real-rerun-latest/` | Real local OpenClaw pass2 rerun output. |
| `runs/failure-case-dataset-latest/` | Direction A dataset-builder output. |

These directories are ignored by Git because they contain local evaluation artifacts, model outputs, logs, and oracle-derived labels.

## Direction B1

Direction B1 adds a plugin-level online repair intervention builder:

```text
nss_evimem_build_intervention
```

It reads the current `failure_diagnosis.json`, `rerun_plan.md`, task contract, tool capability registry, and evidence records, then writes:

- `intervention.json`
- `intervention.md`
- a `prompt_patch` field for the next Agent turn

This still stays within the plugin boundary. It does not solve the cryptanalysis task and does not modify OpenClaw internals directly. It gives the Agent or experiment harness an auditable prompt patch that blocks unsupported verified claims, requires bounded reruns, and forces an explicit evidence boundary.

The next research step after B1 is to wire this intervention bundle into a real live OpenClaw pass and compare whether the Agent follows the prompt patch more reliably than the previous rerun-context-only setup.
