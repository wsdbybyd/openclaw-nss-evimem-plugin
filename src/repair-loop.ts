import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getEvidenceDir, isRecord, stableStringify, utcNow } from "./evidence-store.js";
import type { JsonRecord, PluginHookToolContext, TaskContract } from "./types.js";

type RepairFeedbackStatus = "repair_required" | "independent_verification_required" | "report_boundary_required";
type RepairAttemptStatus = "repair_required" | "independent_verification_required" | "report_boundary_required";

type RepairInstruction = {
  check_id: string;
  severity: string;
  reason: string;
  instruction: string;
};

export type RepairFeedback = {
  schema: "nss_evimem.repair_feedback.v1";
  timestamp: string;
  case_id: string;
  status: RepairFeedbackStatus;
  task_contract: TaskContract;
  prior_validation_fingerprint: string | null;
  max_attempts: number;
  attempts_recorded: number;
  remaining_attempts: number;
  failed_checks: RepairInstruction[];
  diagnosis_failure_types: string[];
  required_actions: string[];
  prohibited_actions: string[];
  requires_independent_verification: true;
  output_files: {
    repair_feedback: string;
    repair_feedback_events: string;
    repair_prompt: string;
  };
  prompt_patch: string;
};

export type RepairAttemptAssessment = {
  schema: "nss_evimem.repair_attempt_assessment.v1";
  timestamp: string;
  case_id: string;
  status: RepairAttemptStatus;
  attempt_number: number;
  max_attempts: number;
  remaining_attempts: number;
  fresh_validation: boolean;
  validation_status: string | null;
  failed_checks: string[];
  verified_correct: false;
  independent_verification_required: boolean;
  reasons: string[];
  attempt_summary: JsonRecord;
  output_files: {
    repair_attempt_assessment: string;
    repair_attempts: string;
  };
};

export function buildRepairFeedback(params: {
  case_id?: string;
  task_contract?: TaskContract;
  artifact_validation_path?: string;
  max_attempts?: number;
  evidence_dir?: string;
  ctx?: PluginHookToolContext;
}): RepairFeedback {
  const evidenceDir = getEvidenceDir(params.ctx, params.evidence_dir);
  mkdirSync(evidenceDir, { recursive: true });

  const validationPath = params.artifact_validation_path ?? join(evidenceDir, "artifact_claim_validation.json");
  const validation = readJsonIfRecord(validationPath);
  const previousFeedback = readJsonIfRecord(join(evidenceDir, "repair_feedback.json"));
  const attempts = readJsonl(join(evidenceDir, "repair_attempts.jsonl"));
  const taskContract = params.task_contract ?? recordField(validation, "task_contract") ?? {};
  const caseId = params.case_id
    ?? stringField(validation?.case_id)
    ?? stringField(taskContract.case_id)
    ?? "openclaw_case";
  const maxAttempts = boundedAttempts(params.max_attempts ?? numberField(previousFeedback?.max_attempts) ?? 2);
  const validationFingerprint = validation === null ? null : fingerprint(validation);
  const failedChecks = failedCheckInstructions(validation);
  const diagnosis = readJsonIfRecord(join(evidenceDir, "failure_diagnosis.json"));
  const diagnosisFailureTypes = stringArray(diagnosis?.failure_types);
  const remainingAttempts = Math.max(0, maxAttempts - attempts.length);
  const supportsVerifiedClaim = validation?.supports_verified_claim === true;
  const status: RepairFeedbackStatus = validation === null || (failedChecks.length > 0 && remainingAttempts === 0)
    ? "report_boundary_required"
    : supportsVerifiedClaim
      ? "independent_verification_required"
      : "repair_required";
  const outputFiles = {
    repair_feedback: join(evidenceDir, "repair_feedback.json"),
    repair_feedback_events: join(evidenceDir, "repair_feedback_events.jsonl"),
    repair_prompt: join(evidenceDir, "repair_prompt.md"),
  };
  const feedback: RepairFeedback = {
    schema: "nss_evimem.repair_feedback.v1",
    timestamp: utcNow(),
    case_id: caseId,
    status,
    task_contract: taskContract,
    prior_validation_fingerprint: validationFingerprint,
    max_attempts: maxAttempts,
    attempts_recorded: attempts.length,
    remaining_attempts: remainingAttempts,
    failed_checks: failedChecks,
    diagnosis_failure_types: diagnosisFailureTypes,
    required_actions: requiredActions(status, failedChecks),
    prohibited_actions: prohibitedActions(),
    requires_independent_verification: true,
    output_files: outputFiles,
    prompt_patch: renderPromptPatch(status, failedChecks, remainingAttempts),
  };

  writeFileSync(outputFiles.repair_feedback, stableStringify(feedback, 2), "utf8");
  appendFileSync(outputFiles.repair_feedback_events, `${stableStringify(feedback)}\n`, "utf8");
  writeFileSync(outputFiles.repair_prompt, renderRepairPrompt(feedback), "utf8");
  return feedback;
}

export function assessRepairAttempt(params: {
  repair_feedback_path?: string;
  artifact_validation_path?: string;
  attempt_summary?: JsonRecord;
  evidence_dir?: string;
  ctx?: PluginHookToolContext;
}): RepairAttemptAssessment {
  const evidenceDir = getEvidenceDir(params.ctx, params.evidence_dir);
  mkdirSync(evidenceDir, { recursive: true });

  const feedbackPath = params.repair_feedback_path ?? join(evidenceDir, "repair_feedback.json");
  const validationPath = params.artifact_validation_path ?? join(evidenceDir, "artifact_claim_validation.json");
  const feedback = readJsonIfRecord(feedbackPath);
  const validation = readJsonIfRecord(validationPath);
  const attemptsPath = join(evidenceDir, "repair_attempts.jsonl");
  const attempts = readJsonl(attemptsPath);
  const maxAttempts = boundedAttempts(numberField(feedback?.max_attempts) ?? 2);
  const failedChecks = stringArray(validation?.failures);
  const outputFiles = {
    repair_attempt_assessment: join(evidenceDir, "repair_attempt_assessment.json"),
    repair_attempts: attemptsPath,
  };
  const feedbackFingerprint = stringField(feedback?.prior_validation_fingerprint);
  const currentFingerprint = validation === null ? null : fingerprint(validation);
  const freshValidation = feedback !== null && currentFingerprint !== null && currentFingerprint !== feedbackFingerprint;
  const attemptNumber = freshValidation ? attempts.length + 1 : attempts.length;
  const remainingAttempts = Math.max(0, maxAttempts - attemptNumber);
  const caseId = stringField(feedback?.case_id) ?? stringField(validation?.case_id) ?? "openclaw_case";
  const validationStatus = stringField(validation?.status) ?? null;
  const reasons = assessmentReasons({ feedback, validation, freshValidation, failedChecks, remainingAttempts });
  const status = assessmentStatus({ feedback, validation, freshValidation, remainingAttempts });
  const assessment: RepairAttemptAssessment = {
    schema: "nss_evimem.repair_attempt_assessment.v1",
    timestamp: utcNow(),
    case_id: caseId,
    status,
    attempt_number: attemptNumber,
    max_attempts: maxAttempts,
    remaining_attempts: remainingAttempts,
    fresh_validation: freshValidation,
    validation_status: validationStatus,
    failed_checks: failedChecks,
    verified_correct: false,
    independent_verification_required: status === "independent_verification_required",
    reasons,
    attempt_summary: params.attempt_summary ?? {},
    output_files: outputFiles,
  };

  writeFileSync(outputFiles.repair_attempt_assessment, stableStringify(assessment, 2), "utf8");
  if (freshValidation) appendFileSync(outputFiles.repair_attempts, `${stableStringify(assessment)}\n`, "utf8");
  return assessment;
}

function failedCheckInstructions(validation: JsonRecord | null): RepairInstruction[] {
  const failed = new Set(stringArray(validation?.failures));
  const checks = Array.isArray(validation?.checks) ? validation.checks : [];
  return checks
    .filter(isRecord)
    .filter((check) => failed.has(stringField(check.id) ?? ""))
    .map((check) => {
      const checkId = stringField(check.id) ?? "unclassified_validation_failure";
      const reason = stringField(check.reason) ?? "The current artifact does not satisfy a required public verification check.";
      return {
        check_id: checkId,
        severity: stringField(check.severity) ?? "medium",
        reason,
        instruction: instructionForCheck(checkId, reason),
      };
    });
}

function instructionForCheck(checkId: string, reason: string): string {
  if (checkId === "simon_and_difference_semantics") {
    return "You must not encode the AND output difference as the bitwise AND of input differences. Do not use gamma <= alpha, gamma <= beta, gamma >= alpha + beta - 1 as the differential transition. Rebuild the model with a sound SIMON AND-difference relation that preserves base-state dependence and rotation correlation.";
  }
  if (checkId === "simon_and_state_value_linkage") {
    return "Bind the value variables to the rotated SIMON round-state bits, or replace them with a reviewed transition relation that already captures this dependency. Do not leave u/v-style actual-state variables unconstrained while using them to define the AND output difference or its probability.";
  }
  if (checkId === "simon_and_weight_proxy") {
    return "Do not use an any-active-AND-input proxy as differential weight. Replace weight >= and_in1 and weight >= and_in2 objective logic with a reviewed SIMON AND transition formulation whose objective is derived from the transition probability, and provide executable evidence for that formulation.";
  }
  return `Repair this failed requirement in fresh artifacts: ${reason}`;
}

function requiredActions(status: RepairFeedbackStatus, failedChecks: RepairInstruction[]): string[] {
  if (status === "independent_verification_required") {
    return ["Submit the fresh artifacts to an independently configured trusted verifier before making any correctness claim."];
  }
  if (status === "report_boundary_required") {
    return ["Report the evidence boundary and do not promote the current result to a verified claim."];
  }
  return [
    ...failedChecks.map((check) => check.instruction),
    "Write a fresh result artifact, report, source artifact, and execution log for the repaired attempt.",
    "Call nss_evimem_validate_artifact_claims on the fresh artifacts, then call nss_evimem_assess_repair_attempt.",
  ];
}

function prohibitedActions(): string[] {
  return [
    "Do not relabel the previous result as repaired without producing fresh artifacts and a fresh validation record.",
    "Do not claim verified_correct or oracle correctness from an Agent-authored repair.",
    "Do not weaken the Task Contract or verification profile to bypass a failed check.",
  ];
}

function renderPromptPatch(status: RepairFeedbackStatus, failedChecks: RepairInstruction[], remainingAttempts: number): string {
  if (status === "independent_verification_required") {
    return "NSS-EviMem found a fresh artifact validation that is eligible for review. Do not call the answer correct. Submit the artifacts to an independent trusted verifier and report only its recorded outcome.";
  }
  if (status === "report_boundary_required") {
    return "NSS-EviMem cannot authorize another repair attempt. Report a bounded failure with the failed checks and preserve the evidence directory; do not claim a correct answer.";
  }
  return [
    "NSS-EviMem repair is required before finalizing.",
    ...failedChecks.map((check) => `- ${check.instruction}`),
    `- Remaining repair attempts: ${remainingAttempts}.`,
    "- Produce fresh artifacts, validate them, and assess the repair attempt.",
    "- Do not claim verified_correct; an independent verifier is still required.",
  ].join("\n");
}

function renderRepairPrompt(feedback: RepairFeedback): string {
  return [
    "# NSS-EviMem Repair Feedback",
    "",
    `Case: ${feedback.case_id}`,
    `Status: ${feedback.status}`,
    `Remaining attempts: ${feedback.remaining_attempts}`,
    "",
    "## Agent Instruction",
    "",
    feedback.prompt_patch,
    "",
    "## Prohibited Actions",
    "",
    ...feedback.prohibited_actions.map((action) => `- ${action}`),
    "",
  ].join("\n");
}

function assessmentStatus(params: {
  feedback: JsonRecord | null;
  validation: JsonRecord | null;
  freshValidation: boolean;
  remainingAttempts: number;
}): RepairAttemptStatus {
  if (params.feedback === null || params.validation === null) return "report_boundary_required";
  if (!params.freshValidation) return "repair_required";
  if (params.validation.supports_verified_claim === true) return "independent_verification_required";
  return params.remainingAttempts > 0 ? "repair_required" : "report_boundary_required";
}

function assessmentReasons(params: {
  feedback: JsonRecord | null;
  validation: JsonRecord | null;
  freshValidation: boolean;
  failedChecks: string[];
  remainingAttempts: number;
}): string[] {
  if (params.feedback === null) return ["No repair feedback record exists. Build repair feedback from a failed validation before assessing a repair."];
  if (params.validation === null) return ["No artifact validation record exists for the repaired attempt."];
  if (!params.freshValidation) return ["The validation record is unchanged from the one that created repair feedback. Produce fresh artifacts and rerun validation before assessing a repair."];
  if (params.validation.supports_verified_claim === true) return ["The fresh artifact passes public claim validation but still requires an independent trusted verifier. NSS-EviMem does not mark it oracle-correct."];
  if (params.remainingAttempts === 0) return ["The fresh repair attempt still failed validation and exhausted the retry budget."];
  return params.failedChecks.length > 0
    ? [`The fresh repair attempt still fails: ${params.failedChecks.join(", ")}.`]
    : ["The fresh repair attempt does not support a verified claim."];
}

function boundedAttempts(value: number): number {
  return Math.max(1, Math.min(3, Math.floor(value)));
}

function fingerprint(value: JsonRecord): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function readJsonIfRecord(path: string): JsonRecord | null {
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function readJsonl(path: string): JsonRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        return isRecord(value) ? [value] : [];
      } catch {
        return [];
      }
    });
}

function recordField(record: JsonRecord | null, field: string): JsonRecord | null {
  return record !== null && isRecord(record[field]) ? record[field] : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
