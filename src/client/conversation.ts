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

export type TimelineEntry =
  | { type: "message"; index: number }
  | { type: "toolCall"; toolCallId: string }
  | { type: "permission"; requestId: number }
  | { type: "plan" };

// ─── Conversation State ───────────────────────────────────────────────

export class Conversation {
  messages: ConversationMessage[] = [];
  toolCalls: Map<string, TrackedToolCall> = new Map();
  permissions: TrackedPermission[] = [];
  plan: TrackedPlan | null = null;
  timeline: TimelineEntry[] = [];
  isPrompting = false;

  private listeners: Set<() => void> = new Set();

  /** Register a change listener. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  // ─── User input ───────────────────────────────────────────────────

  addUserMessage(text: string): void {
    this.messages.push({ role: "user", content: text, timestamp: Date.now() });
    this.timeline.push({ type: "message", index: this.messages.length - 1 });
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
        this.timeline.push({ type: "toolCall", toolCallId: update.toolCallId });
        break;

      case "tool_call_update": {
        const existing = this.toolCalls.get(update.toolCallId);
        if (existing) {
          // Create a new object so Preact detects the change via reference equality
          this.toolCalls.set(update.toolCallId, {
            ...existing,
            ...(update.title !== undefined && { title: update.title }),
            ...(update.status !== undefined && { status: update.status }),
            ...(update.content !== undefined && { content: update.content }),
            ...(update.locations !== undefined && { locations: update.locations }),
          });
        }
        break;
      }

      case "plan": {
        this.plan = { entries: update.entries };
        // Only add plan entry once
        if (!this.timeline.some((e) => e.type === "plan")) {
          this.timeline.push({ type: "plan" });
        }
        break;
      }
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
    this.timeline.push({ type: "permission", requestId });
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
    this.timeline = [];
    this.notify();
  }

  // ─── Private helpers ──────────────────────────────────────────────

  private appendAgentText(text: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last?.role === "agent") {
      last.content += text;
    } else if (text) {
      this.messages.push({ role: "agent", content: text, timestamp: Date.now() });
      this.timeline.push({ type: "message", index: this.messages.length - 1 });
    }
  }

  private appendUserText(text: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last?.role === "user") {
      last.content += text;
    } else if (text) {
      this.messages.push({ role: "user", content: text, timestamp: Date.now() });
      this.timeline.push({ type: "message", index: this.messages.length - 1 });
    }
  }
}
