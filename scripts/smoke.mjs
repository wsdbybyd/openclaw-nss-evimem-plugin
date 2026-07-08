import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distPath = join(packageRoot, "dist", "index.js");
const outputDir = join(packageRoot, "smoke-output");
const evidenceDir = join(outputDir, "evidence");
const artifactsDir = join(outputDir, "artifacts");
const fixturePackDir = join(outputDir, "fixture-pack");

function assertInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === "" || (!rel.startsWith("..") && !rel.includes(":"))) {
    return;
  }
  throw new Error(`Refusing to clean path outside ${parent}: ${child}`);
}

function resetDirectory(path) {
  assertInside(packageRoot, path);
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
  mkdirSync(path, { recursive: true });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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


function createFixtureEvidenceMemoryPack(packDir) {
  resetDirectory(packDir);
  const sourceDir = join(packDir, "sources", "text");
  mkdirSync(sourceDir, { recursive: true });
  for (const id of ["paper_09", "paper_17", "paper_24"]) {
    writeFileSync(join(sourceDir, `${id}.txt`), `${id} fixture source\n`, "utf8");
  }

  const papers = [
    {
      id: "paper_09",
      category: ["differential", "SAT", "ARX"],
      title: "Towards Finding Optimal Differential Characteristics for ARX: Application to Salsa20",
      authors: "Nicky Mouha; Bart Preneel",
      year: 2013,
      source_status: "user_pdf_supplied",
      text_file: "sources/text/paper_09.txt",
      active_in_memory: true,
    },
    {
      id: "paper_17",
      category: ["differential", "linear", "MILP", "S-box"],
      title: "Towards Finding the Best Characteristics of Some Bit-Oriented Block Ciphers",
      authors: "Siwei Sun et al.",
      year: 2014,
      source_status: "user_pdf_supplied",
      text_file: "sources/text/paper_17.txt",
      active_in_memory: true,
    },
    {
      id: "paper_24",
      category: ["platform", "OCP", "automated_cryptanalysis"],
      title: "OCP: Open Cryptanalysis Platform",
      authors: "Chunning Zhou",
      year: 2026,
      source_status: "ocp_tutorial_source",
      text_file: "sources/text/paper_24.txt",
      active_in_memory: true,
    },
  ];

  const structuredClaims = {
    paper_09: {
      analysis_types: ["differential"],
      methods: ["SAT solver", "ARX operation equations"],
      applications: ["Salsa20"],
    },
    paper_17: {
      analysis_types: ["differential", "linear"],
      methods: ["MILP", "exact S-box linear inequalities"],
      applications: ["SIMON", "PRESENT"],
    },
    paper_24: {
      analysis_types: ["differential", "linear"],
      methods: ["OCP platform usage", "MILP", "SAT"],
      applications: ["SPECK", "SIMON"],
    },
  };

  const evidenceRecords = papers.map((paper) => ({
    evidence_id: `evid_acm24_${paper.id.slice(-2)}_method_scope`,
    paper_id: paper.id,
    source_type: paper.id === "paper_24" ? "ocp_usage_documentation" : "user_supplied_pdf_abstract",
    source_url: "https://example.invalid/fixture",
    source_file: paper.text_file,
    source_locator: paper.id === "paper_24" ? "OCP README and OCP.py usage examples" : "Abstract, fixture PDF page 1",
    claim: `${paper.id} fixture claim`,
    structured_claim: structuredClaims[paper.id],
    scope_tags: [...paper.category, paper.id],
    confidence: "high",
  }));

  const memoryRecords = papers.map((paper) => ({
    memory_id: `mem_acm24_${paper.id.slice(-2)}_method_scope`,
    memory_type: paper.id === "paper_24" ? "tool_usage_scope" : "paper_method_scope",
    status: "active",
    paper_id: paper.id,
    paper_title: paper.title,
    paper_authors: paper.authors,
    year: paper.year,
    claim: `${paper.id} fixture claim`,
    structured_claim: structuredClaims[paper.id],
    evidence_id: `evid_acm24_${paper.id.slice(-2)}_method_scope`,
    evidence_ids: [`evid_acm24_${paper.id.slice(-2)}_method_scope`],
    retrieval_tags: ["automated cryptanalysis", paper.id, ...paper.category, ...structuredClaims[paper.id].methods],
    trigger_issue_kinds: ["automated_modeling_literature_context"],
    do_not_apply_when: ["fixture rule"],
    created_at: "2026-06-21T00:00:00.000Z",
  }));

  writeJson(join(packDir, "manifest.json"), {
    schema: "nss-evimem.automated_crypto_modeling.manifest.v1",
    created_at: "2026-06-21T00:00:00.000Z",
    paper_count: papers.length,
    active_paper_count: papers.length,
    excluded_paper_count: 0,
    excluded_papers: [],
    papers,
  });
  writeJson(join(packDir, "evidence_index.json"), {
    schema: "nss-evimem.automated_crypto_modeling.evidence_index.v1",
    created_at: "2026-06-21T00:00:00.000Z",
    records: evidenceRecords,
  });
  writeJson(join(packDir, "memory_records.json"), memoryRecords);
  writeJson(join(packDir, "retrieval_config.json"), {
    schema: "nss-evimem.automated_crypto_modeling.retrieval_config.v1",
    created_at: "2026-06-21T00:00:00.000Z",
    hook_issue_to_memory: {
      fixture: memoryRecords.map((record) => record.memory_id),
    },
  });
}

if (!existsSync(distPath)) {
  throw new Error(`Compiled plugin not found: ${distPath}. Run npm run build first.`);
}

resetDirectory(outputDir);
mkdirSync(artifactsDir, { recursive: true });
createFixtureEvidenceMemoryPack(fixturePackDir);
process.env.NSS_EVIMEM_EVIDENCE_DIR = evidenceDir;

const artifactPath = join(artifactsDir, "demo-result.txt");
writeFileSync(artifactPath, "demo artifact\n", "utf8");

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
      process.stderr.write(`[smoke] ${message}\n`);
    },
    warn(message) {
      process.stderr.write(`[smoke][warn] ${message}\n`);
    },
    error(message) {
      process.stderr.write(`[smoke][error] ${message}\n`);
    },
  },
};

const pluginModule = await import(`${pathToFileURL(distPath).href}?smoke=${Date.now()}`);
const plugin = pluginModule.default ?? pluginModule;
plugin.register(api);

const requiredTools = [
  "nss_evimem_promote_memory",
  "nss_evimem_retrieve_memory",
  "nss_evimem_guard_decision",
  "nss_evimem_import_pack",
  "nss_evimem_register_tool_capability",
  "nss_evimem_list_tool_capabilities",
  "nss_evimem_validate_contract",
  "nss_evimem_validate_artifact_claims",
  "nss_evimem_diagnose_failure",
  "nss_evimem_build_rerun_context",
  "nss_evimem_build_intervention",
];
for (const toolName of requiredTools) {
  if (!tools.has(toolName)) {
    throw new Error(`Required helper tool was not registered: ${toolName}`);
  }
}

const context = {
  agentId: "smoke-agent",
  sessionKey: "smoke-session",
  sessionId: "smoke-session",
  runId: "smoke-run",
  toolName: "demo_user_tool",
  toolCallId: "demo-call-1",
};
const params = { input: "demo" };
const result = {
  content: [{ type: "text", text: "demo completed" }],
  details: {
    artifacts: {
      demo_result: artifactPath,
    },
  },
};

for (const handler of hooks.before_tool_call) {
  await handler({ toolName: "demo_user_tool", params, runId: context.runId, toolCallId: context.toolCallId }, context);
}
for (const handler of hooks.after_tool_call) {
  await handler({
    toolName: "demo_user_tool",
    params,
    runId: context.runId,
    toolCallId: context.toolCallId,
    result,
    durationMs: 12,
  }, context);
}

const promoteTool = tools.get("nss_evimem_promote_memory");
const retrieveTool = tools.get("nss_evimem_retrieve_memory");
const guardTool = tools.get("nss_evimem_guard_decision");
const importTool = tools.get("nss_evimem_import_pack");
const registerCapabilityTool = tools.get("nss_evimem_register_tool_capability");
const listCapabilitiesTool = tools.get("nss_evimem_list_tool_capabilities");
const validateContractTool = tools.get("nss_evimem_validate_contract");
const validateArtifactClaimsTool = tools.get("nss_evimem_validate_artifact_claims");
const diagnoseFailureTool = tools.get("nss_evimem_diagnose_failure");
const buildRerunContextTool = tools.get("nss_evimem_build_rerun_context");
const buildInterventionTool = tools.get("nss_evimem_build_intervention");
const taskContract = {
  domain: "demo",
  objective: "verified_artifact",
};

const promoted = await promoteTool.execute("memory-promote-1", {
  evidence_id: "evid_0001",
  claim: "The demo tool produced a verified artifact.",
  task_contract: taskContract,
  tags: ["demo"],
  evidence_dir: evidenceDir,
});

const retrieved = await retrieveTool.execute("memory-retrieve-1", {
  task_contract: taskContract,
  tags: ["demo"],
  evidence_dir: evidenceDir,
});

const staleRetrieved = await retrieveTool.execute("memory-retrieve-stale", {
  task_contract: {
    domain: "demo",
    objective: "different_objective",
  },
  tags: ["demo"],
  evidence_dir: evidenceDir,
});

const guard = await guardTool.execute("guard-1", {
  requested_tool: "demo_heuristic_tool",
  guard_mode: "pre_redirect",
  task_contract: {
    method: "verified",
    objective: "final_claim",
  },
  tool_capability: {
    method: "heuristic",
    objective: "candidate_claim",
  },
  target_tool: "demo_verified_tool",
  evidence_dir: evidenceDir,
});

const capabilityRegistration = await registerCapabilityTool.execute("capability-register-1", {
  tool_name: "simon32_dl_search",
  capability: {
    domain: "symmetric_cryptanalysis",
    analysis_type: "differential_linear",
    method: "script_search",
    scope: "full_cipher",
    claim_types: ["distinguisher_candidate", "empirical_correlation"],
    produced_artifacts: ["code", "run_log", "search_result"],
  },
  evidence_dir: evidenceDir,
});

const listedCapabilities = await listCapabilitiesTool.execute("capability-list-1", {
  evidence_dir: evidenceDir,
});

const validContract = await validateContractTool.execute("contract-valid-1", {
  task_contract: {
    domain: "symmetric_cryptanalysis",
    cipher: "Simon32/64",
    rounds: 14,
    analysis_type: "differential_linear",
    method: "script_search",
    objective: "distinguisher_candidate",
    scope: "full_cipher",
    required_artifacts: ["code", "run_log", "search_result"],
  },
  require_matching_tool: true,
  evidence_dir: evidenceDir,
});

const incompleteContract = await validateContractTool.execute("contract-incomplete-1", {
  task_contract: {
    domain: "symmetric_cryptanalysis",
    cipher: "SIMON",
  },
  evidence_dir: evidenceDir,
});

const badSimonSourcePath = join(artifactsDir, "bad_simon.py");
writeFileSync(badSimonSourcePath, [
  "def generate_round_keys():",
  "    c = 3",
  "    return [0] * 32",
  "",
  "def simon_encrypt_r_rounds_vec(plaintexts, round_keys, r):",
  "    L = plaintexts",
  "    f = plaintexts",
  "    new_R = L ^ f",
  "    return new_R",
  "",
].join("\n"), "utf8");

const badSimonResultPath = join(artifactsDir, "bad_simon_result.json");
writeJson(badSimonResultPath, {
  status: "bounded_search_complete_no_distinguisher",
  conclusion: "No verified 14-round DL distinguisher.",
  total_time_s: 1783414135.26,
  multikey: {
    input_diff: "0x400",
    output_mask: "0x8000",
    distinguishable: true,
  },
});

const artifactClaimValidation = await validateArtifactClaimsTool.execute("artifact-claims-1", {
  case_id: "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
  task_contract: {
    domain: "symmetric_cryptanalysis",
    cipher: "Simon32/64",
    rounds: 14,
    analysis_type: "differential_linear",
    method: "script_search",
    objective: "verified_14_round_dl_distinguisher",
    scope: "full_cipher",
  },
  result_path: badSimonResultPath,
  source_paths: [badSimonSourcePath],
  report_text: "No verified distinguisher. Candidate Delta=0x400, Gamma=0x8000.",
  evidence_dir: evidenceDir,
});

const failureDiagnosis = await diagnoseFailureTool.execute("failure-diagnosis-1", {
  case_id: "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
  task_contract: {
    domain: "symmetric_cryptanalysis",
    cipher: "Simon32/64",
    rounds: 14,
    analysis_type: "differential_linear",
    method: "script_search",
    objective: "distinguisher_candidate",
    scope: "full_cipher",
  },
  run_summary: {
    final_correctness: "partially_correct_or_insufficient",
    evidence_completeness: "partial",
    claim_boundary_ok: true,
    overclaiming_detected: false,
    openclaw_error: "spawnSync node.exe ETIMEDOUT",
    oracle_alignment: {
      paper_pair_match: false,
      best_split_mentioned: false,
    },
  },
  observations: [
    "quick scan candidates vanished under multi-key verification; likely statistical noise",
    "search process was killed after no new output",
  ],
  evidence_dir: evidenceDir,
});

const rerunContext = await buildRerunContextTool.execute("rerun-context-1", {
  case_id: "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
  prior_result_summary: {
    pass: "plugin_pass1",
    final_correctness: "partially_correct_or_insufficient",
    evidence_completeness: "complete_or_structured",
  },
  evidence_dir: evidenceDir,
});

const intervention = await buildInterventionTool.execute("intervention-1", {
  case_id: "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
  intervention_mode: "online_repair_prompt",
  prior_result_summary: {
    pass: "plugin_pass1",
    final_correctness: "partially_correct_or_insufficient",
    evidence_completeness: "complete_or_structured",
  },
  evidence_dir: evidenceDir,
});

const imported = await importTool.execute("import-pack-1", {
  pack_dir: fixturePackDir,
  evidence_dir: evidenceDir,
  tags: ["fixture-pack"],
});

const importedMilpRetrieved = await retrieveTool.execute("memory-retrieve-imported-milp", {
  task_contract: { domain: "automated_crypto_modeling" },
  tags: ["MILP"],
  evidence_dir: evidenceDir,
});

const importedPaper09Retrieved = await retrieveTool.execute("memory-retrieve-imported-paper09", {
  task_contract: { domain: "automated_crypto_modeling" },
  tags: ["paper_09"],
  evidence_dir: evidenceDir,
});

const importedPaper24Retrieved = await retrieveTool.execute("memory-retrieve-imported-paper24", {
  task_contract: { domain: "automated_crypto_modeling" },
  tags: ["paper_24"],
  evidence_dir: evidenceDir,
});

const toolCallsPath = join(evidenceDir, "tool_calls.jsonl");
const evidenceIndexPath = join(evidenceDir, "evidence_index.json");
const memoryPath = join(evidenceDir, "memory_records.json");
const guardEventsPath = join(evidenceDir, "tool_guard_events.jsonl");
const capabilityRegistryPath = join(evidenceDir, "tool_capabilities.json");
const contractStorePath = join(evidenceDir, "task_contract.json");
const contractEventsPath = join(evidenceDir, "contract_validation_events.jsonl");
const artifactClaimValidationPath = join(evidenceDir, "artifact_claim_validation.json");
const artifactClaimValidationEventsPath = join(evidenceDir, "artifact_claim_validation_events.jsonl");
const failureDiagnosisPath = join(evidenceDir, "failure_diagnosis.json");
const failureDiagnosisEventsPath = join(evidenceDir, "failure_diagnosis_events.jsonl");
const rerunPlanPath = join(evidenceDir, "rerun_plan.md");
const rerunContextPath = join(evidenceDir, "rerun_context.md");
const interventionJsonPath = join(evidenceDir, "intervention.json");
const interventionMarkdownPath = join(evidenceDir, "intervention.md");
const records = readJsonl(toolCallsPath);
const index = readJson(evidenceIndexPath);
const memories = readJson(memoryPath);
const guardEvents = readJsonl(guardEventsPath);
const capabilityRegistry = readJson(capabilityRegistryPath);
const storedContract = readJson(contractStorePath);
const contractEvents = readJsonl(contractEventsPath);
const artifactClaimValidationFile = readJson(artifactClaimValidationPath);
const artifactClaimValidationEvents = readJsonl(artifactClaimValidationEventsPath);
const failureDiagnosisFile = readJson(failureDiagnosisPath);
const failureDiagnosisEvents = readJsonl(failureDiagnosisEventsPath);
const rerunPlan = readFileSync(rerunPlanPath, "utf8");
const rerunContextFile = readFileSync(rerunContextPath, "utf8");
const interventionJson = readJson(interventionJsonPath);
const interventionMarkdown = readFileSync(interventionMarkdownPath, "utf8");
const retrievedDetails = retrieved.details;
const staleDetails = staleRetrieved.details;
const guardDetails = guard.details;
const capabilityRegistrationDetails = capabilityRegistration.details;
const listedCapabilitiesDetails = listedCapabilities.details;
const validContractDetails = validContract.details;
const incompleteContractDetails = incompleteContract.details;
const artifactClaimValidationDetails = artifactClaimValidation.details;
const failureDiagnosisDetails = failureDiagnosis.details;
const rerunContextDetails = rerunContext.details;
const interventionDetails = intervention.details;
const importedDetails = imported.details;
const importedMilpDetails = importedMilpRetrieved.details;
const importedPaper09Details = importedPaper09Retrieved.details;
const importedPaper24Details = importedPaper24Retrieved.details;

const summary = {
  ok:
    records.length === 1
    && index.length === 1
    && memories.length === 4
    && records[0].tool_name === "demo_user_tool"
    && records[0].artifacts.demo_result === resolve(artifactPath)
    && typeof records[0].artifact_hashes.demo_result === "string"
    && promoted.details.memory_id === "mem_0001"
    && retrievedDetails.accepted.length === 1
    && staleDetails.accepted.length === 0
    && staleDetails.rejected.length === 1
    && guardDetails.decision === "redirect"
    && guardEvents.length === 1
    && capabilityRegistrationDetails.tool_name === "simon32_dl_search"
    && listedCapabilitiesDetails.capabilities.some((record) => record.tool_name === "simon32_dl_search")
    && capabilityRegistry.simon32_dl_search.capability.analysis_type === "differential_linear"
    && validContractDetails.status === "valid_contract"
    && validContractDetails.ok === true
    && validContractDetails.matching_tools.includes("simon32_dl_search")
    && storedContract.cipher === "Simon32/64"
    && incompleteContractDetails.status === "incomplete_contract"
    && incompleteContractDetails.missing_fields.includes("analysis_type")
    && artifactClaimValidationDetails.ok === false
    && artifactClaimValidationDetails.supports_verified_claim === false
    && artifactClaimValidationDetails.status === "failed"
    && artifactClaimValidationDetails.checks.some((check) => check.id === "simon32_round_function_uses_key" && check.status === "fail")
    && artifactClaimValidationDetails.checks.some((check) => check.id === "simon32_key_schedule_constant" && check.status === "fail")
    && artifactClaimValidationDetails.checks.some((check) => check.id === "simon32_full_state_pair" && check.status === "fail")
    && artifactClaimValidationDetails.checks.some((check) => check.id === "simon32_required_decompositions" && check.status === "fail")
    && artifactClaimValidationDetails.checks.some((check) => check.id === "dl_signed_sum_measurement" && check.status === "fail")
    && artifactClaimValidationDetails.checks.some((check) => check.id === "result_claim_consistency" && check.status === "fail")
    && artifactClaimValidationDetails.checks.some((check) => check.id === "runtime_duration_sane" && check.status === "fail")
    && artifactClaimValidationFile.schema === "nss_evimem.artifact_claim_validation.v1"
    && artifactClaimValidationEvents.length === 1
    && contractEvents.length === 2
    && failureDiagnosisDetails.status === "needs_rerun"
    && failureDiagnosisDetails.failure_types.includes("search_timeout")
    && failureDiagnosisDetails.failure_types.includes("candidate_statistical_noise")
    && failureDiagnosisDetails.failure_types.includes("artifact_claim_invalid")
    && failureDiagnosisDetails.failure_types.includes("oracle_mismatch")
    && failureDiagnosisDetails.failure_types.includes("insufficient_evidence")
    && failureDiagnosisDetails.output_files.failure_diagnosis === failureDiagnosisPath
    && failureDiagnosisDetails.output_files.rerun_plan === rerunPlanPath
    && failureDiagnosisFile.failure_types.includes("candidate_statistical_noise")
    && failureDiagnosisEvents.length === 1
    && rerunPlan.includes("## Rerun Checklist")
    && rerunPlan.includes("Use the existing validated Task Contract")
    && rerunContextDetails.output_files.rerun_context === rerunContextPath
    && rerunContextFile.includes("# NSS-EviMem Rerun Context")
    && rerunContextFile.includes("Status: `needs_rerun`")
    && rerunContextFile.includes("candidate_statistical_noise")
    && rerunContextFile.includes("## Required Rerun Discipline")
    && interventionDetails.schema === "nss_evimem.online_intervention.v1"
    && interventionDetails.status === "active_intervention"
    && interventionDetails.intervention_mode === "online_repair_prompt"
    && interventionDetails.output_files.intervention_json === interventionJsonPath
    && interventionDetails.output_files.intervention_markdown === interventionMarkdownPath
    && interventionDetails.prompt_patch.includes("Do not claim a verified final answer")
    && interventionDetails.blocked_claims.some((claim) => claim.includes("verified"))
    && interventionDetails.required_actions.includes("Run a bounded staged rerun before finalizing.")
    && interventionJson.schema === "nss_evimem.online_intervention.v1"
    && interventionMarkdown.includes("# NSS-EviMem Online Repair Intervention")
    && interventionMarkdown.includes("## Prompt Patch")
    && importedDetails.imported === 3
    && importedDetails.total_memory_records === 4
    && importedMilpDetails.accepted.length >= 1
    && importedMilpDetails.accepted.some((record) => record.memory_id === "mem_acm24_17_method_scope")
    && importedPaper09Details.accepted.length === 1
    && importedPaper09Details.accepted[0].metadata.paper_id === "paper_09"
    && importedPaper24Details.accepted.length === 1
    && importedPaper24Details.accepted[0].metadata.source_memory_type === "tool_usage_scope",
  registered_hooks: {
    before_tool_call: hooks.before_tool_call.length,
    after_tool_call: hooks.after_tool_call.length,
  },
  registered_tools: [...tools.keys()].sort(),
  files: {
    tool_calls: toolCallsPath,
    evidence_index: evidenceIndexPath,
    memory_records: memoryPath,
    tool_guard_events: guardEventsPath,
    tool_capabilities: capabilityRegistryPath,
    task_contract: contractStorePath,
    contract_validation_events: contractEventsPath,
    artifact_claim_validation: artifactClaimValidationPath,
    artifact_claim_validation_events: artifactClaimValidationEventsPath,
    failure_diagnosis: failureDiagnosisPath,
    failure_diagnosis_events: failureDiagnosisEventsPath,
    rerun_plan: rerunPlanPath,
    rerun_context: rerunContextPath,
    intervention_json: interventionJsonPath,
    intervention_markdown: interventionMarkdownPath,
  },
  memory: promoted.details,
  retrieval: retrieved.details,
  stale_retrieval: staleRetrieved.details,
  guard_decision: guard.details,
  capability_registration: capabilityRegistration.details,
  listed_capabilities: listedCapabilities.details,
  valid_contract: validContract.details,
  incomplete_contract: incompleteContract.details,
  artifact_claim_validation: artifactClaimValidation.details,
  failure_diagnosis: failureDiagnosis.details,
  rerun_context: rerunContext.details,
  intervention: intervention.details,
  imported_memory_pack: imported.details,
  imported_milp_retrieval: importedMilpRetrieved.details,
  imported_paper09_retrieval: importedPaper09Retrieved.details,
  imported_paper24_retrieval: importedPaper24Retrieved.details,
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (!summary.ok) {
  process.exitCode = 1;
}
