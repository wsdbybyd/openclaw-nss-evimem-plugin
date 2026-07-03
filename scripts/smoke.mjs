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
const records = readJsonl(toolCallsPath);
const index = readJson(evidenceIndexPath);
const memories = readJson(memoryPath);
const guardEvents = readJsonl(guardEventsPath);
const retrievedDetails = retrieved.details;
const staleDetails = staleRetrieved.details;
const guardDetails = guard.details;
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
  },
  memory: promoted.details,
  retrieval: retrieved.details,
  stale_retrieval: staleRetrieved.details,
  guard_decision: guard.details,
  imported_memory_pack: imported.details,
  imported_milp_retrieval: importedMilpRetrieved.details,
  imported_paper09_retrieval: importedPaper09Retrieved.details,
  imported_paper24_retrieval: importedPaper24Retrieved.details,
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (!summary.ok) {
  process.exitCode = 1;
}
