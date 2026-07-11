import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runnerSource = readFileSync(join(repoRoot, "experiments", "CBSC-V2-NL-X01", "run_openclaw_all_groups_experiment.mjs"), "utf8");
const verifierSource = readFileSync(join(repoRoot, "experiments", "CBSC-V2-NL-X01", "verify_openclaw_all_groups_experiment.mjs"), "utf8");

function functionSource(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start);
  assert.notEqual(start, -1, `missing ${name}`);
  assert.notEqual(end, -1, `missing ${nextName}`);
  return source.slice(start, end);
}

test("isolates deletion to one known experiment child and nested arm workspaces", () => {
  const resetSource = functionSource(runnerSource, "resetIsolatedWorkspaceRoot", "writeJson");

  assert.match(runnerSource, /const workspaceIsolationBase = resolve\(/);
  assert.match(runnerSource, /const workspaceIsolationRoot = join\(workspaceIsolationBase, "cbsc_v2_nl_x01_all_groups_isolated_latest"\);/);
  assert.match(resetSource, /resetDirectory\(workspaceIsolationBase, workspaceIsolationRoot\);/);
  assert.doesNotMatch(resetSource, /readdirSync\(/);
  assert.match(runnerSource, /const armWorkspaceRoot = join\(workspaceIsolationRoot, arm\.mode\);/);
  assert.match(runnerSource, /resetDirectory\(workspaceIsolationRoot, armWorkspaceRoot\);/);
});

test("cleans up only Python processes tied to the exact arm workspace", () => {
  const cleanupSource = functionSource(runnerSource, "cleanupArmProcesses", "writeCommandResult");

  assert.match(cleanupSource, /\$fragment = \$\{JSON\.stringify\(armWorkspaceRoot\)\}/);
  assert.match(cleanupSource, /\$_\.CommandLine\.Contains\(\$fragment\)/);
  assert.doesNotMatch(cleanupSource, /simon32/i);
  assert.doesNotMatch(cleanupSource, /work[\\/](?:artifacts)/i);
  assert.doesNotMatch(cleanupSource, /-like '\*/);
});

test("matches exact metrics from dynamic oracle probability and weight on answer-facing text only", () => {
  const probabilitySource = functionSource(runnerSource, "hasExactProbability", "hasExactWeight");
  const weightSource = functionSource(runnerSource, "hasExactWeight", "hasInstanceBoundary");
  const evaluatorSource = functionSource(runnerSource, "evaluateArm", "importDistModule");

  assert.match(probabilitySource, /function hasExactProbability\(text, expectedProbability\)/);
  assert.match(weightSource, /function hasExactWeight\(text, expectedWeight\)/);
  assert.doesNotMatch(`${probabilitySource}\n${weightSource}`, /\b25\b/);
  assert.match(evaluatorSource, /hasExactProbability\(answerText, expectedProbability\)/);
  assert.match(evaluatorSource, /hasExactWeight\(answerText, expectedWeight\)/);
  assert.match(evaluatorSource, /const finalAnswerText = readTextIfExists\(join\(workspaceOutputDir, "final_answer\.md"\)\);/);
  assert.doesNotMatch(evaluatorSource, /collectTextFromFiles\(/);
  assert.doesNotMatch(evaluatorSource, /evidenceText/);
});

test("requires Full Intervention protocol evidence before assigning verified_correct", () => {
  const evaluatorSource = functionSource(runnerSource, "evaluateArm", "importDistModule");

  assert.match(evaluatorSource, /const fullInterventionRequirementsMet = !arm\.fullIntervention \|\| \(/);
  assert.match(evaluatorSource, /contractValid\s*&&\s*guardAllow\s*&&\s*capabilityRecorded/);
  assert.match(evaluatorSource, /artifactValidation\?\.supports_verified_claim === true/);
  assert.match(evaluatorSource, /boundaryOk\s*&&\s*fullInterventionRequirementsMet/);
});

test("verifier rejects oracle leakage and requires Full Intervention evidence for verified_correct", () => {
  assert.match(verifierSource, /function collectStringValues\(/);
  assert.match(verifierSource, /collectStringValues\(summary\.oracle_expected\)/);
  assert.match(verifierSource, /oracleValues\.every\(\(value\) => !artifactTaskContract\.includes\(value\)\)/);
  assert.match(verifierSource, /fullInterventionProtocolEvidence[, :]/);
  assert.match(verifierSource, /fullIntervention\.contract_valid === true/);
  assert.match(verifierSource, /fullIntervention\.tool_semantic_match === true/);
  assert.match(verifierSource, /fullIntervention\.tool_capability_recorded === true/);
  assert.match(verifierSource, /artifactValidation\.supports_verified_claim === true/);
  assert.match(verifierSource, /fullInterventionVerifiedClaimGated:/);
});
