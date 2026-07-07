import { isRecord, stableStringify } from "./evidence-store.js";
import type { JsonRecord, TaskContract, ToolCapability } from "./types.js";

const FIELD_ALIASES: Record<string, string[]> = {
  analysis_type: ["analysis_type", "analysis_types", "type", "types"],
  cipher: ["cipher", "ciphers", "application", "applications"],
  deliverables: ["deliverables", "produced_artifacts", "artifacts", "output", "outputs", "output_artifacts", "output_files", "files"],
  domain: ["domain", "domains"],
  method: ["method", "methods"],
  objective: ["objective", "objectives", "claim_type", "claim_types"],
  scope: ["scope", "scopes", "rounds", "nrounds"],
};

const GENERIC_TOKENS = new Set([
  "a",
  "an",
  "and",
  "analysis",
  "before",
  "by",
  "cipher",
  "cryptanalysis",
  "find",
  "for",
  "from",
  "in",
  "of",
  "or",
  "round",
  "rounds",
  "the",
  "to",
  "tool",
  "using",
  "verify",
  "with",
]);

export function capabilitySupportsContractFields(
  capabilityLike: ToolCapability,
  contract: TaskContract,
  fields: string[],
): boolean {
  return fields.every((field) => {
    const expected = contract[field];
    return isMissing(expected) || capabilityFieldMatches(capabilityLike, field, expected);
  });
}

export function capabilityFieldMatches(capabilityLike: ToolCapability, field: string, expected: unknown): boolean {
  if (isMissing(expected)) {
    return true;
  }

  const capability = unwrapCapability(capabilityLike);
  if (field === "deliverables") {
    return deliverablesMatch(capability, expected);
  }

  const directValues = collectFieldCandidates(capability, field);
  if (directValues.some((value) => semanticValueMatches(value, expected, field))) {
    return true;
  }

  const corpus = normalizeText(stableStringify(capability));
  return semanticTextMatches(corpus, expected, field);
}

export function formatCapabilityFieldValue(capabilityLike: ToolCapability, field: string): string {
  const directValues = collectFieldCandidates(unwrapCapability(capabilityLike), field);
  if (directValues.length === 0) {
    return "undefined";
  }
  return directValues
    .map((value) => typeof value === "string" ? value : stableStringify(value))
    .join("|");
}

export function unwrapCapability(capabilityLike: ToolCapability): JsonRecord {
  if (isRecord(capabilityLike.capability)) {
    return capabilityLike.capability;
  }
  return capabilityLike;
}

function collectFieldCandidates(capability: JsonRecord, field: string): unknown[] {
  const keys = new Set(FIELD_ALIASES[field] ?? [field]);
  const candidates: unknown[] = [];
  collectValuesByKey(capability, keys, candidates);

  if (field === "scope") {
    collectValuesByKey(capability, new Set(["limit_rounds", "round_count", "round_scope"]), candidates);
  }

  if (field === "objective") {
    collectValuesByKey(capability, new Set(["description", "output", "verification_status"]), candidates);
  }

  return candidates;
}

function collectValuesByKey(value: unknown, keys: Set<string>, out: unknown[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectValuesByKey(item, keys, out);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key)) {
      if (Array.isArray(child)) {
        out.push(...child);
      } else {
        out.push(child);
      }
    }
    if (isRecord(child) || Array.isArray(child)) {
      collectValuesByKey(child, keys, out);
    }
  }
}

function semanticValueMatches(actual: unknown, expected: unknown, field: string): boolean {
  if (Array.isArray(expected)) {
    return expected.every((item) => semanticValueMatches(actual, item, field));
  }

  if (Array.isArray(actual)) {
    return actual.some((item) => semanticValueMatches(item, expected, field));
  }

  if (field === "scope" && roundCountMatches(actual, expected)) {
    return true;
  }

  const actualText = normalizeText(actual);
  const expectedText = normalizeText(expected);
  if (actualText.length === 0 || expectedText.length === 0) {
    return false;
  }
  if (actualText === expectedText || actualText.includes(expectedText) || expectedText.includes(actualText)) {
    return true;
  }

  return semanticTextMatches(actualText, expected, field);
}

function deliverablesMatch(capability: JsonRecord, expected: unknown): boolean {
  if (!Array.isArray(expected)) {
    return capabilityFieldMatches(capability, "objective", expected);
  }

  const corpus = normalizeText(stableStringify(capability));
  return expected.every((item) => singleDeliverableMatches(corpus, item));
}

function singleDeliverableMatches(corpus: string, expected: unknown): boolean {
  const text = normalizeText(expected);
  if (text.length === 0) {
    return true;
  }

  if (text.includes("executable") && text.includes("code")) {
    return corpus.includes("executable")
      || corpus.includes("python")
      || corpus.includes("script")
      || corpus.includes(" py")
      || corpus.includes(" bounded search");
  }

  if (text.includes("input") && text.includes("difference")) {
    return corpus.includes("input difference") || corpus.includes("input diff") || corpus.includes("input_difference");
  }

  if (text.includes("output") && text.includes("mask")) {
    return corpus.includes("output linear mask")
      || corpus.includes("output mask")
      || corpus.includes("linear mask")
      || corpus.includes("output_linear_mask");
  }

  if (text.includes("round") && text.includes("split")) {
    return (corpus.includes("round") || corpus.includes("nrounds"))
      && (corpus.includes("phase") || corpus.includes("trail") || corpus.includes("differential") || corpus.includes("linear"));
  }

  if (text.includes("correlation") && text.includes("weight")) {
    return corpus.includes("correlation") && corpus.includes("weight");
  }

  if (text.includes("run") && text.includes("log")) {
    return corpus.includes("run log") || corpus.includes("run_log");
  }

  if (text.includes("result") && text.includes("json")) {
    return corpus.includes("result json")
      || (corpus.includes("result") && corpus.includes("json"));
  }

  if (text.includes("final") && text.includes("report")) {
    return corpus.includes("final report")
      || corpus.includes("final_report")
      || corpus.includes("final answer")
      || corpus.includes("final_answer");
  }

  if (text.includes("verification")) {
    return corpus.includes("verification")
      || corpus.includes("verify")
      || corpus.includes("multi key")
      || corpus.includes("nkeys");
  }

  return semanticTextMatches(corpus, expected, "objective");
}

function semanticTextMatches(corpus: string, expected: unknown, field: string): boolean {
  if (field === "scope" && roundCountMatches(corpus, expected)) {
    return true;
  }

  const expectedText = normalizeText(expected);
  if (expectedText.length === 0) {
    return false;
  }
  if (corpus.includes(expectedText)) {
    return true;
  }

  const tokens = meaningfulTokens(expectedText, field);
  if (tokens.length === 0) {
    return false;
  }

  const matched = tokens.filter((token) => corpus.includes(token));
  if (field === "domain" || field === "analysis_type") {
    return matched.length === tokens.length;
  }
  if (field === "objective") {
    return matched.length >= Math.min(3, tokens.length);
  }
  return matched.length === tokens.length;
}

function meaningfulTokens(text: string, field: string): string[] {
  const tokens = text
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !GENERIC_TOKENS.has(token));

  if ((field === "domain" || field === "analysis_type") && tokens.includes("differential") && tokens.includes("linear")) {
    return ["differential", "linear"];
  }
  return [...new Set(tokens)];
}

function roundCountMatches(actual: unknown, expected: unknown): boolean {
  const expectedRound = extractRoundCount(expected);
  if (expectedRound === null) {
    return false;
  }

  if (typeof actual === "number") {
    return actual === expectedRound;
  }

  const actualText = normalizeText(actual);
  if (actualText.length === 0) {
    return false;
  }
  return actualText.includes(`${expectedRound} round`)
    || actualText.includes(`nrounds ${expectedRound}`)
    || actualText.includes(`rounds ${expectedRound}`)
    || actualText.split(/\s+/).includes(String(expectedRound));
}

function extractRoundCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  const text = normalizeText(value);
  const match = text.match(/\b(\d+)\s*round\b/);
  if (match) {
    return Number(match[1]);
  }
  return null;
}

function normalizeText(value: unknown): string {
  if (typeof value === "string") {
    return normalizeRawString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return normalizeRawString(String(value));
  }
  if (value === undefined || value === null) {
    return "";
  }
  return normalizeRawString(stableStringify(value));
}

function normalizeRawString(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_/\\-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}
