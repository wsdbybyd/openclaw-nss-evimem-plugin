import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

import type {
  EvidenceRecord,
  JsonRecord,
  PluginHookBeforeToolCallEvent,
  PluginHookToolContext,
} from "./types.js";

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function utcNow(): string {
  return new Date().toISOString();
}

export function getEvidenceDir(ctx?: PluginHookToolContext, explicitDir?: string): string {
  const configured = explicitDir ?? process.env.NSS_EVIMEM_EVIDENCE_DIR;
  if (configured && configured.trim().length > 0) {
    return resolve(configured);
  }

  const sessionKey = ctx?.sessionId ?? ctx?.sessionKey ?? process.env.NSS_EVIMEM_SESSION_ID;
  if (sessionKey && String(sessionKey).trim().length > 0) {
    return resolve("evidence", String(sessionKey));
  }

  return resolve("evidence", "openclaw-session");
}

export function getCallId(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
): string {
  return String(
    event.toolCallId
      ?? ctx.toolCallId
      ?? `${event.runId ?? ctx.runId ?? "run"}:${event.toolName ?? ctx.toolName ?? "tool"}:${stableStringify(
        event.params ?? {},
      )}`,
  );
}

export function recordToolEvidence(params: {
  timestamp: string;
  case_id: string;
  run_id: string | null;
  tool_call_id: string | null;
  tool_name: string;
  args: JsonRecord;
  result: unknown;
  elapsed_ms: number | null;
  ok: boolean;
  error: string | null;
  source: string;
  ctx?: PluginHookToolContext;
  evidence_dir?: string;
}): EvidenceRecord {
  const evidenceDir = getEvidenceDir(params.ctx, params.evidence_dir);
  mkdirSync(evidenceDir, { recursive: true });

  const toolCallsPath = join(evidenceDir, "tool_calls.jsonl");
  const evidenceId = nextEvidenceId(toolCallsPath);
  const { artifacts, artifactErrors } = collectArtifacts(params.result);
  const { artifactHashes, hashErrors } = hashArtifacts(artifacts);
  const record: EvidenceRecord = {
    evidence_id: evidenceId,
    timestamp: params.timestamp,
    case_id: params.case_id,
    run_id: params.run_id,
    tool_call_id: params.tool_call_id,
    tool_name: params.tool_name,
    args: params.args,
    result: params.result,
    artifacts,
    artifact_hashes: artifactHashes,
    artifact_errors: { ...artifactErrors, ...hashErrors },
    elapsed_ms: params.elapsed_ms,
    ok: params.ok,
    error: params.error,
    source: params.source,
  };

  appendFileSync(toolCallsPath, `${stableStringify(record)}\n`, "utf8");
  writeEvidenceIndex(evidenceDir);
  return record;
}

export function readEvidenceRecords(evidenceDir: string): EvidenceRecord[] {
  const toolCallsPath = join(evidenceDir, "tool_calls.jsonl");
  if (!existsSync(toolCallsPath)) {
    return [];
  }
  return readFileSync(toolCallsPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvidenceRecord);
}

export function findEvidenceRecord(evidenceDir: string, evidenceId: string): EvidenceRecord | null {
  return readEvidenceRecords(evidenceDir).find((record) => record.evidence_id === evidenceId) ?? null;
}

function writeEvidenceIndex(evidenceDir: string): void {
  const indexPath = join(evidenceDir, "evidence_index.json");
  writeFileSync(indexPath, stableStringify(readEvidenceRecords(evidenceDir), 2), "utf8");
}

function nextEvidenceId(toolCallsPath: string): string {
  if (!existsSync(toolCallsPath)) {
    return "evid_0001";
  }
  const count = readFileSync(toolCallsPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0).length;
  return `evid_${String(count + 1).padStart(4, "0")}`;
}

function collectArtifacts(result: unknown): {
  artifacts: Record<string, string>;
  artifactErrors: Record<string, string>;
} {
  const artifacts: Record<string, string> = {};
  const artifactErrors: Record<string, string> = {};
  const details = isRecord(result) && isRecord(result.details) ? result.details : null;
  const candidates = [
    isRecord(result) ? result.artifacts : null,
    isRecord(result) ? result.files : null,
    isRecord(result) ? result.outputFiles : null,
    details ? details.artifacts : null,
    details ? details.files : null,
    details ? details.outputFiles : null,
  ];

  for (const candidate of candidates) {
    addArtifactCandidate(candidate, artifacts, artifactErrors);
  }

  return { artifacts, artifactErrors };
}

function addArtifactCandidate(
  candidate: unknown,
  artifacts: Record<string, string>,
  artifactErrors: Record<string, string>,
): void {
  if (!candidate) {
    return;
  }

  if (Array.isArray(candidate)) {
    for (const item of candidate) {
      const path = typeof item === "string" ? item : isRecord(item) ? String(item.path ?? "") : "";
      const name = isRecord(item) && typeof item.name === "string" ? item.name : `artifact_${Object.keys(artifacts).length + 1}`;
      addArtifactPath(name, path, artifacts, artifactErrors);
    }
    return;
  }

  if (isRecord(candidate)) {
    for (const [name, value] of Object.entries(candidate)) {
      const path = typeof value === "string" ? value : isRecord(value) ? String(value.path ?? "") : "";
      addArtifactPath(name, path, artifacts, artifactErrors);
    }
  }
}

function addArtifactPath(
  name: string,
  path: string,
  artifacts: Record<string, string>,
  artifactErrors: Record<string, string>,
): void {
  if (!path) {
    return;
  }
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    artifactErrors[name] = `missing artifact: ${resolved}`;
    return;
  }
  artifacts[uniqueName(name, artifacts)] = resolved;
}

function uniqueName(name: string, artifacts: Record<string, string>): string {
  if (!(name in artifacts)) {
    return name;
  }
  let index = 2;
  while (`${name}_${index}` in artifacts) {
    index += 1;
  }
  return `${name}_${index}`;
}

function hashArtifacts(artifacts: Record<string, string>): {
  artifactHashes: Record<string, string>;
  hashErrors: Record<string, string>;
} {
  const artifactHashes: Record<string, string> = {};
  const hashErrors: Record<string, string> = {};
  for (const [name, path] of Object.entries(artifacts)) {
    try {
      const stat = statSync(path);
      if (!stat.isFile()) {
        hashErrors[name] = `not a file: ${path}`;
        continue;
      }
      const digest = createHash("sha256");
      digest.update(readFileSync(path));
      artifactHashes[name] = digest.digest("hex");
    } catch (error) {
      hashErrors[name] = error instanceof Error ? error.message : String(error);
    }
  }
  return { artifactHashes, hashErrors };
}

export function stableStringify(value: unknown, space?: number): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(normalizeForJson(value, seen), null, space);
}

function normalizeForJson(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForJson(item, seen));
  }
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const normalized: JsonRecord = {};
    for (const key of Object.keys(value as JsonRecord).sort()) {
      normalized[key] = normalizeForJson((value as JsonRecord)[key], seen);
    }
    seen.delete(value);
    return normalized;
  }
  return value;
}
