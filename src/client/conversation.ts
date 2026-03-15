import type {
  SessionUpdate,
  ToolKind,
  ToolCallStatus,
  ToolCallContent,
  ToolCallLocation,
  PermissionOption,
  PlanEntry,
} from "../shared/acp-types";
import { signal, batch, type ReadonlySignal } from "@preact/signals";

// ─── Data Models ──────────────────────────────────────────────────────

export interface ConversationMessage {
  role: "user" | "agent" | "system";
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
  rawInput?: unknown;
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
  // Reactive state — components that read `.value` auto-subscribe via @preact/signals.
  private readonly _messages = signal<ConversationMessage[]>([]);
  private readonly _toolCalls = signal<Map<string, TrackedToolCall>>(new Map());
  private readonly _permissions = signal<TrackedPermission[]>([]);
  private readonly _shellResults = signal<Map<number, TrackedShellResult>>(new Map());
  private readonly _plan = signal<TrackedPlan | null>(null);
  private readonly _timeline = signal<TimelineEntry[]>([]);
  private readonly _isPrompting = signal(false);

  // Read-only signal accessors for consumers.
  get messages(): ReadonlySignal<ConversationMessage[]> { return this._messages; }
  get toolCalls(): ReadonlySignal<Map<string, TrackedToolCall>> { return this._toolCalls; }
  get permissions(): ReadonlySignal<TrackedPermission[]> { return this._permissions; }
  get shellResults(): ReadonlySignal<Map<number, TrackedShellResult>> { return this._shellResults; }
  get plan(): ReadonlySignal<TrackedPlan | null> { return this._plan; }
  get timeline(): ReadonlySignal<TimelineEntry[]> { return this._timeline; }
  get isPrompting(): ReadonlySignal<boolean> { return this._isPrompting; }

  set prompting(value: boolean) { this._isPrompting.value = value; }

  private nextShellId = 0;
  private nextThinkingId = 0;
  private activeThinkingId: string | null = null;

  // ─── User input ───────────────────────────────────────────────────

  addUserMessage(text: string): void {
    this._messages.value = [...this._messages.value, { role: "user", content: text, timestamp: Date.now() }];
    this._timeline.value = [...this._timeline.value, { type: "message", index: this._messages.value.length - 1 }];
  }

  addSystemMessage(text: string): void {
    this._messages.value = [...this._messages.value, { role: "system", content: text, timestamp: Date.now() }];
    this._timeline.value = [...this._timeline.value, { type: "message", index: this._messages.value.length - 1 }];
  }

  addShellResult(command: string, stdout: string, stderr: string, exitCode: number): void {
    const id = this.nextShellId++;
    const newResults = new Map(this._shellResults.value);
    newResults.set(id, { id, command, stdout, stderr, exitCode });
    this._shellResults.value = newResults;
    this._timeline.value = [...this._timeline.value, { type: "shell", id }];
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

      case "tool_call": {
        const newToolCalls = new Map(this._toolCalls.value);
        newToolCalls.set(update.toolCallId, {
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind,
          status: update.status,
          content: update.content ?? [],
          locations: update.locations ?? [],
          rawInput: update.rawInput,
        });
        this._toolCalls.value = newToolCalls;
        this._timeline.value = [...this._timeline.value, { type: "toolCall", toolCallId: update.toolCallId }];
        break;
      }

      case "tool_call_update": {
        const existing = this._toolCalls.value.get(update.toolCallId);
        if (existing) {
          const mergedContent =
            update.content !== undefined && update.content.length > 0
              ? [...existing.content, ...update.content]
              : existing.content;
          const mergedLocations =
            update.locations !== undefined && update.locations.length > 0
              ? [...existing.locations, ...update.locations]
              : existing.locations;
          const newToolCalls = new Map(this._toolCalls.value);
          newToolCalls.set(update.toolCallId, {
            ...existing,
            ...(update.title !== undefined && { title: update.title }),
            ...(update.status !== undefined && { status: update.status }),
            ...(update.rawInput !== undefined && { rawInput: update.rawInput }),
            content: mergedContent,
            locations: mergedLocations,
          });
          this._toolCalls.value = newToolCalls;
        }
        break;
      }

      case "plan": {
        this._plan.value = { entries: update.entries };
        const tl = this._timeline.value;
        if (!tl.some((e) => e.type === "plan")) {
          this._timeline.value = [...tl, { type: "plan" }];
        }
        break;
      }
    }
  }

  // ─── Permission tracking ──────────────────────────────────────────

  trackPermission(
    requestId: number,
    toolCallId: string,
    title: string,
    options: PermissionOption[],
  ): void {
    this._permissions.value = [...this._permissions.value, {
      requestId,
      toolCallId,
      title,
      options,
      resolved: false,
    }];
    this._timeline.value = [...this._timeline.value, { type: "permission", requestId }];
  }

  resolvePermission(requestId: number, optionId?: string): void {
    this._permissions.value = this._permissions.value.map((p) =>
      p.requestId === requestId
        ? { ...p, resolved: true, selectedOptionId: optionId }
        : p,
    );
  }

  // ─── Computed helpers ─────────────────────────────────────────────

  get activeToolCalls(): TrackedToolCall[] {
    return [...this._toolCalls.value.values()].filter(
      (tc) => tc.status !== "completed" && tc.status !== "failed",
    );
  }

  get pendingPermissions(): TrackedPermission[] {
    return this._permissions.value.filter((p) => !p.resolved);
  }

  // ─── Reset ────────────────────────────────────────────────────────

  clear(): void {
    batch(() => {
      this._messages.value = [];
      this._toolCalls.value = new Map();
      this._permissions.value = [];
      this._shellResults.value = new Map();
      this._plan.value = null;
      this._timeline.value = [];
    });
    this.nextShellId = 0;
    this.nextThinkingId = 0;
    this.activeThinkingId = null;
  }

  // ─── Private helpers ──────────────────────────────────────────────

  /** Move a timeline entry matching `predicate` to the end. */
  private moveToEnd(predicate: (e: TimelineEntry) => boolean): void {
    const tl = this._timeline.value;
    const idx = tl.findIndex(predicate);
    if (idx >= 0 && idx < tl.length - 1) {
      const newTl = [...tl];
      const [entry] = newTl.splice(idx, 1);
      newTl.push(entry);
      this._timeline.value = newTl;
    }
  }

  private appendAgentText(text: string): void {
    const msgs = this._messages.value;
    const last = msgs[msgs.length - 1];
    if (last?.role === "agent") {
      const newContent = !last.content.trim()
        ? (last.content + text).trimStart()
        : last.content + text;
      batch(() => {
        this._messages.value = [...msgs.slice(0, -1), { ...last, content: newContent }];
        const msgIndex = this._messages.value.length - 1;
        this.moveToEnd((e) => e.type === "message" && e.index === msgIndex);
      });
    } else if (text.trim()) {
      batch(() => {
        this._messages.value = [...msgs, { role: "agent", content: text.trimStart(), timestamp: Date.now() }];
        this._timeline.value = [...this._timeline.value, { type: "message", index: this._messages.value.length - 1 }];
      });
    }
  }

  private appendUserText(text: string): void {
    const msgs = this._messages.value;
    const last = msgs[msgs.length - 1];
    if (last?.role === "user") {
      batch(() => {
        this._messages.value = [...msgs.slice(0, -1), { ...last, content: last.content + text }];
        const msgIndex = this._messages.value.length - 1;
        this.moveToEnd((e) => e.type === "message" && e.index === msgIndex);
      });
    } else if (text) {
      batch(() => {
        this._messages.value = [...msgs, { role: "user", content: text, timestamp: Date.now() }];
        this._timeline.value = [...this._timeline.value, { type: "message", index: this._messages.value.length - 1 }];
      });
    }
  }

  private appendThinking(text: string): void {
    if (this.activeThinkingId) {
      const tc = this._toolCalls.value.get(this.activeThinkingId);
      if (tc && tc.content.length > 0 && tc.content[0].type === "content") {
        const inner = tc.content[0].content;
        if (inner.type === "text") {
          const newContent = [{ ...tc.content[0], content: { ...inner, text: inner.text + text } }];
          const newToolCalls = new Map(this._toolCalls.value);
          newToolCalls.set(this.activeThinkingId, { ...tc, content: newContent });
          this._toolCalls.value = newToolCalls;
        }
      }
    } else {
      const id = `thinking-${this.nextThinkingId++}`;
      this.activeThinkingId = id;
      const newToolCalls = new Map(this._toolCalls.value);
      newToolCalls.set(id, {
        toolCallId: id,
        title: "Thinking",
        kind: "think",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text } }],
        locations: [],
      });
      this._toolCalls.value = newToolCalls;
      this._timeline.value = [...this._timeline.value, { type: "toolCall", toolCallId: id }];
    }
  }

  private completeThinking(): void {
    if (!this.activeThinkingId) return;
    const tc = this._toolCalls.value.get(this.activeThinkingId);
    if (tc) {
      const newToolCalls = new Map(this._toolCalls.value);
      newToolCalls.set(this.activeThinkingId, { ...tc, status: "completed" });
      this._toolCalls.value = newToolCalls;
    }
    this.activeThinkingId = null;
  }
}
