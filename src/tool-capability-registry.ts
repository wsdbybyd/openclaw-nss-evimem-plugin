import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getEvidenceDir, isRecord, stableStringify, utcNow } from "./evidence-store.js";
import type { JsonRecord, PluginHookToolContext, ToolCapability, ToolCapabilityRecord } from "./types.js";

export function registerToolCapability(params: {
  tool_name: string;
  capability: ToolCapability;
  metadata?: JsonRecord;
  replace_existing?: boolean;
  ctx?: PluginHookToolContext;
  evidence_dir?: string;
}): ToolCapabilityRecord & { replaced: boolean; evidence_dir: string } {
  const evidenceDir = getEvidenceDir(params.ctx, params.evidence_dir);
  mkdirSync(evidenceDir, { recursive: true });

  const registry = readToolCapabilityRegistry(evidenceDir);
  const existing = registry[params.tool_name];
  if (existing && params.replace_existing === false) {
    return { ...existing, replaced: false, evidence_dir: evidenceDir };
  }

  const now = utcNow();
  const record: ToolCapabilityRecord = {
    tool_name: params.tool_name,
    capability: params.capability,
    registered_at: existing?.registered_at ?? now,
    updated_at: now,
    metadata: params.metadata ?? existing?.metadata ?? {},
  };
  registry[params.tool_name] = record;
  writeToolCapabilityRegistry(evidenceDir, registry);
  return { ...record, replaced: existing !== undefined, evidence_dir: evidenceDir };
}

export function listToolCapabilities(params: {
  tool_name?: string;
  ctx?: PluginHookToolContext;
  evidence_dir?: string;
}): { evidence_dir: string; count: number; capabilities: ToolCapabilityRecord[] } {
  const evidenceDir = getEvidenceDir(params.ctx, params.evidence_dir);
  const registry = readToolCapabilityRegistry(evidenceDir);
  const capabilities = Object.values(registry)
    .filter((record) => !params.tool_name || record.tool_name === params.tool_name)
    .sort((a, b) => a.tool_name.localeCompare(b.tool_name));
  return {
    evidence_dir: evidenceDir,
    count: capabilities.length,
    capabilities,
  };
}

export function readToolCapabilityRegistry(evidenceDir: string): Record<string, ToolCapabilityRecord> {
  const path = capabilityRegistryPath(evidenceDir);
  if (!existsSync(path)) {
    return {};
  }

  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    return {};
  }

  const registry: Record<string, ToolCapabilityRecord> = {};
  for (const [toolName, value] of Object.entries(parsed)) {
    if (isToolCapabilityRecord(value)) {
      registry[toolName] = value;
    }
  }
  return registry;
}

function writeToolCapabilityRegistry(evidenceDir: string, registry: Record<string, ToolCapabilityRecord>): void {
  writeFileSync(capabilityRegistryPath(evidenceDir), stableStringify(registry, 2), "utf8");
}

function capabilityRegistryPath(evidenceDir: string): string {
  return join(evidenceDir, "tool_capabilities.json");
}

function isToolCapabilityRecord(value: unknown): value is ToolCapabilityRecord {
  return (
    isRecord(value)
    && typeof value.tool_name === "string"
    && isRecord(value.capability)
    && typeof value.registered_at === "string"
    && typeof value.updated_at === "string"
    && isRecord(value.metadata)
  );
}
