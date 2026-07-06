import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getEvidenceDir, isRecord, readEvidenceRecords, stableStringify, utcNow } from "./evidence-store.js";
import { readToolCapabilityRegistry } from "./tool-capability-registry.js";
import type { JsonRecord, PluginHookToolContext, TaskContract } from "./types.js";

export type InterventionMode = "online_repair_prompt" | "report_boundary_prompt";

export type OnlineIntervention = {
  schema: "nss_evimem.online_intervention.v1";
  timestamp: string;
  case_id: string;
  status: "active_intervention" | "no_intervention_needed";
  intervention_mode: InterventionMode;
  failure_types: string[];
  severity: string;
  task_contract: TaskContract;
  prior_result_summary: JsonRecord;
  evidence_summary: {
    tool_calls_recorded: number;
    registered_tools: string[];
    has_failure_diagnosis: boolean;
    has_rerun_plan: boolean;
  };
  blocked_claims: string[];
  required_actions: string[];
  evidence_requirements: string[];
  report_boundaries: string[];
  prompt_patch: string;
  source_files: {
    failure_diagnosis: string | null;
    rerun_plan: string | null;
  };
  output_files: {
    intervention_json: string;
    intervention_markdown: string;
  };
};

export function buildIntervention(params: {
  case_id?: string;
  intervention_mode?: InterventionMode;
  failure_diagnosis_path?: string;
  rerun_plan_path?: string;
  output_json_path?: string;
  output_markdown_path?: string;
  prior_result_summary?: JsonRecord;
  extra_instructions?: string[];
  evidence_dir?: string;
  ctx?: PluginHookToolContext;
}): OnlineIntervention {
  const evidenceDir = getEvidenceDir(params.ctx, params.evidence_dir);
  mkdirSync(evidenceDir, { recursive: true });

  const failureDiagnosisPath = params.failure_diagnosis_path ?? join(evidenceDir, "failure_diagnosis.json");
  const rerunPlanPath = params.rerun_plan_path ?? join(evidenceDir, "rerun_plan.md");
  const outputJsonPath = params.output_json_path ?? join(evidenceDir, "intervention.json");
  const outputMarkdownPath = params.output_markdown_path ?? join(evidenceDir, "intervention.md");

  const failureDiagnosis = readJsonIfRecord(failureDiagnosisPath);
  const rerunPlan = readTextIfExists(rerunPlanPath);
  const taskContract = readTaskContract(evidenceDir, failureDiagnosis);
  const registry = readToolCapabilityRegistry(evidenceDir);
  const evidenceRecords = readEvidenceRecords(evidenceDir);
  const failureTypes = stringArray(failureDiagnosis?.failure_types);
  const diagnosisStatus = stringField(failureDiagnosis?.status) ?? "unknown";
  const interventionMode = params.intervention_mode ?? defaultMode(failureTypes);
  const status = diagnosisStatus === "no_failure_detected" || failureTypes.length === 0
    ? "no_intervention_needed"
    : "active_intervention";
  const caseId = params.case_id
    ?? stringField(failureDiagnosis?.case_id)
    ?? stringField(taskContract.case_id)
    ?? stringField(taskContract.cipher)
    ?? "openclaw_case";

  const blockedClaims = buildBlockedClaims(failureTypes, status);
  const requiredActions = buildRequiredActions(failureTypes, interventionMode);
  const evidenceRequirements = buildEvidenceRequirements(failureTypes);
  const reportBoundaries = buildReportBoundaries(failureTypes, status);
  const promptPatch = renderPromptPatch({
    status,
    caseId,
    interventionMode,
    failureTypes,
    blockedClaims,
    requiredActions,
    evidenceRequirements,
    reportBoundaries,
    extraInstructions: params.extra_instructions ?? [],
  });

  const intervention: OnlineIntervention = {
    schema: "nss_evimem.online_intervention.v1",
    timestamp: utcNow(),
    case_id: caseId,
    status,
    intervention_mode: interventionMode,
    failure_types: failureTypes,
    severity: stringField(failureDiagnosis?.severity) ?? (status === "active_intervention" ? "medium" : "low"),
    task_contract: taskContract,
    prior_result_summary: params.prior_result_summary ?? {},
    evidence_summary: {
      tool_calls_recorded: evidenceRecords.length,
      registered_tools: Object.keys(registry).sort(),
      has_failure_diagnosis: failureDiagnosis !== null,
      has_rerun_plan: rerunPlan.length > 0,
    },
    blocked_claims: blockedClaims,
    required_actions: requiredActions,
    evidence_requirements: evidenceRequirements,
    report_boundaries: reportBoundaries,
    prompt_patch: promptPatch,
    source_files: {
      failure_diagnosis: failureDiagnosis === null ? null : failureDiagnosisPath,
      rerun_plan: rerunPlan.length === 0 ? null : rerunPlanPath,
    },
    output_files: {
      intervention_json: outputJsonPath,
      intervention_markdown: outputMarkdownPath,
    },
  };

  mkdirSync(dirname(outputJsonPath), { recursive: true });
  mkdirSync(dirname(outputMarkdownPath), { recursive: true });
  writeFileSync(outputJsonPath, stableStringify(intervention, 2), "utf8");
  writeFileSync(outputMarkdownPath, renderMarkdown({
    intervention,
    failureDiagnosis,
    rerunPlan,
    extraInstructions: params.extra_instructions ?? [],
  }), "utf8");

  return intervention;
}

function defaultMode(failureTypes: string[]): InterventionMode {
  return failureTypes.includes("overclaiming") && failureTypes.length === 1
    ? "report_boundary_prompt"
    : "online_repair_prompt";
}

function buildBlockedClaims(failureTypes: string[], status: OnlineIntervention["status"]): string[] {
  if (status === "no_intervention_needed") {
    return [];
  }

  const claims = new Set<string>([
    "Do not claim a verified final answer without fresh executable evidence.",
    "Do not describe a candidate as verified when multi-key or stronger verification is missing.",
  ]);
  if (failureTypes.includes("candidate_statistical_noise")) {
    claims.add("Do not present a single-key or quick-scan bias as a verified distinguisher.");
  }
  if (failureTypes.includes("search_timeout")) {
    claims.add("Do not treat a timeout, killed process, or no-output run as completed verification.");
  }
  if (failureTypes.includes("tool_contract_mismatch")) {
    claims.add("Do not use a tool outside its declared capability to support the task contract.");
  }
  if (failureTypes.includes("oracle_mismatch")) {
    claims.add("Do not assert oracle/reference alignment until the required fields match verified artifacts.");
  }
  return [...claims];
}

function buildRequiredActions(failureTypes: string[], mode: InterventionMode): string[] {
  if (mode === "report_boundary_prompt") {
    return [
      "Rewrite the final report with an explicit evidence boundary.",
      "State which claims are candidates, unverified, or unsupported.",
      "Call nss_evimem_diagnose_failure again before finalizing.",
    ];
  }

  const actions = new Set<string>([
    "Run a bounded staged rerun before finalizing.",
    "Reuse or rebuild the validated Task Contract.",
    "Register the exact executable tool capability for the rerun.",
    "Call nss_evimem_diagnose_failure again before the final answer.",
  ]);
  if (failureTypes.includes("candidate_statistical_noise")) {
    actions.add("Reject candidates that do not survive multi-key verification against the declared noise floor.");
  }
  if (failureTypes.includes("search_timeout")) {
    actions.add("Use hard per-phase limits and progress logging instead of an unbounded search.");
  }
  if (failureTypes.includes("tool_contract_mismatch")) {
    actions.add("Select a matching tool or downgrade the claim to the supported capability.");
  }
  if (failureTypes.includes("insufficient_evidence")) {
    actions.add("Record code, command, run log, result JSON, and verification boundary.");
  }
  return [...actions];
}

function buildEvidenceRequirements(failureTypes: string[]): string[] {
  const requirements = new Set<string>([
    "executable code or command transcript",
    "run log with exit status and timing",
    "machine-readable result JSON",
    "final report claim tied to the produced artifacts",
  ]);
  if (failureTypes.includes("candidate_statistical_noise")) {
    requirements.add("multi-key verification results with sample budget and noise floor");
  }
  if (failureTypes.includes("tool_contract_mismatch")) {
    requirements.add("validated task_contract.json and matching tool_capabilities.json entry");
  }
  return [...requirements];
}

function buildReportBoundaries(failureTypes: string[], status: OnlineIntervention["status"]): string[] {
  if (status === "no_intervention_needed") {
    return ["No active NSS-EviMem intervention is required."];
  }
  const boundaries = new Set<string>([
    "If verification remains incomplete, report a bounded failure instead of a correct answer.",
    "Separate exploratory candidates from verified cryptanalytic claims.",
  ]);
  if (failureTypes.includes("candidate_statistical_noise")) {
    boundaries.add("If the signal is at or below the noise floor, classify the candidate as statistical noise.");
  }
  if (failureTypes.includes("oracle_mismatch")) {
    boundaries.add("If oracle/reference alignment is absent, label the result as partially_correct or unverified.");
  }
  return [...boundaries];
}

function renderPromptPatch(params: {
  status: OnlineIntervention["status"];
  caseId: string;
  interventionMode: InterventionMode;
  failureTypes: string[];
  blockedClaims: string[];
  requiredActions: string[];
  evidenceRequirements: string[];
  reportBoundaries: string[];
  extraInstructions: string[];
}): string {
  if (params.status === "no_intervention_needed") {
    return "NSS-EviMem found no active failure diagnosis. Continue normally, but keep final claims tied to executable evidence.";
  }

  return [
    `NSS-EviMem online repair intervention is active for ${params.caseId}.`,
    `Mode: ${params.interventionMode}.`,
    `Failure types: ${params.failureTypes.length > 0 ? params.failureTypes.join(", ") : "none_recorded"}.`,
    "Do not claim a verified final answer unless fresh executable evidence satisfies the requirements below.",
    "",
    "Blocked claims:",
    ...params.blockedClaims.map((item) => `- ${item}`),
    "",
    "Required next actions:",
    ...params.requiredActions.map((item) => `- ${item}`),
    "",
    "Evidence required before finalizing:",
    ...params.evidenceRequirements.map((item) => `- ${item}`),
    "",
    "Final report boundary:",
    ...params.reportBoundaries.map((item) => `- ${item}`),
    ...(params.extraInstructions.length > 0
      ? ["", "Extra instructions:", ...params.extraInstructions.map((item) => `- ${item}`)]
      : []),
  ].join("\n");
}

function renderMarkdown(params: {
  intervention: OnlineIntervention;
  failureDiagnosis: JsonRecord | null;
  rerunPlan: string;
  extraInstructions: string[];
}): string {
  const { intervention, failureDiagnosis, rerunPlan, extraInstructions } = params;
  return [
    "# NSS-EviMem Online Repair Intervention",
    "",
    `Generated: ${intervention.timestamp}`,
    `Case: ${intervention.case_id}`,
    `Status: \`${intervention.status}\``,
    `Mode: \`${intervention.intervention_mode}\``,
    "",
    "## Failure Types",
    "",
    ...(intervention.failure_types.length > 0 ? intervention.failure_types.map((type) => `- ${type}`) : ["- none_recorded"]),
    "",
    "## Blocked Claims",
    "",
    ...(intervention.blocked_claims.length > 0 ? intervention.blocked_claims.map((claim) => `- ${claim}`) : ["- none"]),
    "",
    "## Required Actions",
    "",
    ...intervention.required_actions.map((action) => `- ${action}`),
    "",
    "## Evidence Requirements",
    "",
    ...intervention.evidence_requirements.map((requirement) => `- ${requirement}`),
    "",
    "## Report Boundaries",
    "",
    ...intervention.report_boundaries.map((boundary) => `- ${boundary}`),
    "",
    "## Prior Result Summary",
    "",
    "```json",
    stableStringify(intervention.prior_result_summary, 2),
    "```",
    "",
    "## Task Contract",
    "",
    "```json",
    stableStringify(intervention.task_contract, 2),
    "```",
    "",
    "## Evidence Signals",
    "",
    `- Tool calls recorded: ${intervention.evidence_summary.tool_calls_recorded}`,
    `- Failure diagnosis present: ${intervention.evidence_summary.has_failure_diagnosis}`,
    `- Rerun plan present: ${intervention.evidence_summary.has_rerun_plan}`,
    "- Registered tools:",
    ...(intervention.evidence_summary.registered_tools.length > 0
      ? intervention.evidence_summary.registered_tools.map((tool) => `- ${tool}`)
      : ["- none_recorded"]),
    "",
    "## Source Failure Diagnosis",
    "",
    "```json",
    stableStringify(failureDiagnosis ?? {}, 2),
    "```",
    "",
    "## Source Rerun Plan",
    "",
    rerunPlan.trim() || "No rerun plan was found.",
    "",
    "## Extra Instructions",
    "",
    ...(extraInstructions.length > 0 ? extraInstructions.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Prompt Patch",
    "",
    intervention.prompt_patch,
    "",
  ].join("\n");
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
