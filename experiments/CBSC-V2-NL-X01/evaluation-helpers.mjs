function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function powerOfTwoExponent(probability) {
  const match = String(probability ?? "").trim().match(/^2\s*(?:\^|\*\*)\s*(?:\{|\()?\s*-\s*(\d+(?:\.\d+)?)\s*(?:\}|\))?$/i);
  return match?.[1] ?? null;
}

function normalizedMetric(value) {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .replace(/\*\*/g, "^")
    .replace(/[{}()]/g, "")
    .toLowerCase();
}

function clauseAround(text, start, end) {
  const beforeBoundary = Math.max(
    text.lastIndexOf(".", start - 1),
    text.lastIndexOf(";", start - 1),
    text.lastIndexOf("!", start - 1),
    text.lastIndexOf("?", start - 1),
    text.lastIndexOf("\n", start - 1),
  );
  const afterCandidates = [".", ";", "!", "?", "\n"]
    .map((delimiter) => text.indexOf(delimiter, end))
    .filter((index) => index !== -1);
  const afterBoundary = afterCandidates.length > 0 ? Math.min(...afterCandidates) : text.length;
  return text.slice(beforeBoundary + 1, afterBoundary);
}

function isNegatedAssertion(text, start, end) {
  return /\b(?:not|no|incorrect|false|isn't|isnt|doesn't|doesnt)\b/i.test(clauseAround(text, start, end));
}

function collectMatches(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => ({
    value: match[1],
    start: match.index,
    end: match.index + match[0].length,
  }));
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

export function hasExactProbability(text, expectedProbability) {
  const answer = String(text ?? "");
  const expectedExponent = powerOfTwoExponent(expectedProbability);

  if (!expectedExponent) {
    const expected = normalizedMetric(expectedProbability);
    if (!expected || !normalizedMetric(answer).includes(expected)) {
      return false;
    }
    const expectedSource = String(expectedProbability).trim().split(/\s+/).map(escapeRegExp).join("\\s*");
    const expectedMatches = collectMatches(answer, new RegExp(`(${expectedSource})`, "gi"));
    if (expectedMatches.length === 0 || expectedMatches.some((match) => isNegatedAssertion(answer, match.start, match.end))) {
      return false;
    }
    const probabilityPattern = /\b(?:probability|prob|p)\b[^0-9\n]{0,40}(\d+(?:\.\d+)?(?:e[+-]?\d+)?|\d+\s*\/\s*\d+)(?![\d/])/gi;
    return collectMatches(answer, probabilityPattern)
      .filter((match) => normalizedMetric(match.value) !== expected)
      .every((match) => isNegatedAssertion(answer, match.start, match.end));
  }

  const powerPattern = /2\s*(?:\^|\*\*)\s*(?:\{\s*|\(\s*)?-\s*(\d+(?:\.\d+)?)(?:\s*\}|\s*\))?(?!\d)/gi;
  const matches = collectMatches(answer, powerPattern);
  const expectedMatches = matches.filter((match) => match.value === expectedExponent);
  if (expectedMatches.length === 0 || expectedMatches.some((match) => isNegatedAssertion(answer, match.start, match.end))) {
    return false;
  }
  return matches
    .filter((match) => match.value !== expectedExponent)
    .every((match) => isNegatedAssertion(answer, match.start, match.end));
}

export function hasExactWeight(text, expectedWeight) {
  const answer = String(text ?? "");
  const expected = Number(expectedWeight);
  if (!Number.isFinite(expected)) {
    return false;
  }

  const weightPattern = /(?:\b(?:differential\s+)?weight\b|\bminimum(?:\s+differential)?(?:\s+weight)?\b|\u6743\u91cd)[^0-9\n]{0,40}(\d+(?:\.\d+)?)(?!\d)/gi;
  const matches = collectMatches(answer, weightPattern);
  const expectedMatches = matches.filter((match) => Number(match.value) === expected);
  if (expectedMatches.length === 0 || expectedMatches.some((match) => isNegatedAssertion(answer, match.start, match.end))) {
    return false;
  }
  return matches
    .filter((match) => Number(match.value) !== expected)
    .every((match) => isNegatedAssertion(answer, match.start, match.end));
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
