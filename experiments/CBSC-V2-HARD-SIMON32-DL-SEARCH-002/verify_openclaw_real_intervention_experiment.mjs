import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const experimentDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const runDir = join(experimentDir, "runs", "openclaw-real-intervention-latest");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function assertFile(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing expected real OpenClaw intervention experiment file: ${path}`);
  }
}

const expectedFiles = [
  "baseline/evaluation.json",
  "plugin_pass1/evaluation.json",
  "plugin_rerun/evaluation.json",
  "plugin_intervention/prompt.md",
  "plugin_intervention/openclaw_stdout.json",
  "plugin_intervention/openclaw_stderr.log",
  "plugin_intervention/openclaw_exit_code.txt",
  "plugin_intervention/evaluation.json",
  "plugin_intervention/evidence/intervention.json",
  "plugin_intervention/evidence/intervention.md",
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
const rerun = readJson(join(runDir, "plugin_rerun", "evaluation.json"));
const intervention = readJson(join(runDir, "plugin_intervention", "evaluation.json"));
const interventionJson = readJson(join(runDir, "plugin_intervention", "evidence", "intervention.json"));
const interventionMarkdown = readText(join(runDir, "plugin_intervention", "evidence", "intervention.md"));
const prompt = readText(join(runDir, "plugin_intervention", "prompt.md"));
const report = readText(join(runDir, "experiment_report.md"));

const checks = {
  summarySchema: summary.schema === "nss_evimem.real_openclaw_intervention_experiment_summary.v1",
  caseIdMatches: summary.case_id === "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
  baselineModePresent: typeof baseline.mode === "string",
  pass1Mode: pass1.mode === "real_openclaw_agent_with_nss_evimem",
  rerunMode: rerun.mode === "real_openclaw_agent_with_nss_evimem_rerun_context",
  interventionMode: intervention.mode === "real_openclaw_agent_with_nss_evimem_intervention_prompt",
  interventionAttempted: typeof intervention.openclaw_exit_code === "number"
    || typeof intervention.openclaw_signal === "string"
    || typeof intervention.openclaw_error === "string",
  pass1DiagnosisPresent: pass1.failure_diagnosis_recorded === true,
  rerunContextPresent: rerun.rerun_context_recorded === true,
  interventionRecorded: intervention.intervention_recorded === true,
  interventionUsed: intervention.intervention_used === true,
  comparisonPresent: summary.comparison?.intervention_prompt_built === true,
  promptRequestsIntervention: /nss_evimem_build_intervention/i.test(prompt),
  promptAlignsValidateAndGuard: /same task contract that `nss_evimem_validate_contract` accepted/i.test(prompt)
    && /method, analysis_type, domain, scope, target, and deliverables/i.test(prompt),
  interventionSchema: interventionJson.schema === "nss_evimem.online_intervention.v1",
  promptPatchBoundary: /Do not claim a verified final answer/i.test(interventionJson.prompt_patch),
  markdownLooksUseful: /NSS-EviMem Online Repair Intervention/i.test(interventionMarkdown)
    && /Prompt Patch/i.test(interventionMarkdown),
  reportHasArms: /Plugin Agent Rerun Context/i.test(report)
    && /Plugin Agent Intervention Prompt/i.test(report),
};

const failed = Object.entries(checks)
  .filter(([, ok]) => !ok)
  .map(([name]) => name);

if (failed.length > 0) {
  throw new Error(`Real OpenClaw intervention experiment verification failed: ${failed.join(", ")}`);
}

process.stdout.write(`${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
