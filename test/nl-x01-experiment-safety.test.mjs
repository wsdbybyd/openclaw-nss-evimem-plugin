import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  artifactBoundToCurrentRun,
  artifactHasNoOracleScalars,
  canonicalJson,
  classifyArmCorrectness,
  commandLineWorkspaceRegexSource,
  commandLineReferencesWorkspace,
  currentTaskProtocolEvidence,
  encodePowerShellScript,
  hasConsistentExactMetric,
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

test("currentTaskProtocolEvidence binds contract validation, strict guard, and registered capability to one task", () => {
  const taskContract = {
    case_id: "CBSC-V2-NL-X01",
    analysis_type: "differential",
    rounds: 10,
  };
  const capability = {
    analysis_type: "differential",
    rounds_supported: [10],
  };
  const validContractEvent = {
    ok: true,
    status: "valid_contract",
    task_contract: { rounds: 10, case_id: "CBSC-V2-NL-X01", analysis_type: "differential" },
  };
  const validGuardEvent = {
    decision: "allow",
    reasons: [],
    task_contract: taskContract,
    tool_capability: capability,
  };
  const registeredCapability = {
    rounds_supported: [10],
    analysis_type: "differential",
  };
  const capabilityRegistry = {
    "solver-check": {
      tool_name: "solver-check",
      capability: registeredCapability,
    },
  };

  assert.equal(canonicalJson(taskContract), canonicalJson(validContractEvent.task_contract));
  assert.notEqual(validGuardEvent.tool_capability, registeredCapability);
  assert.equal(currentTaskProtocolEvidence({
    contractEvents: [validContractEvent],
    guardEvents: [validGuardEvent],
    capabilityRegistry,
    taskContract,
  }), true);
  assert.equal(currentTaskProtocolEvidence({
    contractEvents: [validContractEvent],
    guardEvents: [{ ...validGuardEvent, task_contract: { ...taskContract, rounds: 9 } }],
    capabilityRegistry,
    taskContract,
  }), false);
  assert.equal(currentTaskProtocolEvidence({
    contractEvents: [{ ...validContractEvent, task_contract: { ...taskContract, rounds: 9 } }],
    guardEvents: [validGuardEvent],
    capabilityRegistry,
    taskContract,
  }), false);
  assert.equal(currentTaskProtocolEvidence({
    contractEvents: [validContractEvent],
    guardEvents: [{ ...validGuardEvent, tool_capability: { ...capability, rounds_supported: [9] } }],
    capabilityRegistry,
    taskContract,
  }), false);
});

test("classifyArmCorrectness never verifies an unsuccessful run and requires the full intervention gate", () => {
  const otherwisePerfect = {
    exactMetricMatch: true,
    instancePreserved: true,
    methodEvidence: true,
    boundaryOk: true,
    crossGroupContamination: false,
    fullInterventionRequirementsMet: true,
  };

  assert.equal(classifyArmCorrectness({ ...otherwisePerfect, runSucceeded: false }), "agent_run_failed");
  assert.equal(classifyArmCorrectness({ ...otherwisePerfect, runSucceeded: true }), "verified_correct");
  assert.equal(classifyArmCorrectness({
    ...otherwisePerfect,
    runSucceeded: true,
    fullInterventionRequirementsMet: false,
  }), "answer_matches_oracle_with_weak_evidence");
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
  assert.equal(hasExactProbability("The probability is 2^-17 (equivalent differential weight 17).", "2^-17"), true);
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
  assert.equal(hasExactWeight("The probability is 2^-17 (equivalent differential weight 17).", 17), true);
  assert.equal(hasExactWeight("The weight is 17.", 17), true);
  assert.equal(hasExactWeight("The weight is not 17; it is 18.", 17), false);
  assert.equal(hasExactWeight("Weight 17 is not correct; the actual weight is 18.", 17), false);
  assert.equal(hasExactWeight("The weight is 17, but a competing result reports weight 18.", 17), false);
  assert.equal(hasExactWeight("The weight is 17 or 18.", 17), false);
});

test("hasConsistentExactMetric rejects an incompatible explicitly reported companion metric", () => {
  const expectedProbability = "2^-25";
  const expectedWeight = 25;

  assert.equal(hasConsistentExactMetric("The probability is 2^-25.", expectedProbability, expectedWeight), true);
  assert.equal(hasConsistentExactMetric("The differential weight is 25.", expectedProbability, expectedWeight), true);
  assert.equal(hasConsistentExactMetric("The probability is 2^-25; the differential weight is 25.", expectedProbability, expectedWeight), true);
  assert.equal(hasConsistentExactMetric("The probability is 2^-25; for the 10-round trail the differential weight is 25.", expectedProbability, expectedWeight), true);
  assert.equal(hasConsistentExactMetric("The probability is 2^-99; the differential weight is 25.", expectedProbability, expectedWeight), false);
  assert.equal(hasConsistentExactMetric("The probability is 2^-25; the differential weight is 99.", expectedProbability, expectedWeight), false);
  assert.equal(hasConsistentExactMetric("The probability is 2^-99; the differential weight is 99.", expectedProbability, expectedWeight), false);
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

test("artifactHasNoOracleScalars scans every nested artifact field for oracle values", () => {
  const oracleValues = ["2^-25", "25"];
  const artifact = {
    case_id: "CBSC-V2-NL-X01",
    task_contract: { cipher: "SIMON32", rounds: 10 },
    diagnostics: {
      nested: ["public evidence", { leaked_metric: "2^-25" }],
    },
  };

  assert.equal(artifactHasNoOracleScalars(artifact, oracleValues), false);
  assert.equal(artifactHasNoOracleScalars({ ...artifact, diagnostics: { nested: ["public evidence"] } }, oracleValues), true);
});

test("artifactBoundToCurrentRun requires the current public run ID, case, and task contract", () => {
  const summary = {
    experiment_run_id: "b00b6f18-279f-45df-b388-9729c5598167",
    case_id: "CBSC-V2-NL-X01",
    task_contract: { rounds: 10, cipher: "SIMON32" },
  };
  const artifact = {
    experiment_run_id: summary.experiment_run_id,
    case_id: summary.case_id,
    task_contract: { cipher: "SIMON32", rounds: 10 },
  };

  assert.equal(artifactBoundToCurrentRun({ artifact, summary }), true);
  assert.equal(artifactBoundToCurrentRun({
    artifact: { ...artifact, experiment_run_id: "70c55f36-56af-41a6-94d4-20a46a1fd5c7" },
    summary,
  }), false);
  assert.equal(artifactBoundToCurrentRun({
    artifact: { case_id: artifact.case_id, task_contract: artifact.task_contract },
    summary,
  }), false);
});

test("runner delegates correctness and protocol evidence to helper functions", () => {
  const runnerSource = readFileSync(join(repoRoot, "experiments", "CBSC-V2-NL-X01", "run_openclaw_all_groups_experiment.mjs"), "utf8");

  assert.match(runnerSource, /currentTaskProtocolEvidence/);
  assert.match(runnerSource, /classifyArmCorrectness/);
});

test("runner does not follow symbolic links while collecting or copying workspace files", () => {
  const runnerSource = readFileSync(join(repoRoot, "experiments", "CBSC-V2-NL-X01", "run_openclaw_all_groups_experiment.mjs"), "utf8");
  const copyDirectorySource = runnerSource.slice(
    runnerSource.indexOf("function copyDirectoryIfExists"),
    runnerSource.indexOf("function listFiles"),
  );
  const listFilesSource = runnerSource.slice(
    runnerSource.indexOf("function listFiles"),
    runnerSource.indexOf("function commandLine"),
  );

  assert.match(runnerSource, /\blstatSync\b/);
  assert.match(copyDirectorySource, /lstatSync\(from\)/);
  assert.match(copyDirectorySource, /stats\.isSymbolicLink\(\)\)\s*\{\s*return false;/);
  assert.match(copyDirectorySource, /entryStats\.isSymbolicLink\(\)\)\s*\{\s*continue;/);
  assert.match(listFilesSource, /lstatSync\(full\)/);
  assert.match(listFilesSource, /stats\.isSymbolicLink\(\)\)\s*\{\s*return \[\];/);
});

test("runner persists its public run ID and verifier delegates artifact integrity checks to helpers", () => {
  const runnerSource = readFileSync(join(repoRoot, "experiments", "CBSC-V2-NL-X01", "run_openclaw_all_groups_experiment.mjs"), "utf8");
  const verifierSource = readFileSync(join(repoRoot, "experiments", "CBSC-V2-NL-X01", "verify_openclaw_all_groups_experiment.mjs"), "utf8");

  assert.match(runnerSource, /randomUUID/);
  assert.match(runnerSource, /experiment_run_id:\s*experimentRunId/);
  assert.match(runnerSource, /const boundValidation = \{\s*\.\.\.validation,\s*experiment_run_id:\s*experimentRunId,\s*\};/s);
  assert.match(runnerSource, /writeJson\(join\(evidenceDir, "artifact_claim_validation\.json"\), boundValidation\)/);
  assert.match(verifierSource, /artifactHasNoOracleScalars/);
  assert.match(verifierSource, /artifactBoundToCurrentRun/);
});
