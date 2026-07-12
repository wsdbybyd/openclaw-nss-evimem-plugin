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

function collectMetricCandidates(text, bounds) {
  const clause = text.slice(bounds.start, bounds.end);
  const candidatePattern = /(?<![\d.])((?:2\s*(?:\^|\*\*)\s*(?:\{\s*|\(\s*)?-\s*\d+(?:\.\d+)?(?:\s*\}|\s*\))?)|(?:\d+(?:\.\d+)?(?:e[+-]?\d+)?|\d+\s*\/\s*\d+))(?!\d|\.\d)/gi;
  return collectMatches(clause, candidatePattern).map((match) => ({
    ...match,
    start: match.start + bounds.start,
    end: match.end + bounds.start,
  }));
}

function labelledMetricMatch(text, labelPattern, isExpectedCandidate) {
  return collectLabelledClauses(text, labelPattern).some((bounds) => {
    const candidates = collectMetricCandidates(text, bounds);
    const expectedCandidates = candidates.filter(isExpectedCandidate);
    return expectedCandidates.some((candidate) => !isNegatedAssertion(text, candidate.start, candidate.end))
      && candidates
        .filter((candidate) => !isExpectedCandidate(candidate))
        .every((candidate) => isNegatedAssertion(text, candidate.start, candidate.end));
  });
}

export function strictGuardAllows(events) {
  return Array.isArray(events) && events.some((event) => event?.decision === "allow"
    && Array.isArray(event.reasons)
    && event.reasons.length === 0);
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
    /\b(?:probability|prob|p)\b/gi,
    (candidate) => normalizedMetric(candidate.value) === expected,
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
    /(?:\b(?:differential\s+)?weight\b|\bminimum(?:\s+differential)?(?:\s+weight)?\b|\u6743\u91cd)/gi,
    (candidate) => Number(candidate.value) === expected,
  );
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
