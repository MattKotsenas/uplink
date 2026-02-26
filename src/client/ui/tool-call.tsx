import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { Conversation, TrackedToolCall } from '../conversation.js';
import type { ToolKind, ToolCallContent } from '../../shared/acp-types.js';

// ─── Pure helpers ─────────────────────────────────────────────────────

function getKindIcon(kind: ToolKind): string {
  switch (kind) {
    case 'read': return '📖';
    case 'edit': return '✏️';
    case 'delete': return '🗑️';
    case 'move': return '📦';
    case 'search': return '🔍';
    case 'execute': return '▶️';
    case 'think': return '💭';
    case 'fetch': return '🌐';
    case 'other': return '⚙️';
  }
}

function ContentBlock({ content }: { content: ToolCallContent[] }) {
  return (
    <>
      {content.map((item, i) => {
        switch (item.type) {
          case 'content':
            return item.content.type === 'text' ? (
              <div key={i}>{item.content.text}</div>
            ) : null;
          case 'diff':
            return (
              <div key={i}>
                <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
                  {item.path}
                </div>
                <pre>
                  {item.oldText && (
                    <>
                      <span style={{ color: 'var(--danger)' }}>{item.oldText}</span>
                      {'\n'}
                    </>
                  )}
                  <span style={{ color: 'var(--success)' }}>{item.newText}</span>
                </pre>
              </div>
            );
          case 'terminal':
            return <pre key={i}>Terminal: {item.terminalId}</pre>;
          default:
            return null;
        }
      })}
    </>
  );
}

// ─── Components ───────────────────────────────────────────────────────

function ThinkingBlock({ tc }: { tc: TrackedToolCall }) {
  return (
    <details
      class="tool-call tool-call-thinking"
      data-tool-call-id={tc.toolCallId}
    >
      <summary class="tool-call-header thinking-header">
        <span class="kind-icon">💭</span>
        <span class="tool-call-title">
          {tc.status === 'completed' ? 'Thought' : 'Thinking…'}
        </span>
        <span class={`status ${tc.status}`}>{tc.status}</span>
      </summary>
      <div class="tool-call-body thinking-body">
        {tc.content.length > 0 && <ContentBlock content={tc.content} />}
      </div>
    </details>
  );
}

function ToolCallCard({ tc }: { tc: TrackedToolCall }) {
  const [collapsed, setCollapsed] = useState(true);

  if (tc.kind === 'think') {
    return <ThinkingBlock tc={tc} />;
  }

  return (
    <div class="tool-call" data-tool-call-id={tc.toolCallId}>
      <div
        class="tool-call-header"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span class="kind-icon">{getKindIcon(tc.kind)}</span>
        <span class="tool-call-title">{tc.title}</span>
        <span class={`status ${tc.status}`}>{tc.status}</span>
      </div>
      <div class="tool-call-body" hidden={collapsed}>
        {tc.content.length > 0 && <ContentBlock content={tc.content} />}
      </div>
    </div>
  );
}

// TODO: Reasoning/thinking messages from the real Copilot CLI (especially Opus 4.6
// with /delve) don't appear in the UI. During extended reasoning the UI looks hung
// with no visible progress. Investigate:
// 1. Does the real CLI send reasoning as `tool_call` updates with `kind: 'think'`,
//    or in a different format we're not handling?
// 2. The bridge may not be forwarding these updates — add logging to confirm.
// 3. Even if they arrive, completed tool calls vanish from `ToolCallList` because
//    it renders `conversation.toolCalls` which only holds in-flight state. Consider
//    interleaving thinking blocks into the chat message timeline so they persist.
// 4. At minimum, show a "thinking..." spinner/indicator during long reasoning pauses
//    so the UI doesn't appear frozen.

/**
 * Renders all tracked tool calls from the conversation.
 * Bridges Conversation.onChange() into Preact re-renders via a version counter.
 */
export function ToolCallList({
  conversation,
}: {
  conversation: Conversation;
}) {
  const [, setVersion] = useState(0);

  // Re-render whenever the conversation changes
  useEffect(() => {
    return conversation.onChange(() => setVersion((v) => v + 1));
  }, [conversation]);

  const toolCalls = [...conversation.toolCalls.values()];

  return (
    <>
      {toolCalls.map((tc) => (
        <ToolCallCard key={tc.toolCallId} tc={tc} />
      ))}
    </>
  );
}
