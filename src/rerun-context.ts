import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getEvidenceDir, isRecord, readEvidenceRecords, stableStringify, utcNow } from "./evidence-store.js";
import { readToolCapabilityRegistry } from "./tool-capability-registry.js";
import type { JsonRecord, PluginHookToolContext, TaskContract } from "./types.js";

export type RerunContext = {
  schema: "nss_evimem.rerun_context.v1";
  timestamp: string;
  case_id: string;
  status: string;
  failure_types: string[];
  prior_result_summary: JsonRecord;
  task_contract: TaskContract;
  evidence_summary: {
    tool_calls_recorded: number;
    registered_tools: string[];
    has_failure_diagnosis: boolean;
    has_rerun_plan: boolean;
  };
  output_files: {
    rerun_context: string;
    failure_diagnosis: string | null;
    rerun_plan: string | null;
  };
  prompt_patch: string;
};

export function buildRerunContext(params: {
  case_id?: string;
  failure_diagnosis_path?: string;
  rerun_plan_path?: string;
  output_path?: string;
  prior_result_summary?: JsonRecord;
  extra_instructions?: string[];
  evidence_dir?: string;
  ctx?: PluginHookToolContext;
}): RerunContext {
  const evidenceDir = getEvidenceDir(params.ctx, params.evidence_dir);
  mkdirSync(evidenceDir, { recursive: true });

  const failureDiagnosisPath = params.failure_diagnosis_path ?? join(evidenceDir, "failure_diagnosis.json");
  const rerunPlanPath = params.rerun_plan_path ?? join(evidenceDir, "rerun_plan.md");
  const outputPath = params.output_path ?? join(evidenceDir, "rerun_context.md");

  const failureDiagnosis = readJsonIfRecord(failureDiagnosisPath);
  const rerunPlan = readTextIfExists(rerunPlanPath);
  const taskContract = readTaskContract(evidenceDir, failureDiagnosis);
  const registry = readToolCapabilityRegistry(evidenceDir);
  const evidenceRecords = readEvidenceRecords(evidenceDir);

  const failureTypes = Array.isArray(failureDiagnosis?.failure_types)
    ? failureDiagnosis.failure_types.filter((item): item is string => typeof item === "string")
    : [];
  const status = typeof failureDiagnosis?.status === "string" ? failureDiagnosis.status : "unknown";
  const caseId = params.case_id
    ?? stringField(failureDiagnosis?.case_id)
    ?? stringField(taskContract.case_id)
    ?? stringField(taskContract.cipher)
    ?? "openclaw_case";

  const context: RerunContext = {
    schema: "nss_evimem.rerun_context.v1",
    timestamp: utcNow(),
    case_id: caseId,
    status,
    failure_types: failureTypes,
    prior_result_summary: params.prior_result_summary ?? {},
    task_contract: taskContract,
    evidence_summary: {
      tool_calls_recorded: evidenceRecords.length,
      registered_tools: Object.keys(registry).sort(),
      has_failure_diagnosis: failureDiagnosis !== null,
      has_rerun_plan: rerunPlan.length > 0,
    },
    output_files: {
      rerun_context: outputPath,
      failure_diagnosis: failureDiagnosis === null ? null : failureDiagnosisPath,
      rerun_plan: rerunPlan.length === 0 ? null : rerunPlanPath,
    },
    prompt_patch: renderPromptPatch(status, failureTypes),
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, renderRerunContextMarkdown({
    context,
    failureDiagnosis,
    rerunPlan,
    extraInstructions: params.extra_instructions ?? [],
  }), "utf8");

  return context;
}

function renderRerunContextMarkdown(params: {
  context: RerunContext;
  failureDiagnosis: JsonRecord | null;
  rerunPlan: string;
  extraInstructions: string[];
}): string {
  const { context, failureDiagnosis, rerunPlan, extraInstructions } = params;
  const failureTypeLines = context.failure_types.length > 0
    ? context.failure_types.map((type) => `- ${type}`)
    : ["- none_recorded"];
  const registeredTools = context.evidence_summary.registered_tools.length > 0
    ? context.evidence_summary.registered_tools.map((tool) => `- ${tool}`)
    : ["- none_recorded"];
  const observations = Array.isArray(failureDiagnosis?.observations)
    ? failureDiagnosis.observations.filter((item): item is string => typeof item === "string")
    : [];
  const observationLines = observations.length > 0
    ? observations.slice(0, 8).map((item) => `- ${item}`)
    : ["- none_recorded"];
  const extraLines = extraInstructions.length > 0
    ? extraInstructions.map((item) => `- ${item}`)
    : ["- No additional instructions supplied."];

  return [
    "# NSS-EviMem Rerun Context",
    "",
    `Generated: ${context.timestamp}`,
    `Case: ${context.case_id}`,
    `Status: \`${context.status}\``,
    "",
    "## Failure Types",
    "",
    ...failureTypeLines,
    "",
    "## Prior Result Summary",
    "",
    "```json",
    stableStringify(context.prior_result_summary, 2),
    "```",
    "",
    "## Task Contract",
    "",
    "```json",
    stableStringify(context.task_contract, 2),
    "```",
    "",
    "## Evidence Signals",
    "",
    `- Tool calls recorded: ${context.evidence_summary.tool_calls_recorded}`,
    `- Failure diagnosis present: ${context.evidence_summary.has_failure_diagnosis}`,
    `- Rerun plan present: ${context.evidence_summary.has_rerun_plan}`,
    "- Registered tools:",
    ...registeredTools,
    "",
    "## Key Observations",
    "",
    ...observationLines,
    "",
    "## Rerun Plan Boundary",
    "",
    rerunPlan.trim() || "No rerun_plan.md was found. Treat this as an evidence boundary and rebuild the plan before claiming success.",
    "",
    "## Required Rerun Discipline",
    "",
    "- Reuse the validated Task Contract unless the previous diagnosis proves it was wrong.",
    "- Re-register the exact executable capability before running a replacement search.",
    "- Start with bounded fast scans and promote only candidates that survive stronger verification.",
    "- Treat disappearing multi-key bias, near-zero bias, timeout, or killed tools as evidence against a verified claim.",
    "- Call `nss_evimem_diagnose_failure` again before the final answer.",
    "- If the rerun still cannot verify the distinguisher, report a bounded failure instead of a correct answer.",
    "- Do not read hidden, oracle, baseline, or previous experiment output folders.",
    "",
    "## Additional Instructions",
    "",
    ...extraLines,
    "",
    "## Prompt Patch",
    "",
    context.prompt_patch,
    "",
  ].join("\n");
}

function renderPromptPatch(status: string, failureTypes: string[]): string {
  return [
    "Use this rerun only to repair the previous failure boundary.",
    `Previous NSS-EviMem status: ${status}.`,
    `Failure types: ${failureTypes.length > 0 ? failureTypes.join(", ") : "none_recorded"}.`,
    "Do not claim a verified final answer unless the new executable evidence survives the rerun checklist.",
  ].join(" ");
}

function readTaskContract(evidenceDir: string, failureDiagnosis: JsonRecord | null): TaskContract {
  if (isRecord(failureDiagnosis?.task_contract)) {
    return failureDiagnosis.task_contract;
  }
  const parsed = readJsonIfRecord(join(evidenceDir, "task_contract.json"));
  return parsed ?? {};
}

function readJsonIfRecord(path: string): JsonRecord | null {
  if (!existsSync(path)) {
    return null;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return isRecord(parsed) ? parsed : null;
}

function readTextIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
