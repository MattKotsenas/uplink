// ─── JSON-RPC 2.0 Envelope ────────────────────────────────────────────

/** JSON-RPC 2.0 request — has id, method, and params. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 notification — has method and params, NO id. */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 error object. */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** JSON-RPC 2.0 success response. */
export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result: unknown;
  error?: never;
}

/** JSON-RPC 2.0 error response. */
export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  error: JsonRpcError;
  result?: never;
}

/** JSON-RPC 2.0 response — has id and exactly one of result or error. */
export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/** Any JSON-RPC 2.0 message. */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ─── Capabilities ─────────────────────────────────────────────────────

/** Capabilities the client advertises during `initialize`. */
export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
}

/** Capabilities the agent advertises in the `initialize` response. */
export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  mcp?: { http?: boolean; sse?: boolean };
}

// ─── Info ─────────────────────────────────────────────────────────────

/** Metadata about a client or agent. */
export interface PeerInfo {
  name: string;
  title?: string;
  version?: string;
}

// ─── initialize ───────────────────────────────────────────────────────

/** Params for the `initialize` request (Client → Agent). */
export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities: ClientCapabilities;
  clientInfo?: PeerInfo;
}

/** Result of the `initialize` request. */
export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: AgentCapabilities;
  agentInfo?: PeerInfo;
  authMethods: unknown[];
}

// ─── MCP Server ───────────────────────────────────────────────────────

/** Stdio-based MCP server descriptor. */
export interface McpServer {
  name: string;
  command: string;
  args: string[];
  env?: { name: string; value: string }[];
}

// ─── session/new ──────────────────────────────────────────────────────

/** Params for the `session/new` request. */
export interface SessionNewParams {
  cwd: string;
  mcpServers: McpServer[];
}

/** Result of the `session/new` request. */
export interface SessionNewResult {
  sessionId: string;
  /** Available models and current selection (Copilot CLI extension, not in ACP spec). */
  models?: {
    availableModels: AvailableModel[];
    currentModelId?: string;
  };
  /** Available interaction modes (agent, plan, autopilot). */
  modes?: {
    availableModes: { id: string; name: string; description: string }[];
    currentModeId?: string;
  };
}

/** A model advertised by the agent. */
export interface AvailableModel {
  modelId: string;
  name: string;
  description?: string;
  _meta?: { copilotUsage?: string; copilotEnablement?: string };
}

// ─── session/load ─────────────────────────────────────────────────────

/** Params for the `session/load` request. */
export interface SessionLoadParams {
  sessionId: string;
  cwd: string;
  mcpServers: McpServer[];
}

/** Result of the `session/load` request (always null). */
export type SessionLoadResult = null;

// ─── session/prompt ───────────────────────────────────────────────────

/** Params for the `session/prompt` request. */
export interface SessionPromptParams {
  sessionId: string;
  prompt: ContentBlock[];
}

/** Reason the agent stopped generating. */
export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

/** Result of the `session/prompt` request. */
export interface SessionPromptResult {
  stopReason: StopReason;
}

// ─── session/cancel ───────────────────────────────────────────────────

/** Params for the `session/cancel` notification (Client → Agent). */
export interface SessionCancelParams {
  sessionId: string;
}

// ─── Content Blocks ───────────────────────────────────────────────────

/** A text content block. */
export interface TextContentBlock {
  type: "text";
  text: string;
}

/** An image content block (base64-encoded). */
export interface ImageContentBlock {
  type: "image";
  data: string;
  mimeType: string;
}

/** A resource link content block. */
export interface ResourceLinkContentBlock {
  type: "resource_link";
  uri: string;
  name?: string;
  mimeType?: string;
}

/** An inline resource content block. */
export interface ResourceContentBlock {
  type: "resource";
  resource: { uri: string; mimeType?: string; text?: string };
}

/** Discriminated union of all content block types used in ACP messages. */
export type ContentBlock =
  | TextContentBlock
  | ImageContentBlock
  | ResourceLinkContentBlock
  | ResourceContentBlock;

// ─── Tool Calls ───────────────────────────────────────────────────────

/** Kind of tool operation. */
export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "other";

/** Status of a tool call. */
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/** Tool call content — inline content variant. */
export interface ToolCallContentBlock {
  type: "content";
  content: ContentBlock;
}

/** Tool call content — diff variant. */
export interface ToolCallDiff {
  type: "diff";
  path: string;
  oldText?: string;
  newText: string;
}

/** Tool call content — terminal variant. */
export interface ToolCallTerminal {
  type: "terminal";
  terminalId: string;
}

/** Discriminated union of tool call content types. */
export type ToolCallContent = ToolCallContentBlock | ToolCallDiff | ToolCallTerminal;

/** A file-system location referenced by a tool call. */
export interface ToolCallLocation {
  path: string;
  line?: number;
}

/** Full tool call snapshot (used in `session/update`). */
export interface ToolCallUpdate {
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

// ─── Session Updates (discriminated union) ────────────────────────────

/** Agent message chunk update. */
export interface AgentMessageChunkUpdate {
  sessionUpdate: "agent_message_chunk";
  content: ContentBlock;
}

/** Agent thought chunk update (chain-of-thought reasoning, streamed token-by-token). */
export interface AgentThoughtChunkUpdate {
  sessionUpdate: "agent_thought_chunk";
  content: ContentBlock;
}

/** User message chunk update. */
export interface UserMessageChunkUpdate {
  sessionUpdate: "user_message_chunk";
  content: ContentBlock;
}

/** New tool call update. */
export interface ToolCallSessionUpdate {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

/** Incremental tool call update. */
export interface ToolCallUpdateSessionUpdate {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  status?: ToolCallStatus;
  title?: string;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

/** Plan entry. */
export interface PlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

/** Plan update. */
export interface PlanSessionUpdate {
  sessionUpdate: "plan";
  entries: PlanEntry[];
}

/**
 * Discriminated union of all session update types sent via the
 * `session/update` notification (Agent → Client).
 */
export type SessionUpdate =
  | AgentMessageChunkUpdate
  | AgentThoughtChunkUpdate
  | UserMessageChunkUpdate
  | ToolCallSessionUpdate
  | ToolCallUpdateSessionUpdate
  | PlanSessionUpdate;

/** Params for the `session/update` notification. */
export interface SessionUpdateParams {
  sessionId: string;
  update: SessionUpdate;
}

// ─── Permissions ──────────────────────────────────────────────────────

/** A single permission option presented to the user. */
export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

/** Outcome when the user selects a permission option. */
export interface PermissionOutcomeSelected {
  outcome: "selected";
  optionId: string;
}

/** Outcome when the user cancels the permission request. */
export interface PermissionOutcomeCancelled {
  outcome: "cancelled";
}

/** Discriminated union of permission outcomes. */
export type PermissionOutcome = PermissionOutcomeSelected | PermissionOutcomeCancelled;

/** Params for the `session/request_permission` request (Agent → Client). */
export interface SessionRequestPermissionParams {
  sessionId: string;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
}

/** Result of the `session/request_permission` request. */
export interface SessionRequestPermissionResult {
  outcome: PermissionOutcome;
}

// ─── Type Guards ──────────────────────────────────────────────────────

/** Narrows a SessionUpdate to an agent_message_chunk. */
export function isSessionUpdateChunk(
  u: SessionUpdate,
): u is AgentMessageChunkUpdate {
  return u.sessionUpdate === "agent_message_chunk";
}

/** Narrows a SessionUpdate to a tool_call. */
export function isSessionUpdateToolCall(
  u: SessionUpdate,
): u is ToolCallSessionUpdate {
  return u.sessionUpdate === "tool_call";
}

/** Narrows a SessionUpdate to a tool_call_update. */
export function isSessionUpdateToolCallUpdate(
  u: SessionUpdate,
): u is ToolCallUpdateSessionUpdate {
  return u.sessionUpdate === "tool_call_update";
}

/** Narrows a SessionUpdate to a plan. */
export function isSessionUpdatePlan(
  u: SessionUpdate,
): u is PlanSessionUpdate {
  return u.sessionUpdate === "plan";
}

// ─── Session Info (returned by GET /api/sessions) ─────────────────────

/** Metadata for a past session, as returned by the sessions API. */
export interface SessionInfo {
  id: string;
  cwd: string;
  branch: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Message Construction Helpers ─────────────────────────────────────

/** Create a JSON-RPC 2.0 request. */
export function createRequest(
  id: number | string,
  method: string,
  params: unknown,
): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}

/** Create a JSON-RPC 2.0 notification (no id). */
export function createNotification(
  method: string,
  params: unknown,
): JsonRpcNotification {
  return { jsonrpc: "2.0", method, params };
}

/** Parse a JSON string into a validated JsonRpcMessage. Throws on invalid input. */
export function parseMessage(json: string): JsonRpcMessage {
  const obj = JSON.parse(json);

  if (typeof obj !== "object" || obj === null || obj.jsonrpc !== "2.0") {
    throw new Error("Invalid JSON-RPC message: missing jsonrpc 2.0 field");
  }

  // Response: has result or error
  if ("result" in obj || "error" in obj) {
    if (!("id" in obj)) {
      throw new Error("Invalid JSON-RPC response: missing id");
    }
    const hasResult = "result" in obj;
    const hasError = "error" in obj;
    if (hasResult && hasError) {
      throw new Error(
        "Invalid JSON-RPC response: must have either result or error, not both",
      );
    }
    if (!hasResult && !hasError) {
      throw new Error(
        "Invalid JSON-RPC response: must have either result or error",
      );
    }
    return obj as JsonRpcResponse;
  }

  // Must have method for request or notification
  if (typeof obj.method !== "string") {
    throw new Error("Invalid JSON-RPC message: missing method");
  }

  // Request: has id
  if ("id" in obj) {
    return obj as JsonRpcRequest;
  }

  // Notification: no id
  return obj as JsonRpcNotification;
}
