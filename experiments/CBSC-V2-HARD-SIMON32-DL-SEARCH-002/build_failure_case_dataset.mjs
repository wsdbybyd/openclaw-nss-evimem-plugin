import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CASE_ID = "CBSC-V2-HARD-SIMON32-DL-SEARCH-002";
const experimentDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const defaultSourceRunDir = join(experimentDir, "runs", "openclaw-real-rerun-latest");
const sourceRunDir = resolve(process.env.NSS_EVIMEM_FAILURE_CASE_SOURCE_DIR ?? defaultSourceRunDir);
const datasetDir = resolve(join(experimentDir, "runs", "failure-case-dataset-latest"));
const generatedAt = new Date().toISOString();

function assertInsideExperiment(path) {
  const relativePath = relative(experimentDir, path);
  if (relativePath.startsWith("..") || relativePath === "") {
    throw new Error(`Refusing to write outside experiment directory: ${path}`);
  }
}

function requireFile(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing required source artifact: ${path}`);
  }
  return path;
}

function readJson(path) {
  return JSON.parse(readFileSync(requireFile(path), "utf8"));
}

function readTextIfExists(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function readJsonlIfExists(path) {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeText(relativePath, text) {
  const outputPath = join(datasetDir, relativePath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, text, "utf8");
}

function writeJson(relativePath, value) {
  writeText(relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(relativePath, records) {
  writeText(relativePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function normalizeArm(mode, evaluation, extra = {}) {
  return {
    mode,
    final_correctness: evaluation.final_correctness,
    evidence_completeness: evaluation.evidence_completeness,
    nss_tool_usage_detected: evaluation.nss_tool_usage_detected,
    contract_valid: evaluation.contract_valid,
    tool_semantic_match: evaluation.tool_semantic_match,
    tool_capability_recorded: evaluation.tool_capability_recorded,
    failure_diagnosis_recorded: evaluation.failure_diagnosis_recorded,
    rerun_plan_recorded: evaluation.rerun_plan_recorded,
    rerun_context_recorded: evaluation.rerun_context_recorded ?? false,
    rerun_context_used: evaluation.rerun_context_used ?? false,
    tool_calls_recorded: evaluation.tool_calls_recorded,
    claim_boundary_ok: evaluation.claim_boundary_ok,
    overclaiming_detected: evaluation.overclaiming_detected,
    oracle_alignment: evaluation.oracle_alignment,
    output_files: evaluation.output_files ?? [],
    evidence_files: evaluation.evidence_files ?? [],
    ...extra,
  };
}

function makeFailureEvent(failureType, evidence, severity = "medium") {
  return {
    failure_type: failureType,
    severity,
    evidence,
  };
}

function summarizeCorrectiveActions(diagnosis) {
  return (diagnosis.corrective_actions ?? []).map((action) => ({
    failure_type: action.failure_type,
    action: action.action,
    rationale: action.rationale,
  }));
}

function formatTable(rows, columns) {
  const header = `| ${columns.join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${columns.map((column) => String(row[column] ?? "")).join(" | ")} |`);
  return [header, separator, ...body].join("\n");
}

assertInsideExperiment(datasetDir);
if (!existsSync(sourceRunDir)) {
  throw new Error(`Missing source experiment run directory: ${sourceRunDir}`);
}

rmSync(datasetDir, { recursive: true, force: true });
mkdirSync(datasetDir, { recursive: true });

const summary = readJson(join(sourceRunDir, "experiment_summary.json"));
const baselineEvaluation = readJson(join(sourceRunDir, "baseline", "evaluation.json"));
const pluginPass1Evaluation = readJson(join(sourceRunDir, "plugin_pass1", "evaluation.json"));
const pluginRerunEvaluation = readJson(join(sourceRunDir, "plugin_rerun", "evaluation.json"));
const pluginPass1Diagnosis = readJson(
  existsSync(join(sourceRunDir, "plugin_pass1", "evidence_seed_used_for_rerun", "failure_diagnosis.json"))
    ? join(sourceRunDir, "plugin_pass1", "evidence_seed_used_for_rerun", "failure_diagnosis.json")
    : join(sourceRunDir, "plugin_pass1", "evidence", "failure_diagnosis.json"),
);
const pluginRerunDiagnosis = readJson(join(sourceRunDir, "plugin_rerun", "evidence", "failure_diagnosis.json"));
const taskContract = readJson(join(sourceRunDir, "plugin_rerun", "evidence", "task_contract.json"));
const toolCapabilities = readJson(join(sourceRunDir, "plugin_rerun", "evidence", "tool_capabilities.json"));
const rerunContext = readTextIfExists(join(sourceRunDir, "plugin_rerun", "evidence", "rerun_context.md"));
const pass1ToolCalls = readJsonlIfExists(join(sourceRunDir, "plugin_pass1", "evidence_seed_used_for_rerun", "tool_calls.jsonl"));
const rerunToolCalls = readJsonlIfExists(join(sourceRunDir, "plugin_rerun", "evidence", "tool_calls.jsonl"));

const trajectories = [
  {
    trajectory_id: "traj_baseline_no_hook",
    group: "h1_no_hook_replay",
    arm: "baseline",
    source_path: relative(experimentDir, join(sourceRunDir, "baseline")),
    description: "Raw OpenClaw agent without NSS-EviMem hooks.",
    evaluation: normalizeArm("real_openclaw_agent_without_nss_evimem", baselineEvaluation),
  },
  {
    trajectory_id: "traj_plugin_pass1",
    group: "h2_evidence_only_hook",
    arm: "plugin_pass1",
    source_path: relative(experimentDir, join(sourceRunDir, "plugin_pass1")),
    description: "OpenClaw agent with NSS-EviMem evidence capture, guard events, contract validation, and failure diagnosis.",
    evaluation: normalizeArm("real_openclaw_agent_with_nss_evimem", pluginPass1Evaluation, {
      diagnosis_status: pluginPass1Diagnosis.status,
      diagnosis_failure_types: pluginPass1Diagnosis.failure_types,
    }),
  },
  {
    trajectory_id: "traj_plugin_pass2_rerun",
    group: "h3_full_htsg_hook",
    arm: "plugin_rerun",
    source_path: relative(experimentDir, join(sourceRunDir, "plugin_rerun")),
    description: "OpenClaw agent rerun with NSS-EviMem rerun context and bounded verification guidance.",
    evaluation: normalizeArm("real_openclaw_agent_with_nss_evimem_rerun_context", pluginRerunEvaluation, {
      diagnosis_status: pluginRerunDiagnosis.status,
      diagnosis_failure_types: pluginRerunDiagnosis.failure_types,
    }),
  },
];

const caseRecord = {
  schema: "nss_evimem.failure_case_dataset.case.v1",
  case_id: CASE_ID,
  generated_at: generatedAt,
  source_run_dir: relative(experimentDir, sourceRunDir),
  source_experiment_schema: summary.schema,
  task: {
    family: "differential_linear_search",
    cipher: "Simon32/64",
    rounds: 14,
    objective: taskContract.objective,
    expected_deliverables: taskContract.deliverables ?? [
      "executable code",
      "input difference",
      "output linear mask",
      "round split",
      "correlation/weight",
      "verification",
    ],
  },
  design_alignment: {
    route: "A",
    scope: "single_case_dataset_from_existing_real_openclaw_artifacts",
    groups_produced: ["H"],
    experiment_groups: ["h1_no_hook_replay", "h2_evidence_only_hook", "h3_full_htsg_hook"],
    note: "This route builds the failure-case dataset view from existing local experiment trajectories; it does not rerun OpenClaw.",
  },
  task_contract: taskContract,
  tool_registry_snapshot: toolCapabilities,
  trajectories,
  labels: {
    initial_agent_status: "partially_correct",
    final_agent_status: "partially_correct",
    primary_failure_types: pluginRerunDiagnosis.failure_types,
    recovery_source: "hook_guided_recovery",
    hook_would_help: true,
    final_claim_boundary_ok: pluginRerunEvaluation.claim_boundary_ok,
    final_oracle_verified: pluginRerunEvaluation.oracle_alignment?.paper_pair_match === true
      || pluginRerunEvaluation.oracle_alignment?.reference_pair_match === true,
    distillation_value: "high",
  },
  artifacts: {
    report: `case_reports/${CASE_ID}.md`,
    episode_labels: "episode_labels.jsonl",
    counterfactual_hook_results: "counterfactual_hook_results.jsonl",
    distillation_samples: "distillation_samples.jsonl",
    evaluation_rubric: "evaluation_rubric.md",
  },
};

const episodes = [
  {
    schema: "nss_evimem.failure_case_dataset.episode.v1",
    episode_id: "ep01_baseline_uninstrumented_search",
    case_id: CASE_ID,
    trajectory_id: "traj_baseline_no_hook",
    group: "h1_no_hook_replay",
    start_trigger: "initial_user_task",
    agent_action: "Ran uninstrumented search scripts and produced a final answer without NSS-EviMem evidence.",
    observation: "Baseline produced output files but no task contract, tool capability, failure diagnosis, or evidence index.",
    failure_events: [
      makeFailureEvent("unsupported_claim", "No structured evidence was recorded for the claimed differential-linear result."),
      makeFailureEvent("unverified_success", "Oracle alignment did not match the paper/reference pair."),
    ],
    recovery_action: "No hook-guided recovery was available in this arm.",
    recovery_source: "self_react_recovery",
    correctness_label: "partially_correct",
    claim_boundary_ok: baselineEvaluation.claim_boundary_ok,
    evidence_refs: baselineEvaluation.output_files ?? [],
  },
  {
    schema: "nss_evimem.failure_case_dataset.episode.v1",
    episode_id: "ep02_pass1_timeout_and_boundary",
    case_id: CASE_ID,
    trajectory_id: "traj_plugin_pass1",
    group: "h2_evidence_only_hook",
    start_trigger: "plugin_pass1_tool_feedback",
    agent_action: "Captured tool calls and diagnosed that the search schedule must be bounded before stronger verification.",
    observation: pluginPass1Diagnosis.reasons?.find((reason) => /timeout/i.test(reason))
      ?? "Tool feedback indicated timeout/kill/no-output symptoms.",
    failure_events: [
      makeFailureEvent("search_timeout", "Pass1 diagnosis recorded timeout symptoms and recommended a bounded staged rerun.", "high"),
    ],
    recovery_action: "Generate a rerun plan with fast scan, hard phase limits, and deep verification only for survivors.",
    recovery_source: "tool_feedback_recovery",
    corrective_actions: summarizeCorrectiveActions(pluginPass1Diagnosis).filter((action) => action.failure_type === "search_timeout"),
    correctness_label: "partially_correct",
    claim_boundary_ok: pluginPass1Evaluation.claim_boundary_ok,
    evidence_refs: [
      "plugin_pass1/evidence_seed_used_for_rerun/failure_diagnosis.json",
      "plugin_pass1/evidence_seed_used_for_rerun/rerun_plan.md",
    ],
  },
  {
    schema: "nss_evimem.failure_case_dataset.episode.v1",
    episode_id: "ep03_pass1_contract_guard",
    case_id: CASE_ID,
    trajectory_id: "traj_plugin_pass1",
    group: "h2_evidence_only_hook",
    start_trigger: "contract_guard_event",
    agent_action: "Validated the task contract against the registered Simon32 differential-linear search tool.",
    observation: pluginPass1Diagnosis.reasons?.find((reason) => /contract|capability/i.test(reason))
      ?? "Guard events identified a contract/capability mismatch risk.",
    failure_events: [
      makeFailureEvent("tool_contract_mismatch", "A guard event recorded that the tool capability and intended task contract needed alignment.", "high"),
    ],
    recovery_action: "Require a matching tool capability or downgrade unsupported claims to the available evidence boundary.",
    recovery_source: "hook_guided_recovery",
    corrective_actions: summarizeCorrectiveActions(pluginPass1Diagnosis).filter((action) => action.failure_type === "tool_contract_mismatch"),
    correctness_label: "partially_correct",
    claim_boundary_ok: pluginPass1Evaluation.claim_boundary_ok,
    evidence_refs: [
      "plugin_pass1/evidence_seed_used_for_rerun/task_contract.json",
      "plugin_pass1/evidence_seed_used_for_rerun/tool_capabilities.json",
      "plugin_pass1/evidence_seed_used_for_rerun/tool_guard_events.jsonl",
    ],
  },
  {
    schema: "nss_evimem.failure_case_dataset.episode.v1",
    episode_id: "ep04_pass1_noise_detected",
    case_id: CASE_ID,
    trajectory_id: "traj_plugin_pass1",
    group: "h2_evidence_only_hook",
    start_trigger: "post_search_failure_diagnosis",
    agent_action: "Compared quick-scan bias against larger-sample and multi-key verification evidence.",
    observation: pluginPass1Diagnosis.observations?.find((observation) => /noise/i.test(observation))
      ?? "Observed bias dropped near the expected noise floor under stronger checks.",
    failure_events: [
      makeFailureEvent("candidate_statistical_noise", "Large-sample and multi-key checks showed the candidate near or below the noise floor.", "high"),
      makeFailureEvent("evidence_mismatch", "Single-key quick-scan evidence did not survive stronger verification."),
    ],
    recovery_action: "Do not promote the quick-scan candidate as a verified distinguisher; require multi-key verification.",
    recovery_source: "hook_guided_recovery",
    correctness_label: "partially_correct",
    claim_boundary_ok: pluginPass1Evaluation.claim_boundary_ok,
    evidence_refs: [
      "plugin_pass1/evidence_seed_used_for_rerun/failure_diagnosis.json",
      "plugin_pass1/memory_use_report.md",
    ],
  },
  {
    schema: "nss_evimem.failure_case_dataset.episode.v1",
    episode_id: "ep05_rerun_context_application",
    case_id: CASE_ID,
    trajectory_id: "traj_plugin_pass2_rerun",
    group: "h3_full_htsg_hook",
    start_trigger: "rerun_context_injected",
    agent_action: "Used rerun context from pass1 to constrain the second OpenClaw run.",
    observation: "Rerun context instructed the agent to use a validated contract, registered capability, bounded search, and explicit evidence boundaries.",
    failure_events: [
      makeFailureEvent("stale_context", "The rerun context preserved pass1 failures so the second run would not repeat the same search assumptions."),
      makeFailureEvent("search_timeout", "The rerun plan converted timeout risk into a bounded staged schedule."),
    ],
    recovery_action: "Apply hook-generated rerun checklist before finalizing the answer.",
    recovery_source: "hook_guided_recovery",
    correctness_label: "partially_correct",
    claim_boundary_ok: pluginRerunEvaluation.claim_boundary_ok,
    evidence_refs: ["plugin_rerun/evidence/rerun_context.md"],
    rerun_context_excerpt: rerunContext.includes("Rerun Checklist") ? "contains_rerun_checklist" : "not_available",
  },
  {
    schema: "nss_evimem.failure_case_dataset.episode.v1",
    episode_id: "ep06_rerun_noise_classification",
    case_id: CASE_ID,
    trajectory_id: "traj_plugin_pass2_rerun",
    group: "h3_full_htsg_hook",
    start_trigger: "multi_key_verification_result",
    agent_action: "Completed bounded rerun and classified the surviving candidate using multi-key verification.",
    observation: pluginRerunDiagnosis.observations?.find((observation) => /statistical noise/i.test(observation))
      ?? "Multi-key average correlation fell below the noise floor.",
    failure_events: [
      makeFailureEvent("candidate_statistical_noise", "Pass2 diagnosis classified the best candidate as statistical noise after multi-key verification.", "high"),
      makeFailureEvent("unsupported_claim", "No verified 14-round DL distinguisher should be claimed from this evidence."),
    ],
    recovery_action: "Report bounded failure/no verified distinguisher instead of a successful distinguisher claim.",
    recovery_source: "tool_feedback_recovery",
    corrective_actions: summarizeCorrectiveActions(pluginRerunDiagnosis),
    correctness_label: "partially_correct",
    claim_boundary_ok: pluginRerunEvaluation.claim_boundary_ok,
    evidence_refs: [
      "plugin_rerun/evidence/failure_diagnosis.json",
      "plugin_rerun/artifacts/dl_rerun_results.json",
      "plugin_rerun/artifacts/simon32_dl_rerun_run.log",
    ],
  },
];

const hookResults = [
  {
    schema: "nss_evimem.failure_case_dataset.counterfactual_hook_result.v1",
    case_id: CASE_ID,
    group: "h1_no_hook_replay",
    trajectory_id: "traj_baseline_no_hook",
    hook_configuration: {
      evidence_memory: false,
      task_contract: false,
      tool_registry: false,
      failure_diagnosis: false,
      rerun_context: false,
    },
    observed_effect: {
      final_correctness: baselineEvaluation.final_correctness,
      evidence_completeness: baselineEvaluation.evidence_completeness,
      tool_calls_recorded: baselineEvaluation.tool_calls_recorded,
      oracle_alignment: baselineEvaluation.oracle_alignment,
    },
    interpretation: "No-hook replay gives the raw failure surface: outputs exist, but trust is not backed by structured evidence.",
  },
  {
    schema: "nss_evimem.failure_case_dataset.counterfactual_hook_result.v1",
    case_id: CASE_ID,
    group: "h2_evidence_only_hook",
    trajectory_id: "traj_plugin_pass1",
    hook_configuration: {
      evidence_memory: true,
      task_contract: true,
      tool_registry: true,
      failure_diagnosis: true,
      rerun_context: false,
    },
    observed_effect: {
      final_correctness: pluginPass1Evaluation.final_correctness,
      evidence_completeness: pluginPass1Evaluation.evidence_completeness,
      tool_calls_recorded: pluginPass1Evaluation.tool_calls_recorded,
      failure_types: pluginPass1Diagnosis.failure_types,
      corrective_actions: summarizeCorrectiveActions(pluginPass1Diagnosis),
      oracle_alignment: pluginPass1Evaluation.oracle_alignment,
    },
    interpretation: "Pass1 improves observability and diagnoses why the result remains insufficient, but does not yet use the diagnosis to rerun the task.",
  },
  {
    schema: "nss_evimem.failure_case_dataset.counterfactual_hook_result.v1",
    case_id: CASE_ID,
    group: "h3_full_htsg_hook",
    trajectory_id: "traj_plugin_pass2_rerun",
    hook_configuration: {
      evidence_memory: true,
      task_contract: true,
      tool_registry: true,
      failure_diagnosis: true,
      rerun_context: true,
    },
    observed_effect: {
      final_correctness: pluginRerunEvaluation.final_correctness,
      evidence_completeness: pluginRerunEvaluation.evidence_completeness,
      tool_calls_recorded: pluginRerunEvaluation.tool_calls_recorded,
      failure_types: pluginRerunDiagnosis.failure_types,
      rerun_context_used: pluginRerunEvaluation.rerun_context_used,
      oracle_alignment: pluginRerunEvaluation.oracle_alignment,
      run_summary: pluginRerunDiagnosis.run_summary,
    },
    interpretation: "Full hook replay turns prior failures into a bounded rerun and a safer final boundary: no verified distinguisher is claimed from noise-level evidence.",
  },
];

const distillationSamples = [
  {
    schema: "nss_evimem.failure_case_dataset.distillation_sample.v1",
    sample_id: "ds01_detect_statistical_noise",
    sample_type: "failure_detection_sample",
    case_id: CASE_ID,
    source_episode_id: "ep06_rerun_noise_classification",
    input: {
      task_contract: taskContract,
      run_summary: pluginRerunDiagnosis.run_summary,
      observations: pluginRerunDiagnosis.observations,
    },
    target: {
      failure_type: "candidate_statistical_noise",
      decision: "needs_rerun_or_bounded_failure",
      rationale: "Average multi-key correlation is below the declared noise floor, so the candidate cannot support a verified 14-round distinguisher claim.",
    },
  },
  {
    schema: "nss_evimem.failure_case_dataset.distillation_sample.v1",
    sample_id: "ds02_repair_timeout_search",
    sample_type: "repair_action_sample",
    case_id: CASE_ID,
    source_episode_id: "ep02_pass1_timeout_and_boundary",
    input: {
      failure_type: "search_timeout",
      prior_observations: pluginPass1Diagnosis.observations,
    },
    target: {
      action: "Use a bounded staged rerun with fast scan, progress logging, hard limits, and deep verification only for survivors.",
      evidence_boundary: "If verification remains incomplete, report bounded failure instead of success.",
    },
  },
  {
    schema: "nss_evimem.failure_case_dataset.distillation_sample.v1",
    sample_id: "ds03_select_capability_matched_tool",
    sample_type: "tool_selection_sample",
    case_id: CASE_ID,
    source_episode_id: "ep03_pass1_contract_guard",
    input: {
      task_contract: taskContract,
      registered_tools: Object.keys(toolCapabilities),
    },
    target: {
      selected_tool: Object.keys(toolCapabilities)[0] ?? "simon32_dl_rerun_search",
      required_capabilities: ["Monte Carlo correlation estimation", "Multi-key verification", "Differential-Linear connection at split point"],
      rejection_rule: "Do not use a tool whose declared output cannot support the task contract deliverables.",
    },
  },
  {
    schema: "nss_evimem.failure_case_dataset.distillation_sample.v1",
    sample_id: "ds04_ground_claim_in_evidence",
    sample_type: "evidence_grounding_sample",
    case_id: CASE_ID,
    source_episode_id: "ep04_pass1_noise_detected",
    input: {
      quick_scan_claim: "A high single-key correlation candidate may be a useful 14-round DL distinguisher.",
      stronger_evidence: pluginPass1Diagnosis.run_summary,
    },
    target: {
      grounded_claim: "The candidate is not verified; stronger checks put the signal near or below the noise floor.",
      cite_evidence: [
        "large_sample_corr",
        "multikey_avg_abs_corr",
        "noise_floor_2_18",
      ],
    },
  },
  {
    schema: "nss_evimem.failure_case_dataset.distillation_sample.v1",
    sample_id: "ds05_generate_task_contract",
    sample_type: "contract_generation_sample",
    case_id: CASE_ID,
    source_episode_id: "ep03_pass1_contract_guard",
    input: {
      natural_language_task: "Find and verify a 14-round differential-linear distinguisher for Simon32/64.",
    },
    target: {
      task_contract: taskContract,
      validation_expectations: [
        "analysis_type is differential-linear",
        "cipher is Simon32/64",
        "scope is 14-round",
        "deliverables include verification and correlation/weight",
      ],
    },
  },
];

const episodeTableRows = episodes.map((episode) => ({
  Episode: episode.episode_id,
  Trajectory: episode.trajectory_id,
  Failures: episode.failure_events.map((event) => event.failure_type).join(", "),
  Recovery: episode.recovery_source,
  Label: episode.correctness_label,
}));

const hookTableRows = hookResults.map((result) => ({
  Group: result.group,
  Trajectory: result.trajectory_id,
  Evidence: result.observed_effect.evidence_completeness,
  ToolCalls: result.observed_effect.tool_calls_recorded,
  Interpretation: result.interpretation,
}));

const caseReport = `# Failure Case Report: ${CASE_ID}

Generated: ${generatedAt}

## Case Summary

This report converts the existing real OpenClaw rerun artifacts into the failure-case dataset format from the experiment design. The case evaluates a 14-round Simon32/64 differential-linear search with three local trajectories: no hook, NSS-EviMem pass1, and NSS-EviMem rerun with context.

## Episode Labels

${formatTable(episodeTableRows, ["Episode", "Trajectory", "Failures", "Recovery", "Label"])}

## Counterfactual Hook Results

${formatTable(hookTableRows, ["Group", "Trajectory", "Evidence", "ToolCalls", "Interpretation"])}

## Main Failure Types

- search_timeout: the first instrumented pass needed a bounded staged rerun plan.
- tool_contract_mismatch: the task contract had to be checked against registered tool capability before claims.
- candidate_statistical_noise: the rerun classified the best candidate as noise after multi-key verification.

## Evidence Boundary

The final local rerun improves evidence structure and recovery behavior, but it is still labeled partially_correct rather than verified_correct because the oracle pair/reference match is not established and the strongest observed candidate is classified as statistical noise.
`;

const evaluationRubric = `# Failure-Case Evaluation Rubric

## Correctness Levels

- verified_correct: final answer matches the expected cryptanalytic target and is backed by executable artifacts, evidence records, and oracle/reference alignment.
- plausible_but_unverified: final answer is coherent and has some artifacts, but lacks enough verification or oracle alignment to be trusted.
- partially_correct: final answer preserves a valid evidence boundary or useful negative result, but does not fully solve the original task.
- incorrect: final answer makes a false or unsupported cryptanalytic claim, or uses a tool outside its declared capability.
- not_evaluable: required artifacts are missing, malformed, or insufficient to judge.

## Episode Labeling Rules

- Label each trajectory segment with failure_events, recovery_source, corrective action, and claim boundary.
- Treat hook_guided_recovery as present only when the hook-generated evidence changes the next action or final boundary.
- Treat tool_feedback_recovery as present when command output, timeout, logs, or solver feedback directly changes the next action.
- Do not upgrade a case to verified_correct unless claims are grounded in the required task contract and stronger verification.
`;

const datasetSummary = {
  schema: "nss_evimem.failure_case_dataset.summary.v1",
  case_id: CASE_ID,
  generated_at: generatedAt,
  source_run_dir: sourceRunDir,
  output_dir: datasetDir,
  counts: {
    cases: 1,
    trajectories: trajectories.length,
    episodes: episodes.length,
    counterfactual_hook_results: hookResults.length,
    distillation_samples: distillationSamples.length,
    pass1_tool_calls_read: pass1ToolCalls.length,
    rerun_tool_calls_read: rerunToolCalls.length,
  },
  required_failure_types_present: ["search_timeout", "candidate_statistical_noise", "tool_contract_mismatch"],
  required_recovery_sources_present: ["hook_guided_recovery", "tool_feedback_recovery"],
  design_route: "A",
};

writeJsonl("failure_case_dataset.jsonl", [caseRecord]);
writeJsonl("episode_labels.jsonl", episodes);
writeJsonl("counterfactual_hook_results.jsonl", hookResults);
writeJsonl("distillation_samples.jsonl", distillationSamples);
writeText(`case_reports/${CASE_ID}.md`, caseReport);
writeText("evaluation_rubric.md", evaluationRubric);
writeJson("dataset_summary.json", datasetSummary);

process.stdout.write(`${JSON.stringify({
  ok: true,
  case_id: CASE_ID,
  output_dir: datasetDir,
  episodes: episodes.length,
  counterfactual_hook_results: hookResults.length,
  distillation_samples: distillationSamples.length,
}, null, 2)}\n`);
