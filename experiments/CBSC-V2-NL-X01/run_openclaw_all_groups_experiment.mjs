import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  classifyArmCorrectness,
  commandLineWorkspaceRegexSource,
  currentTaskProtocolEvidence,
  encodePowerShellScript,
  hasConsistentExactMetric,
  hasExactProbability,
  hasExactWeight,
} from "./evaluation-helpers.mjs";

const CASE_ID = "CBSC-V2-NL-X01";
const experimentDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(experimentDir, "..", "..");
const workspaceRoot = resolve(process.env.NSS_EVIMEM_WORKSPACE_ROOT ?? resolve(repoRoot, ".."));
const runDir = join(experimentDir, "runs", "openclaw-all-groups-isolated-latest");
const workspaceIsolationBase = resolve(process.env.NSS_EVIMEM_ISOLATED_WORKSPACE_BASE
  ?? "C:\\Users\\wsdbybyd\\.openclaw\\workspace-isolated");
const workspaceIsolationRoot = join(workspaceIsolationBase, "cbsc_v2_nl_x01_all_groups_isolated_latest");
const benchmarkQuestionPath = resolve(workspaceRoot, "v4版本benchmark", "tasks", CASE_ID, "public", "question.md");
const hiddenOraclePath = resolve(workspaceRoot, "v4版本benchmark", "tasks", CASE_ID, "hidden", "oracle.json");
const memoryPackDir = resolve(process.env.NSS_EVIMEM_MEMORY_PACK_DIR ?? resolve(workspaceRoot, "hook学习", "automated_crypto_modeling_evidence_memory_24papers"));
const openclawMjs = process.env.OPENCLAW_MJS ?? "C:\\Users\\wsdbybyd\\AppData\\Roaming\\npm\\node_modules\\openclaw\\openclaw.mjs";
const openclawConfigPath = process.env.OPENCLAW_CONFIG ?? "C:\\Users\\wsdbybyd\\.openclaw\\openclaw.json";
const pluginId = "openclaw-nss-evimem-plugin";
const model = process.env.NSS_EVIMEM_MODEL ?? "bailian/qwen3.6-plus";
const timeoutSeconds = Number(process.env.NSS_EVIMEM_OPENCLAW_TIMEOUT_SECONDS ?? 600);
const spawnTimeoutMs = (timeoutSeconds + 120) * 1000;
const experimentRunId = randomUUID();

const arms = [
  {
    mode: "baseline",
    label: "Baseline",
    plugin: false,
    evidenceMemory: false,
    contractCapability: false,
    fullIntervention: false,
  },
  {
    mode: "evidence_only",
    label: "Evidence-only",
    plugin: true,
    evidenceMemory: true,
    contractCapability: false,
    fullIntervention: false,
  },
  {
    mode: "contract_capability",
    label: "Contract+Capability",
    plugin: true,
    evidenceMemory: false,
    contractCapability: true,
    fullIntervention: false,
  },
  {
    mode: "full_intervention",
    label: "Full Intervention",
    plugin: true,
    evidenceMemory: true,
    contractCapability: true,
    fullIntervention: true,
  },
];

const taskContract = {
  case_id: CASE_ID,
  domain: "symmetric_cryptanalysis",
  cipher: "SIMON32",
  rounds: 10,
  attack_family: "differential",
  analysis_type: "differential",
  scope: "reduced_round",
  verification_profile: {
    id: "differential_metric_v1",
    primitive_profile: "simon_family_v1",
    claim_mode: "exact_or_honest_bound",
  },
  metric: "minimum_differential_weight_or_max_probability",
  objective: "reproduce_exact_metric_or_honest_bound",
  expected_deliverables: ["final metric", "probability or weight", "method evidence", "scope boundary"],
};

const defaultCapability = {
  domain: "symmetric_cryptanalysis",
  cipher_support: ["SIMON32"],
  rounds_supported: [10],
  analysis_type: "differential",
  methods: ["literature_reproduction", "manual_reasoning", "optional_script_check", "MILP/SAT/SMT reference"],
  output_artifacts: ["final_report", "source_or_method_reference", "optional_code_or_log"],
  claim_types: ["metric_reproduction", "bounded_verification"],
  limitations: [
    "Does not prove a new full-cipher break.",
    "For this NL-X01 task, source-grounded metric reproduction is acceptable when the source location is explicit.",
  ],
};

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

function resetIsolatedWorkspaceRoot() {
  resetDirectory(workspaceIsolationBase, workspaceIsolationRoot);
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonIfExists(path) {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return readJson(path);
  } catch {
    return null;
  }
}

function readTextIfExists(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function copyDirectoryIfExists(from, to, sourceRoot = from, targetRoot = to) {
  assertInside(sourceRoot, from);
  assertInside(targetRoot, to);
  if (!existsSync(from)) {
    return false;
  }
  const stats = lstatSync(from);
  if (stats.isSymbolicLink()) {
    return false;
  }
  if (!stats.isDirectory()) {
    return false;
  }
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const source = join(from, entry);
    const target = join(to, entry);
    assertInside(sourceRoot, source);
    assertInside(targetRoot, target);
    const entryStats = lstatSync(source);
    if (entryStats.isSymbolicLink()) {
      continue;
    }
    if (entryStats.isDirectory()) {
      copyDirectoryIfExists(source, target, sourceRoot, targetRoot);
    } else if (entryStats.isFile()) {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
  }
  return true;
}

function listFiles(dir, root = dir) {
  assertInside(root, dir);
  if (!existsSync(dir)) {
    return [];
  }
  const directoryStats = lstatSync(dir);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    return [];
  }
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    assertInside(root, full);
    const stats = lstatSync(full);
    if (stats.isSymbolicLink()) {
      return [];
    }
    if (stats.isDirectory()) {
      return listFiles(full, root);
    }
    return stats.isFile() ? [relative(root, full)] : [];
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
    maxBuffer: 1024 * 1024 * 96,
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

function cleanupArmProcesses({ startedAtIso, armWorkspaceRoot }) {
  const powerShellSingleQuotedString = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const command = [
    `$started = [datetime]::Parse(${powerShellSingleQuotedString(startedAtIso)}).AddSeconds(-5)`,
    `$workspacePattern = ${powerShellSingleQuotedString(commandLineWorkspaceRegexSource(armWorkspaceRoot))}`,
    "$targets = Get-CimInstance Win32_Process | Where-Object {",
    "  ($_.Name -eq 'python.exe' -or $_.Name -eq 'py.exe') -and",
    "  $_.CommandLine -and",
    "  ([datetime]$_.CreationDate -ge $started) -and",
    "  ($_.CommandLine -match $workspacePattern)",
    "}",
    "$targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
    "$targets | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress",
  ].join("\n");
  const encodedCommand = encodePowerShellScript(command);

  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });

  return {
    status: result.status,
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
  if (getInitialPluginEnabled() === enabled) {
    return {
      command: `openclaw plugins ${enabled ? "enable" : "disable"} ${pluginId} (skipped; already ${enabled ? "enabled" : "disabled"})`,
      status: 0,
      signal: null,
      error: null,
      stdout: "",
      stderr: "",
    };
  }

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

function readJsonl(path) {
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
        return {};
      }
    });
}

function countJsonl(path) {
  return readJsonl(path).length;
}

function hasCurrentTaskProtocolEvidence(evidenceDir) {
  return currentTaskProtocolEvidence({
    contractEvents: readJsonl(join(evidenceDir, "contract_validation_events.jsonl")),
    guardEvents: readJsonl(join(evidenceDir, "tool_guard_events.jsonl")),
    capabilityRegistry: readJsonIfExists(join(evidenceDir, "tool_capabilities.json")) ?? {},
    taskContract,
  });
}

function hasValidContract(evidenceDir) {
  return hasCurrentTaskProtocolEvidence(evidenceDir);
}

function hasGuardAllow(evidenceDir) {
  return hasCurrentTaskProtocolEvidence(evidenceDir);
}

function capabilityRecorded(evidenceDir) {
  return hasCurrentTaskProtocolEvidence(evidenceDir);
}

function scoreMemoryRecord(record) {
  const text = JSON.stringify(record).toLowerCase();
  let score = 0;
  if (text.includes("simon32")) score += 8;
  if (text.includes("simon")) score += 4;
  if (text.includes("differential")) score += 4;
  if (text.includes("sat")) score += 3;
  if (text.includes("milp")) score += 2;
  if (text.includes("2021")) score += 2;
  if (text.includes("linear") && !text.includes("differential")) score -= 1;
  return score;
}

function buildMemorySeedSummary(memoryRecords, importResult) {
  const selected = memoryRecords
    .map((record) => ({ record, score: scoreMemoryRecord(record) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || String(a.record.memory_id).localeCompare(String(b.record.memory_id)))
    .slice(0, 10)
    .map((item) => item.record);

  return [
    "# Imported EvidenceMemory Seed Summary for CBSC-V2-NL-X01",
    "",
    `- Pack: \`${importResult.pack_dir}\``,
    `- Imported records: \`${importResult.imported}\``,
    "",
    "These memories are method/source-scope evidence only. They are not a hidden oracle and may not be treated as a final-answer table.",
    "",
    ...selected.flatMap((record) => [
      `## ${record.memory_id} / ${record.evidence_id}`,
      "",
      `- Title: ${record.metadata?.paper_title ?? "unknown"}`,
      `- Tags: ${(record.tags ?? []).join(", ")}`,
      `- Claim: ${record.claim}`,
      `- Structured claim: \`${JSON.stringify(record.metadata?.structured_claim ?? {})}\``,
      `- Source locator: ${record.metadata?.source?.source_locator ?? "not specified"}`,
      "",
    ]),
  ].join("\n");
}

function makePrompt(arm, evidenceDir, memorySummaryPath) {
  const workDir = "work/";
  const header = [
    `You are the OpenClaw Agent running the ${arm.label} group for a NSS-EviMem ablation experiment.`,
    "",
    "Task file:",
    "`question.md`",
    "",
    "Strict rules:",
    "1. This is an isolated run. Do not inspect parent directories, sibling directories, hidden/oracle/answer files, or prior experiment folders.",
    `2. Work only under \`${workDir}\` for new outputs.`,
    "3. The final answer must preserve SIMON32, 10 rounds, differential analysis, and the requested metric.",
    "4. If you cannot verify the exact metric, report the strongest honest bound and why it is incomplete.",
    "",
    "Required outputs:",
    `1. \`${workDir}final_answer.md\``,
    `2. \`${workDir}event_log.jsonl\``,
    `3. Optional executable code, logs, or result JSON under \`${workDir}artifacts/\``,
    "",
  ];

  const evidenceOnly = arm.evidenceMemory ? [
    "EvidenceMemory requirements:",
    `- Evidence directory: \`${evidenceDir}\``,
    `- Memory seed summary: \`${memorySummaryPath}\``,
    "- First call `nss_evimem_import_pack` using this pack directory and evidence_dir. If records already exist, continue.",
    `- Then call \`nss_evimem_retrieve_memory\` with \`task_contract: {\"domain\":\"automated_crypto_modeling\"}\`, tags including \`SIMON\`, and this evidence_dir.`,
    "- Use retrieved memories only for method/source guidance, not as a hidden answer table.",
    `- Write \`${workDir}memory_use_report.md\` listing retrieved memory IDs and how they changed your reasoning.`,
    "",
  ] : [];

  const contract = arm.contractCapability ? [
    "Task Contract and Tool Capability requirements:",
    `- Evidence directory: \`${evidenceDir}\``,
    "- Call `nss_evimem_register_tool_capability` for your exact method.",
    "- Call `nss_evimem_validate_contract` with this task contract:",
    "```json",
    JSON.stringify({ task_contract: taskContract, evidence_dir: evidenceDir }, null, 2),
    "```",
    "- Call `nss_evimem_guard_decision` in `post_check` mode comparing the same contract with the registered capability.",
    "",
  ] : [];

  const full = arm.fullIntervention ? [
    "Full Intervention requirements:",
    "- Before final answer, call `nss_evimem_validate_artifact_claims` with the case_id, task_contract, final report path, any result path, source paths, and evidence_dir.",
    "- Then call `nss_evimem_diagnose_failure` with the current task contract and a concise run summary.",
    "- If artifact validation or diagnosis says the claim is unsupported, downgrade the final claim to an honest bound.",
    `- Write \`${workDir}intervention_use_report.md\` explaining how the plugin changed the final answer boundary.`,
    "",
  ] : [];

  const finalRule = [
    "Final answer format:",
    "- Give the metric as probability and equivalent differential weight when possible.",
    "- Include method/source evidence, for example solver/model/script evidence or a source-grounded reproduction citation.",
    "- State the scope boundary: this is only the specified reduced-round SIMON32 instance, not a full-cipher break.",
  ];

  return [...header, ...evidenceOnly, ...contract, ...full, ...finalRule].join("\n");
}

function findFirstFile(root, predicates) {
  const files = listFiles(root)
    .filter((file) => /\.(json|md|py|txt|log)$/i.test(file))
    .sort();
  for (const predicate of predicates) {
    const found = files.find((file) => predicate(file));
    if (found) {
      return join(root, found);
    }
  }
  return null;
}

function collectSourcePaths(root) {
  return listFiles(root)
    .filter((file) => /\.(py|sage|smt2|lp|mps|cpp|c)$/i.test(file))
    .map((file) => join(root, file));
}

function hasInstanceBoundary(text) {
  return /simon32/i.test(text)
    && /(?:\b10\b|10[-\s]*round|10\s*轮)/i.test(text)
    && /(differential|差分)/i.test(text);
}

function hasMethodEvidence(text) {
  return /SunWangWang2021|Sun\s*Wang\s*Wang|Table\s*9|MILP|SAT|SMT|solver|script|literature|source|reproduction|论文|表\s*9/i.test(text)
}

function claimBoundaryOk(text) {
  const overclaims = /(full[-\s]*cipher\s*break|breaks?\s+SIMON32|key[-\s]*recovery\s*attack|完整密码.*攻破|密钥恢复攻击)/i;
  if (!overclaims.test(text)) {
    return true;
  }
  return /(not|no|does not|is not|不是|并非|不构成)/i.test(text);
}

function detectCrossArmContamination(arm, evidenceDir) {
  const toolLogText = readTextIfExists(join(evidenceDir, "tool_calls.jsonl"));
  if (!toolLogText) {
    return { detected: false, hits: [] };
  }

  const hits = [];
  const otherModes = arms
    .map((item) => item.mode)
    .filter((mode) => mode !== arm.mode);
  for (const otherMode of otherModes) {
    const directFolder = new RegExp(`(^|[\\r\\n"'\\\\/])${otherMode}([\\r\\n"'\\\\/]|$)`, "i");
    const nestedFolder = new RegExp(`cbsc_v2_nl_x01[^\\\\/\\r\\n"']*[\\\\/]${otherMode}([\\\\/\\r\\n"']|$)`, "i");
    const artifactFolder = new RegExp(`${otherMode}[\\\\/]artifacts[\\\\/]`, "i");
    if (directFolder.test(toolLogText) || nestedFolder.test(toolLogText) || artifactFolder.test(toolLogText)) {
      hits.push(otherMode);
    }
  }

  return { detected: hits.length > 0, hits };
}

function isAgentTimeout(commandResult, payloadText) {
  return /Request timed out|ETIMEDOUT|timeout/i.test(payloadText)
    || /ETIMEDOUT|timeout/i.test(commandResult.error ?? "");
}

function evaluateArm({ arm, commandResult, stdoutPath, workspaceOutputDir, evidenceDir, oracle, importResult, artifactValidation }) {
  const stdout = readTextIfExists(stdoutPath);
  const payloadText = parseOpenClawPayloadText(stdout);
  const finalAnswerText = readTextIfExists(join(workspaceOutputDir, "final_answer.md"));
  const answerText = `${payloadText}\n${finalAnswerText}`;
  const outputFiles = listFiles(workspaceOutputDir);
  const expectedProbability = oracle.oracle_answer.probability;
  const expectedWeight = oracle.oracle_answer.primary_weight;
  const exactProbabilityMatch = hasExactProbability(answerText, expectedProbability);
  const exactWeightMatch = hasExactWeight(answerText, expectedWeight);
  const exactMetricMatch = hasConsistentExactMetric(answerText, expectedProbability, expectedWeight);
  const instancePreserved = hasInstanceBoundary(answerText);
  const methodEvidence = hasMethodEvidence(answerText);
  const boundaryOk = claimBoundaryOk(answerText);
  const timeoutText = isAgentTimeout(commandResult, payloadText);
  const runSucceeded = commandResult.status === 0
    && !commandResult.signal
    && !commandResult.error
    && !timeoutText;

  const toolCalls = countJsonl(join(evidenceDir, "tool_calls.jsonl"));
  const memoryRecords = readJsonIfExists(join(evidenceDir, "memory_records.json"));
  const memoryCount = Array.isArray(memoryRecords) ? memoryRecords.length : 0;
  const nssToolUsageDetected = /nss_evimem_/i.test(answerText) || toolCalls > 0;
  const contractValid = hasValidContract(evidenceDir);
  const guardAllow = hasGuardAllow(evidenceDir);
  const recordedCapability = capabilityRecorded(evidenceDir);
  const artifactValidationRecorded = existsSync(join(evidenceDir, "artifact_claim_validation.json"));
  const failureDiagnosisRecorded = existsSync(join(evidenceDir, "failure_diagnosis.json"));
  const crossArmContamination = detectCrossArmContamination(arm, evidenceDir);
  const fullInterventionRequirementsMet = !arm.fullIntervention || (
    contractValid && guardAllow && recordedCapability && artifactValidation?.supports_verified_claim === true
  );

  const finalCorrectness = classifyArmCorrectness({
    runSucceeded,
    exactMetricMatch,
    instancePreserved,
    methodEvidence,
    boundaryOk,
    crossGroupContamination: crossArmContamination.detected,
    fullInterventionRequirementsMet,
  });

  let evidenceCompleteness = "none";
  if (methodEvidence || toolCalls > 0 || contractValid || recordedCapability || artifactValidationRecorded || memoryCount > 0) {
    evidenceCompleteness = contractValid && recordedCapability ? "complete_or_structured" : "partial";
  }
  if (arm.mode === "baseline" && methodEvidence) {
    evidenceCompleteness = "visible_answer_evidence";
  }

  return {
    schema: "nss_evimem.nl_x01_arm_evaluation.v1",
    mode: arm.mode,
    label: arm.label,
    openclaw_exit_code: commandResult.status,
    openclaw_signal: commandResult.signal,
    openclaw_error: commandResult.error,
    final_correctness: finalCorrectness,
    evidence_completeness: evidenceCompleteness,
    nss_tool_usage_detected: nssToolUsageDetected,
    evidence_memory_imported: importResult?.imported ?? 0,
    evidence_memory_total_records: importResult?.total_memory_records ?? memoryCount,
    contract_valid: contractValid,
    tool_semantic_match: guardAllow,
    tool_capability_recorded: recordedCapability,
    artifact_claim_validation_recorded: artifactValidationRecorded,
    artifact_claim_validation_status: artifactValidation?.status ?? null,
    artifact_claim_supports_verified: artifactValidation?.supports_verified_claim ?? null,
    failure_diagnosis_recorded: failureDiagnosisRecorded,
    cross_group_contamination_detected: crossArmContamination.detected,
    cross_group_contamination_hits: crossArmContamination.hits,
    tool_calls_recorded: toolCalls,
    claim_boundary_ok: boundaryOk,
    method_evidence_detected: methodEvidence,
    instance_preserved: instancePreserved,
    output_files: outputFiles,
    evidence_files: listFiles(evidenceDir),
    oracle_alignment: {
      expected_probability: expectedProbability,
      expected_weight: expectedWeight,
      exact_probability_match: exactProbabilityMatch,
      exact_weight_match: exactWeightMatch,
      exact_metric_match: exactMetricMatch,
    },
  };
}

async function importDistModule(relativePath, queryName) {
  const fullPath = join(repoRoot, "dist", relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`Compiled plugin module missing: ${fullPath}. Run npm run build first.`);
  }
  return import(`${pathToFileURL(fullPath).href}?${queryName}=${Date.now()}`);
}

async function prepareEvidenceMemory(evidenceDir) {
  const { importEvidenceMemoryPack } = await importDistModule("pack-importer.js", `pack-${Math.random()}`);
  const importResult = importEvidenceMemoryPack({
    pack_dir: memoryPackDir,
    evidence_dir: evidenceDir,
    tags: ["nl_x01_experiment"],
    replace_existing: true,
  });
  const memoryRecords = readJson(join(evidenceDir, "memory_records.json"));
  const summaryPath = join(evidenceDir, "memory_seed_summary.md");
  writeFileSync(summaryPath, buildMemorySeedSummary(memoryRecords, importResult), "utf8");
  return { importResult, summaryPath };
}

async function postprocessFullIntervention({ workspaceOutputDir, evidenceDir, commandResult, experimentRunId }) {
  const { validateArtifactClaims } = await importDistModule("artifact-claim-validator.js", "artifact-nl-x01");
  const { diagnoseFailure } = await importDistModule("failure-diagnosis.js", "failure-nl-x01");
  const resultPath = findFirstFile(workspaceOutputDir, [
    (file) => /result.*\.json$/i.test(file),
    (file) => /\.json$/i.test(file) && !/event_log|command/i.test(file),
  ]);
  const reportPath = findFirstFile(workspaceOutputDir, [
    (file) => /final_answer\.md$/i.test(file),
    (file) => /final.*\.md$/i.test(file),
    (file) => /\.md$/i.test(file),
  ]);
  const sourcePaths = collectSourcePaths(workspaceOutputDir);
  const validation = validateArtifactClaims({
    case_id: CASE_ID,
    task_contract: taskContract,
    result_path: resultPath ?? undefined,
    report_path: reportPath ?? undefined,
    source_paths: sourcePaths,
    evidence_dir: evidenceDir,
  });
  diagnoseFailure({
    case_id: CASE_ID,
    task_contract: taskContract,
    run_summary: {
      openclaw_exit_code: commandResult.status,
      openclaw_signal: commandResult.signal,
      openclaw_error: commandResult.error,
      artifact_claim_validation_status: validation.status,
      artifact_claim_supports_verified: validation.supports_verified_claim,
      result_path: resultPath,
      report_path: reportPath,
      source_paths: sourcePaths,
    },
    observations: [
      `Artifact claim validation status: ${validation.status}.`,
      "NL-X01 differential metric profile checks public evidence eligibility; the oracle is handled offline by the evaluator.",
    ],
    evidence_dir: evidenceDir,
  });
  const boundValidation = {
    ...validation,
    experiment_run_id: experimentRunId,
  };
  writeJson(join(evidenceDir, "artifact_claim_validation.json"), boundValidation);
  return boundValidation;
}

resetDirectory(experimentDir, runDir);
resetIsolatedWorkspaceRoot();

if (!existsSync(openclawMjs)) {
  throw new Error(`OpenClaw CLI entry not found: ${openclawMjs}`);
}
if (!existsSync(benchmarkQuestionPath)) {
  throw new Error(`Public question not found: ${benchmarkQuestionPath}`);
}
if (!existsSync(hiddenOraclePath)) {
  throw new Error(`Hidden oracle not found for evaluator: ${hiddenOraclePath}`);
}

copyFileSync(benchmarkQuestionPath, join(runDir, "question.md"));
const oracle = readJson(hiddenOraclePath);
const initialPluginEnabled = getInitialPluginEnabled();
copyFileSync(openclawConfigPath, join(runDir, "openclaw_config_before.json"));

const stateChanges = [];
const results = {};

try {
  for (const arm of arms) {
    const armRunDir = join(runDir, arm.mode);
    const armWorkspaceRoot = join(workspaceIsolationRoot, arm.mode);
    const armWorkspaceExisted = existsSync(armWorkspaceRoot);
    resetDirectory(workspaceIsolationRoot, armWorkspaceRoot);
    const armWorkspaceDir = join(armWorkspaceRoot, "work");
    const evidenceDir = join(armWorkspaceRoot, "evidence");
    mkdirSync(armRunDir, { recursive: true });
    mkdirSync(armWorkspaceRoot, { recursive: true });
    mkdirSync(armWorkspaceDir, { recursive: true });
    mkdirSync(evidenceDir, { recursive: true });
    copyFileSync(benchmarkQuestionPath, join(armWorkspaceRoot, "question.md"));

    let importResult = null;
    let memorySummaryPath = null;
    if (arm.evidenceMemory) {
      const prepared = await prepareEvidenceMemory(evidenceDir);
      importResult = prepared.importResult;
      memorySummaryPath = prepared.summaryPath;
      writeJson(join(armRunDir, "memory_pack_import.json"), importResult);
    }

    const prompt = makePrompt(arm, evidenceDir, memorySummaryPath);
    writeFileSync(join(armRunDir, "prompt.md"), prompt, "utf8");

    stateChanges.push({ action: arm.plugin ? "enable" : "disable", arm: arm.mode, result: setPluginEnabled(arm.plugin) });
    const armStartedAtIso = new Date().toISOString();
    const commandResult = runOpenClaw([
      "agent",
      "--local",
      "--model",
      model,
      "--session-key",
      `agent:isolated:cbsc_v2_nl_x01_${arm.mode}_${Date.now()}`,
      "--timeout",
      String(timeoutSeconds),
      "--verbose",
      "on",
      "--json",
      "--message",
      prompt,
    ], {
      cwd: armWorkspaceRoot,
      timeout: spawnTimeoutMs,
      env: {
        ...process.env,
        NSS_EVIMEM_EVIDENCE_DIR: evidenceDir,
        NSS_EVIMEM_SESSION_ID: `cbsc_v2_nl_x01_isolated_${arm.mode}`,
      },
    });
    writeCommandResult(armRunDir, commandResult);
    const cleanupResult = cleanupArmProcesses({
      startedAtIso: armStartedAtIso,
      armWorkspaceRoot,
    });

    let artifactValidation = null;
    if (arm.fullIntervention) {
      artifactValidation = await postprocessFullIntervention({
        workspaceOutputDir: armWorkspaceDir,
        evidenceDir,
        commandResult,
        experimentRunId,
      });
    }

    copyDirectoryIfExists(armWorkspaceDir, join(armRunDir, "workspace_outputs"));
    copyDirectoryIfExists(evidenceDir, join(armRunDir, "evidence"));
    writeJson(join(armRunDir, "workspace_isolation.json"), {
      arm_workspace_root: armWorkspaceRoot,
      workspace_isolation_root: workspaceIsolationRoot,
      arm_work_dir: armWorkspaceDir,
      evidence_dir: evidenceDir,
      started_at: armStartedAtIso,
      arm_workspace_reset_before_start: armWorkspaceExisted,
    });
    writeJson(join(armRunDir, "process_cleanup.json"), cleanupResult);

    const evaluation = evaluateArm({
      arm,
      commandResult,
      stdoutPath: join(armRunDir, "openclaw_stdout.json"),
      workspaceOutputDir: join(armRunDir, "workspace_outputs"),
      evidenceDir: join(armRunDir, "evidence"),
      oracle,
      importResult,
      artifactValidation,
    });
    writeJson(join(armRunDir, "evaluation.json"), evaluation);
    results[arm.mode] = evaluation;
  }
} finally {
  const currentEnabled = getInitialPluginEnabled();
  if (currentEnabled !== initialPluginEnabled) {
    stateChanges.push({ action: initialPluginEnabled ? "restore-enable" : "restore-disable", arm: "restore", result: setPluginEnabled(initialPluginEnabled) });
  }
}

writeJson(join(runDir, "openclaw_plugin_state_changes.json"), stateChanges.map((item) => ({
  action: item.action,
  arm: item.arm,
  status: item.result.status,
  stderr: item.result.stderr,
  stdout: item.result.stdout,
})));

const summary = {
  schema: "nss_evimem.nl_x01_all_groups_summary.v1",
  case_id: CASE_ID,
  experiment_run_id: experimentRunId,
  generated_at: new Date().toISOString(),
  model,
  openclaw_entry: openclawMjs,
  workspace_isolation_base: workspaceIsolationBase,
  workspace_isolation_root: workspaceIsolationRoot,
  task_contract: taskContract,
  oracle_expected: {
    probability: oracle.oracle_answer.probability,
    weight: oracle.oracle_answer.primary_weight,
    source_key: oracle.expected_agent_observable.source_key,
  },
  arms: results,
  best_group: Object.values(results).find((item) => item.final_correctness === "verified_correct" && !item.cross_group_contamination_detected)?.mode ?? null,
};
writeJson(join(runDir, "experiment_summary.json"), summary);

const csvRows = [
  ["metric", ...arms.map((arm) => arm.mode)],
  ["openclaw_exit_code", ...arms.map((arm) => results[arm.mode].openclaw_exit_code)],
  ["final_correctness", ...arms.map((arm) => results[arm.mode].final_correctness)],
  ["exact_metric_match", ...arms.map((arm) => results[arm.mode].oracle_alignment.exact_metric_match)],
  ["evidence_completeness", ...arms.map((arm) => results[arm.mode].evidence_completeness)],
  ["nss_tool_usage_detected", ...arms.map((arm) => results[arm.mode].nss_tool_usage_detected)],
  ["evidence_memory_imported", ...arms.map((arm) => results[arm.mode].evidence_memory_imported)],
  ["contract_valid", ...arms.map((arm) => results[arm.mode].contract_valid)],
  ["tool_capability_recorded", ...arms.map((arm) => results[arm.mode].tool_capability_recorded)],
  ["artifact_claim_validation_recorded", ...arms.map((arm) => results[arm.mode].artifact_claim_validation_recorded)],
  ["failure_diagnosis_recorded", ...arms.map((arm) => results[arm.mode].failure_diagnosis_recorded)],
  ["cross_group_contamination_detected", ...arms.map((arm) => results[arm.mode].cross_group_contamination_detected)],
  ["tool_calls_recorded", ...arms.map((arm) => results[arm.mode].tool_calls_recorded)],
  ["claim_boundary_ok", ...arms.map((arm) => results[arm.mode].claim_boundary_ok)],
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
  "# CBSC-V2-NL-X01 OpenClaw All-Groups Experiment",
  "",
  "## Setup",
  "",
  `- Case: \`${CASE_ID}\``,
  `- Model: \`${model}\``,
  `- Expected metric: \`${oracle.oracle_answer.probability}\`, weight \`${oracle.oracle_answer.primary_weight}\``,
  `- Source key: \`${oracle.expected_agent_observable.source_key}\``,
  `- Isolation workspace base: \`${workspaceIsolationBase}\``,
  "",
  "## Results",
  "",
  ...arms.flatMap((arm) => {
    const result = results[arm.mode];
    return [
      `### ${arm.label}`,
      "",
      `- Final correctness: \`${result.final_correctness}\``,
      `- Exact metric match: \`${result.oracle_alignment.exact_metric_match}\``,
      `- Evidence completeness: \`${result.evidence_completeness}\``,
      `- NSS tool usage detected: \`${result.nss_tool_usage_detected}\``,
      `- EvidenceMemory imported: \`${result.evidence_memory_imported}\``,
      `- Contract valid: \`${result.contract_valid}\``,
      `- Tool capability recorded: \`${result.tool_capability_recorded}\``,
      `- Artifact validation recorded: \`${result.artifact_claim_validation_recorded}\``,
      `- Failure diagnosis recorded: \`${result.failure_diagnosis_recorded}\``,
      `- Cross-group contamination detected: \`${result.cross_group_contamination_detected}\``,
      `- Cross-group contamination hits: \`${result.cross_group_contamination_hits.join(", ") || "none"}\``,
      `- Tool calls recorded: \`${result.tool_calls_recorded}\``,
      `- Claim boundary ok: \`${result.claim_boundary_ok}\``,
      "",
    ];
  }),
  "## Interpretation",
  "",
  "This NL-X01 task is metric-level and easier than the previous Simon32 differential-linear search case.",
  "The evaluator labels `verified_correct` when the visible answer preserves the instance, matches the offline oracle metric, provides method/source evidence, and avoids full-cipher overclaiming.",
  `Best verified group: \`${summary.best_group ?? "none"}\``,
  "",
].join("\n");
writeFileSync(join(runDir, "experiment_report.md"), report, "utf8");

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
