import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const caseDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(caseDir, "..", "..");
const outputDir = join(caseDir, "outputs", "latest");
const artifactDir = join(outputDir, "artifacts");
const evidenceDir = join(outputDir, "evidence");
const hiddenOraclePath = resolve(
  repoRoot,
  "..",
  "v4版本benchmark",
  "tasks",
  "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
  "hidden",
  "oracle.json",
);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function readJsonl(path) {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sameArray(actual, expected) {
  return Array.isArray(actual)
    && Array.isArray(expected)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function hasAllSplits(observations, expectedSplits) {
  return expectedSplits.every((expected) => observations.some((item) => sameArray(item.split, expected)));
}

function scoreNode(node_id, observed, score, max_score, reason) {
  return { node_id, observed, score, max_score, reason };
}

if (!existsSync(hiddenOraclePath)) {
  throw new Error(`Hidden oracle not found: ${hiddenOraclePath}`);
}

const oracle = readJson(hiddenOraclePath);
const summary = readJson(join(outputDir, "run_summary.json"));
const searchResult = readJson(join(artifactDir, "search_result.json"));
const evidenceIndex = readJson(join(evidenceDir, "evidence_index.json"));
const toolCalls = readJsonl(join(evidenceDir, "tool_calls.jsonl"));
const contractEvents = readJsonl(join(evidenceDir, "contract_validation_events.jsonl"));
const guardEvents = readJsonl(join(evidenceDir, "tool_guard_events.jsonl"));
const memoryRecords = readJson(join(evidenceDir, "memory_records.json"));
const finalReport = readText(join(artifactDir, "final_report.md"));
const codeText = readText(join(caseDir, "tools", "simon32_dl_sample.py"));

const expected = oracle.expected.core_answer.best_known_paper_pair;
const reference = oracle.expected.reference_run_observation;
const expectedSplits = oracle.target.decomposition_candidates;
const paperDelta = `0x${expected.delta_in_words.map((word) => word.replace(/^0x/i, "")).join("").toLowerCase()}`;
const paperGamma = `0x${expected.gamma_out_words.map((word) => word.replace(/^0x/i, "")).join("").toLowerCase()}`;

const evidenceRecord = evidenceIndex[0];
const artifactErrors = evidenceRecord?.artifact_errors ?? {};
const artifacts = evidenceRecord?.artifacts ?? {};
const requiredArtifacts = ["code", "run_log", "search_result", "final_report"];
const artifactsComplete = requiredArtifacts.every((name) => typeof artifacts[name] === "string" && existsSync(artifacts[name]));
const hashesComplete = requiredArtifacts.every((name) => typeof evidenceRecord?.artifact_hashes?.[name] === "string");
const noArtifactErrors = Object.keys(artifactErrors).length === 0;

const contractValid = contractEvents.some((event) => event.status === "valid_contract" && event.ok === true);
const toolSemanticMatch = guardEvents.some((event) => event.decision === "allow" && event.requested_tool === "python_search_script");
const evidenceCompleteness = toolCalls.length === 1 && evidenceIndex.length === 1 && artifactsComplete && hashesComplete && noArtifactErrors
  ? "complete"
  : "incomplete";

const boundaryText = `${finalReport}\n${searchResult.claim_boundary ?? ""}`;
const claimBoundaryOk = /not a key-recovery attack/i.test(boundaryText)
  && /not an optimality proof|not a proof/i.test(boundaryText)
  && /sampled/i.test(boundaryText);

const observations = Array.isArray(searchResult.observations) ? searchResult.observations : [];
const allSplitsTested = hasAllSplits(observations, expectedSplits);
const bestSplit = searchResult.best_observation?.split ?? [];
const log2Abs = searchResult.best_observation?.log2_abs_correlation;
const samples = Number(searchResult.samples ?? searchResult.best_observation?.samples ?? 0);

const oracleAlignment = {
  paper_pair_match: searchResult.delta_in_32bit?.toLowerCase() === paperDelta && searchResult.gamma_out_32bit?.toLowerCase() === paperGamma,
  best_split_matches_paper: sameArray(bestSplit, expected.best_decomposition),
  best_split_matches_reference_run: sameArray(bestSplit, reference.decomposition),
  reference_pair_match: searchResult.delta_in_32bit?.toLowerCase() === reference.delta_in_32bit?.toLowerCase()
    && searchResult.gamma_out_32bit?.toLowerCase() === reference.gamma_out_32bit?.toLowerCase(),
  acceptable_band_match: typeof log2Abs === "number" && log2Abs <= -13 && log2Abs >= -16,
  all_decompositions_tested: allSplitsTested,
};

const nodeScores = [
  scoreNode(
    "cipher_implementation",
    /def simon_f/.test(codeText) && /def expand_key_32_64/.test(codeText) && /def encrypt_rounds/.test(codeText),
    /def simon_f/.test(codeText) && /def expand_key_32_64/.test(codeText) && /def encrypt_rounds/.test(codeText) ? 0.1 : 0,
    0.15,
    "Simon32/64 implementation functions are present, but no known-answer test vector is recorded.",
  ),
  scoreNode(
    "dl_test_implementation",
    /signed_sum/i.test(searchResult.measurement ?? "") && /parity/i.test(searchResult.measurement ?? ""),
    /signed_sum/i.test(searchResult.measurement ?? "") && /parity/i.test(searchResult.measurement ?? "") ? 0.15 : 0,
    0.15,
    "The result declares signed-sum parity measurement and records signed_sum per split.",
  ),
  scoreNode(
    "systematic_search",
    allSplitsTested,
    allSplitsTested ? 0.2 : 0,
    0.2,
    "The evaluator checks that all oracle decomposition candidates are represented in observations.",
  ),
  scoreNode(
    "best_distinguisher_found",
    typeof searchResult.delta_in_32bit === "string"
      && typeof searchResult.gamma_out_32bit === "string"
      && typeof log2Abs === "number"
      && samples > 0,
    typeof searchResult.delta_in_32bit === "string"
      && typeof searchResult.gamma_out_32bit === "string"
      && typeof log2Abs === "number"
      && samples > 0
      ? 0.15
      : 0,
    0.25,
    "A concrete sampled candidate is reported, but the sample budget is small and the value does not align with oracle-level expectations.",
  ),
  scoreNode(
    "decomposition_ranking",
    allSplitsTested && typeof searchResult.best_observation?.correlation === "number",
    allSplitsTested && typeof searchResult.best_observation?.correlation === "number" ? 0.15 : 0,
    0.15,
    "All three split candidates have observations and a best sampled split is selected.",
  ),
  scoreNode(
    "concept_and_boundary",
    claimBoundaryOk,
    claimBoundaryOk ? 0.1 : 0,
    0.1,
    "The report marks the result as a sampled distinguisher candidate and avoids key-recovery or optimality overclaiming.",
  ),
];

const processScore = nodeScores.reduce((sum, node) => sum + node.score, 0);
const maxProcessScore = nodeScores.reduce((sum, node) => sum + node.max_score, 0);

const missingForVerifiedCorrect = [];
if (!oracleAlignment.acceptable_band_match) {
  missingForVerifiedCorrect.push("correlation is outside the oracle acceptable experimental band");
}
if (!oracleAlignment.best_split_matches_paper) {
  missingForVerifiedCorrect.push("best sampled split does not match the paper reference decomposition");
}
if (samples < 2 ** 20) {
  missingForVerifiedCorrect.push("sample budget is too small for a strong benchmark correctness claim");
}
if (!/known[- ]answer|test vector/i.test(finalReport)) {
  missingForVerifiedCorrect.push("no known-answer test vector is recorded in the final report");
}
if (!/CorT|CorD|aggregate/i.test(finalReport)) {
  missingForVerifiedCorrect.push("final report does not explain CorT versus CorD or aggregate distinguisher semantics");
}

let finalCorrectness = "not_evaluable";
if (evidenceCompleteness === "complete" && contractValid && toolSemanticMatch && claimBoundaryOk) {
  finalCorrectness = oracleAlignment.acceptable_band_match && oracleAlignment.best_split_matches_paper
    ? "plausible_but_unverified"
    : "partially_correct";
}
if (evidenceCompleteness !== "complete" || !contractValid) {
  finalCorrectness = "not_evaluable";
}

const evaluation = {
  schema: "nss_evimem.case_evaluation.v1",
  case_id: "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
  evaluated_at: new Date().toISOString(),
  final_correctness: finalCorrectness,
  evidence_completeness: evidenceCompleteness,
  contract_valid: contractValid,
  tool_semantic_match: toolSemanticMatch,
  claim_boundary_ok: claimBoundaryOk,
  process_score: Number(processScore.toFixed(3)),
  max_process_score: maxProcessScore,
  oracle_alignment: oracleAlignment,
  evidence_nodes: nodeScores,
  missing_for_verified_correct: missingForVerifiedCorrect,
  evaluator_notes: [
    "This evaluator is outside the plugin and may read hidden oracle data.",
    "The plugin output is used for evidence completeness and provenance checks.",
    "The current case harness is intentionally a small sampled run, not a full benchmark solver.",
  ],
  inputs: {
    run_summary_ok: summary.ok === true,
    evidence_id: summary.evidence_id,
    memory_id: memoryRecords[0]?.memory_id ?? null,
  },
};

writeJson(join(outputDir, "case_evaluation.json"), evaluation);

const report = [
  "# CBSC-V2-HARD-SIMON32-DL-SEARCH-002 Evaluation Report",
  "",
  "## Summary",
  "",
  `- Final correctness: \`${evaluation.final_correctness}\``,
  `- Evidence completeness: \`${evaluation.evidence_completeness}\``,
  `- Contract valid: \`${evaluation.contract_valid}\``,
  `- Tool semantic match: \`${evaluation.tool_semantic_match}\``,
  `- Claim boundary ok: \`${evaluation.claim_boundary_ok}\``,
  `- Process score: \`${evaluation.process_score}/${evaluation.max_process_score}\``,
  "",
  "## Oracle Alignment",
  "",
  `- Paper pair match: \`${oracleAlignment.paper_pair_match}\``,
  `- Best split matches paper: \`${oracleAlignment.best_split_matches_paper}\``,
  `- Reference-run pair match: \`${oracleAlignment.reference_pair_match}\``,
  `- Acceptable band match: \`${oracleAlignment.acceptable_band_match}\``,
  `- All decompositions tested: \`${oracleAlignment.all_decompositions_tested}\``,
  "",
  "## Missing For Verified Correct",
  "",
  ...missingForVerifiedCorrect.map((item) => `- ${item}`),
  "",
  "## Evidence Nodes",
  "",
  ...nodeScores.map((node) => `- ${node.node_id}: ${node.score}/${node.max_score} - ${node.reason}`),
  "",
].join("\n");

writeFileSync(join(outputDir, "evaluation_report.md"), report, "utf8");
process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
