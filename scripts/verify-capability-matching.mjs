import { existsSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(packageRoot, "dist");
const outputDir = join(packageRoot, "smoke-output", "capability-matching");
const evidenceDir = join(outputDir, "evidence");

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
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const contractValidatorUrl = pathToFileURL(join(distRoot, "contract-validator.js")).href;
const routerUrl = pathToFileURL(join(distRoot, "router.js")).href;
const registryUrl = pathToFileURL(join(distRoot, "tool-capability-registry.js")).href;

const { validateTaskContract } = await import(`${contractValidatorUrl}?verify=${Date.now()}`);
const { decideGuardRoute } = await import(`${routerUrl}?verify=${Date.now()}`);
const { registerToolCapability } = await import(`${registryUrl}?verify=${Date.now()}`);

resetDirectory(outputDir);

const taskContract = {
  domain: "differential-linear cryptanalysis",
  cipher: "Simon32/64",
  analysis_type: "differential-linear",
  method: "MILP",
  objective: "Find and verify 14-round differential-linear distinguisher for Simon32/64",
  scope: "14-round",
  target: "14-round Simon32/64 DL distinguisher",
  constraints: {
    block_size: 32,
    key_size: 64,
    total_rounds: 32,
  },
  deliverables: [
    "executable code",
    "run log with exit status and timing",
    "machine-readable result JSON",
    "input difference",
    "output linear mask",
    "round split",
    "correlation/weight",
    "verification",
    "final report",
  ],
};

const boundedRerunCapability = {
  description: "Bounded staged search for 14-round differential-linear distinguishers of Simon32/64 using MILP trail analysis and FWHT-based empirical correlation measurement with hard per-phase limits and progress logging",
  methods: ["MILP", "FWHT", "bounded_search", "monte_carlo"],
  parameters: {
    block_size: 32,
    key_size: 64,
    nrounds: 14,
    total_rounds: 32,
  },
  phases: [
    {
      name: "cipher_and_differential_analysis",
      scope: "forward 7-round differential trails",
      limit_seconds: 10,
    },
    {
      name: "linear_analysis",
      scope: "backward 7-round linear trails",
      limit_seconds: 30,
    },
    {
      name: "fwht_verification",
      scope: "empirical correlation with FWHT, capped at 2^16 samples",
      limit_seconds: 60,
    },
    {
      name: "multi_key_check",
      scope: "average correlation across 3 random keys",
      limit_seconds: 20,
    },
  ],
  output: {
    input_difference: "hex 16-bit",
    output_linear_mask: "hex 16-bit",
    correlation: "float in [-1,1]",
    weight: "float (-log2|corr|)",
    verification_status: "verified|candidate|bounded_failure",
  },
  output_files: [
    "simon32_dl_bounded_rerun.py",
    "result.json",
    "run_log.txt",
    "final_answer.md",
  ],
  output_artifacts: [
    "input_difference (hex 16-bit)",
    "output_linear_mask (hex 16-bit)",
    "round_split (rd + rl = 14)",
    "empirical_correlation (float in [-1,1])",
    "empirical_weight (float, -2*log2|corr|)",
    "multi_key_verification_results (array of {key, correlation, weight})",
  ],
  hard_limits: {
    max_runtime_seconds: 120,
    fwht_samples_max: 65536,
    top_candidates_verified: 3,
  },
  limitations: [
    "Linear trail MILP may overcount weight due to mask explosion through AND",
    "Correlations below noise floor cannot be reliably verified by sampling",
    "Results are key-dependent; average across keys is near noise floor",
  ],
};

const registeredCapability = registerToolCapability({
  tool_name: "simon32_dl_search",
  capability: boundedRerunCapability,
  evidence_dir: evidenceDir,
});

const validation = validateTaskContract({
  task_contract: taskContract,
  require_matching_tool: true,
  evidence_dir: evidenceDir,
});

const guardFromRegisteredRecord = decideGuardRoute({
  requested_tool: "simon32_dl_search",
  guard_mode: "post_repair",
  task_contract: taskContract,
  tool_capability: registeredCapability,
  compare_fields: ["method", "analysis_type", "domain", "scope", "deliverables"],
});

const guardFromNestedCapability = decideGuardRoute({
  requested_tool: "simon32_dl_search",
  guard_mode: "post_repair",
  task_contract: taskContract,
  tool_capability: {
    tool_name: "simon32_dl_search",
    capability: boundedRerunCapability,
  },
  compare_fields: ["method", "analysis_type", "domain", "scope", "deliverables"],
});

const hardMismatch = decideGuardRoute({
  requested_tool: "unrelated_tool",
  guard_mode: "post_repair",
  task_contract: taskContract,
  tool_capability: {
    description: "Toy heuristic for AES S-box enumeration",
    methods: ["heuristic"],
    parameters: {
      total_rounds: 4,
    },
  },
  compare_fields: ["method", "analysis_type", "domain", "scope"],
});

assert(validation.status === "valid_contract", `expected valid_contract, got ${validation.status}: ${validation.reasons.join("; ")}`);
assert(validation.matching_tools.includes("simon32_dl_search"), "expected simon32_dl_search to support the task contract");
assert(guardFromRegisteredRecord.decision === "allow", `expected guard allow from registered record, got ${guardFromRegisteredRecord.decision}: ${guardFromRegisteredRecord.reasons.join("; ")}`);
assert(guardFromRegisteredRecord.reasons.length === 0, `expected no registered-record mismatch reasons, got ${guardFromRegisteredRecord.reasons.join("; ")}`);
assert(guardFromNestedCapability.decision === "allow", `expected guard allow from nested capability, got ${guardFromNestedCapability.decision}: ${guardFromNestedCapability.reasons.join("; ")}`);
assert(guardFromNestedCapability.reasons.length === 0, `expected no nested-capability mismatch reasons, got ${guardFromNestedCapability.reasons.join("; ")}`);
assert(hardMismatch.decision === "post_repair_required", `expected hard mismatch to require repair, got ${hardMismatch.decision}`);
assert(hardMismatch.reasons.length > 0, "expected unrelated tool to produce mismatch reasons");

process.stdout.write(`${JSON.stringify({
  ok: true,
  validation,
  guard_from_registered_record: guardFromRegisteredRecord,
  guard_from_nested_capability: guardFromNestedCapability,
  hard_mismatch: hardMismatch,
}, null, 2)}\n`);
