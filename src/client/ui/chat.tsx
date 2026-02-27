import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { Conversation, ConversationMessage } from '../conversation.js';
import type { TimelineEntry } from '../conversation.js';
import { ToolCallCard } from './tool-call.js';
import { PermissionCard, activeRequests } from './permission.js';
import { PlanCard } from './plan.js';
import { ShellOutput } from './shell.js';
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import diff from 'highlight.js/lib/languages/diff';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import csharp from 'highlight.js/lib/languages/csharp';
import powershell from 'highlight.js/lib/languages/powershell';

hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('css', css);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('cs', csharp);
hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('ps1', powershell);

// ─── Markdown renderer (pure function) ────────────────────────────────

export function renderMarkdown(text: string): string {
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang: string, code: string) => {
    const unescaped = code
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"');
    let highlighted: string;
    if (lang && hljs.getLanguage(lang)) {
      highlighted = hljs.highlight(unescaped, { language: lang }).value;
    } else if (lang) {
      highlighted = hljs.highlightAuto(unescaped).value;
    } else {
      highlighted = code;
    }
    const langClass = lang ? ` class="language-${lang}"` : '';
    return `<pre><code${langClass}>${highlighted}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, url) => {
    const trimmedUrl = (url as string).trim();
    if (/^(https?:|mailto:|\/|#)/i.test(trimmedUrl)) {
      return `<a href="${trimmedUrl}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    }
    return `${text} (${trimmedUrl})`;
  });

  return html;
}

// ─── Components ───────────────────────────────────────────────────────

function ChatMessage({ msg }: { msg: ConversationMessage }) {
  return (
    <div class={`message ${msg.role}`}>
      <div
        class="content"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
      />
    </div>
  );
}

/**
 * Renders a single timeline entry.
 */
function TimelineItem({
  entry,
  conversation,
}: {
  entry: TimelineEntry;
  conversation: Conversation;
}) {
  switch (entry.type) {
    case 'message': {
      const msg = conversation.messages[entry.index];
      return msg ? <ChatMessage msg={msg} /> : null;
    }
    case 'toolCall': {
      const tc = conversation.toolCalls.get(entry.toolCallId);
      return tc ? <ToolCallCard tc={tc} /> : null;
    }
    case 'permission': {
      const req = activeRequests.value.find(
        (r) => r.requestId === entry.requestId,
      );
      return req ? (
        <PermissionCard req={req} conversation={conversation} />
      ) : null;
    }
    case 'plan':
      return <PlanCard conversation={conversation} />;
    case 'shell': {
      const sr = conversation.shellResults.get(entry.id);
      return sr ? <ShellOutput command={sr.command} stdout={sr.stdout} stderr={sr.stderr} exitCode={sr.exitCode} /> : null;
    }
  }
}

function timelineKey(entry: TimelineEntry): string {
  switch (entry.type) {
    case 'message': return `msg-${entry.index}`;
    case 'toolCall': return `tc-${entry.toolCallId}`;
    case 'permission': return `perm-${entry.requestId}`;
    case 'plan': return 'plan';
    case 'shell': return `shell-${entry.id}`;
  }
}

/**
 * Renders the conversation timeline.
 * Subscribes to Conversation.onChange() to re-render on new messages/streaming.
 */
export function ChatList({
  conversation,
  scrollContainer,
}: {
  conversation: Conversation;
  scrollContainer: HTMLElement;
}) {
  const [, setVersion] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return conversation.onChange(() => setVersion((v) => v + 1));
  }, [conversation]);

  // Auto-scroll on message changes
  useEffect(() => {
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
  });

  // Show thinking indicator when prompting but no agent response yet
  const lastMsg = conversation.messages[conversation.messages.length - 1];
  const showThinking = conversation.isPrompting &&
    (!lastMsg || lastMsg.role === 'user');

  return (
    <>
      {conversation.timeline.map((entry) => (
        <TimelineItem key={timelineKey(entry)} entry={entry} conversation={conversation} />
      ))}
      {showThinking && (
        <div class="message agent thinking-indicator">
          <div class="content">
            <span class="thinking-dots">
              <span class="dot">.</span>
              <span class="dot">.</span>
              <span class="dot">.</span>
            </span>
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </>
  );
}
