import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getEvidenceDir, isRecord, readEvidenceRecords, stableStringify, utcNow } from "./evidence-store.js";
import { readToolCapabilityRegistry } from "./tool-capability-registry.js";
import type { JsonRecord, PluginHookToolContext, TaskContract } from "./types.js";

export type FailureType =
  | "search_timeout"
  | "candidate_statistical_noise"
  | "oracle_mismatch"
  | "insufficient_evidence"
  | "artifact_claim_invalid"
  | "task_contract_unvalidated"
  | "tool_capability_missing"
  | "tool_contract_mismatch"
  | "overclaiming";

export type FailureDiagnosis = {
  schema: "nss_evimem.failure_diagnosis.v1";
  timestamp: string;
  case_id: string;
  status: "needs_rerun" | "needs_report_boundary" | "no_failure_detected";
  severity: "low" | "medium" | "high";
  failure_types: FailureType[];
  reasons: string[];
  corrective_actions: Array<{
    failure_type: FailureType;
    action: string;
    rationale: string;
  }>;
  task_contract: TaskContract;
  run_summary: JsonRecord;
  observations: string[];
  evidence_summary: {
    tool_calls_recorded: number;
    registered_tools: string[];
    valid_contract_recorded: boolean;
    guard_events_recorded: number;
    artifact_claim_validation_status: string | null;
  };
  output_files: {
    failure_diagnosis: string;
    failure_diagnosis_events: string;
    rerun_plan: string;
  };
};

export function diagnoseFailure(params: {
  case_id?: string;
  task_contract?: TaskContract;
  run_summary?: JsonRecord;
  observations?: string[];
  ctx?: PluginHookToolContext;
  evidence_dir?: string;
}): FailureDiagnosis {
  const evidenceDir = getEvidenceDir(params.ctx, params.evidence_dir);
  mkdirSync(evidenceDir, { recursive: true });

  const taskContract = params.task_contract ?? readTaskContract(evidenceDir);
  const runSummary = params.run_summary ?? {};
  const observations = params.observations ?? [];
  const evidenceRecords = readEvidenceRecords(evidenceDir);
  const contractEvents = readJsonl(join(evidenceDir, "contract_validation_events.jsonl"));
  const guardEvents = readJsonl(join(evidenceDir, "tool_guard_events.jsonl"));
  const artifactClaimValidation = readJsonIfRecord(join(evidenceDir, "artifact_claim_validation.json"));
  const registry = readToolCapabilityRegistry(evidenceDir);

  const failureTypes = detectFailureTypes({
    taskContract,
    runSummary,
    observations,
    evidenceRecords,
    contractEvents,
    guardEvents,
    artifactClaimValidation,
    registeredToolNames: Object.keys(registry),
  });
  const reasons = buildReasons(failureTypes, runSummary, observations, artifactClaimValidation);
  const diagnosisPath = join(evidenceDir, "failure_diagnosis.json");
  const diagnosisEventsPath = join(evidenceDir, "failure_diagnosis_events.jsonl");
  const rerunPlanPath = join(evidenceDir, "rerun_plan.md");

  const diagnosis: FailureDiagnosis = {
    schema: "nss_evimem.failure_diagnosis.v1",
    timestamp: utcNow(),
    case_id: params.case_id ?? String(taskContract.case_id ?? taskContract.cipher ?? "openclaw_case"),
    status: diagnosisStatus(failureTypes),
    severity: diagnosisSeverity(failureTypes),
    failure_types: failureTypes,
    reasons,
    corrective_actions: buildCorrectiveActions(failureTypes),
    task_contract: taskContract,
    run_summary: runSummary,
    observations,
    evidence_summary: {
      tool_calls_recorded: evidenceRecords.length,
      registered_tools: Object.keys(registry).sort(),
      valid_contract_recorded: hasValidContractEvent(contractEvents),
      guard_events_recorded: guardEvents.length,
      artifact_claim_validation_status: typeof artifactClaimValidation?.status === "string"
        ? artifactClaimValidation.status
        : null,
    },
    output_files: {
      failure_diagnosis: diagnosisPath,
      failure_diagnosis_events: diagnosisEventsPath,
      rerun_plan: rerunPlanPath,
    },
  };

  writeFileSync(diagnosisPath, stableStringify(diagnosis, 2), "utf8");
  appendFileSync(diagnosisEventsPath, `${stableStringify(diagnosis)}\n`, "utf8");
  writeFileSync(rerunPlanPath, renderRerunPlan(diagnosis), "utf8");
  return diagnosis;
}

function detectFailureTypes(params: {
  taskContract: TaskContract;
  runSummary: JsonRecord;
  observations: string[];
  evidenceRecords: JsonRecord[];
  contractEvents: JsonRecord[];
  guardEvents: JsonRecord[];
  artifactClaimValidation: JsonRecord | null;
  registeredToolNames: string[];
}): FailureType[] {
  const failures = new Set<FailureType>();
  const text = evidenceText(params.runSummary, params.observations, params.evidenceRecords);

  if (containsAny(text, ["timeout", "timed out", "etimedout", "sigterm", "killed", "no new output"])) {
    failures.add("search_timeout");
  }
  if (containsAny(text, ["statistical noise", "bias vanished", "vanished under", "false positive", "near 0"])) {
    failures.add("candidate_statistical_noise");
  }
  if (isPartialOrFailed(params.runSummary) || oracleAlignmentFailed(params.runSummary)) {
    failures.add("oracle_mismatch");
  }
  if (evidenceIsInsufficient(params.runSummary, params.evidenceRecords)) {
    failures.add("insufficient_evidence");
  }
  if (artifactClaimValidationFailed(params.artifactClaimValidation)) {
    failures.add("artifact_claim_invalid");
  }
  if (!hasValidContractEvent(params.contractEvents)) {
    failures.add("task_contract_unvalidated");
  }
  if (params.registeredToolNames.length === 0) {
    failures.add("tool_capability_missing");
  }
  if (hasRelevantGuardMismatch(params.guardEvents, params.taskContract)) {
    failures.add("tool_contract_mismatch");
  }
  if (params.runSummary.overclaiming_detected === true || params.runSummary.claim_boundary_ok === false) {
    failures.add("overclaiming");
  }

  return [...failures].sort();
}

function buildReasons(
  failureTypes: FailureType[],
  runSummary: JsonRecord,
  observations: string[],
  artifactClaimValidation: JsonRecord | null,
): string[] {
  const reasons: string[] = [];
  for (const type of failureTypes) {
    if (type === "search_timeout") {
      reasons.push("A tool or agent run showed timeout/kill/no-output symptoms.");
    } else if (type === "candidate_statistical_noise") {
      reasons.push("Candidate bias disappeared or was near zero under stronger verification.");
    } else if (type === "oracle_mismatch") {
      reasons.push("The reported result did not align with the expected final-answer checks.");
    } else if (type === "insufficient_evidence") {
      reasons.push("The run lacks complete structured evidence for the final claim.");
    } else if (type === "artifact_claim_invalid") {
      const failures = Array.isArray(artifactClaimValidation?.failures)
        ? artifactClaimValidation.failures.join(", ")
        : "unknown checks";
      reasons.push(`Artifact claim validation failed: ${failures}.`);
    } else if (type === "task_contract_unvalidated") {
      reasons.push("No valid Task Contract validation event was found in this evidence directory.");
    } else if (type === "tool_capability_missing") {
      reasons.push("No Tool Capability Registry record was found for this evidence directory.");
    } else if (type === "tool_contract_mismatch") {
      reasons.push("A relevant guard event recorded a contract/capability mismatch.");
    } else if (type === "overclaiming") {
      reasons.push("The final claim boundary is unsafe or overclaims the evidence.");
    }
  }

  if (typeof runSummary.final_correctness === "string") {
    reasons.push(`final_correctness=${runSummary.final_correctness}`);
  }
  for (const observation of observations.slice(0, 3)) {
    reasons.push(`observation: ${observation}`);
  }
  return reasons;
}

function buildCorrectiveActions(failureTypes: FailureType[]): FailureDiagnosis["corrective_actions"] {
  const actions: Record<FailureType, Omit<FailureDiagnosis["corrective_actions"][number], "failure_type">> = {
    search_timeout: {
      action: "Use a bounded staged rerun: fast scan, progress logging, hard per-phase limits, then deep verification only for survivors.",
      rationale: "Timeouts should change the search schedule, not silently remove the evidence boundary.",
    },
    candidate_statistical_noise: {
      action: "Reject candidates unless they survive multi-key verification with confidence intervals and a predeclared sample budget.",
      rationale: "A high quick-scan bias can be sampling noise and must not be promoted as a distinguisher.",
    },
    oracle_mismatch: {
      action: "Regenerate the final answer from verified artifacts and explicitly fill input difference, output mask, split, and weight fields.",
      rationale: "A structured final-answer pass needs the required cryptanalytic fields, not only exploratory scripts.",
    },
    insufficient_evidence: {
      action: "Record code, command, run log, result JSON, and verification boundary before writing the final report.",
      rationale: "Evidence completeness is what makes the claim auditable.",
    },
    artifact_claim_invalid: {
      action: "Call nss_evimem_validate_artifact_claims after rerun artifacts are produced, then downgrade or rerun until failed checks are cleared.",
      rationale: "A verified claim requires artifacts that satisfy the task-specific claim qualification checks.",
    },
    task_contract_unvalidated: {
      action: "Call nss_evimem_validate_contract before tool execution and save the valid contract in task_contract.json.",
      rationale: "The plugin cannot diagnose task/tool scope safely without a validated contract.",
    },
    tool_capability_missing: {
      action: "Call nss_evimem_register_tool_capability for the exact executable method used in the next run.",
      rationale: "The guard layer needs a capability declaration to detect scope mismatch.",
    },
    tool_contract_mismatch: {
      action: "Either select a matching tool or downgrade the claim to the capability actually supported.",
      rationale: "A mismatch means the current tool cannot support the intended task contract as stated.",
    },
    overclaiming: {
      action: "Rewrite the report as a bounded candidate/negative result and state every unverified assumption.",
      rationale: "Claim wording must track evidence strength.",
    },
  };

  return failureTypes.map((failureType) => ({
    failure_type: failureType,
    ...actions[failureType],
  }));
}

function renderRerunPlan(diagnosis: FailureDiagnosis): string {
  const contractSummary = stableStringify(diagnosis.task_contract, 2);
  const actionLines = diagnosis.corrective_actions
    .map((item) => `- ${item.action}\n  Rationale: ${item.rationale}`)
    .join("\n");
  return [
    "# NSS-EviMem Failure Rerun Plan",
    "",
    `Generated: ${diagnosis.timestamp}`,
    `Case: ${diagnosis.case_id}`,
    `Status: ${diagnosis.status}`,
    `Severity: ${diagnosis.severity}`,
    "",
    "## Failure Types",
    "",
    ...diagnosis.failure_types.map((type) => `- ${type}`),
    "",
    "## Rerun Checklist",
    "",
    "- Use the existing validated Task Contract from `task_contract.json` when present.",
    "- Re-register the executable tool capability before running the search.",
    "- Run a bounded fast scan first, then deep verification only for surviving candidates.",
    "- Call `nss_evimem_validate_artifact_claims` before promoting any verified final claim.",
    "- Treat disappearing bias or near-zero multi-key bias as statistical noise.",
    "- Write code, command, run log, result JSON, and final report before claiming success.",
    "- If verification remains incomplete, report a bounded failure instead of a correct final answer.",
    "",
    "## Corrective Actions",
    "",
    actionLines || "- No corrective action required.",
    "",
    "## Task Contract",
    "",
    "```json",
    contractSummary,
    "```",
    "",
    "## Suggested Agent Prompt Patch",
    "",
    "Before finalizing, call `nss_evimem_diagnose_failure` with the current run summary. If it returns `needs_rerun`, execute the rerun checklist above or explicitly report the evidence boundary.",
    "",
  ].join("\n");
}

function diagnosisStatus(failureTypes: FailureType[]): FailureDiagnosis["status"] {
  if (failureTypes.length === 0) {
    return "no_failure_detected";
  }
  if (failureTypes.includes("overclaiming") && failureTypes.length === 1) {
    return "needs_report_boundary";
  }
  return "needs_rerun";
}

function diagnosisSeverity(failureTypes: FailureType[]): FailureDiagnosis["severity"] {
  if (failureTypes.some((type) => ["artifact_claim_invalid", "oracle_mismatch", "overclaiming", "search_timeout"].includes(type))) {
    return "high";
  }
  if (failureTypes.length > 0) {
    return "medium";
  }
  return "low";
}

function readTaskContract(evidenceDir: string): TaskContract {
  const path = join(evidenceDir, "task_contract.json");
  const parsed = readJsonIfRecord(path);
  return parsed ?? {};
}

function readJsonIfRecord(path: string): JsonRecord | null {
  if (!existsSync(path)) {
    return null;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return isRecord(parsed) ? parsed : null;
}

function readJsonl(path: string): JsonRecord[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isRecord);
}

function hasValidContractEvent(events: JsonRecord[]): boolean {
  return events.some((event) => event.ok === true && event.status === "valid_contract");
}

function hasRelevantGuardMismatch(events: JsonRecord[], taskContract: TaskContract): boolean {
  return events.some((event) => {
    if (!Array.isArray(event.reasons) || event.reasons.length === 0) {
      return false;
    }
    if (typeof event.decision !== "string" || event.decision === "allow") {
      return false;
    }
    return isRecord(event.task_contract) && contractsOverlap(event.task_contract, taskContract);
  });
}

function contractsOverlap(a: JsonRecord, b: TaskContract): boolean {
  for (const field of ["domain", "analysis_type", "cipher", "rounds", "objective"]) {
    if (a[field] !== undefined && b[field] !== undefined && stableStringify(a[field]) === stableStringify(b[field])) {
      return true;
    }
  }
  return false;
}

function evidenceIsInsufficient(runSummary: JsonRecord, evidenceRecords: JsonRecord[]): boolean {
  const completeness = String(runSummary.evidence_completeness ?? "").toLowerCase();
  if (completeness === "none" || completeness === "partial") {
    return true;
  }
  return evidenceRecords.length === 0 && completeness !== "complete_or_structured";
}

function isPartialOrFailed(runSummary: JsonRecord): boolean {
  const correctness = String(runSummary.final_correctness ?? "").toLowerCase();
  return (
    correctness.includes("partial")
    || correctness.includes("insufficient")
    || correctness.includes("failed")
    || correctness.includes("not_evaluable")
  );
}

function oracleAlignmentFailed(runSummary: JsonRecord): boolean {
  const oracle = runSummary.oracle_alignment;
  if (!isRecord(oracle)) {
    return false;
  }
  return (
    oracle.paper_pair_match === false
    || oracle.reference_pair_match === false
    || oracle.best_split_mentioned === false
  );
}

function artifactClaimValidationFailed(validation: JsonRecord | null): boolean {
  if (!validation) {
    return false;
  }
  return validation.ok === false
    || validation.supports_verified_claim === false
    || validation.status === "failed";
}

function evidenceText(runSummary: JsonRecord, observations: string[], evidenceRecords: JsonRecord[]): string {
  return [
    stableStringify(runSummary),
    observations.join("\n"),
    ...evidenceRecords.map((record) => stableStringify(record)),
  ].join("\n").toLowerCase();
}

function containsAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}
