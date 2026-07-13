import { isRecord, stableStringify } from "./evidence-store.js";
import type { ArtifactClaimCheck, JsonRecord, TaskContract } from "./types.js";

export function differentialMetricChecks(params: {
  taskContract: TaskContract;
  result: JsonRecord;
  reportText: string;
  sourceText: string;
  readableSourceCount: number;
  primitiveProfile?: string | null;
}): ArtifactClaimCheck[] {
  const { taskContract, result, reportText, sourceText, readableSourceCount, primitiveProfile } = params;
  const corpus = normalize([stableStringify(result), reportText, sourceText].join("\n"));
  const weight = firstNumber(result, ["total_weight", "minimum_differential_weight", "best_weight", "weight"]);
  const probability = parseProbability(firstValue(result, ["probability", "maximum_differential_probability"]));
  const exactClaim = hasStructuredExactIntent(result);
  const inputWords = firstNumberArray(result, ["input_difference_words", "delta_in_words"]);
  const nonzeroInput = inputWords ? inputWords.some((value) => value !== 0) : hasNonzeroDifference(result) || hasNonzeroFirstTrailDifference(result.trail);
  const rounds = firstNumber(taskContract, ["rounds"]);
  const trail = Array.isArray(result.trail) ? result.trail : null;
  const claimType = normalize(result.claim_type);
  const proof = isRecord(result.proof) ? result.proof : {};
  const proofMethod = normalize(proof.method);
  const completeCoverage = isRecord(result.coverage) && normalize(result.coverage.status) === "complete";
  const sourceReference = hasNonEmptyValue(result.source_reference);
  const formalProof = normalize(proof.method) === "formal_proof";
  const exactnessEvidence = normalize(proof.status) === "optimal"
    || formalProof
    || completeCoverage
    || sourceReference;
  const samplingProof = /sampling|random|monte_carlo/.test(proofMethod);
  const simon = primitiveProfile === "simon_family_v1";
  const independentEvidenceForSampling = (formalProof && !samplingProof)
    || hasIndependentCoverage(result.coverage)
    || hasIndependentSourceReference(result.source_reference);
  const zeroClaim = !simon || ((rounds ?? 0) > 1 && nonzeroInput && exactClaim
    && (weight === 0 || probability === 1));
  const model = isRecord(result.model) ? result.model : {};
  const simon32 = isSimon32(taskContract, result);
  const stateWordsValid = model.state_words === undefined ? sourceHasStateWords(sourceText) : numberValue(model.state_words) === 2;
  const wordSizeValid = !simon32 || (model.word_size_bits === undefined ? sourceHasWordSize(sourceText) : numberValue(model.word_size_bits) === 16);
  const rotationsValid = model.rotations === undefined ? sourceHasRotations(sourceText) : rotationsMatch(model.rotations);
  const sourceSupportsModel = sourceHasStateWords(sourceText) || sourceHasWordSize(sourceText) || sourceHasRotations(sourceText);
  const modelInvariants = simon && stateWordsValid && wordSizeValid && rotationsValid && model.exclude_zero_input === true;
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
    check("required_artifacts_readable", Object.keys(result).length > 0 && readableSourceCount > 0, "high", "The profile requires a nonempty structured result and at least one readable source artifact.", `readable_source_count=${readableSourceCount}`),
    check("task_boundary_preserved", taskBoundaryMatches(taskContract, result), "high", "Result metadata must preserve the task Contract boundary."),
    check("scope_boundary_present", scopeMatchesContract(taskContract.scope, result.scope, corpus), "medium", "The artifact scope must be present and must not expand the Contract scope."),
    check("differential_nonzero_input", nonzeroInput, "high", "Differential claims require a nonzero input difference."),
    check("differential_nontrivial_weight", !zeroClaim && (weight !== null || probability !== null), zeroClaim ? "high" : "medium", "Differential claims must provide either weight or probability, and exact multi-round SIMON claims must not report zero weight or probability one for a nonzero input.", weight === null ? undefined : `weight=${weight}`),
    check("probability_weight_consistency", weight === null || probability === null || Math.abs(probability - 2 ** -weight) <= 1e-9, "high", "Probability and weight must agree when both are present."),
    check("probability_semantics_declared", hasNonEmptyValue(result.probability_semantics), "medium", "The probability semantics must be declared in the structured result."),
    check("round_coverage_matches_contract", rounds !== null && numberValue(result.rounds) === rounds && (trail === null || trail.length === rounds), "high", "Reported rounds must match the Contract, and a supplied trail must cover those rounds."),
    check("round_weight_sum_consistency", weight === null || trailWeight === null || Math.abs(trailWeight - weight) <= 1e-9, "medium", "When both are present, per-round weights must sum to the reported total weight."),
    check("exactness_evidence_present", !exactClaim || exactnessEvidence, "medium", "Exact claims require structured proof, complete coverage, or a source reference."),
    check("sampling_not_exact_proof", !(exactClaim && samplingProof && !independentEvidenceForSampling), "medium", "Sampling-based methods cannot alone establish an exact claim."),
    check("method_result_conflict_resolved", conflictResolved, "medium", "Conflicting method weights require a resolution or a bounded/candidate claim."),
    check("primitive_model_invariants", modelInvariants, "high", "SIMON artifacts must declare the required state, word size, rotations, and zero-input exclusion.", sourceSupportsModel ? "source supports state, word-size, and rotations; structured exclusion remains required" : undefined),
    check(
      "simon_and_difference_semantics",
      !simon || !hasInvalidAndDifferenceAbstraction(sourceText),
      "high",
      "SIMON differential models must not encode the AND output difference as the bitwise AND of input differences; use a sound transition relation that preserves state dependence and rotation correlation.",
    ),
    check(
      "simon_and_state_value_linkage",
      !simon || !hasUnlinkedSimonStateValues(sourceText),
      "high",
      "SIMON AND-difference models that introduce actual-state value variables must constrain them to the corresponding rotated state bits; unconstrained values make the transition relation and probability invalid.",
    ),
    check(
      "simon_and_weight_proxy",
      !simon || !hasSimonAndWeightProxy(sourceText),
      "high",
      "SIMON differential weight must come from a sound AND transition probability relation; an objective that counts any active AND input difference as weight is not a valid probability model.",
    ),
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

function hasNonzeroFirstTrailDifference(trail: unknown): boolean {
  if (!Array.isArray(trail) || !isRecord(trail[0])) return false;
  return hasNonzeroDifference(trail[0]);
}

function hasNonzeroDifference(record: JsonRecord): boolean {
  return Object.entries(record)
    .filter(([key]) => isDifferenceField(key))
    .some(([, value]) => containsNonzeroDifferenceValue(value));
}

function isDifferenceField(key: string): boolean {
  return ["input_difference_words", "delta_in_words", "input_difference", "delta_in", "input_diff", "dx", "dy", "dl", "dr"]
    .some((field) => key.toLowerCase() === field || key.toLowerCase() === `${field}_int`);
}

function containsNonzeroDifferenceValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsNonzeroDifferenceValue);
  const numeric = numberValue(value);
  return numeric !== null && numeric !== 0;
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
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    for (const key of ["weight", "best_weight", "verified_weight"]) {
      const number = numberValue(value[key]);
      if (number !== null) weights.add(number);
    }
    for (const nested of Object.values(value)) visit(nested);
  };
  const entries = Array.isArray(methods) ? methods : isRecord(methods) ? Object.values(methods) : [];
  for (const entry of entries) visit(entry);
  return weights;
}

function hasStructuredExactIntent(result: JsonRecord): boolean {
  return [result.claim_type, result.status].some((value) => {
    const intent = normalize(value);
    return intent === "exact" || intent === "optimal" || intent === "verified";
  });
}

function rotationsMatch(value: unknown): boolean {
  return Array.isArray(value) && value.length === 3 && value.every((item, index) => numberValue(item) === [1, 8, 2][index]);
}

function sourceHasRotations(sourceText: string): boolean {
  const source = normalize(sourceText);
  return /(?:rotations?|simon_rotations?)\s*=\s*[\[(]\s*1\s*,\s*8\s*,\s*2\s*[\])]/.test(source);
}

function sourceHasWordSize(sourceText: string): boolean {
  return /(?:word_size|word_size_bits|word size)\s*=\s*16\b/.test(normalize(sourceText));
}

function sourceHasStateWords(sourceText: string): boolean {
  return /(?:state_words|state words)\s*=\s*2\b/.test(normalize(sourceText));
}

function hasInvalidAndDifferenceAbstraction(sourceText: string): boolean {
  const source = normalize(sourceText);
  const variable = (name: string) => `\\b${name}(?:\\s*\\[[^\\]\\r\\n]+\\])?`;
  const gamma = variable("gamma");
  const alpha = variable("alpha");
  const beta = variable("beta");
  return new RegExp(`${gamma}\\s*(?:=|:=)\\s*${alpha}\\s*(?:&|\\band\\b)\\s*${beta}`).test(source)
    || (new RegExp(`${gamma}\\s*<=\\s*${alpha}`).test(source)
    && new RegExp(`${gamma}\\s*<=\\s*${beta}`).test(source)
    && new RegExp(`${gamma}\\s*>=\\s*${alpha}\\s*\\+\\s*${beta}\\s*-\\s*1\\b`).test(source));
}

function hasUnlinkedSimonStateValues(sourceText: string): boolean {
  const source = normalize(sourceText);
  const declaresValueVariables = /\bu\s*=\s*\{\}/.test(source) && /\bv\s*=\s*\{\}/.test(source);
  const admitsTheyAreUnconstrained = source.includes("don't constrain the actual values")
    || source.includes("do not constrain the actual values");
  return declaresValueVariables && admitsTheyAreUnconstrained;
}

function hasSimonAndWeightProxy(sourceText: string): boolean {
  const source = normalize(sourceText);
  const variable = (name: string) => `\\b${name}(?:\\s*\\[[^\\]\\r\\n]+\\])?`;
  const weight = variable("weight");
  const inputOne = variable("and_in1");
  const inputTwo = variable("and_in2");
  const boundsBothInputs = new RegExp(`${weight}\\s*>=\\s*${inputOne}`).test(source)
    && new RegExp(`${weight}\\s*>=\\s*${inputTwo}`).test(source);
  const objectiveCountsWeight = new RegExp(`lpsum\\s*\\(\\s*\\[?\\s*${weight}`).test(source);
  return boundsBothInputs && objectiveCountsWeight;
}

function isSimon32(contract: TaskContract, result: JsonRecord): boolean {
  return normalize(result.cipher || contract.cipher).includes("simon32");
}

function hasNonEmptyValue(value: unknown): boolean {
  return (typeof value === "string" && value.trim().length > 0) || (isRecord(value) && Object.keys(value).length > 0);
}

function hasIndependentCoverage(value: unknown): boolean {
  return isRecord(value)
    && normalize(value.status) === "complete"
    && normalize(value.method) === "exhaustive"
    && value.independent_from_sampling === true;
}

function hasIndependentSourceReference(value: unknown): boolean {
  if (!isRecord(value) || value.independent !== true) return false;
  const kind = normalize(value.kind ?? value.source_type);
  const recognizedKind = kind === "literature" || kind === "independent_reproduction";
  return recognizedKind && hasNonEmptyValue(value.locator ?? value.citation);
}

function scopeMatchesContract(contractScope: unknown, resultScope: unknown, corpus: string): boolean {
  if (typeof contractScope !== "string" || contractScope.trim().length === 0) return hasNonEmptyValue(resultScope);
  if (typeof resultScope !== "string" || resultScope.trim().length === 0) return corpus.includes(normalize(contractScope));
  const contract = normalizeScope(contractScope);
  const result = normalizeScope(resultScope);
  if (contract === "reducedround") return result.includes("reducedround") && !result.includes("fullround") && !result.includes("fullcipher");
  return result === contract;
}

function normalizeScope(value: unknown): string {
  return normalize(value).replace(/[\s_-]/g, "");
}

function normalize(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}
