import { isRecord } from "./evidence-store.js";
import type {
  ResolvedVerificationProfile,
  TaskContract,
  VerificationProfileRequest,
  VerificationProfileResolution,
} from "./types.js";

type ProfileDefinition = {
  id: string;
  version: number;
  domains: string[];
  analysisTypes: string[];
  metrics: string[];
  claimModes: string[];
  primitiveProfiles: string[];
};

const GENERIC_PROFILE: ProfileDefinition = {
  id: "generic_artifact_consistency_v1",
  version: 1,
  domains: [],
  analysisTypes: [],
  metrics: [],
  claimModes: ["candidate"],
  primitiveProfiles: [],
};

const PROFILE_DEFINITIONS: Record<string, ProfileDefinition> = {
  [GENERIC_PROFILE.id]: GENERIC_PROFILE,
  differential_metric_v1: {
    id: "differential_metric_v1",
    version: 1,
    domains: ["symmetric_cryptanalysis"],
    analysisTypes: ["differential"],
    metrics: ["minimum_differential_weight_or_max_probability"],
    claimModes: ["exact_or_honest_bound", "exact", "bounded"],
    primitiveProfiles: ["simon_family_v1"],
  },
  simon_dl_distinguisher_v1: {
    id: "simon_dl_distinguisher_v1",
    version: 1,
    domains: ["symmetric_cryptanalysis"],
    analysisTypes: ["differential_linear"],
    metrics: [],
    claimModes: ["exact_or_honest_bound", "verified_distinguisher", "bounded"],
    primitiveProfiles: ["simon_family_v1"],
  },
};

const PRIMITIVE_DEFINITIONS: Record<string, { cipherPattern: RegExp }> = {
  simon_family_v1: { cipherPattern: /^simon/i },
};

const FORBIDDEN_REQUEST_FIELDS = ["expected_answer", "oracle", "disabled_checks", "severity_overrides"];

export function resolveVerificationProfile(contract: TaskContract, caseId?: string): VerificationProfileResolution {
  const raw = contract.verification_profile;
  if (raw === undefined) {
    if (normalize(caseId ?? contract.case_id) === "cbsc-v2-hard-simon32-dl-search-002") {
      return resolved(PROFILE_DEFINITIONS.simon_dl_distinguisher_v1, {
        id: "simon_dl_distinguisher_v1",
        primitive_profile: "simon_family_v1",
        claim_mode: "exact_or_honest_bound",
      }, "legacy_case_alias", ["legacy_case_profile_alias"]);
    }
    return resolved(GENERIC_PROFILE, null, "default_generic", ["verification_profile_not_declared"]);
  }
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.trim().length === 0) {
    return failed("verification_profile must be an object with a non-empty id", "invalid");
  }
  const request: VerificationProfileRequest = {
    id: raw.id,
    ...(typeof raw.primitive_profile === "string" ? { primitive_profile: raw.primitive_profile } : {}),
    ...(typeof raw.claim_mode === "string" ? { claim_mode: raw.claim_mode } : {}),
  };
  const definition = PROFILE_DEFINITIONS[request.id];
  if (!definition) {
    return failed(`unknown verification profile: ${request.id}`, "unsupported", request);
  }

  const invalid: string[] = [];
  validateCompatible("domain", contract.domain, definition.domains, invalid);
  validateCompatible("analysis_type", contract.analysis_type, definition.analysisTypes, invalid);
  validateCompatible("metric", contract.metric, definition.metrics, invalid);
  const claimMode = request.claim_mode ?? definition.claimModes[0];
  if (!definition.claimModes.includes(claimMode)) invalid.push(`claim_mode is incompatible with ${definition.id}: ${claimMode}`);
  const primitive = request.primitive_profile ?? null;
  if (primitive && !definition.primitiveProfiles.includes(primitive)) invalid.push(`primitive_profile is incompatible with ${definition.id}: ${primitive}`);
  if (definition.primitiveProfiles.length > 0 && primitive === null) invalid.push(`primitive_profile is required for ${definition.id}`);
  if (primitive && PRIMITIVE_DEFINITIONS[primitive] && !PRIMITIVE_DEFINITIONS[primitive].cipherPattern.test(String(contract.cipher ?? ""))) {
    invalid.push(`primitive_profile is incompatible with cipher: ${primitive}`);
  }

  const warnings = FORBIDDEN_REQUEST_FIELDS.filter((field) => field in raw).map((field) => `ignored_profile_field:${field}`);
  const profile: ResolvedVerificationProfile = {
    id: definition.id,
    version: definition.version,
    primitive_profile: primitive,
    claim_mode: claimMode,
    selection_source: "explicit",
  };
  return { ok: invalid.length === 0, requested: request, profile, invalid_reasons: invalid, unsupported_reasons: [], warnings };
}

export function listVerificationProfileIds(): string[] {
  return Object.keys(PROFILE_DEFINITIONS).sort();
}

function resolved(definition: ProfileDefinition, request: VerificationProfileRequest | null, source: ResolvedVerificationProfile["selection_source"], warnings: string[]): VerificationProfileResolution {
  return {
    ok: true,
    requested: request,
    profile: {
      id: definition.id,
      version: definition.version,
      primitive_profile: request?.primitive_profile ?? null,
      claim_mode: request?.claim_mode ?? definition.claimModes[0],
      selection_source: source,
    },
    invalid_reasons: [],
    unsupported_reasons: [],
    warnings,
  };
}

function failed(reason: string, kind: "invalid" | "unsupported", request: VerificationProfileRequest | null = null): VerificationProfileResolution {
  const fallback = resolved(GENERIC_PROFILE, null, "default_generic", []);
  return {
    ...fallback,
    ok: false,
    requested: request,
    invalid_reasons: kind === "invalid" ? [reason] : [],
    unsupported_reasons: kind === "unsupported" ? [reason] : [],
  };
}

function validateCompatible(field: string, value: unknown, supported: string[], reasons: string[]): void {
  if (supported.length === 0) return;
  if (typeof value !== "string" || value.trim().length === 0) {
    reasons.push(`${field} is required by the verification profile`);
    return;
  }
  if (!supported.includes(value)) reasons.push(`${field} is incompatible with verification profile: ${value}`);
}

function normalize(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}
