# Agent Repair Feedback Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let NSS-EviMem identify a known invalid SIMON differential model, give the Agent actionable repair feedback, and track bounded repair attempts without self-certifying correctness.

**Architecture:** Add a narrow semantic source check to the differential verification profile. Add a repair-loop module that reads persisted validation and diagnosis artifacts, renders a direct Agent prompt, and records retry state. Register two helper tools in the existing plugin entry point; both are evidence-only controllers and never invoke a solver or hidden oracle.

**Tech Stack:** TypeScript, Node.js built-in filesystem APIs, node:test, existing NSS-EviMem evidence store.

---

### Task 1: Detect the invalid AND-difference abstraction

**Files:**
- Modify: `src/differential-metric-profile.ts`
- Test: `test/verification-profiles.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
test("rejects a SIMON model that treats AND output difference as input-difference AND", (t) => {
  const { root, evidenceDir, sourcePath } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(sourcePath, [
    "SIMON_ROTATIONS = (1, 8, 2)",
    "WORD_SIZE = 16",
    "gamma <= alpha",
    "gamma <= beta",
    "gamma >= alpha + beta - 1",
  ].join("\\n"), "utf8");
  const validation = validateArtifactClaims({
    task_contract: taskContract(), result: validResult(), source_paths: [sourcePath], evidence_dir: evidenceDir,
  });
  assert.ok(validation.failures.includes("simon_and_difference_semantics"));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test test/verification-profiles.test.mjs`

Expected: FAIL because `simon_and_difference_semantics` does not exist yet.

- [ ] **Step 3: Add the minimal source-pattern semantic check**

```ts
check(
  "simon_and_difference_semantics",
  !hasInvalidAndDifferenceAbstraction(sourceText),
  "high",
  "SIMON differential models must not encode the AND output difference as the bitwise AND of input differences; use a sound transition relation that preserves state dependence and rotation correlation.",
),
```

Implement `hasInvalidAndDifferenceAbstraction` as a strict recognizer for the
three-constraint `gamma <= alpha`, `gamma <= beta`, and
`gamma >= alpha + beta - 1` pattern, plus direct `gamma = alpha & beta`
notation. Do not reject unrelated AND use.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npm run build && node --test test/verification-profiles.test.mjs`

Expected: PASS, including the new semantic rejection.

### Task 2: Build and persist repair feedback

**Files:**
- Create: `src/repair-loop.ts`
- Modify: `src/index.ts`
- Test: `test/repair-loop.test.mjs`

- [ ] **Step 1: Write failing repair-feedback tests**

```js
test("buildRepairFeedback turns a rejected AND model into a direct repair instruction", (t) => {
  const evidenceDir = makeEvidenceDir(t, {
    failures: ["simon_and_difference_semantics"], status: "failed", supports_verified_claim: false,
  });
  const feedback = buildRepairFeedback({ evidence_dir: evidenceDir });
  assert.equal(feedback.status, "repair_required");
  assert.match(feedback.prompt_patch, /must not encode the AND output difference/i);
  assert.equal(feedback.requires_independent_verification, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/repair-loop.test.mjs`

Expected: FAIL because `src/repair-loop.ts` is missing.

- [ ] **Step 3: Implement `buildRepairFeedback`**

Define a `RepairFeedback` record with schema `nss_evimem.repair_feedback.v1`,
case id, retry budget, failed checks, direct instructions, prohibited actions,
fresh-artifact requirements, prompt patch, and persisted output paths.
Read `artifact_claim_validation.json` and `failure_diagnosis.json`; write
`repair_feedback.json`, `repair_feedback_events.jsonl`, and
`repair_prompt.md` into the evidence directory. Map the new semantic check to
an explicit instruction that names the invalid assumption and requires a
sound transition relation. Map all other failures to their stored validator
reasons.

- [ ] **Step 4: Register `nss_evimem_build_repair_feedback`**

Add it to `registerHelperTools` and expose optional `max_attempts`, `case_id`,
`task_contract`, and `evidence_dir` parameters. Keep `max_attempts` bounded to
the inclusive range 1 to 3.

- [ ] **Step 5: Run focused tests**

Run: `npm run build && node --test test/repair-loop.test.mjs`

Expected: PASS.

### Task 3: Record a bounded repair attempt

**Files:**
- Modify: `src/repair-loop.ts`
- Modify: `src/index.ts`
- Test: `test/repair-loop.test.mjs`

- [ ] **Step 1: Write failing state-machine tests**

```js
test("assessRepairAttempt requests independent verification after a fresh passing validation", (t) => {
  const evidenceDir = makeEvidenceDir(t, { failures: [], status: "passed", supports_verified_claim: true });
  const assessment = assessRepairAttempt({ evidence_dir: evidenceDir });
  assert.equal(assessment.status, "independent_verification_required");
  assert.equal(assessment.verified_correct, false);
});

test("assessRepairAttempt stops retrying when the budget is exhausted", (t) => {
  const evidenceDir = makeEvidenceDir(t, { failures: ["simon_and_difference_semantics"], status: "failed" });
  buildRepairFeedback({ evidence_dir: evidenceDir, max_attempts: 1 });
  const assessment = assessRepairAttempt({ evidence_dir: evidenceDir });
  assert.equal(assessment.status, "report_boundary_required");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/repair-loop.test.mjs`

Expected: FAIL because `assessRepairAttempt` is missing.

- [ ] **Step 3: Implement `assessRepairAttempt`**

Persist `repair_attempts.jsonl` and return schema
`nss_evimem.repair_attempt_assessment.v1`. Require a current repair feedback
record and a fresh validation record. If validation still fails and attempts
remain, return `repair_required`; if no attempts remain, return
`report_boundary_required`. If validation supports a verified claim, return
`independent_verification_required` and keep `verified_correct=false`.

- [ ] **Step 4: Register `nss_evimem_assess_repair_attempt`**

Expose optional `repair_feedback_path`, `artifact_validation_path`,
`attempt_summary`, and `evidence_dir` parameters. Do not accept any oracle or
expected-answer fields.

- [ ] **Step 5: Run focused tests**

Run: `npm run build && node --test test/repair-loop.test.mjs`

Expected: PASS.

### Task 4: Document and verify the plugin change

**Files:**
- Modify: `README.md`
- Modify: `experiments/CBSC-V2-NL-X01/run_openclaw_all_groups_experiment.mjs`
- Test: `test/nl-x01-experiment-safety.test.mjs`
- Test: `test/repair-loop.test.mjs`

- [ ] **Step 1: Add concise tool documentation**

Document the required call order:

```text
validate artifacts -> diagnose failure -> build repair feedback -> agent reruns -> validate fresh artifacts -> assess repair attempt -> independent verifier
```

State that independent verification is still required and that no oracle is
available to the plugin.

- [ ] **Step 2: Require the Full Intervention Agent to use the repair loop**

Extend the Full Intervention prompt with this sequence:

```text
first validation failure -> build repair feedback -> fresh artifacts -> second validation -> assess repair attempt
```

The prompt must forbid relabeling the prior artifact as repaired, must honor
the plugin retry budget, and must retain the independent-verification boundary.
Add a source-safety assertion that checks for both repair tools and the
`independent_verification_required` state.

- [ ] **Step 3: Run project verification**

Run: `npm run typecheck && npm run build && node --test test/verification-profiles.test.mjs test/repair-loop.test.mjs test/nl-x01-experiment-safety.test.mjs && git diff --check`

Expected: all tests pass and no whitespace errors.

- [ ] **Step 4: Commit source-only implementation**

```bash
git add src/differential-metric-profile.ts src/repair-loop.ts src/index.ts test/verification-profiles.test.mjs test/repair-loop.test.mjs README.md docs/superpowers/specs/2026-07-13-agent-repair-feedback-loop-design.md docs/superpowers/plans/2026-07-13-agent-repair-feedback-loop.md
git commit -m "feat: add agent repair feedback loop"
```

Do not stage `experiments/**/runs/**` or unrelated experiment script changes.
