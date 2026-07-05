import { getCallId, isRecord, recordToolEvidence, stableStringify, utcNow } from "./evidence-store.js";
import { diagnoseFailure } from "./failure-diagnosis.js";
import { validateTaskContract } from "./contract-validator.js";
import { importEvidenceMemoryPack } from "./pack-importer.js";
import { promoteEvidenceToMemory, retrieveMemories } from "./memory-store.js";
import { decideGuardRoute, writeGuardEvent } from "./router.js";
import { listToolCapabilities, registerToolCapability } from "./tool-capability-registry.js";
import type {
  AgentToolResult,
  AnyAgentTool,
  JsonRecord,
  PendingToolCall,
  PluginApi,
  PluginHookAfterToolCallEvent,
  PluginHookBeforeToolCallEvent,
  PluginHookToolContext,
} from "./types.js";

const pendingCalls = new Map<string, PendingToolCall>();

const emptyConfigSchema = {
  safeParse(value: unknown) {
    if (value === undefined || (isRecord(value) && Object.keys(value).length === 0)) {
      return { success: true, data: value };
    }
    return {
      success: false,
      error: { issues: [{ path: [], message: "config must be empty" }] },
    };
  },
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
};

export default {
  id: "openclaw-nss-evimem-plugin",
  name: "OpenClaw NSS-EviMem",
  description: "Generic evidence capture, evidence-backed memory, and tool-governance decisions for OpenClaw.",
  configSchema: emptyConfigSchema,
  register(api: PluginApi) {
    registerHooks(api);
    registerHelperTools(api);
    api.logger?.info?.("openclaw-nss-evimem-plugin activated");
  },
};

function registerHooks(api: PluginApi): void {
  api.on?.(
    "before_tool_call",
    async (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => {
      const toolName = event.toolName ?? ctx.toolName ?? "unknown-tool";
      const callId = getCallId(event, ctx);
      pendingCalls.set(callId, {
        startedAt: Date.now(),
        timestamp: utcNow(),
        toolName,
        args: event.params ?? {},
        callId,
        runId: event.runId ?? ctx.runId,
      });
    },
    { priority: 5 },
  );

  api.on?.(
    "after_tool_call",
    async (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => {
      const callId = getCallId(event, ctx);
      const pending = pendingCalls.get(callId);
      pendingCalls.delete(callId);

      const evidence = recordToolEvidence({
        timestamp: pending?.timestamp ?? utcNow(),
        case_id: String(ctx.sessionId ?? ctx.sessionKey ?? "openclaw_session"),
        run_id: pending?.runId ?? event.runId ?? ctx.runId ?? null,
        tool_call_id: event.toolCallId ?? ctx.toolCallId ?? null,
        tool_name: pending?.toolName ?? event.toolName ?? ctx.toolName ?? "unknown-tool",
        args: pending?.args ?? event.params ?? {},
        result: event.result ?? null,
        elapsed_ms: event.durationMs ?? (pending ? Date.now() - pending.startedAt : null),
        ok: event.error == null,
        error: event.error ?? null,
        source: "openclaw-nss-evimem-after_tool_call",
        ctx,
      });

      api.logger?.info?.(`NSS-EviMem evidence recorded: ${evidence.evidence_id} (${evidence.tool_name})`);
    },
    { priority: 5 },
  );
}

function registerHelperTools(api: PluginApi): void {
  for (const tool of [
    createPromoteMemoryTool(),
    createRetrieveMemoryTool(),
    createGuardDecisionTool(),
    createImportPackTool(),
    createRegisterToolCapabilityTool(),
    createListToolCapabilitiesTool(),
    createValidateContractTool(),
    createDiagnoseFailureTool(),
  ]) {
    api.registerTool?.(tool, { name: tool.name });
  }
}

function createPromoteMemoryTool(): AnyAgentTool {
  return {
    name: "nss_evimem_promote_memory",
    label: "Promote Evidence Memory",
    description: "Promote an existing evidence record into an evidence-backed memory record.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["evidence_id", "claim", "task_contract"],
      properties: {
        evidence_id: { type: "string" },
        claim: { type: "string" },
        task_contract: { type: "object" },
        tags: { type: "array", items: { type: "string" } },
        metadata: { type: "object" },
        evidence_dir: { type: "string" },
      },
    },
    async execute(_toolCallId: string, rawParams: unknown): Promise<AgentToolResult> {
      const params = requireRecord(rawParams);
      const memory = promoteEvidenceToMemory({
        evidence_id: requireString(params.evidence_id, "evidence_id"),
        claim: requireString(params.claim, "claim"),
        task_contract: requireRecord(params.task_contract),
        tags: optionalStringArray(params.tags),
        metadata: isRecord(params.metadata) ? params.metadata : {},
        evidence_dir: optionalString(params.evidence_dir),
      });
      return jsonToolResult(memory);
    },
  };
}

function createRetrieveMemoryTool(): AnyAgentTool {
  return {
    name: "nss_evimem_retrieve_memory",
    label: "Retrieve Evidence Memory",
    description: "Retrieve evidence-backed memory records that match a provided task contract.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["task_contract"],
      properties: {
        task_contract: { type: "object" },
        tags: { type: "array", items: { type: "string" } },
        evidence_dir: { type: "string" },
      },
    },
    async execute(_toolCallId: string, rawParams: unknown): Promise<AgentToolResult> {
      const params = requireRecord(rawParams);
      const result = retrieveMemories({
        task_contract: requireRecord(params.task_contract),
        tags: optionalStringArray(params.tags),
        evidence_dir: optionalString(params.evidence_dir),
      });
      return jsonToolResult(result);
    },
  };
}

function createGuardDecisionTool(): AnyAgentTool {
  return {
    name: "nss_evimem_guard_decision",
    label: "NSS-EviMem Guard Decision",
    description: "Compare a task contract with a tool capability and record a generic guard decision.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["requested_tool", "task_contract", "tool_capability"],
      properties: {
        requested_tool: { type: "string" },
        guard_mode: { type: "string", enum: ["pre_block", "pre_redirect", "post_check", "post_repair", "observe"] },
        task_contract: { type: "object" },
        tool_capability: { type: "object" },
        target_tool: { type: "string" },
        compare_fields: { type: "array", items: { type: "string" } },
        evidence_dir: { type: "string" },
      },
    },
    async execute(_toolCallId: string, rawParams: unknown): Promise<AgentToolResult> {
      const params = requireRecord(rawParams);
      const decision = decideGuardRoute({
        requested_tool: requireString(params.requested_tool, "requested_tool"),
        guard_mode: optionalGuardMode(params.guard_mode),
        task_contract: requireRecord(params.task_contract),
        tool_capability: requireRecord(params.tool_capability),
        target_tool: optionalString(params.target_tool),
        compare_fields: optionalStringArray(params.compare_fields),
      });
      writeGuardEvent({
        event: decision,
        evidence_dir: optionalString(params.evidence_dir),
      });
      return jsonToolResult(decision);
    },
  };
}


function createImportPackTool(): AnyAgentTool {
  return {
    name: "nss_evimem_import_pack",
    label: "Import EvidenceMemory Pack",
    description: "Import an existing EvidenceMemory knowledge pack into the NSS-EviMem memory store.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pack_dir"],
      properties: {
        pack_dir: { type: "string" },
        evidence_dir: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        replace_existing: { type: "boolean" },
      },
    },
    async execute(_toolCallId: string, rawParams: unknown): Promise<AgentToolResult> {
      const params = requireRecord(rawParams);
      const result = importEvidenceMemoryPack({
        pack_dir: requireString(params.pack_dir, "pack_dir"),
        evidence_dir: optionalString(params.evidence_dir),
        tags: optionalStringArray(params.tags),
        replace_existing: optionalBoolean(params.replace_existing),
      });
      return jsonToolResult(result);
    },
  };
}

function createRegisterToolCapabilityTool(): AnyAgentTool {
  return {
    name: "nss_evimem_register_tool_capability",
    label: "Register Tool Capability",
    description: "Register or update a structured capability declaration for an external tool.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["tool_name", "capability"],
      properties: {
        tool_name: { type: "string" },
        capability: { type: "object" },
        metadata: { type: "object" },
        replace_existing: { type: "boolean" },
        evidence_dir: { type: "string" },
      },
    },
    async execute(_toolCallId: string, rawParams: unknown): Promise<AgentToolResult> {
      const params = requireRecord(rawParams);
      const result = registerToolCapability({
        tool_name: requireString(params.tool_name, "tool_name"),
        capability: requireRecord(params.capability),
        metadata: isRecord(params.metadata) ? params.metadata : {},
        replace_existing: optionalBoolean(params.replace_existing),
        evidence_dir: optionalString(params.evidence_dir),
      });
      return jsonToolResult(result);
    },
  };
}

function createListToolCapabilitiesTool(): AnyAgentTool {
  return {
    name: "nss_evimem_list_tool_capabilities",
    label: "List Tool Capabilities",
    description: "List registered tool capability declarations for the current evidence directory.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        tool_name: { type: "string" },
        evidence_dir: { type: "string" },
      },
    },
    async execute(_toolCallId: string, rawParams: unknown): Promise<AgentToolResult> {
      const params = rawParams === undefined ? {} : requireRecord(rawParams);
      const result = listToolCapabilities({
        tool_name: optionalString(params.tool_name),
        evidence_dir: optionalString(params.evidence_dir),
      });
      return jsonToolResult(result);
    },
  };
}

function createValidateContractTool(): AnyAgentTool {
  return {
    name: "nss_evimem_validate_contract",
    label: "Validate Task Contract",
    description: "Validate an Agent-generated candidate Task Contract and optionally persist it as the current session contract.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["task_contract"],
      properties: {
        task_contract: { type: "object" },
        required_fields: { type: "array", items: { type: "string" } },
        supported_domains: { type: "array", items: { type: "string" } },
        supported_analysis_types: { type: "array", items: { type: "string" } },
        supported_methods: { type: "array", items: { type: "string" } },
        supported_scopes: { type: "array", items: { type: "string" } },
        require_matching_tool: { type: "boolean" },
        save_as_current: { type: "boolean" },
        evidence_dir: { type: "string" },
      },
    },
    async execute(_toolCallId: string, rawParams: unknown): Promise<AgentToolResult> {
      const params = requireRecord(rawParams);
      const result = validateTaskContract({
        task_contract: requireRecord(params.task_contract),
        required_fields: optionalStringArray(params.required_fields),
        supported_domains: optionalStringArray(params.supported_domains),
        supported_analysis_types: optionalStringArray(params.supported_analysis_types),
        supported_methods: optionalStringArray(params.supported_methods),
        supported_scopes: optionalStringArray(params.supported_scopes),
        require_matching_tool: optionalBoolean(params.require_matching_tool),
        save_as_current: optionalBoolean(params.save_as_current),
        evidence_dir: optionalString(params.evidence_dir),
      });
      return jsonToolResult(result);
    },
  };
}

function createDiagnoseFailureTool(): AnyAgentTool {
  return {
    name: "nss_evimem_diagnose_failure",
    label: "Diagnose Failure",
    description: "Generate a structured failure diagnosis and rerun plan from NSS-EviMem evidence, contract, capability, guard, and run-summary signals.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        case_id: { type: "string" },
        task_contract: { type: "object" },
        run_summary: { type: "object" },
        observations: { type: "array", items: { type: "string" } },
        evidence_dir: { type: "string" },
      },
    },
    async execute(_toolCallId: string, rawParams: unknown): Promise<AgentToolResult> {
      const params = rawParams === undefined ? {} : requireRecord(rawParams);
      const result = diagnoseFailure({
        case_id: optionalString(params.case_id),
        task_contract: isRecord(params.task_contract) ? params.task_contract : undefined,
        run_summary: isRecord(params.run_summary) ? params.run_summary : undefined,
        observations: optionalStringArray(params.observations),
        evidence_dir: optionalString(params.evidence_dir),
      });
      return jsonToolResult(result);
    },
  };
}

function jsonToolResult(details: unknown): AgentToolResult {
  return {
    content: [{ type: "text", text: stableStringify(details, 2) }],
    details,
  };
}

function requireRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) {
    throw new Error("expected object parameter");
  }
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`expected non-empty string: ${name}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("expected string array");
  }
  return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error("expected boolean");
  }
  return value;
}

function optionalGuardMode(value: unknown) {
  const text = optionalString(value);
  if (!text) {
    return undefined;
  }
  if (!["pre_block", "pre_redirect", "post_check", "post_repair", "observe"].includes(text)) {
    throw new Error(`unsupported guard_mode: ${text}`);
  }
  return text as "pre_block" | "pre_redirect" | "post_check" | "post_repair" | "observe";
}
