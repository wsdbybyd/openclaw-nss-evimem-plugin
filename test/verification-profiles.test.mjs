import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateArtifactClaims } from "../dist/artifact-claim-validator.js";
import { validateTaskContract } from "../dist/contract-validator.js";

const METRIC = "minimum_differential_weight_or_max_probability";
const DIFFERENTIAL_METRIC_CHECK_IDS = [
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
];

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
  return { root, evidenceDir, sourcePath };
}

test("accepts a known compatible verification profile", (t) => {
  const { root, evidenceDir } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const validation = validateTaskContract({ task_contract: taskContract(), evidence_dir: evidenceDir });
  assert.equal(validation.status, "valid_contract");
  assert.equal(validation.verification_profile?.id, "differential_metric_v1");
  assert.equal(validation.verification_profile?.version, 1);
  assert.equal(validation.verification_profile?.primitive_profile, "simon_family_v1");
  assert.equal(validation.verification_profile?.claim_mode, "exact_or_honest_bound");
});

test("rejects an unknown verification profile", (t) => {
  const { root, evidenceDir } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const validation = validateTaskContract({
    task_contract: taskContract({ verification_profile: { id: "unknown_profile_v1" } }),
    evidence_dir: evidenceDir,
  });
  assert.equal(validation.status, "unsupported_contract");
  assert.match(validation.reasons.join("\n"), /unknown verification profile/i);
});

test("rejects a profile that is incompatible with the analysis type", (t) => {
  const { root, evidenceDir } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const validation = validateTaskContract({
    task_contract: taskContract({ analysis_type: "linear" }),
    evidence_dir: evidenceDir,
  });
  assert.equal(validation.status, "invalid_contract");
  assert.match(validation.reasons.join("\n"), /analysis_type/i);
});

test("sanitizes forbidden Contract fields before return, logging, and persistence", (t) => {
  const { root, evidenceDir } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const forbiddenFields = ["expected_answer", "oracle", "disabled_checks", "severity_overrides"];
  const forbiddenValues = Object.fromEntries(forbiddenFields.map((field) => [field, true]));
  const contract = taskContract({
    ...forbiddenValues,
    verification_profile: {
      id: "differential_metric_v1",
      primitive_profile: "simon_family_v1",
      claim_mode: "exact_or_honest_bound",
      ...forbiddenValues,
    },
  });

  const validation = validateTaskContract({ task_contract: contract, evidence_dir: evidenceDir });
  const event = JSON.parse(readFileSync(join(evidenceDir, "contract_validation_events.jsonl"), "utf8").trim());
  const persisted = JSON.parse(readFileSync(join(evidenceDir, "task_contract.json"), "utf8"));

  assert.equal(validation.status, "valid_contract");
  for (const field of forbiddenFields) {
    assert.equal(field in validation.task_contract, false, `result retained top-level ${field}`);
    assert.equal(field in validation.task_contract.verification_profile, false, `result retained nested ${field}`);
    assert.equal(field in event.task_contract, false, `event retained top-level ${field}`);
    assert.equal(field in event.task_contract.verification_profile, false, `event retained nested ${field}`);
    assert.equal(field in persisted, false, `persisted Contract retained top-level ${field}`);
    assert.equal(field in persisted.verification_profile, false, `persisted Contract retained nested ${field}`);
    assert.ok(validation.warnings.includes(`ignored_profile_field:${field}`));
  }
});

test("rejects malformed primitive_profile and claim_mode values", (t) => {
  const malformedFields = [
    ["primitive_profile", ""],
    ["primitive_profile", "   "],
    ["primitive_profile", 7],
    ["claim_mode", ""],
    ["claim_mode", "   "],
    ["claim_mode", false],
  ];

  for (const [field, value] of malformedFields) {
    const { root, evidenceDir } = fixture();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const validation = validateTaskContract({
      task_contract: taskContract({
        verification_profile: {
          id: "differential_metric_v1",
          primitive_profile: "simon_family_v1",
          claim_mode: "exact_or_honest_bound",
          [field]: value,
        },
      }),
      evidence_dir: evidenceDir,
    });
    assert.equal(validation.status, "invalid_contract", `${field}=${JSON.stringify(value)}`);
    assert.match(validation.reasons.join("\n"), new RegExp(field), `${field}=${JSON.stringify(value)}`);
  }
});

test("rejects a legacy profile alias with incompatible Contract fields", (t) => {
  const incompatibleFields = [
    ["domain", "public_key_cryptanalysis"],
    ["analysis_type", "linear"],
    ["cipher", "AES"],
  ];

  for (const [field, value] of incompatibleFields) {
    const { root, evidenceDir } = fixture();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const contract = taskContract({
      case_id: "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
      analysis_type: "differential_linear",
      verification_profile: undefined,
      [field]: value,
    });
    const validation = validateTaskContract({ task_contract: contract, evidence_dir: evidenceDir });
    assert.equal(validation.status, "invalid_contract", `${field}=${value}`);
    assert.match(validation.reasons.join("\n"), new RegExp(field), `${field}=${value}`);
  }
});

test("generic fallback resolves an undeclared profile as a candidate", (t) => {
  const { root, evidenceDir } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contract = taskContract({ verification_profile: undefined });

  const validation = validateTaskContract({ task_contract: contract, evidence_dir: evidenceDir });

  assert.equal(validation.status, "valid_contract");
  assert.equal(validation.verification_profile.id, "generic_artifact_consistency_v1");
  assert.equal(validation.verification_profile.selection_source, "default_generic");
  assert.equal(validation.verification_profile.claim_mode, "candidate");
  assert.ok(validation.warnings.includes("verification_profile_not_declared"));
});

function validate(t, result, contract = taskContract()) {
  const { root, evidenceDir, sourcePath } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return validateArtifactClaims({
    case_id: String(contract.case_id),
    task_contract: contract,
    result,
    source_paths: [sourcePath],
    evidence_dir: evidenceDir,
  });
}

test("sanitizes forbidden Contract fields during direct artifact validation", (t) => {
  const { root, evidenceDir, sourcePath } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const forbiddenFields = ["expected_answer", "oracle", "disabled_checks", "severity_overrides"];
  const forbiddenValues = Object.fromEntries(forbiddenFields.map((field) => [field, "dummy"]));
  const contract = taskContract({
    ...forbiddenValues,
    verification_profile: {
      id: "differential_metric_v1",
      primitive_profile: "simon_family_v1",
      claim_mode: "exact_or_honest_bound",
      ...forbiddenValues,
    },
  });

  const validation = validateArtifactClaims({
    task_contract: contract,
    result: validResult(),
    source_paths: [sourcePath],
    evidence_dir: evidenceDir,
  });
  const persisted = JSON.parse(readFileSync(join(evidenceDir, "artifact_claim_validation.json"), "utf8"));

  for (const field of forbiddenFields) {
    assert.equal(field in validation.task_contract, false, `result retained top-level ${field}`);
    assert.equal(field in validation.task_contract.verification_profile, false, `result retained nested ${field}`);
    assert.equal(field in persisted.task_contract, false, `persisted result retained top-level ${field}`);
    assert.equal(field in persisted.task_contract.verification_profile, false, `persisted result retained nested ${field}`);
    assert.ok(validation.warnings.includes(`ignored_profile_field:${field}`));
  }
});

test("rejects a nontrivial ten-round SIMON result with zero weight", (t) => {
  const result = validResult({
    total_weight: 0,
    probability: 1,
    trail: Array.from({ length: 10 }, (_, index) => ({
      round: index + 1,
      weight: 0,
    })),
  });
  const validation = validate(t, result);
  assert.equal(validation.supports_verified_claim, false);
  assert.ok(validation.failures.includes("differential_nontrivial_weight"));
  assert.equal(validation.recommended_claim_level, "reject");
});

test("uses the resolved SIMON primitive profile when cipher metadata is mismatched", (t) => {
  const contract = taskContract({ cipher: "AES" });
  const validation = validate(t, validResult({
    cipher: "AES",
    total_weight: 0,
    probability: 1,
    model: { exclude_zero_input: false },
    trail: Array.from({ length: 10 }, (_, index) => ({ round: index + 1, weight: 0 })),
  }), contract);

  assert.ok(validation.failures.includes("differential_nontrivial_weight"));
  assert.ok(validation.failures.includes("primitive_model_invariants"));
});

test("combines structured and source SIMON model evidence field by field", (t) => {
  const { root, evidenceDir, sourcePath } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(sourcePath, "SIMON_ROTATIONS = (1, 8, 2)\nWORD_SIZE = 16\n", "utf8");
  const validation = validateArtifactClaims({
    task_contract: taskContract(),
    result: validResult({ model: { state_words: 2, exclude_zero_input: true } }),
    source_paths: [sourcePath],
    evidence_dir: evidenceDir,
  });

  assert.equal(validation.failures.includes("primitive_model_invariants"), false);
});

test("does not compare probability and weight unless both metrics are present", (t) => {
  const weightOnly = validate(t, validResult({ probability: undefined }));
  const probabilityOnly = validate(t, validResult({ total_weight: undefined }));

  for (const validation of [weightOnly, probabilityOnly]) {
    assert.equal(validation.failures.includes("probability_weight_consistency"), false);
    assert.equal(validation.failures.includes("differential_nontrivial_weight"), false);
  }
});

test("requires a structured result and one readable source artifact", (t) => {
  const { root, evidenceDir } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const noSource = validateArtifactClaims({
    task_contract: taskContract(),
    result: validResult(),
    evidence_dir: evidenceDir,
  });
  const multipleRequiredArtifacts = validate(t, validResult(), taskContract({
    required_artifacts: ["result.json", "solver.py"],
  }));

  assert.ok(noSource.failures.includes("required_artifacts_readable"));
  assert.equal(multipleRequiredArtifacts.failures.includes("required_artifacts_readable"), false);
});

test("allows declared-round exact evidence without a trail", (t) => {
  const validation = validate(t, validResult({
    trail: undefined,
    source_reference: "local solver source",
  }));

  assert.equal(validation.failures.includes("round_coverage_matches_contract"), false);
  assert.equal(validation.failures.includes("round_weight_sum_consistency"), false);
});

test("accepts sampling when independent exactness evidence is present", (t) => {
  const validation = validate(t, validResult({
    proof: { method: "sampling", status: "completed" },
    coverage: { status: "complete", method: "exhaustive", independent_from_sampling: true },
  }));

  assert.equal(validation.failures.includes("sampling_not_exact_proof"), false);
});

test("caps candidate and bounded claim declarations below verified", (t) => {
  const candidate = validate(t, validResult({
    claim_type: "candidate",
    methods: { exhaustive: { weight: 7 }, reproduction: { weight: 9 } },
  }));
  const bounded = validate(t, validResult({ claim_type: "bound" }));
  const profileBounded = validate(t, validResult(), taskContract({
    verification_profile: {
      id: "differential_metric_v1",
      primitive_profile: "simon_family_v1",
      claim_mode: "bounded",
    },
  }));

  assert.equal(candidate.supports_verified_claim, false);
  assert.equal(candidate.recommended_claim_level, "candidate");
  assert.equal(bounded.supports_verified_claim, false);
  assert.equal(bounded.recommended_claim_level, "bounded");
  assert.equal(profileBounded.supports_verified_claim, false);
  assert.equal(profileBounded.recommended_claim_level, "bounded");
});

test("caps unverified result language below verified", (t) => {
  const validation = validate(t, validResult({ conclusion: "not verified" }));

  assert.equal(validation.supports_verified_claim, false);
  assert.equal(validation.recommended_claim_level, "bounded");
});

test("rejects sampling provenance asserted only by a bare source reference or coverage", (t) => {
  const sourceReference = validate(t, validResult({
    proof: { method: "sampling", status: "optimal" },
    source_reference: "this same sampling run",
  }));
  const coverage = validate(t, validResult({
    proof: { method: "sampling", status: "optimal" },
    coverage: { status: "complete" },
  }));

  assert.ok(sourceReference.failures.includes("sampling_not_exact_proof"));
  assert.ok(coverage.failures.includes("sampling_not_exact_proof"));
});

test("rejects scope expansion beyond the Contract", (t) => {
  const validation = validate(t, validResult({ scope: "full_cipher" }));

  assert.ok(validation.failures.includes("scope_boundary_present"));
});

test("detects conflicting weights in method arrays", (t) => {
  const validation = validate(t, validResult({
    methods: [{ weight: 7 }, { verified_weight: 9 }],
  }));

  assert.ok(validation.failures.includes("method_result_conflict_resolved"));
});

test("does not treat state metadata as a nonzero input difference", (t) => {
  const validation = validate(t, validResult({
    input_difference_words: undefined,
    trail: Array.from({ length: 10 }, (_, index) => ({
      round: index + 1,
      state_words: 2,
      weight: index < 7 ? 1 : 0,
    })),
  }));

  assert.ok(validation.failures.includes("differential_nonzero_input"));
});

test("accepts nonzero input differences encoded as hexadecimal or binary", (t) => {
  const hexadecimal = validate(t, validResult({ input_difference_words: undefined, dx: "0x1", dy: "0x0" }));
  const binary = validate(t, validResult({ input_difference_words: undefined, input_diff: "0b10" }));

  assert.equal(hexadecimal.failures.includes("differential_nonzero_input"), false);
  assert.equal(binary.failures.includes("differential_nonzero_input"), false);
});

test("rejects explicit contradictory structured model fields despite source literals", (t) => {
  const cases = [
    { state_words: 3, word_size_bits: 16, rotations: [1, 8, 2], exclude_zero_input: true },
    { state_words: 2, word_size_bits: 8, rotations: [1, 8, 2], exclude_zero_input: true },
    { state_words: 2, word_size_bits: 16, rotations: [1, 2, 8], exclude_zero_input: true },
  ];

  for (const model of cases) {
    const validation = validate(t, validResult({ model }));
    assert.ok(validation.failures.includes("primitive_model_invariants"));
  }
});

test("fails closed when the differential profile primitive is absent", (t) => {
  const contract = taskContract({
    cipher: "AES",
    verification_profile: { id: "differential_metric_v1", claim_mode: "exact_or_honest_bound" },
  });
  const validation = validate(t, validResult({
    cipher: "AES",
    total_weight: 0,
    probability: 1,
    trail: Array.from({ length: 10 }, (_, index) => ({ round: index + 1, weight: 0 })),
  }), contract);

  assert.ok(validation.failures.includes("differential_nontrivial_weight"));
  assert.ok(validation.failures.includes("primitive_model_invariants"));
});

test("caps ambiguous sampling claims below verified without exact intent", (t) => {
  const validation = validate(t, validResult({
    status: "completed",
    claim_type: undefined,
    proof: { method: "sampling", status: "completed" },
  }));

  assert.equal(validation.supports_verified_claim, false);
  assert.equal(validation.recommended_claim_level, "candidate");
});

test("never verifies an explicitly selected generic artifact profile", (t) => {
  const validation = validate(t, validResult(), taskContract({
    verification_profile: { id: "generic_artifact_consistency_v1", claim_mode: "candidate" },
  }));

  assert.equal(validation.supports_verified_claim, false);
  assert.equal(validation.recommended_claim_level, "candidate");
});

test("preserves verified SIMON-DL claim intent for the legacy profile alias", (t) => {
  const { root, evidenceDir, sourcePath } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(sourcePath, "x ^ round_keys[i]\nc = 0xfffc\n", "utf8");
  const contract = taskContract({
    case_id: "CBSC-V2-HARD-SIMON32-DL-SEARCH-002",
    analysis_type: "differential_linear",
    verification_profile: undefined,
  });
  const validation = validateArtifactClaims({
    task_contract: contract,
    result: {
      claim_type: "verified_distinguisher",
      delta_in_words: [0, 1],
      gamma_out_words: [2, 3],
      measurement: "signed_sum",
      decompositions: "(5,5,4) (5,6,3) (7,3,4)",
    },
    source_paths: [sourcePath],
    evidence_dir: evidenceDir,
  });

  assert.equal(validation.supports_verified_claim, true);
  assert.equal(validation.recommended_claim_level, "verified");
});

test("downgrades unclassified profile check failures to candidate", (t) => {
  const validation = validate(t, validResult({ scope: "full_cipher" }));

  assert.ok(validation.failures.includes("scope_boundary_present"));
  assert.equal(validation.recommended_claim_level, "candidate");
});

test("detects conflicting weights in nested method arrays", (t) => {
  const validation = validate(t, validResult({
    methods: [{ runs: [{ weight: 7 }, { weight: 9 }] }],
  }));

  assert.ok(validation.failures.includes("method_result_conflict_resolved"));
  assert.equal(validation.supports_verified_claim, false);
});

test("rejects inconsistent probability and weight", (t) => {
  const validation = validate(t, validResult({ total_weight: 7, probability: "2^-6" }));
  assert.equal(validation.supports_verified_claim, false);
  assert.ok(validation.failures.includes("probability_weight_consistency"));
  assert.equal(validation.recommended_claim_level, "reject");
});

test("requires conflicting exact method results to be resolved", (t) => {
  const validation = validate(t, validResult({
    methods: {
      exhaustive: { status: "optimal", weight: 7 },
      literature: { status: "exact", weight: 9 },
    },
  }));
  assert.equal(validation.supports_verified_claim, false);
  assert.ok(validation.failures.includes("method_result_conflict_resolved"));
  assert.equal(validation.recommended_claim_level, "bounded");
});

test("does not accept sampling alone as proof of an exact optimum", (t) => {
  const validation = validate(t, validResult({
    proof: { method: "sampling", status: "completed", samples: 100000 },
  }));
  assert.equal(validation.supports_verified_claim, false);
  assert.ok(validation.failures.includes("sampling_not_exact_proof"));
  assert.equal(validation.recommended_claim_level, "bounded");
});

test("does not let a sampling proof certify itself as optimal", (t) => {
  const validation = validate(t, validResult({
    proof: { method: "sampling", status: "optimal" },
  }));

  assert.ok(validation.failures.includes("sampling_not_exact_proof"));
  assert.equal(validation.supports_verified_claim, false);
  assert.equal(validation.recommended_claim_level, "bounded");
});

test("accepts process-complete evidence without knowing an oracle answer", (t) => {
  const validation = validate(t, validResult());
  assert.equal(validation.schema, "nss_evimem.artifact_claim_validation.v2");
  assert.equal(validation.verification_scope, "evidence_eligibility_not_oracle_correctness");
  assert.equal(validation.verification_profile?.id, "differential_metric_v1");
  assert.equal(validation.verification_profile?.version, 1);
  assert.equal(validation.verification_profile?.primitive_profile, "simon_family_v1");
  assert.equal(validation.verification_profile?.claim_mode, "exact_or_honest_bound");
  for (const checkId of DIFFERENTIAL_METRIC_CHECK_IDS) {
    assert.ok(validation.checks.some((check) => check.id === checkId), `missing mandatory check: ${checkId}`);
  }
  assert.equal(validation.supports_verified_claim, true);
  assert.equal(validation.recommended_claim_level, "verified");
});

test("a Contract without a profile remains runnable but cannot gain verified status", (t) => {
  const contract = taskContract();
  delete contract.verification_profile;
  const validation = validate(t, validResult(), contract);
  assert.equal(validation.supports_verified_claim, false);
  assert.equal(validation.recommended_claim_level, "candidate");
  assert.ok(validation.warnings.includes("verification_profile_not_declared"));
});

test("an unreadable result path is returned as a validation failure", (t) => {
  const { root, evidenceDir, sourcePath } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let validation;
  assert.doesNotThrow(() => {
    validation = validateArtifactClaims({
      task_contract: taskContract(),
      result_path: join(evidenceDir, "missing.json"),
      source_paths: [sourcePath],
      evidence_dir: evidenceDir,
    });
  }, "an unreadable result path must return a structured validation failure");
  assert.equal(validation.supports_verified_claim, false);
  assert.ok(validation.failures.includes("result_artifact_readable"));
  assert.equal(validation.recommended_claim_level, "reject");
});
