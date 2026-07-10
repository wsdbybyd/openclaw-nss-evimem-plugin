# Verification Profile Claim Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add versioned Task Contract verification profiles so NSS-EviMem can reject structurally untrustworthy differential-metric claims without embedding benchmark oracle answers.

**Architecture:** A profile registry resolves and validates the Agent-selected `verification_profile`; the Task Contract validator checks compatibility, while the artifact validator dispatches to profile-specific public-process checks. The NL-X01 experiment continues to compare the answer with the hidden oracle only in its offline evaluator, so artifact eligibility and benchmark correctness remain independent gates.

**Tech Stack:** TypeScript 5.4, Node.js 20 ESM, Node built-in `node:test`, OpenClaw plugin tools, JSON/Markdown experiment artifacts.

---

## File Map

- Create `src/verification-profile-registry.ts`: own profile definitions, primitive definitions, legacy alias resolution, and Contract/profile compatibility checks.
- Create `src/differential-metric-profile.ts`: implement public-process checks for differential probability/weight artifacts.
- Modify `src/types.ts`: define profile request/resolution, check, validation, and claim-level types.
- Modify `src/contract-validator.ts`: reject unknown or incompatible profiles and record the resolved profile in validation results.
- Modify `src/artifact-claim-validator.ts`: perform safe artifact loading, dispatch profile checks, emit schema v2, and recommend a claim level.
- Modify `src/index.ts`: describe the profile-aware tool contract without exposing oracle fields.
- Create `test/verification-profiles.test.mjs`: provide regression and behavior tests against compiled plugin modules.
- Modify `scripts/smoke.mjs`: preserve legacy SIMON DL coverage and assert schema-v2 compatibility fields.
- Modify `README.md`: document profile selection, claim-level meaning, and the oracle boundary.
- Modify `experiments/CBSC-V2-NL-X01/run_openclaw_all_groups_experiment.mjs`: add the differential profile to the shared Task Contract.
- Modify `experiments/CBSC-V2-NL-X01/verify_openclaw_all_groups_experiment.mjs`: verify schema v2 and profile/oracle separation.

Do not modify or stage `experiments/**/runs/`, existing reports, or unrelated dirty files. `package.json` already contains unrelated uncommitted experiment aliases, so this plan runs the test command directly instead of editing that file.

### Task 1: Add Failing Profile and Artifact Regression Tests

**Files:**
- Create: `test/verification-profiles.test.mjs`
- Test: `test/verification-profiles.test.mjs`

- [ ] **Step 1: Create shared fixtures and the Contract tests**

Write a Node test file that imports compiled public functions and builds all temporary evidence under `mkdtempSync(join(tmpdir(), "nss-evimem-profile-"))`:

```js
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateArtifactClaims } from "../dist/artifact-claim-validator.js";
import { validateTaskContract } from "../dist/contract-validator.js";

const METRIC = "minimum_differential_weight_or_max_probability";

function taskContract(overrides = {}) {
  return {
    case_id: "profile-test",
    domain: "symmetric_cryptanalysis",
    cipher: "SIMON32",
    rounds: 10,
    analysis_type: "differential",
    metric: METRIC,
    objective: "reproduce_exact_metric_or_honest_bound",
    scope: "reduced_round",
    verification_profile: {
      id: "differential_metric_v1",
      primitive_profile: "simon_family_v1",
      claim_mode: "exact_or_honest_bound",
    },
    ...overrides,
  };
}

function validResult(overrides = {}) {
  return {
    cipher: "SIMON32",
    rounds: 10,
    analysis_type: "differential",
    metric: METRIC,
    scope: "10-round reduced-round SIMON32 instance",
    status: "optimal",
    claim_type: "exact",
    probability_semantics: "single_characteristic",
    total_weight: 7,
    probability: "2^-7",
    input_difference_words: [0, 1],
    model: {
      state_words: 2,
      word_size_bits: 16,
      rotations: [1, 8, 2],
      exclude_zero_input: true,
    },
    proof: {
      method: "solver",
      status: "optimal",
    },
    trail: Array.from({ length: 10 }, (_, index) => ({
      round: index + 1,
      weight: index < 7 ? 1 : 0,
    })),
    ...overrides,
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nss-evimem-profile-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const sourcePath = join(root, "solver.py");
  writeFileSync(sourcePath, "SIMON_ROTATIONS = (1, 8, 2)\nWORD_SIZE = 16\nSTATE_WORDS = 2\n", "utf8");
  return { evidenceDir, sourcePath };
}

test("accepts a known compatible verification profile", () => {
  const { evidenceDir } = fixture();
  const validation = validateTaskContract({ task_contract: taskContract(), evidence_dir: evidenceDir });
  assert.equal(validation.status, "valid_contract");
  assert.equal(validation.verification_profile?.id, "differential_metric_v1");
});

test("rejects an unknown verification profile", () => {
  const { evidenceDir } = fixture();
  const validation = validateTaskContract({
    task_contract: taskContract({ verification_profile: { id: "unknown_profile_v1" } }),
    evidence_dir: evidenceDir,
  });
  assert.equal(validation.status, "unsupported_contract");
  assert.match(validation.reasons.join("\n"), /unknown verification profile/i);
});

test("rejects a profile that is incompatible with the analysis type", () => {
  const { evidenceDir } = fixture();
  const validation = validateTaskContract({
    task_contract: taskContract({ analysis_type: "linear" }),
    evidence_dir: evidenceDir,
  });
  assert.equal(validation.status, "invalid_contract");
  assert.match(validation.reasons.join("\n"), /analysis_type/i);
});
```

- [ ] **Step 2: Add focused artifact tests**

Append one test per behavior:

```js
function validate(result, contract = taskContract()) {
  const { evidenceDir, sourcePath } = fixture();
  return validateArtifactClaims({
    case_id: String(contract.case_id),
    task_contract: contract,
    result,
    source_paths: [sourcePath],
    evidence_dir: evidenceDir,
  });
}

test("rejects a nontrivial ten-round SIMON result with zero weight", () => {
  const result = validResult({ total_weight: 0, probability: 1 });
  const validation = validate(result);
  assert.equal(validation.supports_verified_claim, false);
  assert.ok(validation.failures.includes("differential_nontrivial_weight"));
  assert.equal(validation.recommended_claim_level, "reject");
});

test("rejects inconsistent probability and weight", () => {
  const validation = validate(validResult({ total_weight: 7, probability: "2^-6" }));
  assert.ok(validation.failures.includes("probability_weight_consistency"));
});

test("requires conflicting exact method results to be resolved", () => {
  const validation = validate(validResult({
    methods: {
      exhaustive: { status: "optimal", weight: 7 },
      literature: { status: "exact", weight: 9 },
    },
  }));
  assert.ok(validation.failures.includes("method_result_conflict_resolved"));
  assert.equal(validation.recommended_claim_level, "bounded");
});

test("does not accept sampling alone as proof of an exact optimum", () => {
  const validation = validate(validResult({
    proof: { method: "sampling", status: "completed", samples: 100000 },
  }));
  assert.ok(validation.failures.includes("sampling_not_exact_proof"));
});

test("accepts process-complete evidence without knowing an oracle answer", () => {
  const validation = validate(validResult());
  assert.equal(validation.schema, "nss_evimem.artifact_claim_validation.v2");
  assert.equal(validation.verification_scope, "evidence_eligibility_not_oracle_correctness");
  assert.equal(validation.supports_verified_claim, true);
  assert.equal(validation.recommended_claim_level, "verified");
});

test("a Contract without a profile remains runnable but cannot gain verified status", () => {
  const contract = taskContract();
  delete contract.verification_profile;
  const validation = validate(validResult(), contract);
  assert.equal(validation.supports_verified_claim, false);
  assert.equal(validation.recommended_claim_level, "candidate");
  assert.ok(validation.warnings.includes("verification_profile_not_declared"));
});

test("an unreadable result path is returned as a validation failure", () => {
  const { evidenceDir, sourcePath } = fixture();
  const validation = validateArtifactClaims({
    task_contract: taskContract(),
    result_path: join(evidenceDir, "missing.json"),
    source_paths: [sourcePath],
    evidence_dir: evidenceDir,
  });
  assert.ok(validation.failures.includes("result_artifact_readable"));
});
```

- [ ] **Step 3: Run the tests and confirm the expected red state**

Run:

```powershell
npm run build
node --test test/verification-profiles.test.mjs
```

Expected: the build succeeds against current source, then tests fail because Contract validation ignores `verification_profile`, artifact schema is v1, and the zero-weight result is accepted.

- [ ] **Step 4: Commit only the failing tests**

```powershell
git add test/verification-profiles.test.mjs
git commit -m "test: define verification profile behavior"
```

### Task 2: Implement the Profile Registry and Contract Gate

**Files:**
- Create: `src/verification-profile-registry.ts`
- Modify: `src/types.ts`
- Modify: `src/contract-validator.ts`
- Test: `test/verification-profiles.test.mjs`

- [ ] **Step 1: Add profile types to `src/types.ts`**

Add these exported types after `TaskContract`:

```ts
export type VerificationProfileRequest = {
  id: string;
  primitive_profile?: string;
  claim_mode?: string;
};

export type VerificationProfileSelectionSource = "explicit" | "legacy_case_alias" | "default_generic";

export type ResolvedVerificationProfile = {
  id: string;
  version: number;
  primitive_profile: string | null;
  claim_mode: string;
  selection_source: VerificationProfileSelectionSource;
};

export type VerificationProfileResolution = {
  ok: boolean;
  requested: VerificationProfileRequest | null;
  profile: ResolvedVerificationProfile;
  invalid_reasons: string[];
  unsupported_reasons: string[];
  warnings: string[];
};
```

Extend `ContractValidationResult` with:

```ts
  verification_profile: ResolvedVerificationProfile;
  warnings: string[];
```

- [ ] **Step 2: Create the immutable registry**

Implement `src/verification-profile-registry.ts` with these exported functions and definitions:

```ts
import { isRecord } from "./evidence-store.js";
import type {
  JsonRecord,
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
```

- [ ] **Step 3: Connect resolution to Contract validation**

In `validateTaskContract`, call `resolveVerificationProfile(params.task_contract)` before computing status, append `invalid_reasons` and `unsupported_reasons`, and include the resolved profile and warnings in `ContractValidationResult`:

```ts
const profileResolution = resolveVerificationProfile(params.task_contract);
const invalidReasons = [
  ...invalidContractReasons(params.task_contract),
  ...profileResolution.invalid_reasons,
];
const unsupportedReasons = [
  ...unsupportedContractReasons(params),
  ...profileResolution.unsupported_reasons,
];
```

Add to the result object:

```ts
verification_profile: profileResolution.profile,
warnings: profileResolution.warnings,
```

Keep saving `task_contract.json` only when the final status is `valid_contract`.

- [ ] **Step 4: Run the Contract subset and verify green**

Run:

```powershell
npm run build
node --test --test-name-pattern="verification profile|profile that is incompatible" test/verification-profiles.test.mjs
```

Expected: three Contract tests pass; artifact tests remain red.

- [ ] **Step 5: Commit the registry and Contract gate**

```powershell
git add src/types.ts src/verification-profile-registry.ts src/contract-validator.ts
git commit -m "feat: validate task verification profiles"
```

### Task 3: Implement Differential Metric Checks and Schema v2

**Files:**
- Create: `src/differential-metric-profile.ts`
- Modify: `src/types.ts`
- Modify: `src/artifact-claim-validator.ts`
- Test: `test/verification-profiles.test.mjs`

- [ ] **Step 1: Add claim-validation types**

Add to `src/types.ts`:

```ts
export type ArtifactClaimCheckStatus = "pass" | "fail" | "warn" | "not_applicable";
export type ArtifactClaimCheckSeverity = "high" | "medium" | "low";
export type RecommendedClaimLevel = "verified" | "bounded" | "candidate" | "reject";

export type ArtifactClaimCheck = {
  id: string;
  status: ArtifactClaimCheckStatus;
  severity: ArtifactClaimCheckSeverity;
  reason: string;
  evidence?: string;
};
```

- [ ] **Step 2: Implement `src/differential-metric-profile.ts`**

Export one dispatcher-compatible function:

```ts
export function differentialMetricChecks(params: {
  taskContract: TaskContract;
  result: JsonRecord;
  reportText: string;
  sourceText: string;
  readableSourceCount: number;
}): ArtifactClaimCheck[]
```

The function must emit exactly these stable IDs:

```ts
[
  "required_artifacts_readable",
  "task_boundary_preserved",
  "scope_boundary_present",
  "differential_nonzero_input",
  "differential_nontrivial_weight",
  "probability_weight_consistency",
  "probability_semantics_declared",
  "round_coverage_matches_contract",
  "round_weight_sum_consistency",
  "exactness_evidence_present",
  "sampling_not_exact_proof",
  "method_result_conflict_resolved",
  "primitive_model_invariants",
]
```

Implement deterministic structured extraction rules:

```ts
const weight = firstNumber(result, ["total_weight", "minimum_differential_weight", "best_weight", "weight"]);
const probability = parseProbability(firstValue(result, ["probability", "maximum_differential_probability"]));
const exactClaim = ["optimal", "exact", "verified"].some((token) => corpus.includes(token));
const inputWords = firstNumberArray(result, ["input_difference_words", "delta_in_words"]);
const nonzeroInput = inputWords ? inputWords.some((value) => value !== 0) : hasNonzeroFirstTrailState(result.trail);
```

Use a tolerance of `1e-9` for numeric `probability` versus `2 ** -weight`. Accept strings matching `2^-7`, `2^(-7)`, and `2^{-7}`. Treat `weight === 0` or `probability === 1` as a high-severity failure only when the primitive profile is SIMON, rounds are greater than one, the input is nonzero, and the claim is exact.

For method conflicts, recursively collect numeric `weight`, `best_weight`, and `verified_weight` values directly under each entry of `result.methods`. More than one distinct value fails unless `result.conflict_resolution` is a non-empty string/object or the result explicitly declares `claim_type` as `bound`/`candidate`.

For exactness, accept only one of these structured signals: `proof.status === "optimal"`, `proof.method === "formal_proof"`, `coverage.status === "complete"`, or a non-empty `source_reference` object/string. Reject a proof whose method contains `sampling`, `random`, or `monte_carlo` when the claim remains exact.

For SIMON model invariants, accept `result.model.state_words === 2`, `word_size_bits === 16` for SIMON32, rotations `[1,8,2]`, and `exclude_zero_input === true`; source text may satisfy rotations/word-size/state-word fields, but it cannot satisfy the nonzero-input exclusion by itself.

Use a local helper with this exact shape for every check:

```ts
function check(id: string, passed: boolean, severity: ArtifactClaimCheck["severity"], reason: string, evidence?: string): ArtifactClaimCheck {
  return { id, status: passed ? "pass" : "fail", severity, reason, ...(evidence ? { evidence } : {}) };
}
```

- [ ] **Step 3: Upgrade the artifact validator orchestration**

In `src/artifact-claim-validator.ts`:

1. Import `differentialMetricChecks` and `resolveVerificationProfile`.
2. Replace local check types with imports from `types.ts`.
3. Change the result schema literal to `nss_evimem.artifact_claim_validation.v2`.
4. Add `verification_profile`, `verification_scope`, and `recommended_claim_level` to the result type and object.
5. Preserve the old SIMON DL checks under `simonDlChecks`; call them when the resolved profile id is `simon_dl_distinguisher_v1`.
6. Call `differentialMetricChecks` only for `differential_metric_v1`.
7. For `generic_artifact_consistency_v1`, emit `case_specific_rules: not_applicable` and never grant verified status.

Replace throwing result loading with a safe loader:

```ts
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
```

When `result_path` was supplied and loading failed, append:

```ts
{
  id: "result_artifact_readable",
  status: "fail",
  severity: "high",
  reason: "The structured result artifact must exist and contain a JSON object.",
  evidence: loadError,
}
```

Map profile warnings to warning checks and stable warning IDs. Compute the gates as follows:

```ts
const failures = checks.filter((item) => item.status === "fail").map((item) => item.id);
const warnings = checks.filter((item) => item.status === "warn").map((item) => item.id);
const profileCanVerify = profileResolution.ok
  && profileResolution.profile.selection_source !== "default_generic";
const supportsVerifiedClaim = failures.length === 0 && profileCanVerify;
const recommendedClaimLevel = recommendClaimLevel(checks, profileResolution, supportsVerifiedClaim);
```

`recommendClaimLevel` returns:

- `verified` when `supportsVerifiedClaim` is true;
- `reject` when a failed ID is `result_claim_consistency`, `result_artifact_readable`, `task_boundary_preserved`, `differential_nonzero_input`, `differential_nontrivial_weight`, `probability_weight_consistency`, or `primitive_model_invariants`;
- `bounded` when a failed ID is `exactness_evidence_present`, `sampling_not_exact_proof`, or `method_result_conflict_resolved`;
- `candidate` for the default generic profile and all remaining failures.

- [ ] **Step 4: Run all profile tests and verify green**

Run:

```powershell
npm run build
node --test test/verification-profiles.test.mjs
```

Expected: all profile and artifact tests pass with zero failures.

- [ ] **Step 5: Commit the profile checker**

```powershell
git add src/types.ts src/differential-metric-profile.ts src/artifact-claim-validator.ts
git commit -m "feat: gate differential metric claims by profile"
```

### Task 4: Wire the OpenClaw Tool, Smoke Test, and Documentation

**Files:**
- Modify: `src/index.ts`
- Modify: `scripts/smoke.mjs`
- Modify: `README.md`
- Test: `scripts/smoke.mjs`

- [ ] **Step 1: Update the tool descriptions**

Change the Contract tool description to:

```ts
description: "Validate an Agent-generated Task Contract, including an optional built-in verification_profile, and persist valid contracts.",
```

Change the artifact tool description to:

```ts
description: "Check whether result, report, and source artifacts satisfy the Task Contract's public verification profile. This checks evidence eligibility, not hidden-oracle correctness.",
```

The JSON schema remains open inside `task_contract`; do not add any `expected_answer` or oracle parameter.

- [ ] **Step 2: Update smoke fixtures without weakening legacy coverage**

In the existing SIMON32/64 DL Contract passed to `nss_evimem_validate_artifact_claims`, add:

```js
verification_profile: {
  id: "simon_dl_distinguisher_v1",
  primitive_profile: "simon_family_v1",
  claim_mode: "exact_or_honest_bound",
},
```

Change the schema assertion to v2 and add:

```js
&& artifactClaimValidationDetails.verification_profile.id === "simon_dl_distinguisher_v1"
&& artifactClaimValidationDetails.verification_scope === "evidence_eligibility_not_oracle_correctness"
&& artifactClaimValidationDetails.recommended_claim_level === "reject"
```

Keep every existing old-rule assertion (`simon32_round_function_uses_key`, `simon32_key_schedule_constant`, full state, decompositions, signed sum, claim consistency, and runtime sanity).

- [ ] **Step 3: Document the public API boundary**

Update README sections for Task Contract and artifact validation with the NL-X01 Contract example from the approved design. Explicitly state:

```text
verification_profile selects immutable public-process checks owned by the plugin. Agent-provided fields cannot disable mandatory checks.

supports_verified_claim means the artifacts are eligible to support a verified claim. It does not mean the numeric answer is benchmark-correct; hidden-oracle comparison belongs only to an offline evaluator.
```

Document `recommended_claim_level` values and the three initial profiles.

- [ ] **Step 4: Run focused and smoke verification**

Run:

```powershell
npm run typecheck
npm run build
npm run smoke
node --test test/verification-profiles.test.mjs
```

Expected: typecheck exits 0, smoke emits a JSON object with `"ok": true`, and all profile tests pass.

- [ ] **Step 5: Commit tool and documentation integration**

```powershell
git add src/index.ts scripts/smoke.mjs README.md
git commit -m "docs: expose verification profile claim gate"
```

### Task 5: Integrate the NL-X01 Four-Group Experiment

**Files:**
- Modify: `experiments/CBSC-V2-NL-X01/run_openclaw_all_groups_experiment.mjs`
- Modify: `experiments/CBSC-V2-NL-X01/verify_openclaw_all_groups_experiment.mjs`
- Test: `experiments/CBSC-V2-NL-X01/verify_openclaw_all_groups_experiment.mjs`

- [ ] **Step 1: Add the profile and missing scope to the experiment Contract**

Extend the shared `taskContract` object:

```js
scope: "reduced_round",
verification_profile: {
  id: "differential_metric_v1",
  primitive_profile: "simon_family_v1",
  claim_mode: "exact_or_honest_bound",
},
```

Because all four arms receive the same task statement but only Contract+Capability and Full Intervention invoke Contract handling, do not inject profile instructions into Baseline or Evidence-only prompts beyond the common public question.

- [ ] **Step 2: Strengthen experiment verification**

Replace the schema-v1 assertion with v2 and add these checks:

```js
fullInterventionUsesDifferentialProfile:
  artifactValidation.verification_profile?.id === "differential_metric_v1",
artifactValidationSeparatesOracle:
  artifactValidation.verification_scope === "evidence_eligibility_not_oracle_correctness",
fullInterventionClaimLevelRecorded:
  ["verified", "bounded", "candidate", "reject"].includes(artifactValidation.recommended_claim_level),
oracleRemainsOffline:
  !JSON.stringify(artifactValidation.task_contract).includes(summary.oracle_expected.probability),
```

Keep the existing exact-metric oracle comparison in `evaluation.json`; do not move it into `artifact_claim_validation.json`.

- [ ] **Step 3: Verify the existing run fails for the expected migration reason**

Run:

```powershell
node experiments/CBSC-V2-NL-X01/verify_openclaw_all_groups_experiment.mjs
```

Expected before rerun: FAIL because the historical ignored run contains schema v1 and no profile. This confirms the verifier is checking the new behavior rather than accepting stale output.

- [ ] **Step 4: Commit experiment source only**

```powershell
git add experiments/CBSC-V2-NL-X01/run_openclaw_all_groups_experiment.mjs experiments/CBSC-V2-NL-X01/verify_openclaw_all_groups_experiment.mjs
git commit -m "test: apply verification profile to nl x01"
```

### Task 6: Fresh End-to-End Verification

**Files:**
- Verify: all changed source, tests, docs, and experiment scripts
- Do not stage: `experiments/**/runs/**`

- [ ] **Step 1: Run static and local plugin verification**

Run each command and require exit code 0:

```powershell
npm run typecheck
npm run build
node --test test/verification-profiles.test.mjs
npm run smoke
node --check experiments/CBSC-V2-NL-X01/run_openclaw_all_groups_experiment.mjs
node --check experiments/CBSC-V2-NL-X01/verify_openclaw_all_groups_experiment.mjs
```

- [ ] **Step 2: Re-run the four isolated OpenClaw arms**

Run:

```powershell
npm run experiment:cbsc-nl-x01:openclaw-all-groups-isolated
```

Allow all four arms to finish. Confirm no OpenClaw child process remains and that every arm records `cross_group_contamination_detected=false`.

- [ ] **Step 3: Rescore and verify the fresh run**

Run:

```powershell
npm run experiment:cbsc-nl-x01:openclaw-all-groups-isolated:rescore
npm run experiment:cbsc-nl-x01:openclaw-all-groups-isolated:verify
```

Expected minimum behavior: the Full Intervention artifact uses schema v2 and the differential profile. If its result again reports a nontrivial 10-round `weight=0`/`probability=1`, `supports_verified_claim` is false and `differential_nontrivial_weight` is recorded. `verified_correct` is reported only when both eligibility and offline exact-oracle match are true.

- [ ] **Step 4: Audit repository scope and oracle separation**

Run:

```powershell
git diff --check
git status --short
rg -n -S "2\^-25|primary_weight.*25|expected_answer|oracle_answer" src test README.md
git check-ignore -v experiments/CBSC-V2-NL-X01/runs/openclaw-all-groups-isolated-latest/experiment_summary.json
```

Expected: no oracle answer appears in `src/`, `test/`, or profile documentation examples; the fresh run remains ignored by `experiments/**/runs/`.

- [ ] **Step 5: Review final commits without staging unrelated work**

```powershell
git log --oneline --decorate -6
git diff HEAD~5..HEAD -- src test scripts README.md experiments/CBSC-V2-NL-X01 docs/superpowers
git status --short --branch
```

Report the exact test counts, the Full Intervention validation status and failure IDs, the offline oracle result for each arm, and any pre-existing dirty files that remain untouched. Do not push unless the user explicitly asks for a remote update.
