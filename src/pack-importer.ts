import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { getEvidenceDir, isRecord, stableStringify, utcNow } from "./evidence-store.js";
import { readMemoryRecords, writeMemoryRecords } from "./memory-store.js";
import type { JsonRecord, MemoryRecord, PluginHookToolContext } from "./types.js";

type ImportPackJson = JsonRecord;

type PackImportResult = {
  pack_dir: string;
  evidence_dir: string;
  imported: number;
  replaced: number;
  skipped_existing: number;
  skipped_inactive: number;
  total_memory_records: number;
  memory_ids: string[];
  warnings: string[];
};

const REQUIRED_PACK_FILES = [
  "manifest.json",
  "evidence_index.json",
  "memory_records.json",
  "retrieval_config.json",
] as const;

export function importEvidenceMemoryPack(params: {
  pack_dir: string;
  evidence_dir?: string;
  tags?: string[];
  replace_existing?: boolean;
  ctx?: PluginHookToolContext;
}): PackImportResult {
  const packDir = resolve(params.pack_dir);
  assertDirectory(packDir);

  const evidenceDir = getEvidenceDir(params.ctx, params.evidence_dir);
  mkdirSync(evidenceDir, { recursive: true });

  const manifest = readJsonRecord(join(packDir, "manifest.json"), "manifest.json");
  const evidenceIndex = readJsonRecord(join(packDir, "evidence_index.json"), "evidence_index.json");
  const sourceMemories = readJsonArray(join(packDir, "memory_records.json"), "memory_records.json");
  const retrievalConfig = readJsonRecord(join(packDir, "retrieval_config.json"), "retrieval_config.json");

  const papers = arrayFromRecord(manifest, "papers", "manifest.json");
  const evidenceRecords = arrayFromRecord(evidenceIndex, "records", "evidence_index.json");
  const paperById = indexByStringField(papers, "id");
  const evidenceById = indexByStringField(evidenceRecords, "evidence_id");
  const packHashes = hashPackFiles(packDir);
  const warnings: string[] = [];

  const existing = readMemoryRecords(evidenceDir);
  const existingById = new Map(existing.map((record) => [record.memory_id, record]));
  const importedRecords: MemoryRecord[] = [];
  let skippedExisting = 0;
  let skippedInactive = 0;
  let replaced = 0;

  for (const sourceMemory of sourceMemories) {
    if (!isRecord(sourceMemory)) {
      warnings.push("Skipped non-object memory record from pack.");
      continue;
    }

    const status = optionalString(sourceMemory.status);
    if (status && status !== "active") {
      skippedInactive += 1;
      continue;
    }

    const sourceMemoryId = requiredString(sourceMemory.memory_id, "memory.memory_id");
    if (existingById.has(sourceMemoryId) && params.replace_existing === false) {
      skippedExisting += 1;
      continue;
    }

    const evidenceId = requiredString(sourceMemory.evidence_id, `${sourceMemoryId}.evidence_id`);
    const sourceEvidence = evidenceById.get(evidenceId);
    if (!sourceEvidence) {
      warnings.push(`${sourceMemoryId}: evidence not found in pack: ${evidenceId}`);
    }

    const paperId = optionalString(sourceMemory.paper_id) ?? optionalString(sourceEvidence?.paper_id);
    const sourcePaper = paperId ? paperById.get(paperId) : undefined;
    if (paperId && !sourcePaper) {
      warnings.push(`${sourceMemoryId}: paper not found in manifest: ${paperId}`);
    }

    const adapted = adaptPackMemory({
      packDir,
      manifest,
      retrievalConfig,
      sourceMemory,
      sourceEvidence,
      sourcePaper,
      packHashes,
      extraTags: params.tags ?? [],
      warnings,
    });
    if (existingById.has(adapted.memory_id)) {
      replaced += 1;
    }
    importedRecords.push(adapted);
  }

  const importedIds = new Set(importedRecords.map((record) => record.memory_id));
  const retained = existing.filter((record) => !importedIds.has(record.memory_id));
  const nextRecords = [...retained, ...importedRecords];
  writeMemoryRecords(evidenceDir, nextRecords);

  return {
    pack_dir: packDir,
    evidence_dir: evidenceDir,
    imported: importedRecords.length,
    replaced,
    skipped_existing: skippedExisting,
    skipped_inactive: skippedInactive,
    total_memory_records: nextRecords.length,
    memory_ids: importedRecords.map((record) => record.memory_id),
    warnings,
  };
}

function adaptPackMemory(params: {
  packDir: string;
  manifest: ImportPackJson;
  retrievalConfig: ImportPackJson;
  sourceMemory: JsonRecord;
  sourceEvidence?: JsonRecord;
  sourcePaper?: JsonRecord;
  packHashes: Record<string, string>;
  extraTags: string[];
  warnings: string[];
}): MemoryRecord {
  const sourceMemory = params.sourceMemory;
  const sourceEvidence = params.sourceEvidence;
  const sourcePaper = params.sourcePaper;
  const memoryId = requiredString(sourceMemory.memory_id, "memory.memory_id");
  const evidenceId = requiredString(sourceMemory.evidence_id, `${memoryId}.evidence_id`);
  const paperId = optionalString(sourceMemory.paper_id) ?? optionalString(sourceEvidence?.paper_id);
  const sourceMemoryType = optionalString(sourceMemory.memory_type) ?? "unknown";
  const sourceFile = optionalString(sourceEvidence?.source_file) ?? optionalString(sourcePaper?.text_file);
  const resolvedSourceFile = resolvePackPath(params.packDir, sourceFile);

  const artifactHashes: Record<string, string> = { ...params.packHashes };
  const sourcePdfHash = optionalString(sourcePaper?.pdf_sha256);
  if (paperId && sourcePdfHash) {
    artifactHashes[`${paperId}_source_pdf`] = sourcePdfHash;
  }
  if (resolvedSourceFile && existsSync(resolvedSourceFile)) {
    artifactHashes[`${paperId ?? memoryId}_source_file`] = sha256File(resolvedSourceFile);
  } else if (sourceFile) {
    params.warnings.push(`${memoryId}: source file not found: ${sourceFile}`);
  }

  const structuredClaim = isRecord(sourceMemory.structured_claim)
    ? sourceMemory.structured_claim
    : isRecord(sourceEvidence?.structured_claim)
      ? sourceEvidence.structured_claim
      : {};

  return {
    memory_id: memoryId,
    memory_type: "evidence_backed_memory",
    evidence_id: evidenceId,
    claim: requiredString(sourceMemory.claim, `${memoryId}.claim`),
    task_contract: {
      domain: "automated_crypto_modeling",
      source_pack_schema: optionalString(params.manifest.schema) ?? "unknown",
      source_pack_name: basename(params.packDir),
      memory_kind: sourceMemoryType,
      ...(paperId ? { paper_id: paperId } : {}),
    },
    tool_name: "nss_evimem_import_pack",
    artifact_hashes: artifactHashes,
    created_at: utcNow(),
    tags: uniqueStrings([
      "automated_crypto_modeling",
      "evidence_memory_pack",
      ...stringArray(sourceMemory.retrieval_tags),
      ...stringArray(sourceEvidence?.scope_tags),
      ...stringArray(sourcePaper?.category),
      ...params.extraTags,
      ...(paperId ? [paperId] : []),
    ]),
    metadata: {
      imported_from: {
        pack_dir: params.packDir,
        source_memory_id: memoryId,
        source_evidence_id: evidenceId,
      },
      source_memory_type: sourceMemoryType,
      paper_id: paperId ?? null,
      paper_title: optionalString(sourceMemory.paper_title) ?? optionalString(sourcePaper?.title) ?? null,
      paper_authors: optionalString(sourceMemory.paper_authors) ?? optionalString(sourcePaper?.authors) ?? null,
      year: sourceMemory.year ?? sourcePaper?.year ?? null,
      structured_claim: structuredClaim,
      evidence_ids: stringArray(sourceMemory.evidence_ids).length > 0 ? stringArray(sourceMemory.evidence_ids) : [evidenceId],
      source: {
        source_type: optionalString(sourceEvidence?.source_type) ?? null,
        source_url: optionalString(sourceEvidence?.source_url) ?? optionalString(sourcePaper?.source_url) ?? null,
        source_file: sourceFile ?? null,
        resolved_source_file: resolvedSourceFile ?? null,
        source_locator: optionalString(sourceEvidence?.source_locator) ?? null,
      },
      do_not_apply_when: stringArray(sourceMemory.do_not_apply_when),
      trigger_issue_kinds: stringArray(sourceMemory.trigger_issue_kinds),
      retrieval_config_schema: optionalString(params.retrievalConfig.schema) ?? null,
    },
  };
}

function readJsonRecord(path: string, label: string): JsonRecord {
  const parsed = readJson(path, label);
  if (!isRecord(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parsed;
}

function readJsonArray(path: string, label: string): unknown[] {
  const parsed = readJson(path, label);
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON array`);
  }
  return parsed;
}

function readJson(path: string, label: string): unknown {
  if (!existsSync(path)) {
    throw new Error(`Required EvidenceMemory pack file is missing: ${label}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function arrayFromRecord(record: JsonRecord, key: string, label: string): JsonRecord[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`${label}.${key} must be an array`);
  }
  return value.filter(isRecord);
}

function indexByStringField(records: JsonRecord[], field: string): Map<string, JsonRecord> {
  const indexed = new Map<string, JsonRecord>();
  for (const record of records) {
    const value = optionalString(record[field]);
    if (value) {
      indexed.set(value, record);
    }
  }
  return indexed;
}

function hashPackFiles(packDir: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const file of REQUIRED_PACK_FILES) {
    hashes[`pack_${file.replace(/\.json$/, "")}`] = sha256File(join(packDir, file));
  }
  return hashes;
}

function resolvePackPath(packDir: string, value?: string): string | null {
  if (!value) {
    return null;
  }
  if (isAbsolute(value)) {
    return resolve(value);
  }
  const candidates = [
    resolve(packDir, value),
    resolve(dirname(packDir), value),
    resolve(process.cwd(), value),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function sha256File(path: string): string {
  const digest = createHash("sha256");
  digest.update(readFileSync(path));
  return digest.digest("hex");
}

function assertDirectory(path: string): void {
  if (!existsSync(path)) {
    throw new Error(`EvidenceMemory pack directory does not exist: ${path}`);
  }
  if (!statSync(path).isDirectory()) {
    throw new Error(`EvidenceMemory pack path is not a directory: ${path}`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Expected non-empty string: ${label}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort();
}
