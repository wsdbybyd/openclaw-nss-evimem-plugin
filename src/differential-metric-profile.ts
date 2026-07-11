import { isRecord, stableStringify } from "./evidence-store.js";
import type { ArtifactClaimCheck, JsonRecord, TaskContract } from "./types.js";

export function differentialMetricChecks(params: {
  taskContract: TaskContract;
  result: JsonRecord;
  reportText: string;
  sourceText: string;
  readableSourceCount: number;
}): ArtifactClaimCheck[] {
  const { taskContract, result, reportText, sourceText, readableSourceCount } = params;
  const corpus = normalize([stableStringify(result), reportText, sourceText].join("\n"));
  const weight = firstNumber(result, ["total_weight", "minimum_differential_weight", "best_weight", "weight"]);
  const probability = parseProbability(firstValue(result, ["probability", "maximum_differential_probability"]));
  const exactClaim = ["optimal", "exact", "verified"].some((token) => corpus.includes(token));
  const inputWords = firstNumberArray(result, ["input_difference_words", "delta_in_words"]);
  const nonzeroInput = inputWords ? inputWords.some((value) => value !== 0) : hasNonzeroFirstTrailState(result.trail);
  const rounds = firstNumber(taskContract, ["rounds"]);
  const trail = Array.isArray(result.trail) ? result.trail : null;
  const claimType = normalize(result.claim_type);
  const proof = isRecord(result.proof) ? result.proof : {};
  const proofMethod = normalize(proof.method);
  const exactnessEvidence = normalize(proof.status) === "optimal"
    || normalize(proof.method) === "formal_proof"
    || (isRecord(result.coverage) && normalize(result.coverage.status) === "complete")
    || hasNonEmptyValue(result.source_reference);
  const samplingProof = /sampling|random|monte_carlo/.test(proofMethod);
  const simon = normalize(taskContract.cipher).startsWith("simon");
  const zeroClaim = simon && (rounds ?? 0) > 1 && nonzeroInput && exactClaim
    && (weight === 0 || probability === 1);
  const requiredArtifacts = Array.isArray(taskContract.required_artifacts)
    ? taskContract.required_artifacts.filter((item) => typeof item === "string")
    : [];
  const model = isRecord(result.model) ? result.model : {};
  const structuredModelCore = (
    numberValue(model.state_words) === 2
    && (isSimon32(taskContract, result) ? numberValue(model.word_size_bits) === 16 : true)
    && rotationsMatch(model.rotations)
  );
  const sourceSupportsModel = sourceModelInvariants(sourceText, isSimon32(taskContract, result));
  const modelInvariants = !simon || ((structuredModelCore || sourceSupportsModel) && model.exclude_zero_input === true);
  const methodValues = collectMethodWeights(result.methods);
  const conflictResolved = methodValues.size <= 1
    || hasNonEmptyValue(result.conflict_resolution)
    || claimType === "bound"
    || claimType === "candidate";
  const trailWeight = trail ? trail.reduce<number | null>((sum, entry) => {
    const entryWeight = isRecord(entry) ? firstNumber(entry, ["weight"]) : null;
    return sum === null || entryWeight === null ? null : sum + entryWeight;
  }, 0) : null;

  return [
    check("required_artifacts_readable", requiredArtifacts.length === 0 || readableSourceCount >= requiredArtifacts.length, "high", "Required source artifacts must be readable.", `readable_source_count=${readableSourceCount}`),
    check("task_boundary_preserved", taskBoundaryMatches(taskContract, result), "high", "Result metadata must preserve the task Contract boundary."),
    check("scope_boundary_present", hasNonEmptyValue(result.scope) || (typeof taskContract.scope === "string" && corpus.includes(normalize(taskContract.scope))), "medium", "The artifact must declare the analysis scope."),
    check("differential_nonzero_input", nonzeroInput, "high", "Differential claims require a nonzero input difference."),
    check("differential_nontrivial_weight", !zeroClaim && weight !== null, zeroClaim ? "high" : "medium", "Exact multi-round SIMON claims must not report a zero weight or probability one for a nonzero input.", weight === null ? "no structured weight found" : `weight=${weight}`),
    check("probability_weight_consistency", weight !== null && probability !== null && Math.abs(probability - 2 ** -weight) <= 1e-9, "high", "Probability must equal 2 ** -weight within tolerance."),
    check("probability_semantics_declared", hasNonEmptyValue(result.probability_semantics), "medium", "The probability semantics must be declared in the structured result."),
    check("round_coverage_matches_contract", rounds !== null && numberValue(result.rounds) === rounds && trail !== null && trail.length === rounds, "high", "Reported rounds and trail coverage must match the Contract."),
    check("round_weight_sum_consistency", weight !== null && trailWeight !== null && Math.abs(trailWeight - weight) <= 1e-9, "medium", "Per-round weights must sum to the reported total weight."),
    check("exactness_evidence_present", !exactClaim || exactnessEvidence, "medium", "Exact claims require structured proof, complete coverage, or a source reference."),
    check("sampling_not_exact_proof", !(exactClaim && samplingProof), "medium", "Sampling-based methods cannot alone establish an exact claim."),
    check("method_result_conflict_resolved", conflictResolved, "medium", "Conflicting method weights require a resolution or a bounded/candidate claim."),
    check("primitive_model_invariants", modelInvariants, "high", "SIMON artifacts must declare the required state, word size, rotations, and zero-input exclusion.", sourceSupportsModel ? "source supports state, word-size, and rotations; structured exclusion remains required" : undefined),
  ];
}

function check(id: string, passed: boolean, severity: ArtifactClaimCheck["severity"], reason: string, evidence?: string): ArtifactClaimCheck {
  return { id, status: passed ? "pass" : "fail", severity, reason, ...(evidence ? { evidence } : {}) };
}

function firstValue(record: JsonRecord, keys: string[]): unknown {
  for (const key of keys) if (record[key] !== undefined) return record[key];
  return undefined;
}

function firstNumber(record: JsonRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = numberValue(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstNumberArray(record: JsonRecord, keys: string[]): number[] | null {
  for (const key of keys) {
    if (Array.isArray(record[key])) {
      const values = record[key].map(numberValue);
      if (values.every((value): value is number => value !== null)) return values;
    }
  }
  return null;
}

function parseProbability(value: unknown): number | null {
  const numeric = numberValue(value);
  if (numeric !== null) return numeric;
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^2\^\s*(?:\(\s*)?\{?\s*(-?\d+(?:\.\d+)?)\s*\}?(?:\s*\))?$/);
  return match ? 2 ** Number(match[1]) : null;
}

function hasNonzeroFirstTrailState(trail: unknown): boolean {
  if (!Array.isArray(trail) || !isRecord(trail[0])) return false;
  return containsNonzeroNumber(trail[0]);
}

function containsNonzeroNumber(value: unknown): boolean {
  if (typeof value === "number") return value !== 0;
  if (Array.isArray(value)) return value.some(containsNonzeroNumber);
  if (isRecord(value)) return Object.entries(value)
    .filter(([key]) => /input|delta|state|difference/i.test(key))
    .some(([, nested]) => containsNonzeroNumber(nested));
  return false;
}

function taskBoundaryMatches(contract: TaskContract, result: JsonRecord): boolean {
  for (const field of ["cipher", "rounds", "analysis_type", "metric"] as const) {
    if (contract[field] !== undefined && normalize(contract[field]) !== normalize(result[field])) return false;
  }
  return true;
}

function collectMethodWeights(methods: unknown): Set<number> {
  const weights = new Set<number>();
  const visit = (value: unknown): void => {
    if (!isRecord(value)) return;
    for (const key of ["weight", "best_weight", "verified_weight"]) {
      const number = numberValue(value[key]);
      if (number !== null) weights.add(number);
    }
    for (const nested of Object.values(value)) visit(nested);
  };
  if (isRecord(methods)) for (const entry of Object.values(methods)) visit(entry);
  return weights;
}

function rotationsMatch(value: unknown): boolean {
  return Array.isArray(value) && value.length === 3 && value.every((item, index) => numberValue(item) === [1, 8, 2][index]);
}

function sourceModelInvariants(sourceText: string, simon32: boolean): boolean {
  const source = normalize(sourceText);
  return /(?:rotations?|simon_rotations?)\s*=\s*[\[(]\s*1\s*,\s*8\s*,\s*2\s*[\])]/.test(source)
    && (!simon32 || /(?:word_size|word_size_bits|word size)\s*=\s*16\b/.test(source))
    && /(?:state_words|state words)\s*=\s*2\b/.test(source);
}

function isSimon32(contract: TaskContract, result: JsonRecord): boolean {
  return normalize(result.cipher || contract.cipher).includes("simon32");
}

function hasNonEmptyValue(value: unknown): boolean {
  return (typeof value === "string" && value.trim().length > 0) || (isRecord(value) && Object.keys(value).length > 0);
}

function normalize(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}
