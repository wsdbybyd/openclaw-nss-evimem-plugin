import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const caseDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const outputDir = join(caseDir, "outputs", "latest");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonl(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertFile(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing expected case file: ${path}`);
  }
}

const expectedFiles = [
  "inputs/public_question.md",
  "inputs/task_contract.json",
  "inputs/tool_capability.json",
  "outputs/latest/run_summary.json",
  "outputs/latest/case_report.md",
  "outputs/latest/case_evaluation.json",
  "outputs/latest/evaluation_report.md",
  "outputs/latest/evidence/tool_calls.jsonl",
  "outputs/latest/evidence/evidence_index.json",
  "outputs/latest/evidence/tool_capabilities.json",
  "outputs/latest/evidence/task_contract.json",
  "outputs/latest/evidence/contract_validation_events.jsonl",
  "outputs/latest/artifacts/search_result.json",
  "outputs/latest/artifacts/final_report.md",
  "outputs/latest/artifacts/run.log",
];

for (const relativePath of expectedFiles) {
  assertFile(join(caseDir, relativePath));
}

const summary = readJson(join(outputDir, "run_summary.json"));
const toolCalls = readJsonl(join(outputDir, "evidence", "tool_calls.jsonl"));
const contractEvents = readJsonl(join(outputDir, "evidence", "contract_validation_events.jsonl"));
const taskContract = readJson(join(outputDir, "evidence", "task_contract.json"));
const searchResult = readJson(join(outputDir, "artifacts", "search_result.json"));
const evaluation = readJson(join(outputDir, "case_evaluation.json"));

const checks = {
  summaryOk: summary.ok === true,
  evidenceRecorded: toolCalls.length === 1 && toolCalls[0].tool_name === "python_search_script",
  contractValid: contractEvents.some((event) => event.status === "valid_contract" && event.ok === true),
  taskMatchesBenchmark: taskContract.cipher === "Simon32/64" && taskContract.rounds === 14,
  sampledResultPresent: typeof searchResult.log2_abs_correlation === "number" && searchResult.samples > 0,
  evaluationWritten: evaluation.case_id === "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
  evidenceCompletenessScored: evaluation.evidence_completeness === "complete",
  finalCorrectnessLabeled: ["verified_correct", "plausible_but_unverified", "partially_correct", "incorrect", "not_evaluable"].includes(evaluation.final_correctness),
  oracleAlignmentRecorded: typeof evaluation.oracle_alignment?.paper_pair_match === "boolean",
  missingForVerifiedCorrectRecorded: Array.isArray(evaluation.missing_for_verified_correct),
};

const failed = Object.entries(checks)
  .filter(([, ok]) => !ok)
  .map(([name]) => name);

if (failed.length > 0) {
  throw new Error(`Case verification failed: ${failed.join(", ")}`);
}

process.stdout.write(`${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
