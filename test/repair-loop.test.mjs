import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import plugin from "../dist/index.js";
import { assessRepairAttempt, buildRepairFeedback } from "../dist/repair-loop.js";

function fixture(t, validation) {
  const root = mkdtempSync(join(tmpdir(), "nss-evimem-repair-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const writeValidation = (nextValidation) => {
    writeFileSync(join(evidenceDir, "artifact_claim_validation.json"), JSON.stringify({
      schema: "nss_evimem.artifact_claim_validation.v2",
      case_id: "repair-case",
      task_contract: {
        cipher: "SIMON32",
        rounds: 10,
        analysis_type: "differential",
      },
      checks: nextValidation.failures.map((id) => ({
        id,
        status: "fail",
        severity: "high",
        reason: `reason for ${id}`,
      })),
      ...nextValidation,
    }, null, 2), "utf8");
  };
  writeValidation(validation);
  return { root, evidenceDir, writeValidation };
}

test("buildRepairFeedback turns a rejected AND model into a direct repair instruction", (t) => {
  const { evidenceDir } = fixture(t, {
    failures: ["simon_and_difference_semantics"],
    status: "failed",
    supports_verified_claim: false,
  });

  const feedback = buildRepairFeedback({ evidence_dir: evidenceDir });

  assert.equal(feedback.schema, "nss_evimem.repair_feedback.v1");
  assert.equal(feedback.status, "repair_required");
  assert.equal(feedback.requires_independent_verification, true);
  assert.match(feedback.prompt_patch, /must not encode the AND output difference/i);
  assert.ok(existsSync(feedback.output_files.repair_feedback));
  assert.match(readFileSync(feedback.output_files.repair_prompt, "utf8"), /rotation correlation/i);
});

test("buildRepairFeedback tells the Agent how to repair unlinked SIMON state values", (t) => {
  const { evidenceDir } = fixture(t, {
    failures: ["simon_and_state_value_linkage"],
    status: "failed",
    supports_verified_claim: false,
  });

  const feedback = buildRepairFeedback({ evidence_dir: evidenceDir });

  assert.match(feedback.prompt_patch, /bind the value variables to the rotated SIMON round-state bits/i);
});

test("buildRepairFeedback rejects an AND-input activity proxy as a differential weight", (t) => {
  const { evidenceDir } = fixture(t, {
    failures: ["simon_and_weight_proxy"],
    status: "failed",
    supports_verified_claim: false,
  });

  const feedback = buildRepairFeedback({ evidence_dir: evidenceDir });

  assert.match(feedback.prompt_patch, /do not use an any-active-and-input proxy as differential weight/i);
});

test("assessRepairAttempt requests independent verification after fresh validation passes", (t) => {
  const { evidenceDir, writeValidation } = fixture(t, {
    failures: ["simon_and_difference_semantics"],
    status: "failed",
    supports_verified_claim: false,
  });
  buildRepairFeedback({ evidence_dir: evidenceDir });
  writeValidation({
    failures: [],
    status: "passed",
    supports_verified_claim: true,
    repair_revision: "rerun-1",
  });

  const assessment = assessRepairAttempt({ evidence_dir: evidenceDir });

  assert.equal(assessment.schema, "nss_evimem.repair_attempt_assessment.v1");
  assert.equal(assessment.status, "independent_verification_required");
  assert.equal(assessment.verified_correct, false);
  assert.equal(assessment.independent_verification_required, true);
});

test("assessRepairAttempt stops retrying when the repair budget is exhausted", (t) => {
  const { evidenceDir, writeValidation } = fixture(t, {
    failures: ["simon_and_difference_semantics"],
    status: "failed",
    supports_verified_claim: false,
  });
  buildRepairFeedback({ evidence_dir: evidenceDir, max_attempts: 1 });
  writeValidation({
    failures: ["simon_and_difference_semantics"],
    status: "failed",
    supports_verified_claim: false,
    repair_revision: "rerun-1",
  });

  const assessment = assessRepairAttempt({ evidence_dir: evidenceDir });

  assert.equal(assessment.status, "report_boundary_required");
  assert.equal(assessment.verified_correct, false);
  assert.equal(assessment.remaining_attempts, 0);
});

test("plugin registers the repair feedback and repair assessment tools", () => {
  const tools = [];
  plugin.register({
    registerTool(tool) {
      tools.push(tool);
    },
  });

  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes("nss_evimem_build_repair_feedback"));
  assert.ok(names.includes("nss_evimem_assess_repair_attempt"));
});
