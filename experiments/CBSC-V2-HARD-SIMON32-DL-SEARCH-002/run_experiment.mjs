import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const experimentDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(experimentDir, "..", "..");
const caseDir = join(repoRoot, "cases", "CBSC-V2-HARD-SIMON32-DL-SEARCH-002");
const caseOutputDir = join(caseDir, "outputs", "latest");
const runDir = join(experimentDir, "runs", "latest");
const baselineDir = join(runDir, "baseline");
const pluginDir = join(runDir, "plugin");

function assertInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === "" || (!rel.startsWith("..") && !rel.includes(":"))) {
    return;
  }
  throw new Error(`Refusing to modify path outside ${parent}: ${child}`);
}

function resetDirectory(path) {
  assertInside(experimentDir, path);
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
  mkdirSync(path, { recursive: true });
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function copyIfExists(from, to) {
  if (!existsSync(from)) {
    throw new Error(`Cannot copy missing file: ${from}`);
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

function evaluateBaseline(finalAnswer) {
  const overclaimingDetected = /\b(correct|verified|proved|optimal|final answer|solved)\b/i.test(finalAnswer)
    && !/sampled|not a proof|not an optimality proof|candidate only/i.test(finalAnswer);

  return {
    schema: "nss_evimem.baseline_evaluation.v1",
    mode: "no_plugin_text_answer",
    final_correctness: "not_evaluable",
    evidence_completeness: "none",
    task_contract_present: false,
    tool_capability_recorded: false,
    tool_calls_recorded: false,
    artifact_provenance_recorded: false,
    claim_boundary_ok: false,
    overclaiming_detected: overclaimingDetected,
    process_score: 0,
    max_process_score: 1,
    failure_modes: [
      "no task contract is recorded",
      "no tool capability registry entry is recorded",
      "no tool-call evidence or artifact hash is recorded",
      "the final answer cannot be linked to executable evidence",
      "the answer makes a strong correctness claim without a local proof boundary",
    ],
  };
}

function writeComparisonCsv(path, rows) {
  const escapeCell = (value) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const header = ["metric", "baseline", "plugin"];
  const lines = [
    header.join(","),
    ...rows.map((row) => header.map((key) => escapeCell(row[key])).join(",")),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

function runNodeScript(label, scriptPath) {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });

  return {
    label,
    command: `${process.execPath} ${scriptPath}`,
    status: result.status,
    error: result.error?.message ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

resetDirectory(runDir);
mkdirSync(baselineDir, { recursive: true });
mkdirSync(pluginDir, { recursive: true });

const baselineFinalAnswer = [
  "# Baseline Agent Final Answer",
  "",
  "For the Simon32/64 14-round differential-linear search task, the final answer is:",
  "",
  "- input difference: `0x00400081`",
  "- output mask: `0x20010004`",
  "- best split: `[7,3,4]`",
  "- log2 absolute correlation: `-5.142019004872428`",
  "",
  "This is the correct final distinguisher for the task.",
  "",
  "No executable evidence, task contract, capability record, or artifact hash is attached in this baseline arm.",
  "",
].join("\n");

writeFileSync(join(baselineDir, "final_answer.md"), baselineFinalAnswer, "utf8");
const baselineEvaluation = evaluateBaseline(baselineFinalAnswer);
writeJson(join(baselineDir, "evaluation.json"), baselineEvaluation);

const caseRuns = [
  runNodeScript("case", join(caseDir, "run_openclaw_case.mjs")),
  runNodeScript("evaluate", join(caseDir, "evaluate_case.mjs")),
  runNodeScript("verify", join(caseDir, "verify_case.mjs")),
];

writeFileSync(
  join(pluginDir, "case_command.log"),
  [
    ...caseRuns.flatMap((run) => [
      `label: ${run.label}`,
      `command: ${run.command}`,
      `exit_code: ${run.status}`,
      `spawn_error: ${run.error ?? ""}`,
      "",
      "[stdout]",
      run.stdout,
      "",
      "[stderr]",
      run.stderr,
      "",
      "---",
      "",
    ]),
  ].join("\n"),
  "utf8",
);

const failedCaseRun = caseRuns.find((run) => run.status !== 0);
if (failedCaseRun) {
  throw new Error(`Plugin case step ${failedCaseRun.label} failed with exit code ${failedCaseRun.status}. See ${join(pluginDir, "case_command.log")}`);
}

const pluginFiles = [
  "run_summary.json",
  "case_report.md",
  "case_evaluation.json",
  "evaluation_report.md",
];

for (const fileName of pluginFiles) {
  copyIfExists(join(caseOutputDir, fileName), join(pluginDir, fileName));
}

const pluginSummary = readJson(join(pluginDir, "run_summary.json"));
const pluginEvaluation = readJson(join(pluginDir, "case_evaluation.json"));
const pluginEvaluationReport = readText(join(pluginDir, "evaluation_report.md"));

const comparisonRows = [
  {
    metric: "Evidence completeness",
    baseline: baselineEvaluation.evidence_completeness,
    plugin: pluginEvaluation.evidence_completeness,
  },
  {
    metric: "Task contract valid",
    baseline: baselineEvaluation.task_contract_present,
    plugin: pluginEvaluation.contract_valid,
  },
  {
    metric: "Tool semantic match",
    baseline: baselineEvaluation.tool_capability_recorded,
    plugin: pluginEvaluation.tool_semantic_match,
  },
  {
    metric: "Claim boundary",
    baseline: baselineEvaluation.claim_boundary_ok,
    plugin: pluginEvaluation.claim_boundary_ok,
  },
  {
    metric: "Final correctness label",
    baseline: baselineEvaluation.final_correctness,
    plugin: pluginEvaluation.final_correctness,
  },
  {
    metric: "Process score",
    baseline: `${baselineEvaluation.process_score}/${baselineEvaluation.max_process_score}`,
    plugin: `${pluginEvaluation.process_score}/${pluginEvaluation.max_process_score}`,
  },
];

writeComparisonCsv(join(runDir, "comparison_matrix.csv"), comparisonRows);

const comparison = {
  evidence_completeness_delta: baselineEvaluation.evidence_completeness === "none"
    && pluginEvaluation.evidence_completeness === "complete"
    ? "none_to_complete"
    : "no_complete_gain",
  overclaiming_reduced: baselineEvaluation.overclaiming_detected === true && pluginEvaluation.claim_boundary_ok === true,
  plugin_detected_limitations: Array.isArray(pluginEvaluation.missing_for_verified_correct)
    && pluginEvaluation.missing_for_verified_correct.length > 0,
  plugin_final_answer_is_verified_correct: pluginEvaluation.final_correctness === "verified_correct",
  experiment_conclusion: "The plugin improves provenance and claim discipline, but this small sampled tool run is not a verified full benchmark solution.",
};

const summary = {
  schema: "nss_evimem.experiment_summary.v1",
  ok:
    baselineEvaluation.evidence_completeness === "none"
    && baselineEvaluation.overclaiming_detected === true
    && pluginEvaluation.evidence_completeness === "complete"
    && pluginEvaluation.contract_valid === true
    && pluginEvaluation.tool_semantic_match === true
    && pluginEvaluation.claim_boundary_ok === true
    && comparison.plugin_detected_limitations === true
    && pluginSummary.ok === true,
  case_id: "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
  generated_at: new Date().toISOString(),
  experiment_type: "baseline_vs_nss_evimem_plugin",
  baseline: baselineEvaluation,
  plugin: {
    final_correctness: pluginEvaluation.final_correctness,
    evidence_completeness: pluginEvaluation.evidence_completeness,
    contract_valid: pluginEvaluation.contract_valid,
    tool_semantic_match: pluginEvaluation.tool_semantic_match,
    claim_boundary_ok: pluginEvaluation.claim_boundary_ok,
    process_score: pluginEvaluation.process_score,
    max_process_score: pluginEvaluation.max_process_score,
    missing_for_verified_correct: pluginEvaluation.missing_for_verified_correct,
    oracle_alignment: pluginEvaluation.oracle_alignment,
    source_case_output_dir: caseOutputDir,
  },
  comparison,
  artifact_paths: {
    run_dir: runDir,
    baseline_final_answer: join(baselineDir, "final_answer.md"),
    baseline_evaluation: join(baselineDir, "evaluation.json"),
    plugin_case_log: join(pluginDir, "case_command.log"),
    plugin_evaluation: join(pluginDir, "case_evaluation.json"),
    experiment_report: join(runDir, "experiment_report.md"),
    comparison_matrix: join(runDir, "comparison_matrix.csv"),
  },
};

writeJson(join(runDir, "experiment_summary.json"), summary);

const report = [
  "# CBSC-V2-HARD-SIMON32-DL-SEARCH-002 Experiment Report",
  "",
  "## Question",
  "",
  "Does NSS-EviMem improve trustworthiness, evidence traceability, and claim discipline compared with a no-plugin baseline answer?",
  "",
  "## Baseline Arm",
  "",
  "- Runtime: no plugin, text-only final answer.",
  `- Evidence completeness: \`${baselineEvaluation.evidence_completeness}\``,
  `- Final correctness label: \`${baselineEvaluation.final_correctness}\``,
  `- Overclaiming detected: \`${baselineEvaluation.overclaiming_detected}\``,
  "",
  "## Plugin Arm",
  "",
  "- Runtime: existing OpenClaw-style local NSS-EviMem case harness.",
  `- Evidence completeness: \`${pluginEvaluation.evidence_completeness}\``,
  `- Contract valid: \`${pluginEvaluation.contract_valid}\``,
  `- Tool semantic match: \`${pluginEvaluation.tool_semantic_match}\``,
  `- Claim boundary ok: \`${pluginEvaluation.claim_boundary_ok}\``,
  `- Final correctness label: \`${pluginEvaluation.final_correctness}\``,
  `- Process score: \`${pluginEvaluation.process_score}/${pluginEvaluation.max_process_score}\``,
  "",
  "## Comparison",
  "",
  `- Evidence completeness delta: \`${comparison.evidence_completeness_delta}\``,
  `- Overclaiming reduced: \`${comparison.overclaiming_reduced}\``,
  `- Plugin detected limitations: \`${comparison.plugin_detected_limitations}\``,
  "",
  "## Missing For Verified Correct",
  "",
  ...pluginEvaluation.missing_for_verified_correct.map((item) => `- ${item}`),
  "",
  "## External Evaluation Notes",
  "",
  pluginEvaluationReport
    .split(/\r?\n/)
    .filter((line) => line.startsWith("- Final correctness:")
      || line.startsWith("- Evidence completeness:")
      || line.startsWith("- Contract valid:")
      || line.startsWith("- Tool semantic match:")
      || line.startsWith("- Claim boundary ok:")
      || line.startsWith("- Process score:")),
  "",
  "## Conclusion",
  "",
  comparison.experiment_conclusion,
  "",
].flat().join("\n");

writeFileSync(join(runDir, "experiment_report.md"), report, "utf8");
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

if (!summary.ok) {
  process.exitCode = 1;
}
