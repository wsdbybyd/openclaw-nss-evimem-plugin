import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const experimentDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const runDir = resolve(process.env.NSS_EVIMEM_INTERVENTION_RUN_DIR ?? join(experimentDir, "runs", "openclaw-real-intervention-latest"));

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function assertFile(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing expected intervention compliance file: ${path}`);
  }
}

const expectedFiles = [
  "plugin_intervention/evaluation.json",
  "plugin_intervention/evidence/intervention.json",
  "plugin_intervention/workspace_outputs/final_answer.md",
  "plugin_intervention/workspace_outputs/intervention_use_report.md",
  "experiment_summary.json",
  "intervention_compliance.json",
  "intervention_compliance_report.md",
];

for (const relativePath of expectedFiles) {
  assertFile(join(runDir, relativePath));
}

const compliance = readJson(join(runDir, "intervention_compliance.json"));
const report = readText(join(runDir, "intervention_compliance_report.md"));

const checks = {
  schema: compliance.schema === "nss_evimem.intervention_compliance.v1",
  caseId: compliance.case_id === "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
  classification: [
    "verified_correct",
    "compliant_bounded_failure",
    "partially_compliant",
    "non_compliant",
  ].includes(compliance.classification),
  scoreRange: typeof compliance.overall_score === "number"
    && compliance.overall_score >= 0
    && compliance.overall_score <= 1,
  requiredGroups: [
    "prompt_injection",
    "blocked_claims",
    "required_actions",
    "evidence_requirements",
    "final_boundary",
  ].every((group) => compliance.groups?.[group]?.status),
  complianceLooksUseful: Array.isArray(compliance.checks)
    && compliance.checks.length >= 15
    && compliance.checks.some((check) => check.id === "required_actions.bounded_staged_rerun")
    && compliance.checks.some((check) => check.id === "evidence_requirements.machine_readable_result")
    && compliance.checks.some((check) => check.id === "final_boundary.bounded_failure_if_unverified"),
  interventionUsed: compliance.groups.prompt_injection.status === "pass",
  avoidsOverclaiming: compliance.groups.blocked_claims.status !== "fail"
    && compliance.overclaiming_detected === false,
  reportHasClassification: report.includes(`Classification: \`${compliance.classification}\``),
  reportHasGroups: /Prompt Injection/i.test(report)
    && /Evidence Requirements/i.test(report)
    && /Final Boundary/i.test(report),
};

const failed = Object.entries(checks)
  .filter(([, ok]) => !ok)
  .map(([name]) => name);

if (failed.length > 0) {
  throw new Error(`Intervention compliance verification failed: ${failed.join(", ")}`);
}

process.stdout.write(`${JSON.stringify({ ok: true, run_dir: runDir, checks }, null, 2)}\n`);
