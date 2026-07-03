import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findEvidenceRecord, getEvidenceDir, stableStringify, utcNow } from "./evidence-store.js";
import type { JsonRecord, MemoryRecord, MemoryRetrievalResult, PluginHookToolContext, TaskContract } from "./types.js";

export function promoteEvidenceToMemory(params: {
  evidence_id: string;
  claim: string;
  task_contract: TaskContract;
  tags?: string[];
  metadata?: JsonRecord;
  ctx?: PluginHookToolContext;
  evidence_dir?: string;
}): MemoryRecord {
  const evidenceDir = getEvidenceDir(params.ctx, params.evidence_dir);
  mkdirSync(evidenceDir, { recursive: true });

  const evidence = findEvidenceRecord(evidenceDir, params.evidence_id);
  if (!evidence) {
    throw new Error(`Evidence not found: ${params.evidence_id}`);
  }

  const records = readMemoryRecords(evidenceDir);
  const memory: MemoryRecord = {
    memory_id: nextMemoryId(records),
    memory_type: "evidence_backed_memory",
    evidence_id: evidence.evidence_id,
    claim: params.claim,
    task_contract: params.task_contract,
    tool_name: evidence.tool_name,
    artifact_hashes: evidence.artifact_hashes,
    created_at: utcNow(),
    tags: params.tags ?? [],
    metadata: params.metadata ?? {},
  };
  records.push(memory);
  writeMemoryRecords(evidenceDir, records);
  return memory;
}

export function retrieveMemories(params: {
  task_contract: TaskContract;
  tags?: string[];
  ctx?: PluginHookToolContext;
  evidence_dir?: string;
}): MemoryRetrievalResult {
  const evidenceDir = getEvidenceDir(params.ctx, params.evidence_dir);
  const accepted: MemoryRecord[] = [];
  const rejected: MemoryRetrievalResult["rejected"] = [];
  const requiredTags = params.tags ?? [];

  for (const record of readMemoryRecords(evidenceDir)) {
    if (!requiredTags.every((tag) => record.tags.includes(tag))) {
      rejected.push({
        memory_id: record.memory_id,
        evidence_id: record.evidence_id,
        reason: "tag_mismatch",
      });
      continue;
    }

    const mismatch = contractMismatch(record.task_contract, params.task_contract);
    if (mismatch) {
      rejected.push({
        memory_id: record.memory_id,
        evidence_id: record.evidence_id,
        reason: mismatch,
      });
      continue;
    }

    accepted.push(record);
  }

  return { accepted, rejected };
}

export function readMemoryRecords(evidenceDir: string): MemoryRecord[] {
  const path = memoryPath(evidenceDir);
  if (!existsSync(path)) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return Array.isArray(parsed) ? parsed.filter(isMemoryRecord) : [];
}

export function writeMemoryRecords(evidenceDir: string, records: MemoryRecord[]): void {
  writeFileSync(memoryPath(evidenceDir), stableStringify(records, 2), "utf8");
}

function memoryPath(evidenceDir: string): string {
  return join(evidenceDir, "memory_records.json");
}

function nextMemoryId(records: MemoryRecord[]): string {
  return `mem_${String(records.length + 1).padStart(4, "0")}`;
}

function contractMismatch(stored: TaskContract, current: TaskContract): string | null {
  for (const [key, expected] of Object.entries(current)) {
    if (expected === undefined || expected === null) {
      continue;
    }
    const actual = stored[key];
    if (stableStringify(actual) !== stableStringify(expected)) {
      return `contract_mismatch:${key}`;
    }
  }
  return null;
}

function isMemoryRecord(value: unknown): value is MemoryRecord {
  return (
    typeof value === "object"
    && value !== null
    && "memory_id" in value
    && "evidence_id" in value
    && "task_contract" in value
  );
}
