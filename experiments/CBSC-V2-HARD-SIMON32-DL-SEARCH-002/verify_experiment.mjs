import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const experimentDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const runDir = join(experimentDir, "runs", "latest");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function assertFile(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing expected experiment file: ${path}`);
  }
}

const expectedFiles = [
  "baseline/final_answer.md",
  "baseline/evaluation.json",
  "plugin/case_command.log",
  "plugin/run_summary.json",
  "plugin/case_evaluation.json",
  "plugin/evaluation_report.md",
  "experiment_summary.json",
  "experiment_report.md",
  "comparison_matrix.csv",
];

for (const relativePath of expectedFiles) {
  assertFile(join(runDir, relativePath));
}

const summary = readJson(join(runDir, "experiment_summary.json"));
const baseline = readJson(join(runDir, "baseline", "evaluation.json"));
const plugin = readJson(join(runDir, "plugin", "case_evaluation.json"));
const report = readText(join(runDir, "experiment_report.md"));

const checks = {
  summaryOk: summary.ok === true,
  caseIdMatches: summary.case_id === "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
  baselineNoPlugin: baseline.mode === "no_plugin_text_answer",
  baselineEvidenceNone: baseline.evidence_completeness === "none",
  baselineNotEvaluable: baseline.final_correctness === "not_evaluable",
  baselineOverclaimDetected: baseline.overclaiming_detected === true,
  pluginEvidenceComplete: plugin.evidence_completeness === "complete",
  pluginContractValid: plugin.contract_valid === true,
  pluginToolMatch: plugin.tool_semantic_match === true,
  pluginClaimBoundaryOk: plugin.claim_boundary_ok === true,
  comparisonRecordsImprovement: summary.comparison.evidence_completeness_delta === "none_to_complete",
  comparisonRecordsLimitations: summary.comparison.plugin_detected_limitations === true,
  reportHasBothArms: /Baseline/i.test(report) && /Plugin/i.test(report),
};

const failed = Object.entries(checks)
  .filter(([, ok]) => !ok)
  .map(([name]) => name);

if (failed.length > 0) {
  throw new Error(`Experiment verification failed: ${failed.join(", ")}`);
}

process.stdout.write(`${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
