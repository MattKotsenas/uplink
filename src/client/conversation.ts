import type {
  SessionUpdate,
  ToolKind,
  ToolCallStatus,
  ToolCallContent,
  ToolCallLocation,
  PermissionOption,
  PlanEntry,
} from "../shared/acp-types";

// ─── Data Models ──────────────────────────────────────────────────────

export interface ConversationMessage {
  role: "user" | "agent";
  content: string;
  timestamp: number;
}

export interface TrackedToolCall {
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
  content: ToolCallContent[];
  locations: ToolCallLocation[];
}

export interface TrackedPermission {
  requestId: number;
  toolCallId: string;
  title: string;
  options: PermissionOption[];
  resolved: boolean;
  selectedOptionId?: string;
}

export interface TrackedPlan {
  entries: PlanEntry[];
}

// ─── Conversation State ───────────────────────────────────────────────

export class Conversation {
  messages: ConversationMessage[] = [];
  toolCalls: Map<string, TrackedToolCall> = new Map();
  permissions: TrackedPermission[] = [];
  plan: TrackedPlan | null = null;

  private listeners: Set<() => void> = new Set();

  /** Register a change listener. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  // ─── User input ───────────────────────────────────────────────────

  addUserMessage(text: string): void {
    this.messages.push({ role: "user", content: text, timestamp: Date.now() });
    this.notify();
  }

  // ─── Session update routing ───────────────────────────────────────

  handleSessionUpdate(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.appendAgentText(
          update.content.type === "text" ? update.content.text : "",
        );
        break;

      case "user_message_chunk":
        this.appendUserText(
          update.content.type === "text" ? update.content.text : "",
        );
        break;

      case "tool_call":
        this.toolCalls.set(update.toolCallId, {
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind,
          status: update.status,
          content: update.content ?? [],
          locations: update.locations ?? [],
        });
        break;

      case "tool_call_update": {
        const existing = this.toolCalls.get(update.toolCallId);
        if (existing) {
          if (update.title !== undefined) existing.title = update.title;
          if (update.status !== undefined) existing.status = update.status;
          if (update.content !== undefined) existing.content = update.content;
          if (update.locations !== undefined)
            existing.locations = update.locations;
        }
        break;
      }

      case "plan":
        this.plan = { entries: update.entries };
        break;
    }

    this.notify();
  }

  // ─── Permission tracking ──────────────────────────────────────────

  trackPermission(
    requestId: number,
    toolCallId: string,
    title: string,
    options: PermissionOption[],
  ): void {
    this.permissions.push({
      requestId,
      toolCallId,
      title,
      options,
      resolved: false,
    });
    this.notify();
  }

  resolvePermission(requestId: number, optionId?: string): void {
    const perm = this.permissions.find((p) => p.requestId === requestId);
    if (perm) {
      perm.resolved = true;
      perm.selectedOptionId = optionId;
      this.notify();
    }
  }

  // ─── Computed helpers ─────────────────────────────────────────────

  get currentAgentMessage(): ConversationMessage | undefined {
    const last = this.messages[this.messages.length - 1];
    return last?.role === "agent" ? last : undefined;
  }

  get activeToolCalls(): TrackedToolCall[] {
    return [...this.toolCalls.values()].filter(
      (tc) => tc.status !== "completed" && tc.status !== "failed",
    );
  }

  get pendingPermissions(): TrackedPermission[] {
    return this.permissions.filter((p) => !p.resolved);
  }

  // ─── Reset ────────────────────────────────────────────────────────

  clear(): void {
    this.messages = [];
    this.toolCalls.clear();
    this.permissions = [];
    this.plan = null;
    this.notify();
  }

  // ─── Private helpers ──────────────────────────────────────────────

  private appendAgentText(text: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last?.role === "agent") {
      last.content += text;
    } else {
      this.messages.push({ role: "agent", content: text, timestamp: Date.now() });
    }
  }

  private appendUserText(text: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last?.role === "user") {
      last.content += text;
    } else {
      this.messages.push({ role: "user", content: text, timestamp: Date.now() });
    }
  }
}
