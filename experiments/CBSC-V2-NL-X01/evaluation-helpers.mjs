function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedMetric(value) {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .replace(/\*\*/g, "^")
    .replace(/[{}()]/g, "")
    .toLowerCase();
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function artifactHasNoOracleScalars(artifact, oracleValues) {
  let serializedArtifact;
  try {
    serializedArtifact = JSON.stringify(artifact);
  } catch {
    return false;
  }
  if (typeof serializedArtifact !== "string") {
    return false;
  }

  const values = Array.isArray(oracleValues) ? oracleValues : [oracleValues];
  return values
    .map((value) => typeof value === "string" && value.trim()
      ? value
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : null)
    .filter(Boolean)
    .every((value) => !serializedArtifact.includes(value));
}

export function artifactBoundToCurrentRun({ artifact, summary }) {
  if (!isRecord(artifact) || !isRecord(summary)) {
    return false;
  }

  const experimentRunId = summary.experiment_run_id;
  return typeof experimentRunId === "string"
    && experimentRunId.trim().length > 0
    && artifact.experiment_run_id === experimentRunId
    && artifact.case_id === summary.case_id
    && canonicalJson(artifact.task_contract ?? null) === canonicalJson(summary.task_contract ?? null);
}

function isClauseBoundary(text, index) {
  const character = text[index];
  if (character !== ".") {
    return character === "!" || character === "?" || character === "\n";
  }
  return !/\d/.test(text[index - 1] ?? "") || !/\d/.test(text[index + 1] ?? "");
}

function clauseBounds(text, start, end) {
  let beforeBoundary = -1;
  for (let index = start - 1; index >= 0; index -= 1) {
    if (isClauseBoundary(text, index)) {
      beforeBoundary = index;
      break;
    }
  }

  let afterBoundary = text.length;
  for (let index = end; index < text.length; index += 1) {
    if (isClauseBoundary(text, index)) {
      afterBoundary = index;
      break;
    }
  }
  return { start: beforeBoundary + 1, end: afterBoundary };
}

function isNegatedAssertion(text, start, end) {
  const { start: clauseStart, end: clauseEnd } = clauseBounds(text, start, end);
  const before = text.slice(Math.max(clauseStart, start - 48), start);
  const after = text.slice(end, Math.min(clauseEnd, end + 48));
  return /\b(?:not|no|incorrect|false)\s*$/i.test(before)
    || /^\s*(?:is|was|are|were|be)?\s*(?:not|incorrect|false)\b/i.test(after);
}

function collectMatches(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => ({
    value: match[1],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function collectLabelledClauses(text, labelPattern) {
  const clauses = new Map();
  for (const match of text.matchAll(labelPattern)) {
    const bounds = clauseBounds(text, match.index, match.index + match[0].length);
    clauses.set(`${bounds.start}:${bounds.end}`, bounds);
  }
  return [...clauses.values()];
}

function lastLabelIndex(text, pattern) {
  let lastIndex = -1;
  for (const match of text.matchAll(pattern)) {
    lastIndex = match.index;
  }
  return lastIndex;
}

function collectMetricCandidates(text, bounds, labelPattern, otherMetricLabelPattern, acceptsCandidate = () => true) {
  const clause = text.slice(bounds.start, bounds.end);
  const candidatePattern = /(?<![\d.])((?:2\s*(?:\^|\*\*)\s*(?:\{\s*|\(\s*)?-\s*\d+(?:\.\d+)?(?:\s*\}|\s*\))?)|(?:\d+(?:\.\d+)?(?:e[+-]?\d+)?|\d+\s*\/\s*\d+))(?!\d|\.\d)/gi;
  return collectMatches(clause, candidatePattern).map((match) => ({
    ...match,
    start: match.start + bounds.start,
    end: match.end + bounds.start,
  })).filter((candidate) => {
    const precedingText = text.slice(bounds.start, candidate.start);
    const labelIndex = lastLabelIndex(precedingText, labelPattern);
    return acceptsCandidate(candidate.value)
      && labelIndex >= 0
      && labelIndex >= lastLabelIndex(precedingText, otherMetricLabelPattern);
  });
}

function labelledMetricMatch(text, labelPattern, otherMetricLabelPattern, isExpectedCandidate, acceptsCandidate) {
  return collectLabelledClauses(text, labelPattern).some((bounds) => {
    const candidates = collectMetricCandidates(text, bounds, labelPattern, otherMetricLabelPattern, acceptsCandidate);
    const expectedCandidates = candidates.filter(isExpectedCandidate);
    return expectedCandidates.some((candidate) => !isNegatedAssertion(text, candidate.start, candidate.end))
      && candidates
        .filter((candidate) => !isExpectedCandidate(candidate))
        .every((candidate) => isNegatedAssertion(text, candidate.start, candidate.end));
  });
}

function hasLabelledMetricCandidate(text, labelPattern, otherMetricLabelPattern, acceptsCandidate) {
  return collectLabelledClauses(text, labelPattern).some((bounds) => (
    collectMetricCandidates(text, bounds, labelPattern, otherMetricLabelPattern, acceptsCandidate).length > 0
  ));
}

const probabilityLabelPattern = /\b(?:probability|prob|p)\b/gi;
const weightLabelPattern = /(?:\b(?:differential\s+)?weight\b|\bminimum(?:\s+differential)?(?:\s+weight)?\b|\u6743\u91cd)/gi;

function isProbabilityMetricCandidate(value) {
  const candidate = normalizedMetric(value);
  if (/^2\^-\d+(?:\.\d+)?$/.test(candidate)) {
    return true;
  }
  if (/^\d+\/\d+$/.test(candidate)) {
    const [numerator, denominator] = candidate.split("/").map(Number);
    return denominator !== 0 && numerator >= 0 && numerator <= denominator;
  }
  if (!/^(?:\d+(?:\.\d+)?|\d+(?:\.\d+)?e[+-]?\d+)$/.test(candidate)) {
    return false;
  }
  const numericCandidate = Number(candidate);
  return Number.isFinite(numericCandidate) && numericCandidate >= 0 && numericCandidate <= 1;
}

export function strictGuardAllows(events) {
  return Array.isArray(events) && events.some((event) => event?.decision === "allow"
    && Array.isArray(event.reasons)
    && event.reasons.length === 0);
}

export function currentTaskProtocolEvidence({ contractEvents, guardEvents, capabilityRegistry, taskContract }) {
  if (!isRecord(taskContract)) {
    return false;
  }

  const currentContract = canonicalJson(taskContract);
  const registeredCapabilities = isRecord(capabilityRegistry)
    ? Object.values(capabilityRegistry)
      .map((record) => isRecord(record) ? record.capability : null)
      .filter(isRecord)
    : [];
  const hasValidCurrentContract = Array.isArray(contractEvents) && contractEvents.some((event) => event?.ok === true
    && event.status === "valid_contract"
    && canonicalJson(event.task_contract) === currentContract);
  const hasStrictCurrentGuard = Array.isArray(guardEvents) && guardEvents.some((event) => event?.decision === "allow"
    && Array.isArray(event.reasons)
    && event.reasons.length === 0
    && canonicalJson(event.task_contract) === currentContract
    && registeredCapabilities.some((capability) => canonicalJson(capability) === canonicalJson(event.tool_capability)));

  return hasValidCurrentContract && hasStrictCurrentGuard;
}

export function classifyArmCorrectness({
  runSucceeded,
  exactMetricMatch,
  instancePreserved,
  methodEvidence,
  boundaryOk,
  crossGroupContamination,
  fullInterventionRequirementsMet,
}) {
  if (runSucceeded !== true) {
    return "agent_run_failed";
  }
  if (crossGroupContamination === true) {
    return "protocol_violation";
  }
  if (exactMetricMatch === true
    && instancePreserved === true
    && methodEvidence === true
    && boundaryOk === true
    && fullInterventionRequirementsMet === true) {
    return "verified_correct";
  }
  if (exactMetricMatch === true) {
    return "answer_matches_oracle_with_weak_evidence";
  }
  if (instancePreserved === true || methodEvidence === true) {
    return "partially_correct_or_insufficient";
  }
  return "not_evaluable";
}

export function commandLineWorkspaceRegexSource(armWorkspaceRoot) {
  const root = String(armWorkspaceRoot ?? "").trim();
  return root ? `${escapeRegExp(root)}(?=[\\\\/\\s"']|$)` : "(?!)";
}

export function commandLineReferencesWorkspace(commandLine, armWorkspaceRoot) {
  return new RegExp(commandLineWorkspaceRegexSource(armWorkspaceRoot), "i").test(String(commandLine ?? ""));
}

export function encodePowerShellScript(script) {
  return Buffer.from(String(script ?? ""), "utf16le").toString("base64");
}

export function hasExactProbability(text, expectedProbability) {
  const answer = String(text ?? "");
  const expected = normalizedMetric(expectedProbability);
  if (!expected) {
    return false;
  }
  return labelledMetricMatch(
    answer,
    probabilityLabelPattern,
    weightLabelPattern,
    (candidate) => normalizedMetric(candidate.value) === expected,
    isProbabilityMetricCandidate,
  );
}

export function hasExactWeight(text, expectedWeight) {
  const answer = String(text ?? "");
  const expected = Number(expectedWeight);
  if (!Number.isFinite(expected)) {
    return false;
  }

  return labelledMetricMatch(
    answer,
    weightLabelPattern,
    probabilityLabelPattern,
    (candidate) => Number(candidate.value) === expected,
  );
}

export function hasConsistentExactMetric(text, expectedProbability, expectedWeight) {
  const answer = String(text ?? "");
  const exactProbabilityMatch = hasExactProbability(answer, expectedProbability);
  const exactWeightMatch = hasExactWeight(answer, expectedWeight);
  const reportsProbability = hasLabelledMetricCandidate(
    answer,
    probabilityLabelPattern,
    weightLabelPattern,
    isProbabilityMetricCandidate,
  );
  const reportsWeight = hasLabelledMetricCandidate(answer, weightLabelPattern, probabilityLabelPattern);

  return (exactProbabilityMatch || exactWeightMatch)
    && (!reportsProbability || exactProbabilityMatch)
    && (!reportsWeight || exactWeightMatch);
}

export function oracleScalarValues(value) {
  const values = [];

  function visit(candidate) {
    if (typeof candidate === "string" && candidate.trim()) {
      values.push(candidate);
    } else if (typeof candidate === "number" && Number.isFinite(candidate)) {
      values.push(String(candidate));
    } else if (Array.isArray(candidate)) {
      candidate.forEach(visit);
    } else if (candidate && typeof candidate === "object") {
      Object.values(candidate).forEach(visit);
    }
  }

  visit(value);
  return [...new Set(values)].sort();
}

export function oracleAnswerScalars(oracle) {
  return oracleScalarValues(isRecord(oracle) ? oracle.oracle_answer : undefined);
}

export function hasExpectedDifferentialMetricProfile(profile) {
  return isRecord(profile)
    && profile.id === "differential_metric_v1"
    && profile.version === 1
    && profile.primitive_profile === "simon_family_v1"
    && profile.claim_mode === "exact_or_honest_bound";
}
