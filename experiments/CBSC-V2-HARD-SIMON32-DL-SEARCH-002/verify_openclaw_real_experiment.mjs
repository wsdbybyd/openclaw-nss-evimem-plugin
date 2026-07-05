import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const experimentDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const runDir = join(experimentDir, "runs", "openclaw-real-latest");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function assertFile(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing expected real OpenClaw experiment file: ${path}`);
  }
}

const expectedFiles = [
  "baseline/prompt.md",
  "baseline/openclaw_stdout.json",
  "baseline/openclaw_stderr.log",
  "baseline/openclaw_exit_code.txt",
  "baseline/evaluation.json",
  "plugin/prompt.md",
  "plugin/openclaw_stdout.json",
  "plugin/openclaw_stderr.log",
  "plugin/openclaw_exit_code.txt",
  "plugin/evaluation.json",
  "experiment_summary.json",
  "experiment_report.md",
  "comparison_matrix.csv",
];

for (const relativePath of expectedFiles) {
  assertFile(join(runDir, relativePath));
}

const summary = readJson(join(runDir, "experiment_summary.json"));
const baseline = readJson(join(runDir, "baseline", "evaluation.json"));
const plugin = readJson(join(runDir, "plugin", "evaluation.json"));
const report = readText(join(runDir, "experiment_report.md"));

const checks = {
  summarySchema: summary.schema === "nss_evimem.real_openclaw_experiment_summary.v1",
  caseIdMatches: summary.case_id === "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
  baselineMode: baseline.mode === "real_openclaw_agent_without_nss_evimem",
  pluginMode: plugin.mode === "real_openclaw_agent_with_nss_evimem",
  baselineAttempted: typeof baseline.openclaw_exit_code === "number"
    || typeof baseline.openclaw_signal === "string"
    || typeof baseline.openclaw_error === "string",
  pluginAttempted: typeof plugin.openclaw_exit_code === "number"
    || typeof plugin.openclaw_signal === "string"
    || typeof plugin.openclaw_error === "string",
  comparisonPresent: typeof summary.comparison?.evidence_completeness_delta === "string",
  reportHasBothArms: /Baseline Agent/i.test(report) && /Plugin Agent/i.test(report),
};

const failed = Object.entries(checks)
  .filter(([, ok]) => !ok)
  .map(([name]) => name);

if (failed.length > 0) {
  throw new Error(`Real OpenClaw experiment verification failed: ${failed.join(", ")}`);
}

process.stdout.write(`${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
