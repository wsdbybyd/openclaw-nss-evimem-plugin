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
```

## Helper Tools

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
```

## Environment Variables

- `NSS_EVIMEM_EVIDENCE_DIR`: explicit evidence output directory.
- `NSS_EVIMEM_SESSION_ID`: fallback session id if OpenClaw context does not provide one.

## Smoke Test

```powershell
npm run build
npm run smoke
```

The smoke test simulates an external user tool, captures evidence, promotes evidence-backed memory, retrieves matching memory, rejects stale memory, and writes one guard decision. The summary should contain:

```json
{
  "ok": true
}
```
