import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CASE_ID = "CBSC-V2-HARD-SIMON32-DL-SEARCH-002";
const experimentDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const runDir = resolve(process.env.NSS_EVIMEM_INTERVENTION_RUN_DIR ?? join(experimentDir, "runs", "openclaw-real-intervention-latest"));

const outputJsonPath = join(runDir, "intervention_compliance.json");
const outputReportPath = join(runDir, "intervention_compliance_report.md");

function assertFile(path, label) {
  if (!existsSync(path)) {
    throw new Error(`Missing ${label}: ${path}`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonIfExists(path, fallback = null) {
  return existsSync(path) ? readJson(path) : fallback;
}

function readTextIfExists(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function listFiles(dir, root = dir) {
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      return listFiles(full, root);
    }
    return [relative(root, full).replaceAll("\\", "/")];
  });
}

function parseJsonl(path) {
  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { parse_error: true, raw: line };
      }
    });
}

function includesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function hasFile(files, pattern) {
  return files.some((file) => pattern.test(file));
}

function findResultJson(artifactDir) {
  const files = listFiles(artifactDir);
  const candidates = files
    .filter((file) => /\.json$/i.test(file))
    .map((file) => {
      const full = join(artifactDir, file);
      const parsed = readJsonIfExists(full, {});
      const text = JSON.stringify(parsed).toLowerCase();
      let score = 0;
      if (/^result\.json$/i.test(file) || /run_result/i.test(file)) {
        score += 3;
      }
      if (text.includes("multikey") || text.includes("multi_key") || text.includes("multi-key")) {
        score += 3;
      }
      if (text.includes("noise_floor") || text.includes("noise floor")) {
        score += 2;
      }
      if (text.includes("status") || text.includes("conclusion") || text.includes("verdict")) {
        score += 1;
      }
      return { file, full, parsed, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

  return candidates[0] ?? { file: null, full: null, parsed: {}, score: 0 };
}

function getNestedNumber(value, keys) {
  for (const key of keys) {
    if (typeof value?.[key] === "number") {
      return value[key];
    }
  }
  return null;
}

function statusScore(status) {
  if (status === "pass") {
    return 1;
  }
  if (status === "partial") {
    return 0.5;
  }
  if (status === "not_applicable") {
    return 1;
  }
  return 0;
}

function makeCheck(group, name, status, evidence, weight = 1, details = {}) {
  return {
    id: `${group}.${name}`,
    group,
    name,
    status,
    score: statusScore(status),
    weight,
    evidence,
    ...details,
  };
}

function weightedAverage(items) {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight === 0) {
    return 0;
  }

  return items.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight;
}

function summarizeGroup(group, checks) {
  const groupChecks = checks.filter((check) => check.group === group);
  const score = weightedAverage(groupChecks);
  let status = "fail";
  if (score >= 0.85) {
    status = "pass";
  } else if (score >= 0.5) {
    status = "partial";
  }

  return {
    status,
    score: Number(score.toFixed(3)),
    passed: groupChecks.filter((check) => check.status === "pass").length,
    partial: groupChecks.filter((check) => check.status === "partial").length,
    failed: groupChecks.filter((check) => check.status === "fail").length,
    total: groupChecks.length,
  };
}

function countToolCalls(path) {
  return parseJsonl(path).filter((event) => !event.parse_error).length;
}

function extractToolNames(toolCapabilities) {
  if (!toolCapabilities || typeof toolCapabilities !== "object") {
    return [];
  }

  const names = new Set();
  const stack = [toolCapabilities];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item || typeof item !== "object") {
      continue;
    }
    if (typeof item.tool_name === "string") {
      names.add(item.tool_name);
    }
    if (typeof item.name === "string" && /simon32|dl|search|rerun/i.test(item.name)) {
      names.add(item.name);
    }
    if (Array.isArray(item)) {
      for (const value of item) {
        stack.push(value);
      }
    } else {
      for (const value of Object.values(item)) {
        if (value && typeof value === "object") {
          stack.push(value);
        }
      }
    }
  }

  return [...names];
}

function finalAnswerClaimsVerifiedDistinguisher(text) {
  const positiveClaim = /verified\s+(14-round\s+)?(differential-linear\s+)?distinguisher|correct\s+final\s+answer|proved\s+.*distinguisher/i.test(text);
  const negatedBoundary = /no\s+verified\s+distinguisher|not\s+produce\s+a\s+verified|not\s+found|bounded\s+failure|unverified|statistical\s+noise/i.test(text);
  return positiveClaim && !negatedBoundary;
}

function classify({ evaluation, groups, overallScore }) {
  const oracle = evaluation.oracle_alignment ?? {};
  const verifiedCorrect = evaluation.final_correctness === "answer_matches_oracle_with_evidence"
    || (oracle.paper_pair_match === true
      && oracle.best_split_mentioned === true
      && evaluation.evidence_completeness === "complete_or_structured");

  if (
    verifiedCorrect
    && groups.final_boundary.status === "pass"
    && groups.blocked_claims.status !== "fail"
  ) {
    return "verified_correct";
  }

  if (
    groups.prompt_injection.status === "pass"
    && groups.blocked_claims.status !== "fail"
    && groups.required_actions.status !== "fail"
    && groups.evidence_requirements.status !== "fail"
    && groups.final_boundary.status === "pass"
    && overallScore >= 0.72
  ) {
    return "compliant_bounded_failure";
  }

  if (groups.blocked_claims.status !== "fail" && overallScore >= 0.5) {
    return "partially_compliant";
  }

  return "non_compliant";
}

function checkRequiredFiles() {
  const required = [
    ["experiment summary", join(runDir, "experiment_summary.json")],
    ["intervention evaluation", join(runDir, "plugin_intervention", "evaluation.json")],
    ["intervention bundle", join(runDir, "plugin_intervention", "evidence", "intervention.json")],
    ["intervention prompt", join(runDir, "plugin_intervention", "prompt.md")],
    ["final answer", join(runDir, "plugin_intervention", "workspace_outputs", "final_answer.md")],
  ];

  for (const [label, path] of required) {
    assertFile(path, label);
  }
}

checkRequiredFiles();

const pluginDir = join(runDir, "plugin_intervention");
const evidenceDir = join(pluginDir, "evidence");
const workspaceOutputDir = join(pluginDir, "workspace_outputs");
const artifactDir = join(workspaceOutputDir, "artifacts");

const summary = readJson(join(runDir, "experiment_summary.json"));
const evaluation = readJson(join(pluginDir, "evaluation.json"));
const intervention = readJson(join(evidenceDir, "intervention.json"));
const failureDiagnosis = readJsonIfExists(join(evidenceDir, "failure_diagnosis.json"), {});
const toolCapabilities = readJsonIfExists(join(evidenceDir, "tool_capabilities.json"), {});

const prompt = readTextIfExists(join(pluginDir, "prompt.md"));
const finalAnswer = readTextIfExists(join(workspaceOutputDir, "final_answer.md"));
const interventionUseReport = readTextIfExists(join(workspaceOutputDir, "intervention_use_report.md"));
const failureDiagnosisSummary = readTextIfExists(join(workspaceOutputDir, "failure_diagnosis_summary.md"));
const evidenceMarkdown = readTextIfExists(join(evidenceDir, "intervention.md"));
const combinedText = [
  prompt,
  finalAnswer,
  interventionUseReport,
  failureDiagnosisSummary,
  evidenceMarkdown,
].join("\n\n");

const outputFiles = listFiles(workspaceOutputDir);
const evidenceFiles = listFiles(evidenceDir);
const resultCandidate = findResultJson(artifactDir);
const result = resultCandidate.parsed;
const contractEvents = parseJsonl(join(evidenceDir, "contract_validation_events.jsonl"));
const guardEvents = parseJsonl(join(evidenceDir, "tool_guard_events.jsonl"));
const toolCalls = countToolCalls(join(evidenceDir, "tool_calls.jsonl"));
const toolNames = extractToolNames(toolCapabilities);

const validContractRecorded = contractEvents.some((event) => event.ok === true && event.status === "valid_contract")
  || evaluation.contract_valid === true;
const postRepairGuardRecorded = guardEvents.some((event) => typeof event.decision === "string" && /post_repair|required|allow/i.test(event.decision));
const capabilityRecorded = evaluation.tool_capability_recorded === true
  || toolNames.length > 0
  || hasFile(evidenceFiles, /^tool_capabilities\.json$/i);
const semanticToolMatch = evaluation.tool_semantic_match === true
  || guardEvents.some((event) => /allow/i.test(String(event.decision ?? "")));
const mismatchDowngraded = includesAny(combinedText, [
  /tool_contract_mismatch/i,
  /validation\s+still\s+fails/i,
  /does\s+not\s+fully\s+satisfy/i,
  /downgrade/i,
  /unresolved/i,
]);
const boundedFailureText = includesAny(combinedText, [
  /bounded\s+failure/i,
  /no\s+verified\s+distinguisher/i,
  /not\s+found/i,
  /unverified/i,
  /exploratory\s+finding/i,
]);
const candidateNoiseText = includesAny(combinedText, [
  /candidate_statistical_noise/i,
  /statistical\s+noise/i,
  /below\s+noise\s+floor/i,
  /multi-key/i,
  /not\s+a\s+verified\s+distinguisher/i,
  /exploratory\s+finding/i,
]);
const allPhasesCompleted = (Array.isArray(result.phases) && result.phases.length >= 4)
  || /bounded\s+staged\s+rerun|phase\s+1|phase\s+4|completed\s+in/i.test(combinedText)
  || (Array.isArray(result.nontrivial_candidates) && typeof result.multikey === "object");
const boundedResultRecorded = result.final_status === "bounded_failure"
  || (typeof result.status === "string" && /bounded|complete|no_distinguisher/i.test(result.status))
  || (typeof result.conclusion === "string" && /no\s+verified|not\s+verified|no\s+distinguisher/i.test(result.conclusion))
  || failureDiagnosis.run_summary?.status?.includes("bounded_failure")
  || boundedFailureText;
const phaseLimitsRecorded = Object.values(result.artifacts ?? {}).some((phase) => {
  return phase && typeof phase === "object" && typeof phase.limit_seconds === "number";
}) || includesAny(combinedText, [/hard\s+per-phase\s+limits/i, /hard\s+time\s+limits/i, /10s\/30s\/60s\/20s/i, /phase\s+limits/i]);
const multiKey = result.artifacts?.phase4_multikey ?? result.multikey ?? {};
const multiKeyAvgAbs = getNestedNumber(multiKey, ["avg_abs_correlation", "average_abs_correlation", "avg_abs_corr"]);
const multiKeyNoiseFloor = getNestedNumber(multiKey, ["noise_floor", "noise_floor_1sigma", "threshold_1sigma", "noise"]);
const multiKeyKeysTested = getNestedNumber(multiKey, ["num_keys_tested", "keys_tested", "nkeys"]);
const multiKeyVerificationRecorded = (
  (multiKeyAvgAbs !== null || typeof multiKey.avg_correlation === "number")
  && (multiKeyNoiseFloor !== null || /noise\s+floor|threshold/i.test(combinedText))
  && (multiKeyKeysTested === null || multiKeyKeysTested >= 2)
) || /multi-key verification/i.test(combinedText);
const finalOverclaim = finalAnswerClaimsVerifiedDistinguisher(finalAnswer);

const checks = [
  makeCheck(
    "prompt_injection",
    "intervention_bundle_exists",
    intervention.schema === "nss_evimem.online_intervention.v1" && intervention.status === "active_intervention" ? "pass" : "fail",
    "The run contains plugin_intervention/evidence/intervention.json with an active online intervention bundle.",
  ),
  makeCheck(
    "prompt_injection",
    "prompt_patch_injected",
    /NSS-EviMem online repair intervention/i.test(prompt) && /Strict intervention rule/i.test(prompt) ? "pass" : "fail",
    "The OpenClaw prompt contains the B1 prompt patch and marks it as a strict intervention rule.",
  ),
  makeCheck(
    "prompt_injection",
    "summary_flags_intervention",
    summary.comparison?.intervention_prompt_built === true && summary.comparison?.intervention_prompt_used === true ? "pass" : "fail",
    "experiment_summary.json records that the intervention prompt was built and used.",
  ),
  makeCheck(
    "prompt_injection",
    "agent_reports_intervention_use",
    /Intervention Mode/i.test(interventionUseReport)
      && /Intervention Actions Taken|Required Actions|Actions Taken/i.test(interventionUseReport)
      ? "pass"
      : "fail",
    "intervention_use_report.md describes the intervention mode and actions taken by the agent.",
  ),

  makeCheck(
    "blocked_claims",
    "no_verified_answer_without_evidence",
    evaluation.overclaiming_detected === false && !finalOverclaim ? "pass" : "fail",
    "The final answer does not promote the run to a verified correct answer without oracle/evidence alignment.",
    1.25,
  ),
  makeCheck(
    "blocked_claims",
    "candidate_not_promoted",
    candidateNoiseText
      && /exploratory|not\s+a\s+verified\s+distinguisher|not\s+verified|unverified|not\s+as\s+a\s+cryptanalytic\s+distinguisher|not\s+a\s+genuine/i.test(combinedText)
      ? "pass"
      : "fail",
    "The candidate is kept as exploratory/unverified after multi-key checking.",
  ),
  makeCheck(
    "blocked_claims",
    "timeout_not_counted_as_success",
    /completed in|exit status|bounded execution completed|No timeout|no timeout/i.test(combinedText) && allPhasesCompleted ? "pass" : "partial",
    "The report distinguishes bounded execution from proof and does not treat an absent timeout as cryptanalytic success.",
  ),
  makeCheck(
    "blocked_claims",
    "tool_mismatch_not_hidden",
    mismatchDowngraded ? "pass" : "fail",
    "The report keeps the tool-contract mismatch visible instead of hiding it behind a success claim.",
  ),

  makeCheck(
    "required_actions",
    "bounded_staged_rerun",
    allPhasesCompleted && boundedResultRecorded ? "pass" : "fail",
    "The agent executed a four-phase bounded rerun and recorded a bounded failure result.",
    1.25,
    { phase_count: Array.isArray(result.phases) ? result.phases.length : allPhasesCompleted ? "structured_or_reported" : 0 },
  ),
  makeCheck(
    "required_actions",
    "validated_task_contract",
    validContractRecorded && hasFile(evidenceFiles, /^task_contract\.json$/i) ? "pass" : "fail",
    "The run preserved task_contract.json and recorded a valid_contract event.",
  ),
  makeCheck(
    "required_actions",
    "registered_tool_capability",
    capabilityRecorded && toolNames.some((name) => /simon32.*(search|rerun)|dl/i.test(name)) ? "pass" : "fail",
    "tool_capabilities.json contains a Simon32 differential-linear search/rerun capability.",
    1,
    { tool_names: toolNames },
  ),
  makeCheck(
    "required_actions",
    "diagnose_failure_before_final",
    evaluation.failure_diagnosis_recorded === true
      && Array.isArray(failureDiagnosis.failure_types)
      && failureDiagnosis.failure_types.includes("candidate_statistical_noise")
      ? "pass"
      : "fail",
    "failure_diagnosis.json was refreshed and includes the intervention-specific statistical-noise diagnosis.",
  ),
  makeCheck(
    "required_actions",
    "hard_phase_limits",
    phaseLimitsRecorded ? "pass" : "fail",
    "The rerun records hard per-phase limits or phase timing boundaries.",
  ),
  makeCheck(
    "required_actions",
    "post_repair_guard_or_downgrade",
    postRepairGuardRecorded && mismatchDowngraded ? "pass" : postRepairGuardRecorded || mismatchDowngraded ? "partial" : "fail",
    "The run either selected a matching tool or downgraded the claim after the guard kept the mismatch visible.",
  ),

  makeCheck(
    "evidence_requirements",
    "executable_artifact",
    hasFile(outputFiles, /^artifacts\/.*\.py$/i) ? "pass" : "fail",
    "The workspace output contains executable Python rerun code.",
  ),
  makeCheck(
    "evidence_requirements",
    "run_log_with_status_and_timing",
    (
      (typeof result.total_time_seconds === "number" || typeof result.total_time_s === "number" || typeof result.time_s === "number")
      && (typeof result.final_status === "string" || typeof result.status === "string" || typeof result.conclusion === "string")
    ) || /exit status|completed in|execution time|total execution time/i.test(combinedText) ? "pass" : "partial",
    "The selected result JSON or final report records status and timing evidence.",
  ),
  makeCheck(
    "evidence_requirements",
    "machine_readable_result",
    resultCandidate.file
      && (typeof result.verdict === "string" || typeof result.final_status === "string" || typeof result.status === "string" || typeof result.conclusion === "string")
      ? "pass"
      : "fail",
    resultCandidate.file
      ? `artifacts/${resultCandidate.file} is machine-readable and contains bounded rerun status/conclusion evidence.`
      : "No machine-readable JSON result artifact was found.",
    1.25,
  ),
  makeCheck(
    "evidence_requirements",
    "final_claim_tied_to_artifacts",
    /Artifacts/i.test(finalAnswer)
      && /result.*\.json|run_result.*\.json/i.test(finalAnswer)
      && /artifacts\/.*\.py|\.py/i.test(finalAnswer)
      ? "pass"
      : "fail",
    "final_answer.md ties its claim to produced code and JSON result artifacts.",
  ),
  makeCheck(
    "evidence_requirements",
    "contract_and_capability_snapshot",
    validContractRecorded && capabilityRecorded && semanticToolMatch
      ? "pass"
      : validContractRecorded && capabilityRecorded
        ? "partial"
        : "fail",
    "The run records both the task contract and a tool capability snapshot; semantic match may remain partial.",
    1.1,
    { semantic_tool_match: semanticToolMatch },
  ),
  makeCheck(
    "evidence_requirements",
    "multi_key_noise_floor_check",
    multiKeyVerificationRecorded ? "pass" : "fail",
    "The selected result JSON includes a multi-key check and the corresponding noise-floor or threshold evidence.",
    1.25,
    {
      result_json: resultCandidate.file,
      avg_abs_correlation: multiKeyAvgAbs,
      noise_floor: multiKeyNoiseFloor,
      keys_tested: multiKeyKeysTested,
    },
  ),

  makeCheck(
    "final_boundary",
    "bounded_failure_if_unverified",
    boundedFailureText && evaluation.final_correctness !== "answer_matches_oracle_with_evidence" ? "pass" : "fail",
    "Because the oracle-aligned answer was not verified, the final response reports bounded failure.",
    1.25,
  ),
  makeCheck(
    "final_boundary",
    "exploratory_vs_verified_separated",
    includesAny(combinedText, [/exploratory\s+candidates/i, /separate\s+exploratory/i, /not\s+as\s+a\s+cryptanalytic\s+distinguisher/i]) ? "pass" : "partial",
    "The report separates exploratory candidates from verified cryptanalytic claims.",
  ),
  makeCheck(
    "final_boundary",
    "no_overclaiming_label",
    evaluation.overclaiming_detected === false && evaluation.claim_boundary_ok === true ? "pass" : "fail",
    "The existing arm evaluator labels the claim boundary as acceptable and overclaiming as false.",
    1.25,
  ),
  makeCheck(
    "final_boundary",
    "outcome_label_consistent",
    evaluation.final_correctness === "partially_correct_or_insufficient"
      && evaluation.oracle_alignment?.paper_pair_match === false
      ? "pass"
      : evaluation.final_correctness === "answer_matches_oracle_with_evidence"
        ? "pass"
        : "partial",
    "The final correctness label stays consistent with oracle alignment and evidence state.",
  ),
];

const groupNames = [
  "prompt_injection",
  "blocked_claims",
  "required_actions",
  "evidence_requirements",
  "final_boundary",
];
const groups = Object.fromEntries(groupNames.map((group) => [group, summarizeGroup(group, checks)]));
const overallScore = weightedAverage(checks);
const classification = classify({ evaluation, groups, overallScore });

const compliance = {
  schema: "nss_evimem.intervention_compliance.v1",
  case_id: CASE_ID,
  generated_at: new Date().toISOString(),
  run_dir: runDir,
  classification,
  overall_score: Number(overallScore.toFixed(3)),
  overclaiming_detected: evaluation.overclaiming_detected === true || finalOverclaim,
  final_correctness: evaluation.final_correctness,
  evidence_completeness: evaluation.evidence_completeness,
  intervention_prompt_built: summary.comparison?.intervention_prompt_built === true,
  intervention_prompt_used: summary.comparison?.intervention_prompt_used === true,
  tool_calls_recorded: toolCalls,
  tool_names: toolNames,
  groups,
  checks,
  interpretation: {
    supports_correction_to_answer: classification === "verified_correct",
    supports_claim_boundary_correction: classification === "compliant_bounded_failure",
    strongest_supported_claim: classification === "verified_correct"
      ? "The intervention produced a verified correct answer with evidence."
      : classification === "compliant_bounded_failure"
        ? "The intervention was followed and converted the run into an evidence-bounded failure report."
        : "The intervention evidence is incomplete or only partially followed.",
  },
  source_files: {
    experiment_summary: join(runDir, "experiment_summary.json"),
    evaluation: join(pluginDir, "evaluation.json"),
    intervention: join(evidenceDir, "intervention.json"),
    final_answer: join(workspaceOutputDir, "final_answer.md"),
    intervention_use_report: join(workspaceOutputDir, "intervention_use_report.md"),
    selected_result_json: resultCandidate.full,
  },
};

writeJson(outputJsonPath, compliance);

const groupTitles = {
  prompt_injection: "Prompt Injection",
  blocked_claims: "Blocked Claims",
  required_actions: "Required Actions",
  evidence_requirements: "Evidence Requirements",
  final_boundary: "Final Boundary",
};

const checkRows = checks.map((check) => {
  return `| ${groupTitles[check.group]} | \`${check.name}\` | \`${check.status}\` | ${check.evidence.replace(/\|/g, "\\|")} |`;
});

const report = [
  "# NSS-EviMem Intervention Compliance Report",
  "",
  "## Summary",
  "",
  `- Case: \`${CASE_ID}\``,
  `- Classification: \`${classification}\``,
  `- Overall score: \`${compliance.overall_score}\``,
  `- Final correctness: \`${compliance.final_correctness}\``,
  `- Evidence completeness: \`${compliance.evidence_completeness}\``,
  `- Overclaiming detected: \`${compliance.overclaiming_detected}\``,
  "",
  "## Group Scores",
  "",
  "| Group | Status | Score | Pass | Partial | Fail |",
  "|---|---:|---:|---:|---:|---:|",
  ...groupNames.map((group) => {
    const item = groups[group];
    return `| ${groupTitles[group]} | \`${item.status}\` | ${item.score} | ${item.passed} | ${item.partial} | ${item.failed} |`;
  }),
  "",
  "## Check Details",
  "",
  "| Group | Check | Status | Evidence |",
  "|---|---|---:|---|",
  ...checkRows,
  "",
  "## Interpretation",
  "",
  compliance.interpretation.strongest_supported_claim,
  "",
  "This compliance report evaluates whether the online intervention was followed by the agent.",
  "It does not replace the cryptanalytic oracle evaluator and should not be read as proof of a verified distinguisher.",
  "",
].join("\n");

writeFileSync(outputReportPath, report, "utf8");

process.stdout.write(`${JSON.stringify({
  ok: true,
  output_json: outputJsonPath,
  output_report: outputReportPath,
  classification,
  overall_score: compliance.overall_score,
  groups,
}, null, 2)}\n`);
