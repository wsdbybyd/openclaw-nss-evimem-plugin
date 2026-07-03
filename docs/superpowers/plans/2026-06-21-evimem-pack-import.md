# NSS-EviMem EvidenceMemory Pack Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `nss_evimem_import_pack` helper tool that imports the 24-record EvidenceMemory knowledge pack into the OpenClaw NSS-EviMem plugin's runtime memory store.

**Architecture:** Implement a focused importer in `src/pack-importer.ts`, expose it through `src/index.ts`, and extend `scripts/smoke.mjs` with a fixture pack that proves import and retrieval behavior. Imported pack memories are adapted into the existing plugin `MemoryRecord` shape so existing retrieval code remains unchanged.

**Tech Stack:** TypeScript ESM, Node.js built-ins (`fs`, `path`, `crypto`), existing plugin smoke test script.

---

### Task 1: Add Smoke Coverage For Pack Import

**Files:**
- Modify: `C:/Users/wsdbybyd/Desktop/openclaw-nss-evimem-plugin/scripts/smoke.mjs`

- [ ] **Step 1: Write the failing smoke assertions**

Add fixture-pack creation helpers and assert that `nss_evimem_import_pack` is registered, imports three representative records, and retrieves records by domain plus tags.

- [ ] **Step 2: Run smoke to verify it fails**

Run: `npm run smoke`

Expected: failure mentioning missing required helper tool `nss_evimem_import_pack`.

### Task 2: Implement Pack Importer

**Files:**
- Create: `C:/Users/wsdbybyd/Desktop/openclaw-nss-evimem-plugin/src/pack-importer.ts`
- Modify: `C:/Users/wsdbybyd/Desktop/openclaw-nss-evimem-plugin/src/memory-store.ts`
- Modify: `C:/Users/wsdbybyd/Desktop/openclaw-nss-evimem-plugin/src/types.ts`

- [ ] **Step 1: Add importer types and helpers**

Create a TypeScript module that reads required pack JSON files, validates arrays and cross references, computes source hashes, and maps source memories to plugin memory records.

- [ ] **Step 2: Expose memory writing support**

Export a write helper from `memory-store.ts` so the importer can upsert adapted memories without changing retrieval semantics.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: TypeScript reports missing tool registration until Task 3 is complete or no type errors if the module is self-contained.

### Task 3: Register Import Tool

**Files:**
- Modify: `C:/Users/wsdbybyd/Desktop/openclaw-nss-evimem-plugin/src/index.ts`
- Modify: `C:/Users/wsdbybyd/Desktop/openclaw-nss-evimem-plugin/README.md`

- [ ] **Step 1: Register `nss_evimem_import_pack`**

Add the new helper tool beside promote/retrieve/guard. Parameters: `pack_dir`, optional `evidence_dir`, optional `tags`, optional `replace_existing`.

- [ ] **Step 2: Document the tool**

Add README usage showing import of `C:\Users\wsdbybyd\Desktop\密码大模型\hook学习\automated_crypto_modeling_evidence_memory_24papers`.

### Task 4: Verify End To End

**Files:**
- Build output: `C:/Users/wsdbybyd/Desktop/openclaw-nss-evimem-plugin/dist/*`

- [ ] **Step 1: Build**

Run: `npm run build`

Expected: exit code 0.

- [ ] **Step 2: Run smoke**

Run: `npm run smoke`

Expected: JSON summary with `ok: true`, imported memory count 3 for fixture, and registered tool `nss_evimem_import_pack`.

- [ ] **Step 3: Run real-pack import check**

Run a Node one-off or smoke variant against `C:\Users\wsdbybyd\Desktop\密码大模型\hook学习\automated_crypto_modeling_evidence_memory_24papers` and a temporary evidence directory.

Expected: imported count 24; retrieval by `{ domain: "automated_crypto_modeling" }` and tag `MILP` returns accepted records; `paper_09`, `paper_17`, and `paper_24` exist.
