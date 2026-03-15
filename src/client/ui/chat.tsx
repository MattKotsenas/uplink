import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { Conversation, ConversationMessage } from '../conversation.js';
import type { TimelineEntry } from '../conversation.js';
import { ScrollFollower } from '../scroll-follower.js';
import { ToolCallCard } from './tool-call.js';
import { activeRequests } from './permission.js';
import { PlanCard } from './plan.js';
import { ShellOutput } from './shell.js';
import { Marked } from 'marked';
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

// ─── Markdown renderer (marked + highlight.js) ───────────────────────

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    // Escape raw HTML in markdown source (security)
    html({ text }) {
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    },
    // Open links in new tabs and reject non-http schemes
    link({ href, text }) {
      const trimmed = (href ?? '').trim();
      if (/^(https?:|mailto:|\/|#)/i.test(trimmed)) {
        return `<a href="${trimmed}" target="_blank" rel="noopener noreferrer">${text}</a>`;
      }
      return `${text} (${trimmed})`;
    },
    // Syntax highlighting for fenced code blocks
    code({ text, lang }) {
      let highlighted: string;
      if (lang && hljs.getLanguage(lang)) {
        highlighted = hljs.highlight(text, { language: lang }).value;
      } else if (lang) {
        highlighted = hljs.highlightAuto(text).value;
      } else {
        highlighted = text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }
      const langClass = lang ? ` class="language-${lang}"` : '';
      return `<pre><code${langClass}>${highlighted}</code></pre>`;
    },
  },
});

export function renderMarkdown(text: string): string {
  return marked.parse(text) as string;
}

// ─── Components ───────────────────────────────────────────────────────

function ChatMessage({ msg }: { msg: ConversationMessage }) {
  return (
    <div class={`message ${msg.role}`}>
      <div
        class="content"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content.trimEnd()) }}
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
      const msg = conversation.messages.value[entry.index];
      return msg ? <ChatMessage msg={msg} /> : null;
    }
    case 'toolCall': {
      const tc = conversation.toolCalls.value.get(entry.toolCallId);
      if (!tc) return null;
      const permReq = activeRequests.value.find(r => r.toolCallId === entry.toolCallId);
      return <ToolCallCard tc={tc} permissionRequest={permReq} />;
    }
    case 'plan':
      return <PlanCard conversation={conversation} />;
    case 'shell': {
      const sr = conversation.shellResults.value.get(entry.id);
      return sr ? <ShellOutput command={sr.command} stdout={sr.stdout} stderr={sr.stderr} exitCode={sr.exitCode} /> : null;
    }
  }
}

function timelineKey(entry: TimelineEntry): string {
  switch (entry.type) {
    case 'message': return `msg-${entry.index}`;
    case 'toolCall': return `tc-${entry.toolCallId}`;
    case 'plan': return 'plan';
    case 'shell': return `shell-${entry.id}`;
  }
}

/**
 * Renders the conversation timeline.
 * Components reading signal `.value` auto-subscribe via @preact/signals.
 */
export function ChatList({
  conversation,
  scrollContainer,
}: {
  conversation: Conversation;
  scrollContainer: HTMLElement;
}) {
  // Show thinking indicator when prompting but no agent response yet
  const msgs = conversation.messages.value;
  const lastMsg = msgs[msgs.length - 1];
  const showThinking = conversation.isPrompting.value &&
    (!lastMsg || lastMsg.role === 'user');

  // Auto-scroll: follow the conversation unless the user scrolled up.
  const followerRef = useRef<ScrollFollower | null>(null);

  useEffect(() => {
    const follower = new ScrollFollower(scrollContainer);
    followerRef.current = follower;
    return () => {
      follower.dispose();
      followerRef.current = null;
    };
  }, [scrollContainer]);

  useEffect(() => {
    followerRef.current?.scrollIfFollowing();
  });

  const timeline = conversation.timeline.value;

  return (
    <>
      {timeline.map((entry) => (
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
    </>
  );
}
