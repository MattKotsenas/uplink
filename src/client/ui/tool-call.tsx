import { h } from 'preact';
import { useState } from 'preact/hooks';
import hljs from 'highlight.js/lib/core';
import { TrackedToolCall } from '../conversation.js';
import type { ToolKind, ToolCallContent } from '../../shared/acp-types.js';
import { Icon } from './icon.js';

// ─── Pure helpers ─────────────────────────────────────────────────────

/** Map wire status to kebab-case CSS class */
function statusClass(status: string): string {
  return status.replace(/_/g, '-');
}

/** Map wire status to human-readable label */
function statusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

function getKindIcon(kind: ToolKind): string {
  switch (kind) {
    case 'read': return 'description';
    case 'edit': return 'edit';
    case 'delete': return 'delete';
    case 'move': return 'drive_file_move';
    case 'search': return 'search';
    case 'execute': return 'terminal';
    case 'think': return 'psychology';
    case 'fetch': return 'language';
    case 'other': return 'settings';
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
        <Icon name="psychology" class="kind-icon" />
        <span class="tool-call-title">
          {tc.status === 'completed' ? 'Thought' : 'Thinking…'}
        </span>
        <span class={`status ${statusClass(tc.status)}`}>{statusLabel(tc.status)}</span>
      </summary>
      <div class="tool-call-body thinking-body">
        {tc.content.length > 0 && <ContentBlock content={tc.content} />}
      </div>
    </details>
  );
}

function extractCommand(rawInput: unknown): string | null {
  if (rawInput == null || typeof rawInput !== 'object') return null;
  const obj = rawInput as Record<string, unknown>;
  // Copilot CLI sends { command: "..." } for powershell/execute tools
  if (typeof obj.command === 'string') return obj.command;
  return null;
}

export function ToolCallCard({ tc }: { tc: TrackedToolCall }) {
  const [collapsed, setCollapsed] = useState(true);

  if (tc.kind === 'think') {
    return <ThinkingBlock tc={tc} />;
  }

  const command = extractCommand(tc.rawInput);

  return (
    <div class="tool-call" data-tool-call-id={tc.toolCallId}>
      <div
        class="tool-call-header"
        onClick={() => setCollapsed(!collapsed)}
      >
        <Icon name={getKindIcon(tc.kind)} class="kind-icon" />
        <span class="tool-call-title">{tc.title}</span>
        <span class={`status ${statusClass(tc.status)}`}>{statusLabel(tc.status)}</span>
      </div>
      {command && (
        <pre class="tool-call-command"><code
          dangerouslySetInnerHTML={{ __html: hljs.highlightAuto(command).value }}
        /></pre>
      )}
      <div class="tool-call-body" hidden={collapsed}>
        {tc.content.length > 0
          ? <ContentBlock content={tc.content} />
          : <div class="tool-call-empty">No output</div>}
        {tc.locations.length > 0 && (
          <div class="tool-call-locations">
            {tc.locations.map((loc, i) => (
              <div key={i} class="tool-call-location">
                {loc.path}{loc.line != null ? `:${loc.line}` : ''}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
