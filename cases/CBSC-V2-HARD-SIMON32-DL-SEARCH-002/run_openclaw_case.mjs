import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const caseDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(caseDir, "..", "..");
const distPath = join(repoRoot, "dist", "index.js");
const benchmarkQuestionPath = resolve(
  repoRoot,
  "..",
  "v4版本benchmark",
  "tasks",
  "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
  "public",
  "question.md",
);
const inputDir = join(caseDir, "inputs");
const outputDir = join(caseDir, "outputs", "latest");
const artifactDir = join(outputDir, "artifacts");
const evidenceDir = join(outputDir, "evidence");
const toolPath = join(caseDir, "tools", "simon32_dl_sample.py");

function assertInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === "" || (!rel.startsWith("..") && !rel.includes(":"))) {
    return;
  }
  throw new Error(`Refusing to modify path outside ${parent}: ${child}`);
}

function resetDirectory(path) {
  assertInside(caseDir, path);
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

function readJsonl(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function requireTool(tools, name) {
  const tool = tools.get(name);
  if (!tool) {
    throw new Error(`Required plugin helper tool was not registered: ${name}`);
  }
  return tool;
}

if (!existsSync(distPath)) {
  throw new Error(`Compiled plugin not found: ${distPath}. Run npm run build first.`);
}
if (!existsSync(benchmarkQuestionPath)) {
  throw new Error(`Benchmark public question not found: ${benchmarkQuestionPath}`);
}

resetDirectory(inputDir);
resetDirectory(outputDir);
mkdirSync(artifactDir, { recursive: true });
mkdirSync(evidenceDir, { recursive: true });

const taskContract = {
  domain: "symmetric_cryptanalysis",
  cipher: "Simon32/64",
  rounds: 14,
  analysis_type: "differential_linear",
  method: "script_search",
  objective: "distinguisher_candidate",
  scope: "full_cipher",
  required_artifacts: ["code", "run_log", "search_result", "final_report"],
};

const toolCapability = {
  domain: "symmetric_cryptanalysis",
  analysis_type: "differential_linear",
  method: "script_search",
  scope: "full_cipher",
  claim_types: ["distinguisher_candidate", "empirical_correlation"],
  produced_artifacts: ["code", "run_log", "search_result", "final_report"],
};

writeFileSync(join(inputDir, "public_question.md"), readFileSync(benchmarkQuestionPath, "utf8"), "utf8");
writeJson(join(inputDir, "task_contract.json"), taskContract);
writeJson(join(inputDir, "tool_capability.json"), {
  tool_name: "python_search_script",
  capability: toolCapability,
});

process.env.NSS_EVIMEM_EVIDENCE_DIR = evidenceDir;

const tools = new Map();
const hooks = {
  before_tool_call: [],
  after_tool_call: [],
};

const api = {
  registerTool(tool, options = {}) {
    const names = [
      ...(options.names ?? []),
      options.name,
      tool?.name,
    ].filter((name) => typeof name === "string" && name.trim().length > 0);
    for (const name of names) {
      tools.set(name, tool);
    }
  },
  on(hookName, handler) {
    if (!hooks[hookName]) {
      throw new Error(`Unexpected hook registered: ${hookName}`);
    }
    hooks[hookName].push(handler);
  },
  logger: {
    info(message) {
      process.stderr.write(`[case] ${message}\n`);
    },
    warn(message) {
      process.stderr.write(`[case][warn] ${message}\n`);
    },
    error(message) {
      process.stderr.write(`[case][error] ${message}\n`);
    },
  },
};

const pluginModule = await import(`${pathToFileURL(distPath).href}?case=${Date.now()}`);
const plugin = pluginModule.default ?? pluginModule;
plugin.register(api);

const registerCapabilityTool = requireTool(tools, "nss_evimem_register_tool_capability");
const listCapabilitiesTool = requireTool(tools, "nss_evimem_list_tool_capabilities");
const validateContractTool = requireTool(tools, "nss_evimem_validate_contract");
const guardTool = requireTool(tools, "nss_evimem_guard_decision");
const promoteMemoryTool = requireTool(tools, "nss_evimem_promote_memory");
const retrieveMemoryTool = requireTool(tools, "nss_evimem_retrieve_memory");

const capabilityRegistration = await registerCapabilityTool.execute("register-python-search", {
  tool_name: "python_search_script",
  capability: toolCapability,
  metadata: {
    case_id: "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
    note: "Session-level capability for the case harness Python sampling script.",
  },
  evidence_dir: evidenceDir,
});

const contractValidation = await validateContractTool.execute("validate-contract", {
  task_contract: taskContract,
  require_matching_tool: true,
  evidence_dir: evidenceDir,
});

const guardDecision = await guardTool.execute("guard-python-search", {
  requested_tool: "python_search_script",
  guard_mode: "post_check",
  task_contract: {
    domain: taskContract.domain,
    analysis_type: taskContract.analysis_type,
    method: taskContract.method,
    scope: taskContract.scope,
  },
  tool_capability: toolCapability,
  compare_fields: ["domain", "analysis_type", "method", "scope"],
  evidence_dir: evidenceDir,
});

const context = {
  agentId: "case-harness-agent",
  sessionKey: "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
  sessionId: "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
  runId: "case-run-latest",
  toolName: "python_search_script",
  toolCallId: "case-python-search-1",
};

const toolParams = {
  command: "python",
  args: [
    toolPath,
    "--samples",
    "4096",
    "--rounds",
    "14",
    "--seed",
    "20260705",
    "--out-dir",
    artifactDir,
  ],
  task_contract: taskContract,
};

for (const handler of hooks.before_tool_call) {
  await handler({ toolName: context.toolName, params: toolParams, runId: context.runId, toolCallId: context.toolCallId }, context);
}

const startedAt = Date.now();
const run = spawnSync("python", toolParams.args, {
  cwd: caseDir,
  encoding: "utf8",
  windowsHide: true,
});
const elapsedMs = Date.now() - startedAt;
const runLogPath = join(artifactDir, "run.log");
writeFileSync(
  runLogPath,
  [
    `command: python ${toolParams.args.map((part) => JSON.stringify(part)).join(" ")}`,
    `exit_code: ${run.status}`,
    "",
    "[stdout]",
    run.stdout ?? "",
    "",
    "[stderr]",
    run.stderr ?? "",
  ].join("\n"),
  "utf8",
);

const toolError = run.status === 0 ? undefined : `python_search_script exited with code ${run.status}`;
const result = {
  content: [{ type: "text", text: run.stdout || "python_search_script completed" }],
  details: {
    exit_code: run.status,
    elapsed_ms: elapsedMs,
    artifacts: {
      code: toolPath,
      run_log: runLogPath,
      search_result: join(artifactDir, "search_result.json"),
      final_report: join(artifactDir, "final_report.md"),
    },
  },
};

for (const handler of hooks.after_tool_call) {
  await handler({
    toolName: context.toolName,
    params: toolParams,
    runId: context.runId,
    toolCallId: context.toolCallId,
    result,
    error: toolError,
    durationMs: elapsedMs,
  }, context);
}

if (toolError) {
  throw new Error(toolError);
}

const memory = await promoteMemoryTool.execute("promote-case-evidence", {
  evidence_id: "evid_0001",
  claim: "The case harness produced sampled Simon32/64 differential-linear correlation artifacts.",
  task_contract: taskContract,
  tags: ["CBSC-V2-HARD-SIMON32-DL-SEARCH-002", "simon32", "differential_linear", "case_harness"],
  metadata: {
    boundary: "sampled case artifact, not a proof of optimality",
  },
  evidence_dir: evidenceDir,
});

const retrievedMemory = await retrieveMemoryTool.execute("retrieve-case-memory", {
  task_contract: {
    domain: "symmetric_cryptanalysis",
    cipher: "Simon32/64",
  },
  tags: ["case_harness"],
  evidence_dir: evidenceDir,
});

const capabilities = await listCapabilitiesTool.execute("list-capabilities", {
  evidence_dir: evidenceDir,
});

const searchResult = readJson(join(artifactDir, "search_result.json"));
const toolCalls = readJsonl(join(evidenceDir, "tool_calls.jsonl"));
const evidenceIndex = readJson(join(evidenceDir, "evidence_index.json"));

const summary = {
  ok:
    contractValidation.details.ok === true
    && guardDecision.details.decision === "allow"
    && run.status === 0
    && toolCalls.length === 1
    && evidenceIndex.length === 1
    && memory.details.evidence_id === "evid_0001",
  case_id: "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
  plugin_runtime: "openclaw-style-local-harness",
  contract_validation: contractValidation.details,
  capability_registration: capabilityRegistration.details,
  capabilities: capabilities.details,
  guard_decision: guardDecision.details,
  evidence_id: "evid_0001",
  memory: memory.details,
  retrieved_memory: retrievedMemory.details,
  search_result: {
    status: searchResult.status,
    delta_in_32bit: searchResult.delta_in_32bit,
    gamma_out_32bit: searchResult.gamma_out_32bit,
    best_observation: searchResult.best_observation,
    claim_boundary: searchResult.claim_boundary,
  },
  outputs: {
    input_dir: inputDir,
    output_dir: outputDir,
    artifact_dir: artifactDir,
    evidence_dir: evidenceDir,
  },
};

writeJson(join(outputDir, "run_summary.json"), summary);

const caseReport = [
  "# CBSC-V2-HARD-SIMON32-DL-SEARCH-002 Case Report",
  "",
  "## Purpose",
  "",
  "This case demonstrates the OpenClaw NSS-EviMem plugin around a Simon32/64 differential-linear benchmark task.",
  "The generated Python artifacts are a deterministic integration sample, not a full benchmark solution.",
  "",
  "## NSS-EviMem Outputs",
  "",
  `- Contract status: \`${contractValidation.details.status}\``,
  `- Matching tools: \`${contractValidation.details.matching_tools.join(", ")}\``,
  `- Guard decision: \`${guardDecision.details.decision}\``,
  `- Evidence id: \`evid_0001\``,
  `- Memory id: \`${memory.details.memory_id}\``,
  "",
  "## Sampled Observation",
  "",
  `- Input difference: \`${searchResult.delta_in_32bit}\``,
  `- Output mask: \`${searchResult.gamma_out_32bit}\``,
  `- Best sampled split: \`${JSON.stringify(searchResult.best_observation.split)}\``,
  `- Samples: \`${searchResult.best_observation.samples}\``,
  `- log2(abs(correlation)): \`${searchResult.best_observation.log2_abs_correlation}\``,
  "",
  "## Boundary",
  "",
  "This run should be used to test evidence capture, provenance, and task-contract wiring.",
  "A separate evaluator or verifier is still required for final benchmark correctness scoring.",
  "",
].join("\n");

writeFileSync(join(outputDir, "case_report.md"), caseReport, "utf8");
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (!summary.ok) {
  process.exitCode = 1;
}
