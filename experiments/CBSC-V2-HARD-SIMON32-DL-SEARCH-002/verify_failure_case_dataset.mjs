import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const experimentDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const datasetDir = join(experimentDir, "runs", "failure-case-dataset-latest");

function assertFile(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing expected failure-case dataset file: ${path}`);
  }
}

function readJsonl(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readText(path) {
  return readFileSync(path, "utf8");
}

const expectedFiles = [
  "failure_case_dataset.jsonl",
  "episode_labels.jsonl",
  "counterfactual_hook_results.jsonl",
  "distillation_samples.jsonl",
  "case_reports/CBSC-V2-HARD-SIMON32-DL-SEARCH-002.md",
  "evaluation_rubric.md",
  "dataset_summary.json",
];

for (const relativePath of expectedFiles) {
  assertFile(join(datasetDir, relativePath));
}

const cases = readJsonl(join(datasetDir, "failure_case_dataset.jsonl"));
const episodes = readJsonl(join(datasetDir, "episode_labels.jsonl"));
const hookResults = readJsonl(join(datasetDir, "counterfactual_hook_results.jsonl"));
const samples = readJsonl(join(datasetDir, "distillation_samples.jsonl"));
const report = readText(join(datasetDir, "case_reports", "CBSC-V2-HARD-SIMON32-DL-SEARCH-002.md"));
const rubric = readText(join(datasetDir, "evaluation_rubric.md"));

const caseRecord = cases[0] ?? {};
const episodeFailureTypes = new Set(episodes.flatMap((episode) => episode.failure_events?.map?.((event) => event.failure_type) ?? []));
const recoverySources = new Set(episodes.map((episode) => episode.recovery_source));
const sampleTypes = new Set(samples.map((sample) => sample.sample_type));
const hookGroups = new Set(hookResults.map((result) => result.group));

const checks = {
  oneCaseRecord: cases.length === 1,
  caseSchema: caseRecord.schema === "nss_evimem.failure_case_dataset.case.v1",
  caseId: caseRecord.case_id === "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
  trajectoryLevel: Array.isArray(caseRecord.trajectories) && caseRecord.trajectories.length >= 3,
  episodeCount: episodes.length >= 5,
  episodeSchema: episodes.every((episode) => episode.schema === "nss_evimem.failure_case_dataset.episode.v1"),
  hasSearchTimeout: episodeFailureTypes.has("search_timeout"),
  hasStatisticalNoise: episodeFailureTypes.has("candidate_statistical_noise"),
  hasToolContractMismatch: episodeFailureTypes.has("tool_contract_mismatch"),
  hasHookGuidedRecovery: recoverySources.has("hook_guided_recovery"),
  hasToolFeedbackRecovery: recoverySources.has("tool_feedback_recovery"),
  hookGroupsPresent: ["h1_no_hook_replay", "h2_evidence_only_hook", "h3_full_htsg_hook"].every((group) => hookGroups.has(group)),
  distillationTypesPresent: [
    "failure_detection_sample",
    "repair_action_sample",
    "tool_selection_sample",
    "evidence_grounding_sample",
    "contract_generation_sample",
  ].every((type) => sampleTypes.has(type)),
  reportMentionsEpisodes: /Episode Labels/i.test(report) && /Counterfactual Hook/i.test(report),
  rubricHasFiveLevelCorrectness: /verified_correct/i.test(rubric)
    && /plausible_but_unverified/i.test(rubric)
    && /partially_correct/i.test(rubric)
    && /incorrect/i.test(rubric)
    && /not_evaluable/i.test(rubric),
};

const failed = Object.entries(checks)
  .filter(([, ok]) => !ok)
  .map(([name]) => name);

if (failed.length > 0) {
  throw new Error(`Failure-case dataset verification failed: ${failed.join(", ")}`);
}

process.stdout.write(`${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
