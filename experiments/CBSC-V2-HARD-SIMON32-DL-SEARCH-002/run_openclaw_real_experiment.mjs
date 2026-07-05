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
const runDir = join(experimentDir, "runs", "openclaw-real-latest");
const baselineDir = join(runDir, "baseline");
const pluginDir = join(runDir, "plugin");
const workspaceRoot = "C:\\Users\\wsdbybyd\\.openclaw\\workspace-weak";
const workspaceCaseDir = join(workspaceRoot, "cbsc_simon32_dl_openclaw_real_latest");
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
  const combinedText = `${payloadText}\n${fileText}`;
  const lowerText = combinedText.toLowerCase();
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
  const nssToolUsageDetected = /nss_evimem_/i.test(combinedText) || toolCalls > 0 || contractValid || capabilityRecorded;

  let evidenceCompleteness = "none";
  if (toolCalls > 0 || hasEvidenceIndex || contractValid || capabilityRecorded) {
    evidenceCompleteness = contractValid && capabilityRecorded ? "complete_or_structured" : "partial";
  }

  const claimBoundaryOk = /not\s+(a\s+)?proof|not\s+proved|not\s+verified|unverified|sampled|candidate|未证明|未完全|样本|候选|不能证明/i.test(combinedText);
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

function makeBaselinePrompt() {
  return [
    "You are the original OpenClaw Agent. The NSS-EviMem plugin is disabled for this run.",
    "",
    "Solve the real benchmark task in this workspace:",
    "",
    "`cbsc_simon32_dl_openclaw_real_latest/question.md`",
    "",
    "Strict rules:",
    "1. Do not read any hidden, oracle, or answer folder from the benchmark source.",
    "2. Do not read prior case outputs, prior experiment outputs, or plugin-generated outputs.",
    "3. Work only under `cbsc_simon32_dl_openclaw_real_latest/baseline/` for outputs.",
    "4. If you cannot fully solve the task, state the strongest result reached and the unverified boundary.",
    "",
    "Required outputs:",
    "1. `cbsc_simon32_dl_openclaw_real_latest/baseline/final_answer.md`",
    "2. `cbsc_simon32_dl_openclaw_real_latest/baseline/event_log.jsonl`",
    "3. Any executable code or run logs under `cbsc_simon32_dl_openclaw_real_latest/baseline/artifacts/`",
    "",
    "The final answer must include the input difference, output linear mask, round split, correlation or equivalent weight, and executable evidence if you produced it.",
  ].join("\n");
}

function makePluginPrompt(pluginEvidenceDir) {
  return [
    "You are the OpenClaw Agent solving the same benchmark with the `openclaw-nss-evimem-plugin` enabled.",
    "",
    "Task file:",
    "",
    "`cbsc_simon32_dl_openclaw_real_latest/question.md`",
    "",
    "Strict rules:",
    "1. Do not read any hidden, oracle, or answer folder from the benchmark source.",
    "2. Do not read prior case outputs, prior experiment outputs, or baseline outputs except the public question file.",
    "3. Work only under `cbsc_simon32_dl_openclaw_real_latest/plugin/` for outputs.",
    "4. If you cannot fully solve the task, state the strongest result reached and the unverified boundary.",
    "",
    "Required NSS-EviMem actions before final answer:",
    "1. Call `nss_evimem_register_tool_capability` for the executable search/checking method you use. Use `evidence_dir`:",
    `   \`${pluginEvidenceDir}\``,
    "2. Call `nss_evimem_validate_contract` with a Task Contract for this Simon32/64 14-round differential-linear task.",
    "3. Call `nss_evimem_guard_decision` in `post_check` mode to compare the task contract with the tool capability.",
    "4. After producing executable evidence, call `nss_evimem_promote_memory` if an evidence id is available.",
    "5. Before the final answer, call `nss_evimem_diagnose_failure` with the current Task Contract, observed run summary, and observations. If the task is not fully solved, use its `rerun_plan.md` boundary in the final answer.",
    "",
    "Required outputs:",
    "1. `cbsc_simon32_dl_openclaw_real_latest/plugin/final_answer.md`",
    "2. `cbsc_simon32_dl_openclaw_real_latest/plugin/event_log.jsonl`",
    "3. `cbsc_simon32_dl_openclaw_real_latest/plugin/memory_use_report.md`",
    "4. `cbsc_simon32_dl_openclaw_real_latest/plugin/failure_diagnosis_summary.md` if `nss_evimem_diagnose_failure` reports a rerun or evidence boundary.",
    "5. Any executable code or run logs under `cbsc_simon32_dl_openclaw_real_latest/plugin/artifacts/`",
    "",
    "The final answer must include the input difference, output linear mask, round split, correlation or equivalent weight, and the evidence boundary. Do not claim verified correctness unless the evidence supports it.",
  ].join("\n");
}

resetDirectory(experimentDir, runDir);
resetDirectory(workspaceRoot, workspaceCaseDir);
mkdirSync(baselineDir, { recursive: true });
mkdirSync(pluginDir, { recursive: true });
mkdirSync(join(workspaceCaseDir, "baseline"), { recursive: true });
mkdirSync(join(workspaceCaseDir, "plugin"), { recursive: true });
mkdirSync(join(workspaceCaseDir, "plugin_evidence"), { recursive: true });

if (!existsSync(openclawMjs)) {
  throw new Error(`OpenClaw CLI entry not found: ${openclawMjs}`);
}
if (!existsSync(benchmarkQuestionPath)) {
  throw new Error(`Public question not found: ${benchmarkQuestionPath}`);
}
if (!existsSync(hiddenOraclePath)) {
  throw new Error(`Hidden oracle not found for evaluator: ${hiddenOraclePath}`);
}

copyFileSync(benchmarkQuestionPath, join(workspaceCaseDir, "question.md"));
copyFileSync(benchmarkQuestionPath, join(runDir, "question.md"));

const oracle = readJson(hiddenOraclePath);
const initialPluginEnabled = getInitialPluginEnabled();
const configBackupPath = join(runDir, "openclaw_config_before.json");
copyFileSync(openclawConfigPath, configBackupPath);

const baselinePrompt = makeBaselinePrompt();
const pluginEvidenceDir = join(workspaceCaseDir, "plugin_evidence");
const pluginPrompt = makePluginPrompt(pluginEvidenceDir);
writeFileSync(join(baselineDir, "prompt.md"), baselinePrompt, "utf8");
writeFileSync(join(pluginDir, "prompt.md"), pluginPrompt, "utf8");

const stateChanges = [];
let baselineRun;
let pluginRun;

try {
  stateChanges.push({ action: "disable", result: setPluginEnabled(false) });
  baselineRun = runOpenClaw([
    "agent",
    "--local",
    "--model",
    model,
    "--session-key",
    `agent:weak:cbsc_simon32_dl_real_baseline_${Date.now()}`,
    "--timeout",
    String(timeoutSeconds),
    "--verbose",
    "on",
    "--json",
    "--message",
    baselinePrompt,
  ], {
    cwd: workspaceRoot,
    timeout: spawnTimeoutMs,
    env: {
      ...process.env,
      NSS_EVIMEM_EVIDENCE_DIR: join(workspaceCaseDir, "baseline_evidence_disabled"),
      NSS_EVIMEM_SESSION_ID: "cbsc_simon32_dl_real_baseline",
    },
  });
  writeCommandResult(baselineDir, baselineRun);

  stateChanges.push({ action: "enable", result: setPluginEnabled(true) });
  pluginRun = runOpenClaw([
    "agent",
    "--local",
    "--model",
    model,
    "--session-key",
    `agent:weak:cbsc_simon32_dl_real_plugin_${Date.now()}`,
    "--timeout",
    String(timeoutSeconds),
    "--verbose",
    "on",
    "--json",
    "--message",
    pluginPrompt,
  ], {
    cwd: workspaceRoot,
    timeout: spawnTimeoutMs,
    env: {
      ...process.env,
      NSS_EVIMEM_EVIDENCE_DIR: pluginEvidenceDir,
      NSS_EVIMEM_SESSION_ID: "cbsc_simon32_dl_real_plugin",
    },
  });
  writeCommandResult(pluginDir, pluginRun);
} finally {
  const currentEnabled = getInitialPluginEnabled();
  if (currentEnabled !== initialPluginEnabled) {
    stateChanges.push({ action: initialPluginEnabled ? "restore-enable" : "restore-disable", result: setPluginEnabled(initialPluginEnabled) });
  }
}

copyDirectoryIfExists(join(workspaceCaseDir, "baseline"), join(baselineDir, "workspace_outputs"));
copyDirectoryIfExists(join(workspaceCaseDir, "plugin"), join(pluginDir, "workspace_outputs"));
copyDirectoryIfExists(pluginEvidenceDir, join(pluginDir, "evidence"));
writeJson(join(runDir, "openclaw_plugin_state_changes.json"), stateChanges.map((item) => ({
  action: item.action,
  status: item.result.status,
  stderr: item.result.stderr,
  stdout: item.result.stdout,
})));

const baselineEvaluation = evaluateArm({
  mode: "real_openclaw_agent_without_nss_evimem",
  commandResult: baselineRun,
  stdoutPath: join(baselineDir, "openclaw_stdout.json"),
  workspaceOutputDir: join(baselineDir, "workspace_outputs"),
  evidenceDir: join(baselineDir, "evidence"),
  oracle,
});
const pluginEvaluation = evaluateArm({
  mode: "real_openclaw_agent_with_nss_evimem",
  commandResult: pluginRun,
  stdoutPath: join(pluginDir, "openclaw_stdout.json"),
  workspaceOutputDir: join(pluginDir, "workspace_outputs"),
  evidenceDir: join(pluginDir, "evidence"),
  oracle,
});

writeJson(join(baselineDir, "evaluation.json"), baselineEvaluation);
writeJson(join(pluginDir, "evaluation.json"), pluginEvaluation);

const comparison = {
  evidence_completeness_delta: `${baselineEvaluation.evidence_completeness}_to_${pluginEvaluation.evidence_completeness}`,
  plugin_used_nss_tools: pluginEvaluation.nss_tool_usage_detected,
  plugin_recorded_contract: pluginEvaluation.contract_valid,
  plugin_recorded_tool_calls: pluginEvaluation.tool_calls_recorded > 0,
  plugin_recorded_failure_diagnosis: pluginEvaluation.failure_diagnosis_recorded,
  plugin_recorded_rerun_plan: pluginEvaluation.rerun_plan_recorded,
  baseline_overclaiming: baselineEvaluation.overclaiming_detected,
  plugin_overclaiming: pluginEvaluation.overclaiming_detected,
  plugin_claim_boundary_improved: baselineEvaluation.claim_boundary_ok === false && pluginEvaluation.claim_boundary_ok === true,
  baseline_final_correctness: baselineEvaluation.final_correctness,
  plugin_final_correctness: pluginEvaluation.final_correctness,
};

const summary = {
  schema: "nss_evimem.real_openclaw_experiment_summary.v1",
  case_id: "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
  generated_at: new Date().toISOString(),
  model,
  openclaw_entry: openclawMjs,
  workspace_case_dir: workspaceCaseDir,
  baseline: baselineEvaluation,
  plugin: pluginEvaluation,
  comparison,
};
writeJson(join(runDir, "experiment_summary.json"), summary);

const csvRows = [
  ["metric", "baseline_agent", "plugin_agent"],
  ["openclaw_exit_code", baselineEvaluation.openclaw_exit_code, pluginEvaluation.openclaw_exit_code],
  ["final_correctness", baselineEvaluation.final_correctness, pluginEvaluation.final_correctness],
  ["evidence_completeness", baselineEvaluation.evidence_completeness, pluginEvaluation.evidence_completeness],
  ["nss_tool_usage_detected", baselineEvaluation.nss_tool_usage_detected, pluginEvaluation.nss_tool_usage_detected],
  ["contract_valid", baselineEvaluation.contract_valid, pluginEvaluation.contract_valid],
  ["tool_calls_recorded", baselineEvaluation.tool_calls_recorded, pluginEvaluation.tool_calls_recorded],
  ["failure_diagnosis_recorded", baselineEvaluation.failure_diagnosis_recorded, pluginEvaluation.failure_diagnosis_recorded],
  ["rerun_plan_recorded", baselineEvaluation.rerun_plan_recorded, pluginEvaluation.rerun_plan_recorded],
  ["claim_boundary_ok", baselineEvaluation.claim_boundary_ok, pluginEvaluation.claim_boundary_ok],
  ["overclaiming_detected", baselineEvaluation.overclaiming_detected, pluginEvaluation.overclaiming_detected],
  ["paper_pair_match", baselineEvaluation.oracle_alignment.paper_pair_match, pluginEvaluation.oracle_alignment.paper_pair_match],
  ["best_split_mentioned", baselineEvaluation.oracle_alignment.best_split_mentioned, pluginEvaluation.oracle_alignment.best_split_mentioned],
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
  "# Real OpenClaw Agent vs NSS-EviMem Plugin Agent Experiment",
  "",
  "## Setup",
  "",
  `- Case: \`${summary.case_id}\``,
  `- Model: \`${model}\``,
  `- Workspace: \`${workspaceCaseDir}\``,
  `- Baseline mode: plugin disabled via \`openclaw plugins disable ${pluginId}\``,
  `- Plugin mode: plugin enabled via \`openclaw plugins enable ${pluginId}\``,
  "",
  "## Baseline Agent",
  "",
  `- OpenClaw exit code: \`${baselineEvaluation.openclaw_exit_code}\``,
  `- Final correctness label: \`${baselineEvaluation.final_correctness}\``,
  `- Evidence completeness: \`${baselineEvaluation.evidence_completeness}\``,
  `- Claim boundary ok: \`${baselineEvaluation.claim_boundary_ok}\``,
  `- Overclaiming detected: \`${baselineEvaluation.overclaiming_detected}\``,
  `- Paper pair match: \`${baselineEvaluation.oracle_alignment.paper_pair_match}\``,
  `- Best split mentioned: \`${baselineEvaluation.oracle_alignment.best_split_mentioned}\``,
  "",
  "## Plugin Agent",
  "",
  `- OpenClaw exit code: \`${pluginEvaluation.openclaw_exit_code}\``,
  `- Final correctness label: \`${pluginEvaluation.final_correctness}\``,
  `- Evidence completeness: \`${pluginEvaluation.evidence_completeness}\``,
  `- NSS tool usage detected: \`${pluginEvaluation.nss_tool_usage_detected}\``,
  `- Contract valid: \`${pluginEvaluation.contract_valid}\``,
  `- Tool calls recorded: \`${pluginEvaluation.tool_calls_recorded}\``,
  `- Failure diagnosis recorded: \`${pluginEvaluation.failure_diagnosis_recorded}\``,
  `- Rerun plan recorded: \`${pluginEvaluation.rerun_plan_recorded}\``,
  `- Tool semantic match: \`${pluginEvaluation.tool_semantic_match}\``,
  `- Claim boundary ok: \`${pluginEvaluation.claim_boundary_ok}\``,
  `- Overclaiming detected: \`${pluginEvaluation.overclaiming_detected}\``,
  `- Paper pair match: \`${pluginEvaluation.oracle_alignment.paper_pair_match}\``,
  `- Best split mentioned: \`${pluginEvaluation.oracle_alignment.best_split_mentioned}\``,
  "",
  "## Comparison",
  "",
  `- Evidence completeness delta: \`${comparison.evidence_completeness_delta}\``,
  `- Plugin used NSS tools: \`${comparison.plugin_used_nss_tools}\``,
  `- Plugin recorded contract: \`${comparison.plugin_recorded_contract}\``,
  `- Plugin recorded tool calls: \`${comparison.plugin_recorded_tool_calls}\``,
  `- Plugin recorded failure diagnosis: \`${comparison.plugin_recorded_failure_diagnosis}\``,
  `- Plugin recorded rerun plan: \`${comparison.plugin_recorded_rerun_plan}\``,
  `- Plugin claim boundary improved: \`${comparison.plugin_claim_boundary_improved}\``,
  "",
  "## Interpretation",
  "",
  "This report is generated from real local OpenClaw runs. The evaluator may read the hidden oracle, but both Agent prompts explicitly forbid reading hidden or oracle folders.",
  "If the plugin arm did not use NSS-EviMem tools, that is an experimental finding about integration/instruction strength rather than a scoring failure.",
  "",
].join("\n");
writeFileSync(join(runDir, "experiment_report.md"), report, "utf8");

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
