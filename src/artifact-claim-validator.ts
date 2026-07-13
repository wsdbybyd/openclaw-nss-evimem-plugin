import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { getEvidenceDir, isRecord, stableStringify, utcNow } from "./evidence-store.js";
import { differentialMetricChecks } from "./differential-metric-profile.js";
import { resolveVerificationProfile, sanitizeTaskContract } from "./verification-profile-registry.js";
import type {
  ArtifactClaimCheck,
  JsonRecord,
  PluginHookToolContext,
  RecommendedClaimLevel,
  ResolvedVerificationProfile,
  TaskContract,
  VerificationProfileResolution,
} from "./types.js";

export type ArtifactClaimValidationResult = {
  schema: "nss_evimem.artifact_claim_validation.v2";
  timestamp: string;
  case_id: string;
  status: "passed" | "failed" | "warning";
  ok: boolean;
  supports_verified_claim: boolean;
  verification_profile: ResolvedVerificationProfile;
  verification_scope: "evidence_eligibility_not_oracle_correctness";
  recommended_claim_level: RecommendedClaimLevel;
  task_contract: TaskContract;
  checks: ArtifactClaimCheck[];
  failures: string[];
  warnings: string[];
  output_files: {
    artifact_claim_validation: string;
    artifact_claim_validation_events: string;
  };
  source_files: {
    result_path: string | null;
    report_path: string | null;
    source_paths: string[];
  };
};

export function validateArtifactClaims(params: {
  case_id?: string;
  task_contract?: TaskContract;
  result?: JsonRecord;
  result_path?: string;
  report_text?: string;
  report_path?: string;
  source_paths?: string[];
  ctx?: PluginHookToolContext;
  evidence_dir?: string;
}): ArtifactClaimValidationResult {
  const sanitization = sanitizeTaskContract(params.task_contract ?? {});
  const taskContract = sanitization.task_contract;
  const caseId = params.case_id ?? stringValue(taskContract.case_id) ?? "generic";
  const profileResolution = resolveVerificationProfile(taskContract, caseId);
  const evidenceDir = getEvidenceDir(params.ctx, params.evidence_dir);
  mkdirSync(evidenceDir, { recursive: true });

  const resultPath = optionalExistingPath(params.result_path);
  const reportPath = optionalExistingPath(params.report_path);
  const sourcePaths = (params.source_paths ?? []).map((path) => resolve(path));
  const loadedResult = readJsonArtifact(resultPath);
  const result = params.result ?? loadedResult.result;
  const reportText = [params.report_text, readTextIfPresent(reportPath)].filter(Boolean).join("\n");
  const readableSources = sourcePaths.map((path) => readTextIfPresent(path)).filter(Boolean);
  const sourceText = readableSources.join("\n");

  const checks: ArtifactClaimCheck[] = [
    ...genericChecks(result, reportText),
    ...profileWarningChecks([...sanitization.warnings, ...profileResolution.warnings]),
  ];
  if (params.result_path && loadedResult.error) {
    checks.push({
      id: "result_artifact_readable",
      status: "fail",
      severity: "high",
      reason: "The structured result artifact must exist and contain a JSON object.",
      evidence: loadedResult.error,
    });
  }
  if (profileResolution.profile.id === "differential_metric_v1") {
    checks.push(...differentialMetricChecks({
      taskContract,
      result,
      reportText,
      sourceText,
      readableSourceCount: readableSources.length,
      primitiveProfile: profileResolution.profile.primitive_profile,
    }));
  } else if (profileResolution.profile.id === "simon_dl_distinguisher_v1") {
    checks.push(...simonDlChecks(taskContract, result, reportText, sourceText));
  } else {
    checks.push({
      id: "case_specific_rules",
      status: "not_applicable",
      severity: "low",
      reason: "No case-specific artifact rules apply to this task.",
    });
  }
  const failures = checks.filter((check) => check.status === "fail").map((check) => check.id);
  const warnings = checks.filter((check) => check.status === "warn").map((check) => check.id);
  const profileCanVerify = profileResolution.ok
    && profileResolution.profile.selection_source !== "default_generic"
    && profileResolution.profile.id !== "generic_artifact_consistency_v1";
  const processSupportsVerifiedClaim = failures.length === 0 && profileCanVerify;
  const claimLevelCap = maximumClaimLevel(result, reportText, profileResolution);
  const supportsVerifiedClaim = processSupportsVerifiedClaim && claimLevelCap === "verified";
  const recommendedClaimLevel = recommendClaimLevel(checks, profileResolution, supportsVerifiedClaim, claimLevelCap);
  const status = failures.length > 0 ? "failed" : warnings.length > 0 ? "warning" : "passed";

  const validationPath = join(evidenceDir, "artifact_claim_validation.json");
  const eventsPath = join(evidenceDir, "artifact_claim_validation_events.jsonl");
  const resultRecord: ArtifactClaimValidationResult = {
    schema: "nss_evimem.artifact_claim_validation.v2",
    timestamp: utcNow(),
    case_id: caseId,
    status,
    ok: supportsVerifiedClaim,
    supports_verified_claim: supportsVerifiedClaim,
    verification_profile: profileResolution.profile,
    verification_scope: "evidence_eligibility_not_oracle_correctness",
    recommended_claim_level: recommendedClaimLevel,
    task_contract: taskContract,
    checks,
    failures,
    warnings,
    output_files: {
      artifact_claim_validation: validationPath,
      artifact_claim_validation_events: eventsPath,
    },
    source_files: {
      result_path: resultPath,
      report_path: reportPath,
      source_paths: sourcePaths,
    },
  };

  writeFileSync(validationPath, stableStringify(resultRecord, 2), "utf8");
  appendFileSync(eventsPath, `${stableStringify(resultRecord)}\n`, "utf8");
  return resultRecord;
}

function genericChecks(result: JsonRecord, reportText: string): ArtifactClaimCheck[] {
  const checks: ArtifactClaimCheck[] = [];
  const resultText = normalizeText(stableStringify(result));
  const report = normalizeText(reportText);

  const saysNoVerified = resultText.includes("no verified")
    || resultText.includes("no_distinguisher")
    || report.includes("no verified");
  const saysDistinguishable = resultText.includes("\"distinguishable\":true")
    || resultText.includes("\"distinguishable\": true");
  checks.push(check(
    "result_claim_consistency",
    !(saysNoVerified && saysDistinguishable),
    "high",
    "Result artifacts must not simultaneously mark a candidate distinguishable and conclude no verified distinguisher.",
    saysNoVerified && saysDistinguishable ? "distinguishable=true conflicts with no verified/no_distinguisher wording" : undefined,
  ));

  const totalTime = numberValue(result.total_time_s);
  checks.push(check(
    "runtime_duration_sane",
    totalTime === null || (totalTime >= 0 && totalTime <= 24 * 60 * 60),
    "medium",
    "Runtime duration fields should be elapsed seconds, not wall-clock timestamps.",
    totalTime === null ? undefined : `total_time_s=${totalTime}`,
  ));

  return checks;
}

function profileWarningChecks(warnings: string[]): ArtifactClaimCheck[] {
  return [...new Set(warnings)].map((warning) => ({
    id: warning,
    status: "warn" as const,
    severity: "low" as const,
    reason: `Verification profile warning: ${warning}.`,
  }));
}

function recommendClaimLevel(
  checks: ArtifactClaimCheck[],
  profileResolution: VerificationProfileResolution,
  supportsVerifiedClaim: boolean,
  maximumLevel: RecommendedClaimLevel,
): RecommendedClaimLevel {
  if (supportsVerifiedClaim) return "verified";
  const failures = new Set(checks.filter((item) => item.status === "fail").map((item) => item.id));
  let processLevel: RecommendedClaimLevel;
  if ([
    "result_claim_consistency",
    "result_artifact_readable",
    "task_boundary_preserved",
    "differential_nonzero_input",
    "differential_nontrivial_weight",
    "probability_weight_consistency",
    "primitive_model_invariants",
    "simon_and_difference_semantics",
    "simon_and_state_value_linkage",
    "simon_and_weight_proxy",
  ].some((id) => failures.has(id))) processLevel = "reject";
  else if (["exactness_evidence_present", "sampling_not_exact_proof", "method_result_conflict_resolved"]
    .some((id) => failures.has(id))) processLevel = "bounded";
  else if (failures.size > 0 || profileResolution.profile.selection_source === "default_generic") processLevel = "candidate";
  else processLevel = "verified";
  return weakerClaimLevel(processLevel, maximumLevel);
}

function maximumClaimLevel(
  result: JsonRecord,
  reportText: string,
  profileResolution: VerificationProfileResolution,
): RecommendedClaimLevel {
  const claimType = normalizeText(result.claim_type);
  if (claimType === "candidate") return "candidate";
  if (claimType === "bound" || claimType === "bounded" || profileResolution.profile.claim_mode === "bounded") return "bounded";
  if (profileResolution.profile.id === "simon_dl_distinguisher_v1" && claimType === "verified_distinguisher") return "verified";
  if (profileResolution.profile.id === "generic_artifact_consistency_v1") return "candidate";
  if (claimType !== "exact" && claimType !== "optimal" && claimType !== "verified") return "candidate";
  const corpus = normalizeText([stableStringify(result), reportText].join("\n"));
  if (corpus.includes("no verified") || corpus.includes("not verified")) return corpus.includes("candidate") ? "candidate" : "bounded";
  return "verified";
}

function weakerClaimLevel(left: RecommendedClaimLevel, right: RecommendedClaimLevel): RecommendedClaimLevel {
  const rank: Record<RecommendedClaimLevel, number> = { reject: 0, candidate: 1, bounded: 2, verified: 3 };
  return rank[left] <= rank[right] ? left : right;
}

function simonDlChecks(
  taskContract: TaskContract,
  result: JsonRecord,
  reportText: string,
  sourceText: string,
): ArtifactClaimCheck[] {
  const corpus = normalizeText([stableStringify(result), reportText, sourceText].join("\n"));
  const source = normalizeText(sourceText);
  return [
    check(
      "simon32_round_function_uses_key",
      /\^\s*(round_keys|keys|rk)\s*\[\s*i\s*\]/i.test(sourceText)
        || /\^\s*(key_word|key)\b/i.test(sourceText),
      "high",
      "Simon32/64 encryption evidence must show each round xors the round key.",
      sourceText ? undefined : "no source text supplied",
    ),
    check(
      "simon32_key_schedule_constant",
      source.includes("0xfffc") && !/\bc\s*=\s*3\b/i.test(sourceText),
      "high",
      "Simon32/64 key schedule must use c=0xfffc rather than the small constant 3.",
      source.includes("c = 3") || source.includes("c=3") ? "source contains c = 3" : undefined,
    ),
    check(
      "simon32_full_state_pair",
      hasFullStatePair(result, corpus),
      "high",
      "The reported Delta_in and Gamma_out must be full 32-bit/two-word state values.",
    ),
    check(
      "simon32_required_decompositions",
      hasRequiredDecompositions(corpus),
      "high",
      "The artifact should compare or explicitly discuss (5,5,4), (5,6,3), and (7,3,4).",
    ),
    check(
      "dl_signed_sum_measurement",
      corpus.includes("signed_sum")
        || corpus.includes("signed sum")
        || corpus.includes("2*pr")
        || corpus.includes("2 * pr")
        || corpus.includes("signed-sum"),
      "high",
      "Differential-linear measurement should use signed-sum or an equivalent c=2*Pr[parity=0]-1 formula.",
    ),
  ];
}

function check(
  id: string,
  passed: boolean,
  severity: ArtifactClaimCheck["severity"],
  reason: string,
  evidence?: string,
): ArtifactClaimCheck {
  return {
    id,
    status: passed ? "pass" : "fail",
    severity,
    reason,
    ...(evidence ? { evidence } : {}),
  };
}

function hasFullStatePair(result: JsonRecord, corpus: string): boolean {
  if (Array.isArray(result.delta_in_words) && result.delta_in_words.length === 2
    && Array.isArray(result.gamma_out_words) && result.gamma_out_words.length === 2) {
    return true;
  }
  if (typeof result.delta_in_32bit === "string" && /^0x[0-9a-f]{8}$/i.test(result.delta_in_32bit)
    && typeof result.gamma_out_32bit === "string" && /^0x[0-9a-f]{8}$/i.test(result.gamma_out_32bit)) {
    return true;
  }
  return corpus.includes("delta_in_words")
    && corpus.includes("gamma_out_words")
    && countHexWords(corpus) >= 4;
}

function hasRequiredDecompositions(corpus: string): boolean {
  return hasSplit(corpus, 5, 5, 4)
    && hasSplit(corpus, 5, 6, 3)
    && hasSplit(corpus, 7, 3, 4);
}

function hasSplit(corpus: string, a: number, b: number, c: number): boolean {
  return corpus.includes(`(${a},${b},${c})`)
    || corpus.includes(`(${a}, ${b}, ${c})`)
    || corpus.includes(`[${a},${b},${c}]`)
    || corpus.includes(`[${a}, ${b}, ${c}]`)
    || corpus.includes(`${a}+${b}+${c}`);
}

function countHexWords(text: string): number {
  return (text.match(/0x[0-9a-f]{4}/g) ?? []).length;
}

function readJsonArtifact(path: string | null): { result: JsonRecord; error: string | null } {
  if (!path) return { result: {}, error: null };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed)
      ? { result: parsed, error: null }
      : { result: {}, error: "result artifact root must be an object" };
  } catch (error) {
    return { result: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

function readTextIfPresent(path: string | null): string {
  if (!path || !existsSync(path)) {
    return "";
  }
  return readFileSync(path, "utf8");
}

function optionalExistingPath(path: string | undefined): string | null {
  if (!path || path.trim().length === 0) {
    return null;
  }
  return resolve(path);
}

function normalizeText(value: unknown): string {
  return String(value ?? "").toLowerCase();
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
