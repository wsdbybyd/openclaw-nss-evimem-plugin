import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const experimentDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const runDir = join(experimentDir, "runs", "openclaw-real-rerun-latest");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function assertFile(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing expected real OpenClaw rerun experiment file: ${path}`);
  }
}

const expectedFiles = [
  "baseline/evaluation.json",
  "plugin_pass1/evaluation.json",
  "plugin_pass1/evidence/failure_diagnosis.json",
  "plugin_pass1/evidence/rerun_plan.md",
  "plugin_rerun/prompt.md",
  "plugin_rerun/openclaw_stdout.json",
  "plugin_rerun/openclaw_stderr.log",
  "plugin_rerun/openclaw_exit_code.txt",
  "plugin_rerun/evaluation.json",
  "plugin_rerun/evidence/rerun_context.md",
  "experiment_summary.json",
  "experiment_report.md",
  "comparison_matrix.csv",
];

for (const relativePath of expectedFiles) {
  assertFile(join(runDir, relativePath));
}

const summary = readJson(join(runDir, "experiment_summary.json"));
const baseline = readJson(join(runDir, "baseline", "evaluation.json"));
const pass1 = readJson(join(runDir, "plugin_pass1", "evaluation.json"));
const pass2 = readJson(join(runDir, "plugin_rerun", "evaluation.json"));
const report = readText(join(runDir, "experiment_report.md"));
const rerunContext = readText(join(runDir, "plugin_rerun", "evidence", "rerun_context.md"));

const checks = {
  summarySchema: summary.schema === "nss_evimem.real_openclaw_rerun_experiment_summary.v1",
  caseIdMatches: summary.case_id === "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
  baselineModePresent: typeof baseline.mode === "string",
  pass1Mode: pass1.mode === "real_openclaw_agent_with_nss_evimem",
  pass2Mode: pass2.mode === "real_openclaw_agent_with_nss_evimem_rerun_context",
  pass1DiagnosisPresent: pass1.failure_diagnosis_recorded === true,
  pass1RerunPlanPresent: pass1.rerun_plan_recorded === true,
  pass2Attempted: typeof pass2.openclaw_exit_code === "number"
    || typeof pass2.openclaw_signal === "string"
    || typeof pass2.openclaw_error === "string",
  pass2RerunContextRecorded: pass2.rerun_context_recorded === true,
  comparisonPresent: summary.comparison?.pass2_built_rerun_context === true,
  reportHasThreeArms: /Baseline Agent/i.test(report) && /Plugin Agent Pass 1/i.test(report) && /Plugin Agent Pass 2 Rerun/i.test(report),
  rerunContextLooksUseful: /Status: `needs_rerun`/i.test(rerunContext) && /Required Rerun Discipline/i.test(rerunContext),
};

const failed = Object.entries(checks)
  .filter(([, ok]) => !ok)
  .map(([name]) => name);

if (failed.length > 0) {
  throw new Error(`Real OpenClaw rerun experiment verification failed: ${failed.join(", ")}`);
}

process.stdout.write(`${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
