import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const experimentDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const runDir = join(experimentDir, "runs", "openclaw-all-groups-isolated-latest");

const arms = [
  "baseline",
  "evidence_only",
  "contract_capability",
  "full_intervention",
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function assertFile(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing expected NL-X01 all-groups experiment file: ${path}`);
  }
}

for (const arm of arms) {
  for (const relativePath of [
    `${arm}/prompt.md`,
    `${arm}/openclaw_stdout.json`,
    `${arm}/openclaw_stderr.log`,
    `${arm}/openclaw_exit_code.txt`,
    `${arm}/evaluation.json`,
  ]) {
    assertFile(join(runDir, relativePath));
  }
}

for (const arm of ["evidence_only", "contract_capability", "full_intervention"]) {
  assertFile(join(runDir, arm, "evidence", "tool_calls.jsonl"));
}

assertFile(join(runDir, "question.md"));
assertFile(join(runDir, "experiment_summary.json"));
assertFile(join(runDir, "experiment_report.md"));
assertFile(join(runDir, "comparison_matrix.csv"));
assertFile(join(runDir, "full_intervention", "evidence", "artifact_claim_validation.json"));
assertFile(join(runDir, "full_intervention", "evidence", "failure_diagnosis.json"));

const summary = readJson(join(runDir, "experiment_summary.json"));
const report = readText(join(runDir, "experiment_report.md"));
const evaluations = Object.fromEntries(
  arms.map((arm) => [arm, readJson(join(runDir, arm, "evaluation.json"))]),
);
const artifactValidation = readJson(join(runDir, "full_intervention", "evidence", "artifact_claim_validation.json"));
const artifactTaskContract = JSON.stringify(artifactValidation.task_contract ?? null);

const allowedCorrectness = [
  "verified_correct",
  "answer_matches_oracle_with_weak_evidence",
  "partially_correct_or_insufficient",
  "not_evaluable",
  "agent_run_failed",
  "protocol_violation",
];

const checks = {
  summarySchema: summary.schema === "nss_evimem.nl_x01_all_groups_summary.v1",
  caseIdMatches: summary.case_id === "CBSC-V2-NL-X01",
  hasFourArms: arms.every((arm) => typeof summary.arms?.[arm] === "object"),
  modesMatch: arms.every((arm) => evaluations[arm].mode === arm),
  allAttempted: arms.every((arm) => typeof evaluations[arm].openclaw_exit_code === "number"
    || typeof evaluations[arm].openclaw_signal === "string"
    || typeof evaluations[arm].openclaw_error === "string"),
  correctnessLabels: arms.every((arm) => allowedCorrectness.includes(evaluations[arm].final_correctness)),
  contaminationChecksPresent: arms.every((arm) => typeof evaluations[arm].cross_group_contamination_detected === "boolean"
    && Array.isArray(evaluations[arm].cross_group_contamination_hits)),
  oracleChecksPresent: arms.every((arm) => typeof evaluations[arm].oracle_alignment?.exact_metric_match === "boolean"),
  evidenceOnlyImportedMemory: evaluations.evidence_only.evidence_memory_imported >= 24,
  contractGroupHasContract: evaluations.contract_capability.contract_valid === true,
  fullInterventionHasArtifactValidation: artifactValidation.schema === "nss_evimem.artifact_claim_validation.v2",
  fullInterventionUsesDifferentialProfile: artifactValidation.verification_profile?.id === "differential_metric_v1",
  artifactValidationSeparatesOracle: artifactValidation.verification_scope === "evidence_eligibility_not_oracle_correctness",
  fullInterventionClaimLevelRecorded: ["verified", "bounded", "candidate", "reject"].includes(artifactValidation.recommended_claim_level),
  oracleRemainsOffline: !artifactTaskContract.includes(summary.oracle_expected?.probability),
  reportMentionsAllGroups: /Baseline/i.test(report)
    && /Evidence-only/i.test(report)
    && /Contract\+Capability/i.test(report)
    && /Full Intervention/i.test(report),
};

const failed = Object.entries(checks)
  .filter(([, ok]) => !ok)
  .map(([name]) => name);

if (failed.length > 0) {
  throw new Error(`NL-X01 all-groups experiment verification failed: ${failed.join(", ")}`);
}

process.stdout.write(`${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
