export type JsonRecord = Record<string, unknown>;

export type HookName = "before_tool_call" | "after_tool_call";

export type PluginHookBeforeToolCallEvent = {
  toolName?: string;
  params?: JsonRecord;
  runId?: string;
  toolCallId?: string;
};

export type PluginHookAfterToolCallEvent = PluginHookBeforeToolCallEvent & {
  result?: unknown;
  error?: string;
  durationMs?: number;
};

export type PluginHookToolContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolName?: string;
  toolCallId?: string;
};

export type AgentToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
};

export type AnyAgentTool = {
  name: string;
  label?: string;
  description: string;
  parameters: JsonRecord;
  execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<AgentToolResult>;
};

export type PluginApi = {
  registerTool?: (tool: AnyAgentTool, options?: { name?: string; names?: string[]; optional?: boolean }) => void;
  on?: (
    hookName: HookName,
    handler:
      | ((event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => unknown | Promise<unknown>)
      | ((event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => unknown | Promise<unknown>),
    options?: { priority?: number; timeoutMs?: number },
  ) => void;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
};

export type PendingToolCall = {
  startedAt: number;
  timestamp: string;
  toolName: string;
  args: JsonRecord;
  callId: string;
  runId?: string;
};

export type EvidenceRecord = {
  evidence_id: string;
  timestamp: string;
  case_id: string;
  run_id: string | null;
  tool_call_id: string | null;
  tool_name: string;
  args: JsonRecord;
  result: unknown;
  artifacts: Record<string, string>;
  artifact_hashes: Record<string, string>;
  artifact_errors: Record<string, string>;
  elapsed_ms: number | null;
  ok: boolean;
  error: string | null;
  source: string;
};

export type TaskContract = JsonRecord;

export type ToolCapability = JsonRecord;

export type ToolCapabilityRecord = {
  tool_name: string;
  capability: ToolCapability;
  registered_at: string;
  updated_at: string;
  metadata: JsonRecord;
};

export type ContractValidationStatus =
  | "valid_contract"
  | "incomplete_contract"
  | "invalid_contract"
  | "unsupported_contract";

export type ContractValidationResult = {
  timestamp: string;
  status: ContractValidationStatus;
  ok: boolean;
  task_contract: TaskContract;
  missing_fields: string[];
  reasons: string[];
  matching_tools: string[];
  saved_as_current: boolean;
};

export type GuardMode = "pre_block" | "pre_redirect" | "post_check" | "post_repair" | "observe";

export type GuardDecisionType = "allow" | "block" | "redirect" | "allow_after_check" | "post_repair_required";

export type GuardDecision = {
  timestamp: string;
  requested_tool: string;
  effective_tool: string | null;
  target_tool: string | null;
  guard_mode: GuardMode;
  decision: GuardDecisionType;
  reasons: string[];
  task_contract: TaskContract;
  tool_capability: ToolCapability;
};

export type MemoryRecord = {
  memory_id: string;
  memory_type: "evidence_backed_memory";
  evidence_id: string;
  claim: string;
  task_contract: TaskContract;
  tool_name: string;
  artifact_hashes: Record<string, string>;
  created_at: string;
  tags: string[];
  metadata: JsonRecord;
};

export type MemoryRetrievalResult = {
  accepted: MemoryRecord[];
  rejected: Array<{
    memory_id: string;
    evidence_id: string;
    reason: string;
  }>;
};
