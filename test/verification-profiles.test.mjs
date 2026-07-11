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
