# NSS-EviMem EvidenceMemory Pack Import Design

## Goal

Add an explicit import path that lets the OpenClaw NSS-EviMem plugin ingest an existing EvidenceMemory knowledge pack without modifying the original pack. The immediate target pack is `automated_crypto_modeling_evidence_memory_24papers`, which contains 24 active literature/tool-context memory records for automated differential, linear, and integral cryptanalysis modeling.

## Source Context

The plugin currently captures runtime tool evidence into `tool_calls.jsonl`, promotes evidence into `memory_records.json`, retrieves memory through `task_contract` plus tags, and records guard decisions. The existing runtime `MemoryRecord` shape is narrower than the cryptanalysis EvidenceMemory pack: plugin records use `memory_type: "evidence_backed_memory"`, a single `evidence_id`, a `task_contract`, tags, and metadata; the pack records use richer `paper_method_scope` and `tool_usage_scope` records with paper IDs, structured claims, retrieval tags, and source locators.

## Design

Add a helper tool named `nss_evimem_import_pack`. The tool accepts `pack_dir`, optional `evidence_dir`, optional extra `tags`, and optional `replace_existing`. It reads the pack's `manifest.json`, `evidence_index.json`, `memory_records.json`, and `retrieval_config.json`; validates the basic cross references; then adapts active pack memories into the plugin's existing runtime memory format.

Imported memories keep their original memory IDs, evidence IDs, claims, and retrieval tags. To remain compatible with the existing retrieval path, imported records are stored as `memory_type: "evidence_backed_memory"`; the original pack memory type is preserved in `metadata.source_memory_type`. The stored `task_contract` is intentionally broad: `domain: "automated_crypto_modeling"`, `source_pack_schema`, `source_pack_name`, `memory_kind`, and `paper_id`. This allows callers to retrieve the whole domain with `{ "domain": "automated_crypto_modeling" }`, while using tags such as `MILP`, `SAT`, `paper_09`, or `OCP` for narrower matching.

The import is idempotent by default. When `replace_existing` is true or omitted, existing records with the same imported memory IDs are replaced. When false, existing imported IDs are left untouched and reported as skipped. The original EvidenceMemory directory is never modified.

## Data Mapping

Each source memory maps to one plugin memory:

- `memory_id`: original source `memory_id`.
- `evidence_id`: original primary `evidence_id`.
- `claim`: original extracted claim.
- `task_contract`: domain and source-pack routing fields.
- `tool_name`: `nss_evimem_import_pack`.
- `artifact_hashes`: pack manifest/evidence/memory/retrieval file hashes plus source PDF hash when present.
- `tags`: union of source `retrieval_tags`, source paper categories, source scope tags, user-provided extra tags, and `automated_crypto_modeling`.
- `metadata`: source paper metadata, structured claim, evidence source locator, do-not-apply rules, source file path, source URL, and import summary.

## Error Handling

The tool fails fast when `pack_dir` is missing, required JSON files are absent, JSON is invalid, or the pack has no array-shaped memory records/evidence records. Cross-reference gaps are returned as warnings unless they prevent constructing a memory. Missing source files are also warnings because some pack paths may be relative to a different workspace; the source path is still preserved in metadata.

## Testing

Extend `scripts/smoke.mjs` with a small fixture EvidenceMemory pack. The smoke flow must verify that the new import tool is registered, imports fixture records, writes memory records to the plugin evidence directory, retrieves imported records by `task_contract` and tags, preserves special records equivalent to `paper_09`, `paper_17`, and `paper_24`, and remains compatible with the existing promote/retrieve/guard smoke assertions.
