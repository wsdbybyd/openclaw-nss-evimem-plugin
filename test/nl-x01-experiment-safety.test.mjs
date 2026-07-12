import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  commandLineWorkspaceRegexSource,
  commandLineReferencesWorkspace,
  encodePowerShellScript,
  hasExactProbability,
  hasExactWeight,
  oracleScalarValues,
  strictGuardAllows,
} from "../experiments/CBSC-V2-NL-X01/evaluation-helpers.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("strictGuardAllows requires an exact allow decision with no reasons", () => {
  assert.equal(strictGuardAllows([{ decision: "allow", reasons: [] }]), true);
  assert.equal(strictGuardAllows([{ decision: "allow_after_check", reasons: [] }]), false);
  assert.equal(strictGuardAllows([{ decision: "allow", reasons: ["capability mismatch"] }]), false);
  assert.equal(strictGuardAllows([{ decision: "allow" }]), false);
});

test("commandLineReferencesWorkspace honors only workspace path boundaries", () => {
  const armWorkspace = "C:\\isolated\\cbsc_v2_nl_x01\\baseline";

  assert.equal(commandLineReferencesWorkspace(`python.exe \"${armWorkspace}\"`, armWorkspace), true);
  assert.equal(commandLineReferencesWorkspace(`python.exe ${armWorkspace}\\work\\solve.py`, armWorkspace), true);
  assert.equal(commandLineReferencesWorkspace(`python.exe ${armWorkspace}-old\\work\\solve.py`, armWorkspace), false);
  assert.equal(commandLineReferencesWorkspace("python.exe C:\\other\\baseline\\solve.py", armWorkspace), false);
  assert.equal(commandLineReferencesWorkspace(`python.exe ${armWorkspace}.backup\\solve.py`, armWorkspace), false);
});

test("encodePowerShellScript preserves cleanup scripts and safely applies workspace boundaries", () => {
  const armWorkspace = "C:\\isolated\\cbsc_v2_nl_x01\\baseline";
  const workspacePattern = commandLineWorkspaceRegexSource(armWorkspace);
  const powerShellWorkspacePattern = `'${workspacePattern.replaceAll("'", "''")}'`;
  const powerShellLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
  const script = [
    `$workspacePattern = ${powerShellWorkspacePattern}`,
    `$baseline = ${powerShellLiteral(`${armWorkspace}\\work\\solve.py`)}`,
    `$baselineOld = ${powerShellLiteral(`${armWorkspace}-old\\work\\solve.py`)}`,
    "if (($baseline -match $workspacePattern) -and -not ($baselineOld -match $workspacePattern)) { Write-Output 'workspace-boundary-ok'; exit 0 }",
    "Write-Error 'workspace boundary mismatch'; exit 1",
  ].join("\n");
  const encodedScript = encodePowerShellScript(script);

  assert.equal(Buffer.from(encodedScript, "base64").toString("utf16le"), script);

  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /workspace-boundary-ok/);
});

test("hasExactProbability accepts the expected dynamic metric but rejects negated or competing claims", () => {
  assert.equal(hasExactProbability("The probability is 2^(-17).", "2^-17"), true);
  assert.equal(hasExactProbability("The probability is 0.2.", "0.2"), true);
  assert.equal(hasExactProbability("The probability is not 2^-17; it is 2^-18.", "2^-17"), false);
  assert.equal(hasExactProbability("2^-17 is not the probability; the probability is 2^-18.", "2^-17"), false);
  assert.equal(hasExactProbability("The probability is 2^-17, while another claimed probability is 2^-18.", "2^-17"), false);
  assert.equal(hasExactProbability("The probability is 0.2, while a competing probability is 0.3.", "0.2"), false);
  assert.equal(hasExactProbability("The probability is 0.2 or 0.3.", "0.2"), false);
  assert.equal(hasExactProbability("The reported metric is 10.2.", "0.2"), false);
  assert.equal(hasExactProbability("The probability is not 0.2; it is 0.3.", "0.2"), false);
});

test("hasExactWeight accepts the expected dynamic metric but rejects negated or competing claims", () => {
  assert.equal(hasExactWeight("The minimum differential weight is 17.", 17), true);
  assert.equal(hasExactWeight("The weight is 17.", 17), true);
  assert.equal(hasExactWeight("The weight is not 17; it is 18.", 17), false);
  assert.equal(hasExactWeight("Weight 17 is not correct; the actual weight is 18.", 17), false);
  assert.equal(hasExactWeight("The weight is 17, but a competing result reports weight 18.", 17), false);
  assert.equal(hasExactWeight("The weight is 17 or 18.", 17), false);
});

test("oracleScalarValues includes nested strings and finite numeric oracle values", () => {
  assert.deepEqual(
    oracleScalarValues({
      probability: "2^-25",
      primary_weight: 25,
      nested: ["SIMON32", { rounds: 10, blank: "", invalid: Number.POSITIVE_INFINITY }],
    }),
    ["10", "25", "2^-25", "SIMON32"],
  );
});

test("runner and verifier delegate integrity-sensitive behavior to the helper module", () => {
  const runnerSource = readFileSync(join(repoRoot, "experiments", "CBSC-V2-NL-X01", "run_openclaw_all_groups_experiment.mjs"), "utf8");
  const verifierSource = readFileSync(join(repoRoot, "experiments", "CBSC-V2-NL-X01", "verify_openclaw_all_groups_experiment.mjs"), "utf8");

  assert.match(runnerSource, /strictGuardAllows/);
  assert.match(runnerSource, /commandLineWorkspaceRegexSource/);
  assert.match(runnerSource, /encodePowerShellScript/);
  assert.match(runnerSource, /-EncodedCommand/);
  assert.doesNotMatch(runnerSource, /"-Command", command/);
  assert.match(runnerSource, /hasExactProbability\(answerText, expectedProbability\)/);
  assert.match(runnerSource, /hasExactWeight\(answerText, expectedWeight\)/);
  assert.match(runnerSource, /task_contract:\s*taskContract/);
  assert.match(verifierSource, /oracleScalarValues\(summary\.oracle_expected\)/);
  assert.match(verifierSource, /artifactBoundToCurrentRun/);
  assert.match(verifierSource, /artifactValidation\.case_id === summary\.case_id/);
  assert.match(verifierSource, /oracleExpectationPresent/);
  assert.match(verifierSource, /oracleRemainsOffline:\s*oracleExpectationPresent/);
});
