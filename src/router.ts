import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { capabilityFieldMatches, formatCapabilityFieldValue } from "./capability-matcher.js";
import { getEvidenceDir, stableStringify, utcNow } from "./evidence-store.js";
import type {
  GuardDecision,
  GuardMode,
  JsonRecord,
  PluginHookToolContext,
  TaskContract,
  ToolCapability,
} from "./types.js";

export function mismatchReasons(
  taskContract: TaskContract,
  toolCapability: ToolCapability,
  fields?: string[],
): string[] {
  const keys = fields ?? Object.keys(taskContract);
  const reasons: string[] = [];
  for (const key of keys) {
    const expected = taskContract[key];
    if (expected === undefined || expected === null) {
      continue;
    }
    if (!capabilityFieldMatches(toolCapability, key, expected)) {
      reasons.push(`${key}=${formatCapabilityFieldValue(toolCapability, key)} expected=${String(expected)}`);
    }
  }
  return reasons;
}

export function decideGuardRoute(params: {
  requested_tool: string;
  guard_mode?: GuardMode;
  task_contract: TaskContract;
  tool_capability: ToolCapability;
  target_tool?: string | null;
  compare_fields?: string[];
}): GuardDecision {
  const guardMode = params.guard_mode ?? "post_check";
  const reasons = mismatchReasons(params.task_contract, params.tool_capability, params.compare_fields);
  let decision: GuardDecision["decision"] = "allow";
  let effectiveTool: string | null = params.requested_tool;

  if (reasons.length > 0 && guardMode === "pre_block") {
    decision = "block";
    effectiveTool = null;
  } else if (reasons.length > 0 && guardMode === "pre_redirect") {
    decision = params.target_tool ? "redirect" : "block";
    effectiveTool = params.target_tool ?? null;
  } else if (reasons.length > 0 && guardMode === "post_repair") {
    decision = "post_repair_required";
    effectiveTool = params.target_tool ?? params.requested_tool;
  } else if (reasons.length > 0) {
    decision = "allow_after_check";
  }

  return {
    timestamp: utcNow(),
    requested_tool: params.requested_tool,
    effective_tool: effectiveTool,
    target_tool: params.target_tool ?? null,
    guard_mode: guardMode,
    decision,
    reasons,
    task_contract: params.task_contract,
    tool_capability: params.tool_capability,
  };
}

export function writeGuardEvent(params: {
  event: GuardDecision | JsonRecord;
  ctx?: PluginHookToolContext;
  evidence_dir?: string;
}): void {
  const evidenceDir = getEvidenceDir(params.ctx, params.evidence_dir);
  mkdirSync(evidenceDir, { recursive: true });
  appendFileSync(join(evidenceDir, "tool_guard_events.jsonl"), `${stableStringify(params.event)}\n`, "utf8");
}
