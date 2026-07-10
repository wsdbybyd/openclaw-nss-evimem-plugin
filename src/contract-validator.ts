import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { capabilityFieldMatches, capabilitySupportsContractFields } from "./capability-matcher.js";
import { getEvidenceDir, isRecord, stableStringify, utcNow } from "./evidence-store.js";
import { readToolCapabilityRegistry } from "./tool-capability-registry.js";
import { resolveVerificationProfile } from "./verification-profile-registry.js";
import type {
  ContractValidationResult,
  ContractValidationStatus,
  JsonRecord,
  PluginHookToolContext,
  TaskContract,
  ToolCapabilityRecord,
} from "./types.js";

const BASE_REQUIRED_FIELDS = ["domain", "analysis_type", "objective", "scope"] as const;

export function validateTaskContract(params: {
  task_contract: TaskContract;
  required_fields?: string[];
  supported_domains?: string[];
  supported_analysis_types?: string[];
  supported_methods?: string[];
  supported_scopes?: string[];
  require_matching_tool?: boolean;
  save_as_current?: boolean;
  ctx?: PluginHookToolContext;
  evidence_dir?: string;
}): ContractValidationResult {
  const evidenceDir = getEvidenceDir(params.ctx, params.evidence_dir);
  mkdirSync(evidenceDir, { recursive: true });

  const missingFields = missingRequiredFields(params.task_contract, params.required_fields);
  const profileResolution = resolveVerificationProfile(params.task_contract);
  const invalidReasons = [
    ...invalidContractReasons(params.task_contract),
    ...profileResolution.invalid_reasons,
  ];
  const unsupportedReasons = [
    ...unsupportedContractReasons(params),
    ...profileResolution.unsupported_reasons,
  ];
  const matchingTools = params.require_matching_tool
    ? findMatchingTools(evidenceDir, params.task_contract)
    : [];
  if (params.require_matching_tool && missingFields.length === 0 && invalidReasons.length === 0 && matchingTools.length === 0) {
    unsupportedReasons.push("no registered tool capability supports this task contract");
  }

  const status = contractStatus(missingFields, invalidReasons, unsupportedReasons);
  const saveAsCurrent = params.save_as_current !== false && status === "valid_contract";
  const result: ContractValidationResult = {
    timestamp: utcNow(),
    status,
    ok: status === "valid_contract",
    task_contract: params.task_contract,
    missing_fields: missingFields,
    reasons: [...invalidReasons, ...unsupportedReasons],
    matching_tools: matchingTools,
    saved_as_current: saveAsCurrent,
    verification_profile: profileResolution.profile,
    warnings: profileResolution.warnings,
  };

  appendFileSync(join(evidenceDir, "contract_validation_events.jsonl"), `${stableStringify(result)}\n`, "utf8");
  if (saveAsCurrent) {
    writeFileSync(join(evidenceDir, "task_contract.json"), stableStringify(params.task_contract, 2), "utf8");
  }
  return result;
}

function missingRequiredFields(contract: TaskContract, explicitFields?: string[]): string[] {
  const required = new Set<string>(explicitFields ?? BASE_REQUIRED_FIELDS);
  if (contract.domain === "symmetric_cryptanalysis") {
    required.add("cipher");
  }
  if (contract.scope === "full_cipher") {
    required.add("rounds");
  }

  return [...required].filter((field) => isMissing(contract[field]));
}

function invalidContractReasons(contract: TaskContract): string[] {
  const reasons: string[] = [];
  if (contract.rounds !== undefined && (!Number.isInteger(contract.rounds) || Number(contract.rounds) <= 0)) {
    reasons.push("rounds must be a positive integer");
  }
  if (contract.required_artifacts !== undefined && !isStringArray(contract.required_artifacts)) {
    reasons.push("required_artifacts must be an array of strings");
  }
  if (contract.method === "heuristic" && typeof contract.objective === "string") {
    const objective = contract.objective.toLowerCase();
    if (objective.startsWith("best_") || objective.includes("optimal")) {
      reasons.push("heuristic method cannot support best or optimal objective claims");
    }
  }
  return reasons;
}

function unsupportedContractReasons(params: {
  task_contract: TaskContract;
  supported_domains?: string[];
  supported_analysis_types?: string[];
  supported_methods?: string[];
  supported_scopes?: string[];
}): string[] {
  const contract = params.task_contract;
  const checks: Array<[string, unknown, string[] | undefined]> = [
    ["domain", contract.domain, params.supported_domains],
    ["analysis_type", contract.analysis_type, params.supported_analysis_types],
    ["method", contract.method, params.supported_methods],
    ["scope", contract.scope, params.supported_scopes],
  ];

  const reasons: string[] = [];
  for (const [field, value, supported] of checks) {
    if (supported && !supported.includes(String(value))) {
      reasons.push(`${field} is unsupported: ${String(value)}`);
    }
  }
  return reasons;
}

function findMatchingTools(evidenceDir: string, contract: TaskContract): string[] {
  const registry = readToolCapabilityRegistry(evidenceDir);
  return Object.values(registry)
    .filter((record) => capabilitySupportsContract(record, contract))
    .map((record) => record.tool_name)
    .sort();
}

function capabilitySupportsContract(record: ToolCapabilityRecord, contract: TaskContract): boolean {
  const capability = record.capability;
  if (!capabilitySupportsContractFields(capability, contract, ["domain", "analysis_type", "method", "scope"])) {
    return false;
  }

  if (!isMissing(contract.objective) && !objectiveMatches(capability, String(contract.objective))) {
    return false;
  }

  if (isStringArray(contract.required_artifacts) && isStringArray(capability.produced_artifacts)) {
    for (const artifact of contract.required_artifacts) {
      if (!capability.produced_artifacts.includes(artifact)) {
        return false;
      }
    }
  }
  return true;
}

function objectiveMatches(capability: JsonRecord, objective: string): boolean {
  return (
    valueMatches(capability.objective, objective)
    || valueMatches(capability.claim_type, objective)
    || valueMatches(capability.claim_types, objective)
    || capabilityFieldMatches(capability, "objective", objective)
  );
}

function valueMatches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) {
    return actual.some((item) => stableStringify(item) === stableStringify(expected));
  }
  return stableStringify(actual) === stableStringify(expected);
}

function contractStatus(
  missingFields: string[],
  invalidReasons: string[],
  unsupportedReasons: string[],
): ContractValidationStatus {
  if (missingFields.length > 0) {
    return "incomplete_contract";
  }
  if (invalidReasons.length > 0) {
    return "invalid_contract";
  }
  if (unsupportedReasons.length > 0) {
    return "unsupported_contract";
  }
  return "valid_contract";
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
