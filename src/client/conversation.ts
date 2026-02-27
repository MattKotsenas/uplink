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

export interface TrackedShellResult {
  id: number;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type TimelineEntry =
  | { type: "message"; index: number }
  | { type: "toolCall"; toolCallId: string }
  | { type: "permission"; requestId: number }
  | { type: "plan" }
  | { type: "shell"; id: number };

// ─── Conversation State ───────────────────────────────────────────────

export class Conversation {
  messages: ConversationMessage[] = [];
  toolCalls: Map<string, TrackedToolCall> = new Map();
  permissions: TrackedPermission[] = [];
  shellResults: Map<number, TrackedShellResult> = new Map();
  plan: TrackedPlan | null = null;
  timeline: TimelineEntry[] = [];
  isPrompting = false;
  private nextShellId = 0;
  private nextThinkingId = 0;
  private activeThinkingId: string | null = null;

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

  addShellResult(command: string, stdout: string, stderr: string, exitCode: number): void {
    const id = this.nextShellId++;
    this.shellResults.set(id, { id, command, stdout, stderr, exitCode });
    this.timeline.push({ type: "shell", id });
    this.notify();
  }

  // ─── Session update routing ───────────────────────────────────────

  handleSessionUpdate(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.completeThinking();
        this.appendAgentText(
          update.content.type === "text" ? update.content.text : "",
        );
        break;

      case "agent_thought_chunk":
        this.appendThinking(
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
          // Merge content: append new items rather than replacing
          const mergedContent =
            update.content !== undefined && update.content.length > 0
              ? [...existing.content, ...update.content]
              : existing.content;
          const mergedLocations =
            update.locations !== undefined && update.locations.length > 0
              ? [...existing.locations, ...update.locations]
              : existing.locations;
          // Create a new object so Preact detects the change via reference equality
          this.toolCalls.set(update.toolCallId, {
            ...existing,
            ...(update.title !== undefined && { title: update.title }),
            ...(update.status !== undefined && { status: update.status }),
            content: mergedContent,
            locations: mergedLocations,
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
    this.shellResults.clear();
    this.plan = null;
    this.timeline = [];
    this.nextShellId = 0;
    this.nextThinkingId = 0;
    this.activeThinkingId = null;
    this.notify();
  }

  // ─── Private helpers ──────────────────────────────────────────────

  /** Move a timeline entry matching `predicate` to the end (most-recently-updated → closest to input). */
  private moveToEnd(predicate: (e: TimelineEntry) => boolean): void {
    const idx = this.timeline.findIndex(predicate);
    if (idx >= 0 && idx < this.timeline.length - 1) {
      const [entry] = this.timeline.splice(idx, 1);
      this.timeline.push(entry);
    }
  }

  private appendAgentText(text: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last?.role === "agent") {
      last.content += text;
      const msgIndex = this.messages.length - 1;
      this.moveToEnd((e) => e.type === "message" && e.index === msgIndex);
    } else if (text.trim()) {
      this.messages.push({ role: "agent", content: text, timestamp: Date.now() });
      this.timeline.push({ type: "message", index: this.messages.length - 1 });
    }
  }

  private appendUserText(text: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last?.role === "user") {
      last.content += text;
      const msgIndex = this.messages.length - 1;
      this.moveToEnd((e) => e.type === "message" && e.index === msgIndex);
    } else if (text) {
      this.messages.push({ role: "user", content: text, timestamp: Date.now() });
      this.timeline.push({ type: "message", index: this.messages.length - 1 });
    }
  }

  private appendThinking(text: string): void {
    if (this.activeThinkingId) {
      // Accumulate into existing thinking tool call
      const tc = this.toolCalls.get(this.activeThinkingId);
      if (tc && tc.content.length > 0 && tc.content[0].type === "content") {
        const inner = tc.content[0].content;
        if (inner.type === "text") {
          inner.text += text;
        }
      }
      // Create new object reference so Preact detects the change
      this.toolCalls.set(this.activeThinkingId, { ...tc! });
    } else {
      // Create a new thinking tool call
      const id = `thinking-${this.nextThinkingId++}`;
      this.activeThinkingId = id;
      this.toolCalls.set(id, {
        toolCallId: id,
        title: "Thinking",
        kind: "think",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text } }],
        locations: [],
      });
      this.timeline.push({ type: "toolCall", toolCallId: id });
    }
  }

  private completeThinking(): void {
    if (!this.activeThinkingId) return;
    const tc = this.toolCalls.get(this.activeThinkingId);
    if (tc) {
      this.toolCalls.set(this.activeThinkingId, { ...tc, status: "completed" });
    }
    this.activeThinkingId = null;
  }
}
