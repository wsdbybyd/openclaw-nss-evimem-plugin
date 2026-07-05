import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const experimentDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(experimentDir, "..", "..");
const seedRunDir = resolve(process.env.NSS_EVIMEM_RERUN_SEED_DIR ?? join(experimentDir, "runs", "openclaw-real-latest"));
const runDir = join(experimentDir, "runs", "openclaw-real-rerun-latest");
const baselineDir = join(runDir, "baseline");
const pluginPass1Dir = join(runDir, "plugin_pass1");
const pluginRerunDir = join(runDir, "plugin_rerun");
const workspaceRoot = "C:\\Users\\wsdbybyd\\.openclaw\\workspace-weak";
const workspaceCaseDir = join(workspaceRoot, "cbsc_simon32_dl_openclaw_real_rerun_latest");
const benchmarkQuestionPath = resolve(
  repoRoot,
  "..",
  "v4版本benchmark",
  "tasks",
  "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
  "public",
  "question.md",
);
const hiddenOraclePath = resolve(
  repoRoot,
  "..",
  "v4版本benchmark",
  "tasks",
  "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
  "hidden",
  "oracle.json",
);
const openclawMjs = "C:\\Users\\wsdbybyd\\AppData\\Roaming\\npm\\node_modules\\openclaw\\openclaw.mjs";
const openclawConfigPath = "C:\\Users\\wsdbybyd\\.openclaw\\openclaw.json";
const pluginId = "openclaw-nss-evimem-plugin";
const model = "bailian/qwen3.6-plus";
const timeoutSeconds = 1800;
const spawnTimeoutMs = (timeoutSeconds + 120) * 1000;

function assertInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === "" || (!rel.startsWith("..") && !rel.includes(":"))) {
    return;
  }
  throw new Error(`Refusing to modify path outside ${parent}: ${child}`);
}

function resetDirectory(parent, path) {
  assertInside(parent, path);
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

function readTextIfExists(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function copyDirectoryIfExists(from, to) {
  if (!existsSync(from)) {
    return false;
  }
  const stats = statSync(from);
  if (!stats.isDirectory()) {
    return false;
  }
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const source = join(from, entry);
    const target = join(to, entry);
    const entryStats = statSync(source);
    if (entryStats.isDirectory()) {
      copyDirectoryIfExists(source, target);
    } else if (entryStats.isFile()) {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
  }
  return true;
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
    return [relative(root, full)];
  });
}

function commandLine(command, args) {
  return [command, ...args.map((arg) => JSON.stringify(arg))].join(" ");
}

function runOpenClaw(args, options = {}) {
  const result = spawnSync(process.execPath, [openclawMjs, ...args], {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 120000,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 64,
  });

  return {
    command: commandLine(process.execPath, [openclawMjs, ...args]),
    status: result.status,
    signal: result.signal ?? null,
    error: result.error?.message ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function writeCommandResult(dir, result) {
  writeFileSync(join(dir, "openclaw_stdout.json"), result.stdout, "utf8");
  writeFileSync(join(dir, "openclaw_stderr.log"), result.stderr, "utf8");
  writeFileSync(join(dir, "openclaw_exit_code.txt"), `${result.status ?? "null"}\n`, "utf8");
  writeJson(join(dir, "openclaw_command.json"), {
    command: result.command,
    status: result.status,
    signal: result.signal,
    error: result.error,
  });
}

function getInitialPluginEnabled() {
  const config = readJson(openclawConfigPath);
  return config.plugins?.entries?.[pluginId]?.enabled === true;
}

function setPluginEnabled(enabled) {
  const result = runOpenClaw(["plugins", enabled ? "enable" : "disable", pluginId], {
    cwd: repoRoot,
    timeout: 120000,
  });
  if (result.status !== 0) {
    throw new Error(`Failed to ${enabled ? "enable" : "disable"} ${pluginId}: ${result.stderr || result.stdout}`);
  }
  return result;
}

function parseOpenClawPayloadText(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const payloads = Array.isArray(parsed.payloads) ? parsed.payloads : [];
    return payloads
      .map((payload) => typeof payload.text === "string" ? payload.text : "")
      .filter(Boolean)
      .join("\n\n");
  } catch {
    return stdout;
  }
}

function collectTextFromFiles(dir) {
  return listFiles(dir)
    .filter((file) => /\.(md|txt|json|jsonl|py|log)$/i.test(file))
    .map((file) => {
      const full = join(dir, file);
      const text = readTextIfExists(full);
      return `\n\n--- FILE ${file} ---\n${text.slice(0, 20000)}`;
    })
    .join("");
}

function normalizeHex(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function extractHexCandidates(text) {
  return [...text.matchAll(/0x[0-9a-fA-F]{8}/g)]
    .map((match) => match[0].toLowerCase());
}

function containsSplit(text, split) {
  const compact = text.replace(/\s+/g, "");
  return compact.includes(`[${split.join(",")}]`)
    || compact.includes(split.join(","))
    || compact.includes(split.join("-"));
}

function countJsonl(path) {
  if (!existsSync(path)) {
    return 0;
  }
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .length;
}

function hasValidContract(evidenceDir) {
  const path = join(evidenceDir, "contract_validation_events.jsonl");
  if (!existsSync(path)) {
    return false;
  }
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .some((line) => {
      try {
        const event = JSON.parse(line);
        return event.ok === true && event.status === "valid_contract";
      } catch {
        return false;
      }
    });
}

function hasGuardAllow(evidenceDir) {
  const path = join(evidenceDir, "tool_guard_events.jsonl");
  if (!existsSync(path)) {
    return false;
  }
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .some((line) => {
      try {
        const event = JSON.parse(line);
        return typeof event.decision === "string" && event.decision.includes("allow");
      } catch {
        return false;
      }
    });
}

function evaluateArm({
  mode,
  commandResult,
  stdoutPath,
  workspaceOutputDir,
  evidenceDir,
  oracle,
}) {
  const stdout = readTextIfExists(stdoutPath);
  const payloadText = parseOpenClawPayloadText(stdout);
  const fileText = collectTextFromFiles(workspaceOutputDir);
  const evidenceText = collectTextFromFiles(evidenceDir);
  const combinedText = `${payloadText}\n${fileText}\n${evidenceText}`;
  const hexCandidates = extractHexCandidates(combinedText);

  const expected = oracle.expected.core_answer.best_known_paper_pair;
  const reference = oracle.expected.reference_run_observation;
  const paperDelta = `0x${expected.delta_in_words.map((word) => word.replace(/^0x/i, "")).join("").toLowerCase()}`;
  const paperGamma = `0x${expected.gamma_out_words.map((word) => word.replace(/^0x/i, "")).join("").toLowerCase()}`;
  const bestSplit = expected.best_decomposition;

  const paperPairMatch = hexCandidates.includes(paperDelta) && hexCandidates.includes(paperGamma);
  const referencePairMatch = hexCandidates.includes(normalizeHex(reference.delta_in_32bit))
    && hexCandidates.includes(normalizeHex(reference.gamma_out_32bit));
  const bestSplitMentioned = containsSplit(combinedText, bestSplit);

  const toolCalls = countJsonl(join(evidenceDir, "tool_calls.jsonl"));
  const hasEvidenceIndex = existsSync(join(evidenceDir, "evidence_index.json"));
  const contractValid = hasValidContract(evidenceDir);
  const guardAllow = hasGuardAllow(evidenceDir);
  const capabilityRecorded = existsSync(join(evidenceDir, "tool_capabilities.json"));
  const failureDiagnosisRecorded = existsSync(join(evidenceDir, "failure_diagnosis.json"));
  const rerunPlanRecorded = existsSync(join(evidenceDir, "rerun_plan.md"));
  const rerunContextRecorded = existsSync(join(evidenceDir, "rerun_context.md"));
  const nssToolUsageDetected = /nss_evimem_/i.test(combinedText) || toolCalls > 0 || contractValid || capabilityRecorded;
  const rerunContextUsed = /nss_evimem_build_rerun_context|rerun_context|failure_diagnosis|rerun_plan/i.test(combinedText)
    || rerunContextRecorded;

  let evidenceCompleteness = "none";
  if (toolCalls > 0 || hasEvidenceIndex || contractValid || capabilityRecorded) {
    evidenceCompleteness = contractValid && capabilityRecorded ? "complete_or_structured" : "partial";
  }

  const claimBoundaryOk = /not\s+(a\s+)?proof|not\s+proved|not\s+verified|unverified|sampled|candidate|noise floor|statistical noise|未验证|未完全|样本|候选|不能证明/i.test(combinedText);
  const strongClaim = /correct final|verified correct|proved|optimal|solved|最终正确|已证明|最优/i.test(combinedText);
  const overclaimingDetected = strongClaim && !claimBoundaryOk;

  let finalCorrectness = "not_evaluable";
  if (paperPairMatch && bestSplitMentioned) {
    finalCorrectness = evidenceCompleteness === "none" ? "answer_matches_oracle_without_evidence" : "answer_matches_oracle_with_evidence";
  } else if (referencePairMatch || bestSplitMentioned || hexCandidates.length > 0) {
    finalCorrectness = "partially_correct_or_insufficient";
  } else if (commandResult.status === 0) {
    finalCorrectness = "not_evaluable";
  } else {
    finalCorrectness = "agent_run_failed";
  }

  return {
    schema: "nss_evimem.real_openclaw_arm_evaluation.v1",
    mode,
    openclaw_exit_code: commandResult.status,
    openclaw_signal: commandResult.signal,
    openclaw_error: commandResult.error,
    final_correctness: finalCorrectness,
    evidence_completeness: evidenceCompleteness,
    nss_tool_usage_detected: nssToolUsageDetected,
    contract_valid: contractValid,
    tool_semantic_match: guardAllow,
    tool_capability_recorded: capabilityRecorded,
    failure_diagnosis_recorded: failureDiagnosisRecorded,
    rerun_plan_recorded: rerunPlanRecorded,
    rerun_context_recorded: rerunContextRecorded,
    rerun_context_used: rerunContextUsed,
    tool_calls_recorded: toolCalls,
    claim_boundary_ok: claimBoundaryOk,
    overclaiming_detected: overclaimingDetected,
    output_files: listFiles(workspaceOutputDir),
    evidence_files: listFiles(evidenceDir),
    oracle_alignment: {
      paper_pair_match: paperPairMatch,
      reference_pair_match: referencePairMatch,
      best_split_mentioned: bestSplitMentioned,
      reported_hex_candidates: hexCandidates.slice(0, 20),
    },
  };
}

function makePluginRerunPrompt({
  pass1EvidenceSeedDir,
  pluginRerunEvidenceDir,
  pass1Evaluation,
}) {
  const buildArgs = {
    case_id: "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
    evidence_dir: pass1EvidenceSeedDir,
    output_path: join(pluginRerunEvidenceDir, "rerun_context.md"),
    prior_result_summary: {
      pass: "plugin_pass1",
      final_correctness: pass1Evaluation.final_correctness,
      evidence_completeness: pass1Evaluation.evidence_completeness,
      contract_valid: pass1Evaluation.contract_valid,
      failure_diagnosis_recorded: pass1Evaluation.failure_diagnosis_recorded,
      rerun_plan_recorded: pass1Evaluation.rerun_plan_recorded,
      oracle_alignment: pass1Evaluation.oracle_alignment,
    },
    extra_instructions: [
      "Focus the rerun on correcting the previous evidence boundary, not on producing a fresh unsupported claim.",
      "If the previous diagnosis says the candidate is statistical noise, reject it unless stronger verification reverses that conclusion.",
    ],
  };

  return [
    "You are the OpenClaw Agent running pass 2 of a NSS-EviMem correction-loop experiment.",
    "",
    "Task file:",
    "",
    "`cbsc_simon32_dl_openclaw_real_rerun_latest/question.md`",
    "",
    "Allowed previous-run context:",
    `- NSS-EviMem pass1 evidence seed directory: \`${pass1EvidenceSeedDir}\``,
    "- You may use only these seed files if present: `failure_diagnosis.json`, `rerun_plan.md`, `task_contract.json`, `tool_capabilities.json`, `tool_guard_events.jsonl`, and `evidence_index.json`.",
    "- Do not read pass1 workspace outputs, baseline outputs, hidden folders, oracle folders, or previous experiment report files.",
    "",
    "Strict required first action:",
    "Call `nss_evimem_build_rerun_context` with exactly this JSON object:",
    "",
    "```json",
    JSON.stringify(buildArgs, null, 2),
    "```",
    "",
    "Then use the returned prompt patch and `rerun_context.md` as the boundary for the rerun.",
    "",
    "Work directory and evidence:",
    "1. Work only under `cbsc_simon32_dl_openclaw_real_rerun_latest/plugin_rerun/` for new outputs.",
    `2. Use \`${pluginRerunEvidenceDir}\` as the evidence_dir for new NSS-EviMem calls after the rerun context is built.`,
    "",
    "Required NSS-EviMem actions before final answer:",
    "1. Call `nss_evimem_register_tool_capability` for the exact rerun search/checking method.",
    "2. Call `nss_evimem_validate_contract` using the validated Task Contract from the rerun context unless you explicitly justify a schema repair.",
    "3. Call `nss_evimem_guard_decision` in `post_repair` or `post_check` mode.",
    "4. Execute bounded code and record command/log/result artifacts.",
    "5. Call `nss_evimem_diagnose_failure` again before final answer.",
    "",
    "Required outputs:",
    "1. `cbsc_simon32_dl_openclaw_real_rerun_latest/plugin_rerun/final_answer.md`",
    "2. `cbsc_simon32_dl_openclaw_real_rerun_latest/plugin_rerun/event_log.jsonl`",
    "3. `cbsc_simon32_dl_openclaw_real_rerun_latest/plugin_rerun/rerun_context_use_report.md`",
    "4. `cbsc_simon32_dl_openclaw_real_rerun_latest/plugin_rerun/failure_diagnosis_summary.md` if the second diagnosis is not `no_failure_detected`.",
    "5. Any executable code or run logs under `cbsc_simon32_dl_openclaw_real_rerun_latest/plugin_rerun/artifacts/`.",
    "",
    "Final-answer rule: claim a verified distinguisher only if the new evidence survives the rerun checklist. Otherwise, state the strongest bounded result and why the rerun did or did not improve over pass1.",
  ].join("\n");
}

resetDirectory(experimentDir, runDir);
resetDirectory(workspaceRoot, workspaceCaseDir);
mkdirSync(baselineDir, { recursive: true });
mkdirSync(pluginPass1Dir, { recursive: true });
mkdirSync(pluginRerunDir, { recursive: true });
mkdirSync(join(workspaceCaseDir, "plugin_rerun"), { recursive: true });
mkdirSync(join(workspaceCaseDir, "plugin_rerun_evidence"), { recursive: true });

if (!existsSync(openclawMjs)) {
  throw new Error(`OpenClaw CLI entry not found: ${openclawMjs}`);
}
if (!existsSync(benchmarkQuestionPath)) {
  throw new Error(`Public question not found: ${benchmarkQuestionPath}`);
}
if (!existsSync(hiddenOraclePath)) {
  throw new Error(`Hidden oracle not found for evaluator: ${hiddenOraclePath}`);
}

const requiredSeedFiles = [
  "baseline/evaluation.json",
  "plugin/evaluation.json",
  "plugin/evidence/failure_diagnosis.json",
  "plugin/evidence/rerun_plan.md",
];
for (const relativePath of requiredSeedFiles) {
  const full = join(seedRunDir, relativePath);
  if (!existsSync(full)) {
    throw new Error(`Missing seed file for rerun experiment: ${full}. Run npm run experiment:cbsc-simon32-dl:openclaw-real first.`);
  }
}

copyFileSync(benchmarkQuestionPath, join(workspaceCaseDir, "question.md"));
copyFileSync(benchmarkQuestionPath, join(runDir, "question.md"));
copyDirectoryIfExists(join(seedRunDir, "baseline"), baselineDir);
copyDirectoryIfExists(join(seedRunDir, "plugin"), pluginPass1Dir);

const pass1EvidenceSeedDir = join(workspaceCaseDir, "plugin_pass1_evidence_seed");
copyDirectoryIfExists(join(seedRunDir, "plugin", "evidence"), pass1EvidenceSeedDir);
copyDirectoryIfExists(pass1EvidenceSeedDir, join(pluginPass1Dir, "evidence_seed_used_for_rerun"));

const oracle = readJson(hiddenOraclePath);
const baselineEvaluation = readJson(join(baselineDir, "evaluation.json"));
const pluginPass1Evaluation = readJson(join(pluginPass1Dir, "evaluation.json"));
const initialPluginEnabled = getInitialPluginEnabled();
const configBackupPath = join(runDir, "openclaw_config_before.json");
copyFileSync(openclawConfigPath, configBackupPath);

const pluginRerunEvidenceDir = join(workspaceCaseDir, "plugin_rerun_evidence");
const pluginRerunPrompt = makePluginRerunPrompt({
  pass1EvidenceSeedDir,
  pluginRerunEvidenceDir,
  pass1Evaluation: pluginPass1Evaluation,
});
writeFileSync(join(pluginRerunDir, "prompt.md"), pluginRerunPrompt, "utf8");

const stateChanges = [];
let pluginRerunRun;

try {
  stateChanges.push({ action: "enable", result: setPluginEnabled(true) });
  pluginRerunRun = runOpenClaw([
    "agent",
    "--local",
    "--model",
    model,
    "--session-key",
    `agent:weak:cbsc_simon32_dl_real_plugin_rerun_${Date.now()}`,
    "--timeout",
    String(timeoutSeconds),
    "--verbose",
    "on",
    "--json",
    "--message",
    pluginRerunPrompt,
  ], {
    cwd: workspaceRoot,
    timeout: spawnTimeoutMs,
    env: {
      ...process.env,
      NSS_EVIMEM_EVIDENCE_DIR: pluginRerunEvidenceDir,
      NSS_EVIMEM_SESSION_ID: "cbsc_simon32_dl_real_plugin_rerun",
    },
  });
  writeCommandResult(pluginRerunDir, pluginRerunRun);
} finally {
  const currentEnabled = getInitialPluginEnabled();
  if (currentEnabled !== initialPluginEnabled) {
    stateChanges.push({ action: initialPluginEnabled ? "restore-enable" : "restore-disable", result: setPluginEnabled(initialPluginEnabled) });
  }
}

copyDirectoryIfExists(join(workspaceCaseDir, "plugin_rerun"), join(pluginRerunDir, "workspace_outputs"));
copyDirectoryIfExists(pluginRerunEvidenceDir, join(pluginRerunDir, "evidence"));
writeJson(join(runDir, "openclaw_plugin_state_changes.json"), stateChanges.map((item) => ({
  action: item.action,
  status: item.result.status,
  stderr: item.result.stderr,
  stdout: item.result.stdout,
})));

const pluginRerunEvaluation = evaluateArm({
  mode: "real_openclaw_agent_with_nss_evimem_rerun_context",
  commandResult: pluginRerunRun,
  stdoutPath: join(pluginRerunDir, "openclaw_stdout.json"),
  workspaceOutputDir: join(pluginRerunDir, "workspace_outputs"),
  evidenceDir: join(pluginRerunDir, "evidence"),
  oracle,
});

writeJson(join(pluginRerunDir, "evaluation.json"), pluginRerunEvaluation);

const comparison = {
  seed_run_dir: seedRunDir,
  pass1_to_pass2_evidence_completeness: `${pluginPass1Evaluation.evidence_completeness}_to_${pluginRerunEvaluation.evidence_completeness}`,
  pass2_used_nss_tools: pluginRerunEvaluation.nss_tool_usage_detected,
  pass2_built_rerun_context: pluginRerunEvaluation.rerun_context_recorded,
  pass2_used_rerun_context: pluginRerunEvaluation.rerun_context_used,
  pass2_recorded_contract: pluginRerunEvaluation.contract_valid,
  pass2_recorded_failure_diagnosis: pluginRerunEvaluation.failure_diagnosis_recorded,
  pass2_recorded_rerun_plan: pluginRerunEvaluation.rerun_plan_recorded,
  pass1_final_correctness: pluginPass1Evaluation.final_correctness,
  pass2_final_correctness: pluginRerunEvaluation.final_correctness,
  pass1_paper_pair_match: pluginPass1Evaluation.oracle_alignment.paper_pair_match,
  pass2_paper_pair_match: pluginRerunEvaluation.oracle_alignment.paper_pair_match,
  pass1_best_split_mentioned: pluginPass1Evaluation.oracle_alignment.best_split_mentioned,
  pass2_best_split_mentioned: pluginRerunEvaluation.oracle_alignment.best_split_mentioned,
  pass1_overclaiming: pluginPass1Evaluation.overclaiming_detected,
  pass2_overclaiming: pluginRerunEvaluation.overclaiming_detected,
};

const summary = {
  schema: "nss_evimem.real_openclaw_rerun_experiment_summary.v1",
  case_id: "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
  generated_at: new Date().toISOString(),
  model,
  openclaw_entry: openclawMjs,
  workspace_case_dir: workspaceCaseDir,
  seed_run_dir: seedRunDir,
  baseline: baselineEvaluation,
  plugin_pass1: pluginPass1Evaluation,
  plugin_rerun: pluginRerunEvaluation,
  comparison,
};
writeJson(join(runDir, "experiment_summary.json"), summary);

const csvRows = [
  ["metric", "baseline_agent", "plugin_pass1", "plugin_pass2_rerun"],
  ["openclaw_exit_code", baselineEvaluation.openclaw_exit_code, pluginPass1Evaluation.openclaw_exit_code, pluginRerunEvaluation.openclaw_exit_code],
  ["final_correctness", baselineEvaluation.final_correctness, pluginPass1Evaluation.final_correctness, pluginRerunEvaluation.final_correctness],
  ["evidence_completeness", baselineEvaluation.evidence_completeness, pluginPass1Evaluation.evidence_completeness, pluginRerunEvaluation.evidence_completeness],
  ["nss_tool_usage_detected", baselineEvaluation.nss_tool_usage_detected, pluginPass1Evaluation.nss_tool_usage_detected, pluginRerunEvaluation.nss_tool_usage_detected],
  ["contract_valid", baselineEvaluation.contract_valid, pluginPass1Evaluation.contract_valid, pluginRerunEvaluation.contract_valid],
  ["tool_calls_recorded", baselineEvaluation.tool_calls_recorded, pluginPass1Evaluation.tool_calls_recorded, pluginRerunEvaluation.tool_calls_recorded],
  ["failure_diagnosis_recorded", baselineEvaluation.failure_diagnosis_recorded, pluginPass1Evaluation.failure_diagnosis_recorded, pluginRerunEvaluation.failure_diagnosis_recorded],
  ["rerun_plan_recorded", baselineEvaluation.rerun_plan_recorded, pluginPass1Evaluation.rerun_plan_recorded, pluginRerunEvaluation.rerun_plan_recorded],
  ["rerun_context_recorded", false, false, pluginRerunEvaluation.rerun_context_recorded],
  ["claim_boundary_ok", baselineEvaluation.claim_boundary_ok, pluginPass1Evaluation.claim_boundary_ok, pluginRerunEvaluation.claim_boundary_ok],
  ["overclaiming_detected", baselineEvaluation.overclaiming_detected, pluginPass1Evaluation.overclaiming_detected, pluginRerunEvaluation.overclaiming_detected],
  ["paper_pair_match", baselineEvaluation.oracle_alignment.paper_pair_match, pluginPass1Evaluation.oracle_alignment.paper_pair_match, pluginRerunEvaluation.oracle_alignment.paper_pair_match],
  ["best_split_mentioned", baselineEvaluation.oracle_alignment.best_split_mentioned, pluginPass1Evaluation.oracle_alignment.best_split_mentioned, pluginRerunEvaluation.oracle_alignment.best_split_mentioned],
];
const escapeCsv = (value) => {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
writeFileSync(
  join(runDir, "comparison_matrix.csv"),
  `${csvRows.map((row) => row.map(escapeCsv).join(",")).join("\n")}\n`,
  "utf8",
);

const report = [
  "# Real OpenClaw NSS-EviMem Rerun Correction Experiment",
  "",
  "## Setup",
  "",
  `- Case: \`${summary.case_id}\``,
  `- Model: \`${model}\``,
  `- Workspace: \`${workspaceCaseDir}\``,
  `- Seed run: \`${seedRunDir}\``,
  "- Baseline and plugin pass1 are copied from the seed run.",
  "- Plugin pass2 is a fresh local OpenClaw run with NSS-EviMem enabled and pass1 failure diagnosis as the allowed prior context.",
  "",
  "## Baseline Agent",
  "",
  `- Final correctness label: \`${baselineEvaluation.final_correctness}\``,
  `- Evidence completeness: \`${baselineEvaluation.evidence_completeness}\``,
  `- Paper pair match: \`${baselineEvaluation.oracle_alignment.paper_pair_match}\``,
  `- Best split mentioned: \`${baselineEvaluation.oracle_alignment.best_split_mentioned}\``,
  "",
  "## Plugin Agent Pass 1",
  "",
  `- Final correctness label: \`${pluginPass1Evaluation.final_correctness}\``,
  `- Evidence completeness: \`${pluginPass1Evaluation.evidence_completeness}\``,
  `- NSS tool usage detected: \`${pluginPass1Evaluation.nss_tool_usage_detected}\``,
  `- Failure diagnosis recorded: \`${pluginPass1Evaluation.failure_diagnosis_recorded}\``,
  `- Rerun plan recorded: \`${pluginPass1Evaluation.rerun_plan_recorded}\``,
  `- Paper pair match: \`${pluginPass1Evaluation.oracle_alignment.paper_pair_match}\``,
  `- Best split mentioned: \`${pluginPass1Evaluation.oracle_alignment.best_split_mentioned}\``,
  "",
  "## Plugin Agent Pass 2 Rerun",
  "",
  `- OpenClaw exit code: \`${pluginRerunEvaluation.openclaw_exit_code}\``,
  `- Final correctness label: \`${pluginRerunEvaluation.final_correctness}\``,
  `- Evidence completeness: \`${pluginRerunEvaluation.evidence_completeness}\``,
  `- NSS tool usage detected: \`${pluginRerunEvaluation.nss_tool_usage_detected}\``,
  `- Rerun context recorded: \`${pluginRerunEvaluation.rerun_context_recorded}\``,
  `- Rerun context used: \`${pluginRerunEvaluation.rerun_context_used}\``,
  `- Contract valid: \`${pluginRerunEvaluation.contract_valid}\``,
  `- Tool calls recorded: \`${pluginRerunEvaluation.tool_calls_recorded}\``,
  `- Failure diagnosis recorded: \`${pluginRerunEvaluation.failure_diagnosis_recorded}\``,
  `- Rerun plan recorded: \`${pluginRerunEvaluation.rerun_plan_recorded}\``,
  `- Claim boundary ok: \`${pluginRerunEvaluation.claim_boundary_ok}\``,
  `- Overclaiming detected: \`${pluginRerunEvaluation.overclaiming_detected}\``,
  `- Paper pair match: \`${pluginRerunEvaluation.oracle_alignment.paper_pair_match}\``,
  `- Best split mentioned: \`${pluginRerunEvaluation.oracle_alignment.best_split_mentioned}\``,
  "",
  "## Comparison",
  "",
  `- Pass1 to pass2 evidence completeness: \`${comparison.pass1_to_pass2_evidence_completeness}\``,
  `- Pass2 built rerun context: \`${comparison.pass2_built_rerun_context}\``,
  `- Pass2 used rerun context: \`${comparison.pass2_used_rerun_context}\``,
  `- Pass2 recorded failure diagnosis: \`${comparison.pass2_recorded_failure_diagnosis}\``,
  `- Pass1 final correctness: \`${comparison.pass1_final_correctness}\``,
  `- Pass2 final correctness: \`${comparison.pass2_final_correctness}\``,
  `- Pass1 overclaiming: \`${comparison.pass1_overclaiming}\``,
  `- Pass2 overclaiming: \`${comparison.pass2_overclaiming}\``,
  "",
  "## Interpretation",
  "",
  "This rerun experiment tests whether NSS-EviMem failure artifacts can be turned into a second-pass correction context.",
  "A pass2 oracle match would support correction-to-answer. A bounded negative pass2 result still supports the narrower claim-boundary correction loop.",
  "",
].join("\n");
writeFileSync(join(runDir, "experiment_report.md"), report, "utf8");

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
