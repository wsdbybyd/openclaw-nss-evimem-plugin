# OpenClaw NSS-EviMem Plugin

Generic OpenClaw plugin for NSS-EviMem evidence capture, evidence-backed memory, and tool-governance decisions.

This package intentionally does not include cryptanalysis tools, OCP/MILP code, Python wrappers, SIMON/GIFT experiments, or experiment outputs. It observes and governs tools registered by another OpenClaw module.

## What It Provides

- `before_tool_call` hook: stores the call start time, tool name, arguments, and run metadata.
- `after_tool_call` hook: records the observed tool result as evidence.
- Artifact discovery: reads artifact paths from `result.artifacts`, `result.files`, `result.outputFiles`, or `result.details.*`.
- Artifact integrity: records SHA-256 hashes for existing artifact files.
- Evidence store: writes `tool_calls.jsonl` and `evidence_index.json`.
- Evidence Memory: promotes valid evidence into `memory_records.json` and retrieves only memories whose task contract matches the current task.
- Generic guard decisions: compares a task contract with a tool capability and records block, redirect, post-check, or post-repair decisions in `tool_guard_events.jsonl`.
- Tool Capability Registry: stores structured external-tool capability declarations in `tool_capabilities.json`.
- Task Contract validation: validates Agent-generated candidate contracts and persists valid session contracts in `task_contract.json`.
- Failure diagnosis and rerun planning: writes `failure_diagnosis.json`, `failure_diagnosis_events.jsonl`, and `rerun_plan.md` when a run is incomplete, noisy, timed out, mismatched, or overclaiming.
- Online repair intervention: converts a diagnosis and rerun plan into `intervention.json`, `intervention.md`, and a prompt patch the Agent can use in the next turn.

## Install and Build

```powershell
cd C:\Users\wsdbybyd\Desktop\openclaw-nss-evimem-plugin
npm install
npm run build
```

## Link Into OpenClaw

```powershell
openclaw plugins install --link "C:\Users\wsdbybyd\Desktop\openclaw-nss-evimem-plugin"
openclaw plugins inspect openclaw-nss-evimem-plugin --runtime
```

Expected runtime capabilities include:

```text
before_tool_call
after_tool_call
nss_evimem_promote_memory
nss_evimem_retrieve_memory
nss_evimem_guard_decision
nss_evimem_import_pack
nss_evimem_register_tool_capability
nss_evimem_list_tool_capabilities
nss_evimem_validate_contract
nss_evimem_diagnose_failure
nss_evimem_build_rerun_context
nss_evimem_build_intervention
```

## Helper Tools

### `nss_evimem_register_tool_capability`

Registers or updates an external tool capability declaration. The plugin does not need to know every possible tool in advance; callers can register project-level or session-level capabilities before validation and guard checks.

Input:

```json
{
  "tool_name": "simon32_dl_search",
  "capability": {
    "domain": "symmetric_cryptanalysis",
    "analysis_type": "differential_linear",
    "method": "script_search",
    "scope": "full_cipher",
    "claim_types": ["distinguisher_candidate", "empirical_correlation"],
    "produced_artifacts": ["code", "run_log", "search_result"]
  },
  "evidence_dir": "C:/tmp/nss-evimem-session"
}
```

Records are stored in `tool_capabilities.json`. Existing records with the same `tool_name` are replaced unless `replace_existing` is set to `false`.

Capability matching accepts both flat declarations such as `method` and structured declarations such as `methods`, `analysis_types`, `parameters.nrounds`, phase scopes, and descriptive text. This lets an Agent register a realistic executable tool capability without forcing every field into the exact Task Contract shape.

### `nss_evimem_list_tool_capabilities`

Lists registered capability declarations.

Input:

```json
{
  "evidence_dir": "C:/tmp/nss-evimem-session"
}
```

The result includes `count` and a `capabilities` array. Add `tool_name` to filter to one tool.

### `nss_evimem_validate_contract`

Validates an Agent-generated candidate Task Contract. Natural-language understanding remains the Agent's job; the plugin only checks the structured contract for completeness, basic semantic consistency, optional support lists, and optional matching registered tools.

Input:

```json
{
  "task_contract": {
    "domain": "symmetric_cryptanalysis",
    "cipher": "Simon32/64",
    "rounds": 14,
    "analysis_type": "differential_linear",
    "method": "script_search",
    "objective": "distinguisher_candidate",
    "scope": "full_cipher",
    "required_artifacts": ["code", "run_log", "search_result"]
  },
  "require_matching_tool": true,
  "evidence_dir": "C:/tmp/nss-evimem-session"
}
```

Possible statuses:

- `valid_contract`
- `incomplete_contract`
- `invalid_contract`
- `unsupported_contract`

Each validation is appended to `contract_validation_events.jsonl`. Valid contracts are saved as `task_contract.json` by default; pass `save_as_current: false` to validate without updating the session contract.

### `nss_evimem_diagnose_failure`

Generates a structured diagnosis and rerun plan from the current evidence directory plus an optional run summary. This tool does not solve the cryptanalysis task and does not execute reruns; it gives the Agent an auditable failure classification and a bounded next-run checklist.

Input:

```json
{
  "case_id": "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
  "task_contract": {
    "domain": "symmetric_cryptanalysis",
    "cipher": "Simon32/64",
    "rounds": 14,
    "analysis_type": "differential_linear",
    "method": "script_search",
    "objective": "distinguisher_candidate",
    "scope": "full_cipher"
  },
  "run_summary": {
    "final_correctness": "partially_correct_or_insufficient",
    "evidence_completeness": "partial",
    "claim_boundary_ok": true,
    "overclaiming_detected": false,
    "openclaw_error": "spawnSync node.exe ETIMEDOUT",
    "oracle_alignment": {
      "paper_pair_match": false,
      "best_split_mentioned": false
    }
  },
  "observations": [
    "quick-scan candidates vanished under multi-key verification",
    "search process was killed after no new output"
  ],
  "evidence_dir": "C:/tmp/nss-evimem-session"
}
```

Detected failure types include:

- `search_timeout`
- `candidate_statistical_noise`
- `oracle_mismatch`
- `insufficient_evidence`
- `task_contract_unvalidated`
- `tool_capability_missing`
- `tool_contract_mismatch`
- `overclaiming`

Outputs:

- `failure_diagnosis.json`: latest structured diagnosis.
- `failure_diagnosis_events.jsonl`: append-only diagnosis history.
- `rerun_plan.md`: human-readable rerun checklist for the next Agent turn.

### `nss_evimem_build_rerun_context`

Builds a compact rerun context from an existing `failure_diagnosis.json`, `rerun_plan.md`, current task contract, tool capability registry, and evidence summary. This is useful when starting a fresh OpenClaw pass from the previous failure boundary.

Input:

```json
{
  "case_id": "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
  "prior_result_summary": {
    "pass": "plugin_pass1",
    "final_correctness": "partially_correct_or_insufficient",
    "evidence_completeness": "complete_or_structured"
  },
  "evidence_dir": "C:/tmp/nss-evimem-session"
}
```

Outputs:

- `rerun_context.md`: markdown context for a bounded rerun.
- `prompt_patch`: compact text telling the Agent not to claim success unless the rerun checklist is satisfied.

### `nss_evimem_build_intervention`

Builds an online repair intervention from the current failure diagnosis and rerun plan. This tool stays inside the plugin boundary: it does not solve the cryptanalysis task, mutate OpenClaw internals, or execute tools. It returns a structured intervention that the Agent or experiment harness can inject into the next prompt.

Input:

```json
{
  "case_id": "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
  "intervention_mode": "online_repair_prompt",
  "prior_result_summary": {
    "pass": "plugin_pass1",
    "final_correctness": "partially_correct_or_insufficient",
    "evidence_completeness": "complete_or_structured"
  },
  "evidence_dir": "C:/tmp/nss-evimem-session"
}
```

Modes:

- `online_repair_prompt`: require a bounded rerun, matching tool capability, fresh evidence, and a final diagnosis before answering.
- `report_boundary_prompt`: rewrite the final report boundary when the main issue is unsafe claim wording.

Outputs:

- `intervention.json`: structured intervention with blocked claims, required actions, evidence requirements, report boundaries, and output paths.
- `intervention.md`: human-readable intervention bundle.
- `prompt_patch`: text that can be inserted into the next Agent turn.

### `nss_evimem_import_pack`

Imports an existing EvidenceMemory knowledge pack into the plugin memory store without modifying the source pack.

Input:

```json
{
  "pack_dir": "C:/Users/wsdbybyd/Desktop/?????/hook??/automated_crypto_modeling_evidence_memory_24papers",
  "evidence_dir": "C:/tmp/nss-evimem-real-pack-check",
  "tags": ["crypto-literature-pack"]
}
```

The imported records can then be retrieved with the existing retrieval tool, for example:

```json
{
  "task_contract": {
    "domain": "automated_crypto_modeling"
  },
  "tags": ["MILP"],
  "evidence_dir": "C:/tmp/nss-evimem-real-pack-check"
}
```

The import is idempotent by default: records with the same source `memory_id` are replaced unless `replace_existing` is set to `false`. Original pack fields such as `paper_id`, `paper_title`, `structured_claim`, source locator, and do-not-apply rules are preserved in imported memory `metadata`.


### `nss_evimem_promote_memory`

Promotes an existing evidence record into evidence-backed memory.

Input:

```json
{
  "evidence_id": "evid_0001",
  "claim": "The tool result supports this claim.",
  "task_contract": {
    "domain": "demo",
    "objective": "verified_artifact"
  },
  "tags": ["demo"]
}
```

Output includes a `memory_id`, the original `evidence_id`, artifact hashes, and the stored task contract.

### `nss_evimem_retrieve_memory`

Retrieves memory only when the provided task contract matches the stored memory contract.

Input:

```json
{
  "task_contract": {
    "domain": "demo",
    "objective": "verified_artifact"
  },
  "tags": ["demo"]
}
```

The result has `accepted` and `rejected` arrays. Stale or mismatched memory is rejected with a reason such as `contract_mismatch:objective`.

### `nss_evimem_guard_decision`

Records a generic HTSG-style guard decision. It does not execute any target tool.

Input:

```json
{
  "requested_tool": "demo_heuristic_tool",
  "guard_mode": "pre_redirect",
  "task_contract": {
    "method": "verified",
    "objective": "final_claim"
  },
  "tool_capability": {
    "method": "heuristic",
    "objective": "candidate_claim"
  },
  "target_tool": "demo_verified_tool"
}
```

Possible decisions:

- `allow`
- `block`
- `redirect`
- `allow_after_check`
- `post_repair_required`

The caller module remains responsible for actually executing or rerunning domain tools.

## Output Files

By default, evidence is written under `evidence/<session-id>` when OpenClaw provides a session id, otherwise under `evidence/openclaw-session`.

Generated files:

```text
tool_calls.jsonl
evidence_index.json
memory_records.json
tool_guard_events.jsonl
tool_capabilities.json
task_contract.json
contract_validation_events.jsonl
failure_diagnosis.json
failure_diagnosis_events.jsonl
rerun_plan.md
```

## Environment Variables

- `NSS_EVIMEM_EVIDENCE_DIR`: explicit evidence output directory.
- `NSS_EVIMEM_SESSION_ID`: fallback session id if OpenClaw context does not provide one.

## Experiment Helper Scripts

The plugin repository also includes local helper scripts for the `CBSC-V2-HARD-SIMON32-DL-SEARCH-002` case. These scripts are source-controlled, but their generated `runs/` outputs are ignored by Git.

To analyze whether a completed B2 OpenClaw intervention run actually followed the B1 prompt intervention, run:

```powershell
npm run experiment:cbsc-simon32-dl:intervention-compliance:all
```

This reads `experiments/CBSC-V2-HARD-SIMON32-DL-SEARCH-002/runs/openclaw-real-intervention-latest/` and writes local-only `intervention_compliance.json` and `intervention_compliance_report.md` files. The strongest expected label for the current case is `compliant_bounded_failure`, not `verified_correct`.

## Smoke Test

```powershell
npm run build
npm run smoke
```

The smoke test simulates an external user tool, captures evidence, promotes evidence-backed memory, retrieves matching memory, rejects stale memory, writes one guard decision, registers a tool capability, validates a task contract, diagnoses a failed run, writes a rerun plan, and imports a fixture EvidenceMemory pack. The summary should contain:

```json
{
  "ok": true
}
```
