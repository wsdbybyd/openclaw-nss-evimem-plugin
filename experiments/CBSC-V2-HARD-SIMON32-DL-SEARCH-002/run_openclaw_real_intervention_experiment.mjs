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
import { fileURLToPath, pathToFileURL } from "node:url";

const CASE_ID = "CBSC-V2-HARD-SIMON32-DL-SEARCH-002";
const experimentDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(experimentDir, "..", "..");
const sourceRunDir = resolve(process.env.NSS_EVIMEM_INTERVENTION_SOURCE_DIR ?? join(experimentDir, "runs", "openclaw-real-rerun-latest"));
const runDir = join(experimentDir, "runs", "openclaw-real-intervention-latest");
const baselineDir = join(runDir, "baseline");
const pluginPass1Dir = join(runDir, "plugin_pass1");
const pluginRerunDir = join(runDir, "plugin_rerun");
const pluginInterventionDir = join(runDir, "plugin_intervention");
const workspaceRoot = "C:\\Users\\wsdbybyd\\.openclaw\\workspace-weak";
const workspaceCaseDir = join(workspaceRoot, "cbsc_simon32_dl_openclaw_real_intervention_latest");
const benchmarkQuestionPath = resolve(repoRoot, "..", "v4版本benchmark", "tasks", CASE_ID, "public", "question.md");
const hiddenOraclePath = resolve(repoRoot, "..", "v4版本benchmark", "tasks", CASE_ID, "hidden", "oracle.json");
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
  return [...text.matchAll(/0x[0-9a-fA-F]{8}/g)].map((match) => match[0].toLowerCase());
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
  const interventionRecorded = existsSync(join(evidenceDir, "intervention.json"))
    && existsSync(join(evidenceDir, "intervention.md"));
  const nssToolUsageDetected = /nss_evimem_/i.test(combinedText) || toolCalls > 0 || contractValid || capabilityRecorded || interventionRecorded;
  const rerunContextUsed = /nss_evimem_build_rerun_context|rerun_context|failure_diagnosis|rerun_plan/i.test(combinedText)
    || rerunContextRecorded;
  const interventionUsed = /nss_evimem_build_intervention|online repair intervention|blocked claims|Do not claim a verified final answer/i.test(combinedText)
    || interventionRecorded;

  let evidenceCompleteness = "none";
  if (toolCalls > 0 || hasEvidenceIndex || contractValid || capabilityRecorded || interventionRecorded) {
    evidenceCompleteness = contractValid && capabilityRecorded ? "complete_or_structured" : "partial";
  }

  const claimBoundaryOk = /not\s+(a\s+)?proof|not\s+proved|not\s+verified|unverified|sampled|candidate|noise floor|statistical noise|bounded failure|partially_correct|未验证|不完整|样本|候选/i.test(combinedText);
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
    intervention_recorded: interventionRecorded,
    intervention_used: interventionUsed,
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

async function buildInterventionSeed({
  pass1EvidenceSeedDir,
  pluginInterventionEvidenceDir,
  pass1Evaluation,
}) {
  const distInterventionBuilderPath = join(repoRoot, "dist", "intervention-builder.js");
  if (!existsSync(distInterventionBuilderPath)) {
    throw new Error(`Compiled intervention builder not found: ${distInterventionBuilderPath}. Run npm run build first.`);
  }
  const moduleUrl = `${pathToFileURL(distInterventionBuilderPath).href}?intervention=${Date.now()}`;
  const { buildIntervention } = await import(moduleUrl);
  return buildIntervention({
    case_id: CASE_ID,
    intervention_mode: "online_repair_prompt",
    evidence_dir: pass1EvidenceSeedDir,
    output_json_path: join(pluginInterventionEvidenceDir, "intervention.json"),
    output_markdown_path: join(pluginInterventionEvidenceDir, "intervention.md"),
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
      "Use this intervention as a live repair constraint, not as an oracle answer.",
      "If the rerun cannot verify a distinguisher, produce a bounded failure report.",
    ],
  });
}

function makePluginInterventionPrompt({
  pass1EvidenceSeedDir,
  pluginInterventionEvidenceDir,
  intervention,
}) {
  const refreshArgs = {
    case_id: CASE_ID,
    intervention_mode: "online_repair_prompt",
    evidence_dir: pass1EvidenceSeedDir,
    output_json_path: join(pluginInterventionEvidenceDir, "intervention.json"),
    output_markdown_path: join(pluginInterventionEvidenceDir, "intervention.md"),
    prior_result_summary: intervention.prior_result_summary,
    extra_instructions: [
      "Use this intervention as a live repair constraint, not as an oracle answer.",
      "If the rerun cannot verify a distinguisher, produce a bounded failure report.",
    ],
  };

  return [
    "You are the OpenClaw Agent running the intervention-prompt arm of a NSS-EviMem online correction experiment.",
    "",
    "Task file:",
    "",
    "`cbsc_simon32_dl_openclaw_real_intervention_latest/question.md`",
    "",
    "Allowed previous-run context:",
    `- NSS-EviMem pass1 evidence seed directory: \`${pass1EvidenceSeedDir}\``,
    `- Prebuilt online intervention bundle: \`${join(pluginInterventionEvidenceDir, "intervention.md")}\` and \`${join(pluginInterventionEvidenceDir, "intervention.json")}\``,
    "- You may use only these seed files if present: `failure_diagnosis.json`, `rerun_plan.md`, `task_contract.json`, `tool_capabilities.json`, `tool_guard_events.jsonl`, and `evidence_index.json`.",
    "- Do not read baseline outputs, previous workspace outputs, hidden folders, oracle folders, or previous experiment report files.",
    "",
    "Strict intervention rule:",
    "Use the following NSS-EviMem prompt patch as a live repair constraint before planning any new search.",
    "",
    "```text",
    intervention.prompt_patch,
    "```",
    "",
    "Optional refresh action:",
    "You may call `nss_evimem_build_intervention` with exactly this JSON object if you need to refresh the intervention bundle:",
    "",
    "```json",
    JSON.stringify(refreshArgs, null, 2),
    "```",
    "",
    "Work directory and evidence:",
    "1. Work only under `cbsc_simon32_dl_openclaw_real_intervention_latest/plugin_intervention/` for new outputs.",
    `2. Use \`${pluginInterventionEvidenceDir}\` as the evidence_dir for new NSS-EviMem calls.`,
    "",
    "Required NSS-EviMem actions before final answer:",
    "1. Call `nss_evimem_register_tool_capability` for the exact intervention rerun/search/checking method.",
    "   The capability must explicitly cover method, analysis_type, domain, scope, target, and deliverables/output artifacts.",
    "2. Call `nss_evimem_validate_contract` using the task contract from the intervention unless you explicitly justify a schema repair.",
    "   If the actual bounded tool is a MILP+sampling/FWHT hybrid, validate and save the repaired contract before guard checking.",
    "3. Call `nss_evimem_guard_decision` in `post_repair` or `post_check` mode.",
    "   Use the same task contract that `nss_evimem_validate_contract` accepted, and compare it against the registered capability, not an older unrepaired contract.",
    "4. Execute bounded code and record command/log/result artifacts.",
    "5. Call `nss_evimem_diagnose_failure` again before final answer.",
    "",
    "Required outputs:",
    "1. `cbsc_simon32_dl_openclaw_real_intervention_latest/plugin_intervention/final_answer.md`",
    "2. `cbsc_simon32_dl_openclaw_real_intervention_latest/plugin_intervention/event_log.jsonl`",
    "3. `cbsc_simon32_dl_openclaw_real_intervention_latest/plugin_intervention/intervention_use_report.md`",
    "4. `cbsc_simon32_dl_openclaw_real_intervention_latest/plugin_intervention/failure_diagnosis_summary.md` if the final diagnosis is not `no_failure_detected`.",
    "5. Any executable code or run logs under `cbsc_simon32_dl_openclaw_real_intervention_latest/plugin_intervention/artifacts/`.",
    "",
    "Final-answer rule: claim a verified distinguisher only if fresh executable evidence satisfies the intervention evidence requirements. Otherwise, state the strongest bounded result and why the intervention did or did not improve over the rerun-context-only arm.",
  ].join("\n");
}

function escapeCsv(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

resetDirectory(experimentDir, runDir);
resetDirectory(workspaceRoot, workspaceCaseDir);
mkdirSync(baselineDir, { recursive: true });
mkdirSync(pluginPass1Dir, { recursive: true });
mkdirSync(pluginRerunDir, { recursive: true });
mkdirSync(pluginInterventionDir, { recursive: true });
mkdirSync(join(workspaceCaseDir, "plugin_intervention"), { recursive: true });
mkdirSync(join(workspaceCaseDir, "plugin_intervention_evidence"), { recursive: true });

if (!existsSync(openclawMjs)) {
  throw new Error(`OpenClaw CLI entry not found: ${openclawMjs}`);
}
if (!existsSync(benchmarkQuestionPath)) {
  throw new Error(`Public question not found: ${benchmarkQuestionPath}`);
}
if (!existsSync(hiddenOraclePath)) {
  throw new Error(`Hidden oracle not found for evaluator: ${hiddenOraclePath}`);
}

const sourcePass1EvidenceDir = existsSync(join(sourceRunDir, "plugin_pass1", "evidence_seed_used_for_rerun"))
  ? join(sourceRunDir, "plugin_pass1", "evidence_seed_used_for_rerun")
  : join(sourceRunDir, "plugin_pass1", "evidence");
const requiredSourceFiles = [
  "baseline/evaluation.json",
  "plugin_pass1/evaluation.json",
  "plugin_rerun/evaluation.json",
  "plugin_rerun/evidence/rerun_context.md",
];
for (const relativePath of requiredSourceFiles) {
  const full = join(sourceRunDir, relativePath);
  if (!existsSync(full)) {
    throw new Error(`Missing source file for intervention experiment: ${full}. Run npm run experiment:cbsc-simon32-dl:openclaw-rerun first.`);
  }
}
for (const relativePath of ["failure_diagnosis.json", "rerun_plan.md", "task_contract.json", "tool_capabilities.json"]) {
  const full = join(sourcePass1EvidenceDir, relativePath);
  if (!existsSync(full)) {
    throw new Error(`Missing pass1 evidence file for intervention experiment: ${full}`);
  }
}

copyFileSync(benchmarkQuestionPath, join(workspaceCaseDir, "question.md"));
copyFileSync(benchmarkQuestionPath, join(runDir, "question.md"));
copyDirectoryIfExists(join(sourceRunDir, "baseline"), baselineDir);
copyDirectoryIfExists(join(sourceRunDir, "plugin_pass1"), pluginPass1Dir);
copyDirectoryIfExists(join(sourceRunDir, "plugin_rerun"), pluginRerunDir);

const pass1EvidenceSeedDir = join(workspaceCaseDir, "plugin_pass1_evidence_seed");
copyDirectoryIfExists(sourcePass1EvidenceDir, pass1EvidenceSeedDir);
copyDirectoryIfExists(pass1EvidenceSeedDir, join(pluginPass1Dir, "evidence_seed_used_for_intervention"));

const oracle = readJson(hiddenOraclePath);
const baselineEvaluation = readJson(join(baselineDir, "evaluation.json"));
const pluginPass1Evaluation = readJson(join(pluginPass1Dir, "evaluation.json"));
const pluginRerunEvaluation = readJson(join(pluginRerunDir, "evaluation.json"));
const initialPluginEnabled = getInitialPluginEnabled();
const configBackupPath = join(runDir, "openclaw_config_before.json");
copyFileSync(openclawConfigPath, configBackupPath);

const pluginInterventionEvidenceDir = join(workspaceCaseDir, "plugin_intervention_evidence");
const interventionSeed = await buildInterventionSeed({
  pass1EvidenceSeedDir,
  pluginInterventionEvidenceDir,
  pass1Evaluation: pluginPass1Evaluation,
});
writeJson(join(pluginInterventionDir, "prebuilt_intervention_details.json"), interventionSeed);

const pluginInterventionPrompt = makePluginInterventionPrompt({
  pass1EvidenceSeedDir,
  pluginInterventionEvidenceDir,
  intervention: interventionSeed,
});
writeFileSync(join(pluginInterventionDir, "prompt.md"), pluginInterventionPrompt, "utf8");

const stateChanges = [];
let pluginInterventionRun;

try {
  stateChanges.push({ action: "enable", result: setPluginEnabled(true) });
  pluginInterventionRun = runOpenClaw([
    "agent",
    "--local",
    "--model",
    model,
    "--session-key",
    `agent:weak:cbsc_simon32_dl_real_plugin_intervention_${Date.now()}`,
    "--timeout",
    String(timeoutSeconds),
    "--verbose",
    "on",
    "--json",
    "--message",
    pluginInterventionPrompt,
  ], {
    cwd: workspaceRoot,
    timeout: spawnTimeoutMs,
    env: {
      ...process.env,
      NSS_EVIMEM_EVIDENCE_DIR: pluginInterventionEvidenceDir,
      NSS_EVIMEM_SESSION_ID: "cbsc_simon32_dl_real_plugin_intervention",
    },
  });
  writeCommandResult(pluginInterventionDir, pluginInterventionRun);
} finally {
  const currentEnabled = getInitialPluginEnabled();
  if (currentEnabled !== initialPluginEnabled) {
    stateChanges.push({ action: initialPluginEnabled ? "restore-enable" : "restore-disable", result: setPluginEnabled(initialPluginEnabled) });
  }
}

copyDirectoryIfExists(join(workspaceCaseDir, "plugin_intervention"), join(pluginInterventionDir, "workspace_outputs"));
copyDirectoryIfExists(pluginInterventionEvidenceDir, join(pluginInterventionDir, "evidence"));
writeJson(join(runDir, "openclaw_plugin_state_changes.json"), stateChanges.map((item) => ({
  action: item.action,
  status: item.result.status,
  stderr: item.result.stderr,
  stdout: item.result.stdout,
})));

const pluginInterventionEvaluation = evaluateArm({
  mode: "real_openclaw_agent_with_nss_evimem_intervention_prompt",
  commandResult: pluginInterventionRun,
  stdoutPath: join(pluginInterventionDir, "openclaw_stdout.json"),
  workspaceOutputDir: join(pluginInterventionDir, "workspace_outputs"),
  evidenceDir: join(pluginInterventionDir, "evidence"),
  oracle,
});

writeJson(join(pluginInterventionDir, "evaluation.json"), pluginInterventionEvaluation);

const comparison = {
  source_run_dir: sourceRunDir,
  rerun_to_intervention_evidence_completeness: `${pluginRerunEvaluation.evidence_completeness}_to_${pluginInterventionEvaluation.evidence_completeness}`,
  intervention_prompt_built: pluginInterventionEvaluation.intervention_recorded,
  intervention_prompt_used: pluginInterventionEvaluation.intervention_used,
  intervention_used_nss_tools: pluginInterventionEvaluation.nss_tool_usage_detected,
  intervention_recorded_contract: pluginInterventionEvaluation.contract_valid,
  intervention_recorded_failure_diagnosis: pluginInterventionEvaluation.failure_diagnosis_recorded,
  intervention_recorded_rerun_plan: pluginInterventionEvaluation.rerun_plan_recorded,
  rerun_final_correctness: pluginRerunEvaluation.final_correctness,
  intervention_final_correctness: pluginInterventionEvaluation.final_correctness,
  rerun_paper_pair_match: pluginRerunEvaluation.oracle_alignment.paper_pair_match,
  intervention_paper_pair_match: pluginInterventionEvaluation.oracle_alignment.paper_pair_match,
  rerun_best_split_mentioned: pluginRerunEvaluation.oracle_alignment.best_split_mentioned,
  intervention_best_split_mentioned: pluginInterventionEvaluation.oracle_alignment.best_split_mentioned,
  rerun_overclaiming: pluginRerunEvaluation.overclaiming_detected,
  intervention_overclaiming: pluginInterventionEvaluation.overclaiming_detected,
  intervention_claim_boundary_ok: pluginInterventionEvaluation.claim_boundary_ok,
};

const summary = {
  schema: "nss_evimem.real_openclaw_intervention_experiment_summary.v1",
  case_id: CASE_ID,
  generated_at: new Date().toISOString(),
  model,
  openclaw_entry: openclawMjs,
  workspace_case_dir: workspaceCaseDir,
  source_run_dir: sourceRunDir,
  baseline: baselineEvaluation,
  plugin_pass1: pluginPass1Evaluation,
  plugin_rerun: pluginRerunEvaluation,
  plugin_intervention: pluginInterventionEvaluation,
  comparison,
};
writeJson(join(runDir, "experiment_summary.json"), summary);

const csvRows = [
  ["metric", "baseline_agent", "plugin_pass1", "plugin_rerun_context", "plugin_intervention_prompt"],
  ["openclaw_exit_code", baselineEvaluation.openclaw_exit_code, pluginPass1Evaluation.openclaw_exit_code, pluginRerunEvaluation.openclaw_exit_code, pluginInterventionEvaluation.openclaw_exit_code],
  ["final_correctness", baselineEvaluation.final_correctness, pluginPass1Evaluation.final_correctness, pluginRerunEvaluation.final_correctness, pluginInterventionEvaluation.final_correctness],
  ["evidence_completeness", baselineEvaluation.evidence_completeness, pluginPass1Evaluation.evidence_completeness, pluginRerunEvaluation.evidence_completeness, pluginInterventionEvaluation.evidence_completeness],
  ["nss_tool_usage_detected", baselineEvaluation.nss_tool_usage_detected, pluginPass1Evaluation.nss_tool_usage_detected, pluginRerunEvaluation.nss_tool_usage_detected, pluginInterventionEvaluation.nss_tool_usage_detected],
  ["contract_valid", baselineEvaluation.contract_valid, pluginPass1Evaluation.contract_valid, pluginRerunEvaluation.contract_valid, pluginInterventionEvaluation.contract_valid],
  ["tool_calls_recorded", baselineEvaluation.tool_calls_recorded, pluginPass1Evaluation.tool_calls_recorded, pluginRerunEvaluation.tool_calls_recorded, pluginInterventionEvaluation.tool_calls_recorded],
  ["failure_diagnosis_recorded", baselineEvaluation.failure_diagnosis_recorded, pluginPass1Evaluation.failure_diagnosis_recorded, pluginRerunEvaluation.failure_diagnosis_recorded, pluginInterventionEvaluation.failure_diagnosis_recorded],
  ["rerun_context_recorded", false, false, pluginRerunEvaluation.rerun_context_recorded, pluginInterventionEvaluation.rerun_context_recorded],
  ["intervention_recorded", false, false, false, pluginInterventionEvaluation.intervention_recorded],
  ["intervention_used", false, false, false, pluginInterventionEvaluation.intervention_used],
  ["claim_boundary_ok", baselineEvaluation.claim_boundary_ok, pluginPass1Evaluation.claim_boundary_ok, pluginRerunEvaluation.claim_boundary_ok, pluginInterventionEvaluation.claim_boundary_ok],
  ["overclaiming_detected", baselineEvaluation.overclaiming_detected, pluginPass1Evaluation.overclaiming_detected, pluginRerunEvaluation.overclaiming_detected, pluginInterventionEvaluation.overclaiming_detected],
  ["paper_pair_match", baselineEvaluation.oracle_alignment.paper_pair_match, pluginPass1Evaluation.oracle_alignment.paper_pair_match, pluginRerunEvaluation.oracle_alignment.paper_pair_match, pluginInterventionEvaluation.oracle_alignment.paper_pair_match],
  ["best_split_mentioned", baselineEvaluation.oracle_alignment.best_split_mentioned, pluginPass1Evaluation.oracle_alignment.best_split_mentioned, pluginRerunEvaluation.oracle_alignment.best_split_mentioned, pluginInterventionEvaluation.oracle_alignment.best_split_mentioned],
];
writeFileSync(
  join(runDir, "comparison_matrix.csv"),
  `${csvRows.map((row) => row.map(escapeCsv).join(",")).join("\n")}\n`,
  "utf8",
);

const report = [
  "# Real OpenClaw NSS-EviMem Online Intervention Experiment",
  "",
  "## Setup",
  "",
  `- Case: \`${summary.case_id}\``,
  `- Model: \`${model}\``,
  `- Workspace: \`${workspaceCaseDir}\``,
  `- Source run: \`${sourceRunDir}\``,
  "- Baseline, plugin pass1, and plugin rerun context arms are copied from the source run.",
  "- Plugin intervention prompt is a fresh local OpenClaw run with NSS-EviMem enabled and a prebuilt B1 intervention prompt patch injected into the user message.",
  "",
  "## Baseline Agent",
  "",
  `- Final correctness label: \`${baselineEvaluation.final_correctness}\``,
  `- Evidence completeness: \`${baselineEvaluation.evidence_completeness}\``,
  `- Paper pair match: \`${baselineEvaluation.oracle_alignment.paper_pair_match}\``,
  "",
  "## Plugin Agent Pass 1",
  "",
  `- Final correctness label: \`${pluginPass1Evaluation.final_correctness}\``,
  `- Evidence completeness: \`${pluginPass1Evaluation.evidence_completeness}\``,
  `- Failure diagnosis recorded: \`${pluginPass1Evaluation.failure_diagnosis_recorded}\``,
  "",
  "## Plugin Agent Rerun Context",
  "",
  `- Final correctness label: \`${pluginRerunEvaluation.final_correctness}\``,
  `- Evidence completeness: \`${pluginRerunEvaluation.evidence_completeness}\``,
  `- Rerun context recorded: \`${pluginRerunEvaluation.rerun_context_recorded}\``,
  `- Claim boundary ok: \`${pluginRerunEvaluation.claim_boundary_ok}\``,
  `- Overclaiming detected: \`${pluginRerunEvaluation.overclaiming_detected}\``,
  "",
  "## Plugin Agent Intervention Prompt",
  "",
  `- OpenClaw exit code: \`${pluginInterventionEvaluation.openclaw_exit_code}\``,
  `- Final correctness label: \`${pluginInterventionEvaluation.final_correctness}\``,
  `- Evidence completeness: \`${pluginInterventionEvaluation.evidence_completeness}\``,
  `- NSS tool usage detected: \`${pluginInterventionEvaluation.nss_tool_usage_detected}\``,
  `- Intervention recorded: \`${pluginInterventionEvaluation.intervention_recorded}\``,
  `- Intervention used: \`${pluginInterventionEvaluation.intervention_used}\``,
  `- Contract valid: \`${pluginInterventionEvaluation.contract_valid}\``,
  `- Tool calls recorded: \`${pluginInterventionEvaluation.tool_calls_recorded}\``,
  `- Failure diagnosis recorded: \`${pluginInterventionEvaluation.failure_diagnosis_recorded}\``,
  `- Claim boundary ok: \`${pluginInterventionEvaluation.claim_boundary_ok}\``,
  `- Overclaiming detected: \`${pluginInterventionEvaluation.overclaiming_detected}\``,
  `- Paper pair match: \`${pluginInterventionEvaluation.oracle_alignment.paper_pair_match}\``,
  `- Best split mentioned: \`${pluginInterventionEvaluation.oracle_alignment.best_split_mentioned}\``,
  "",
  "## Comparison",
  "",
  `- Rerun to intervention evidence completeness: \`${comparison.rerun_to_intervention_evidence_completeness}\``,
  `- Intervention prompt built: \`${comparison.intervention_prompt_built}\``,
  `- Intervention prompt used: \`${comparison.intervention_prompt_used}\``,
  `- Rerun final correctness: \`${comparison.rerun_final_correctness}\``,
  `- Intervention final correctness: \`${comparison.intervention_final_correctness}\``,
  `- Rerun overclaiming: \`${comparison.rerun_overclaiming}\``,
  `- Intervention overclaiming: \`${comparison.intervention_overclaiming}\``,
  "",
  "## Interpretation",
  "",
  "This B2 experiment tests whether the B1 intervention bundle can be injected into a fresh local OpenClaw pass as an online repair prompt.",
  "A verified oracle match would support correction-to-answer. A bounded negative result with an intact claim boundary supports the narrower online intervention claim.",
  "",
].join("\n");
writeFileSync(join(runDir, "experiment_report.md"), report, "utf8");

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
