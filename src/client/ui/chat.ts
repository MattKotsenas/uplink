import { Conversation, ConversationMessage } from '../conversation.js';
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

export class ChatUI {
  private chatArea: HTMLElement;
  private conversation: Conversation;
  private unsubscribe: (() => void) | null = null;
  // Track our own elements — chatArea is shared with ToolCallUI, PermissionUI, etc.
  private renderedElements: HTMLElement[] = [];

  constructor(chatArea: HTMLElement, conversation: Conversation) {
    this.chatArea = chatArea;
    this.conversation = conversation;
  }

  attach(): void {
    this.unsubscribe = this.conversation.onChange(() => this.render());
    this.render();
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Remove all rendered message elements and reset tracking state. */
  clear(): void {
    for (const el of this.renderedElements) {
      el.remove();
    }
    this.renderedElements = [];
  }

  private render(): void {
    const messages = this.conversation.messages;

    // Update existing message elements that may have changed content (streaming)
    for (let i = 0; i < this.renderedElements.length && i < messages.length; i++) {
      const contentEl = this.renderedElements[i].querySelector('.content');
      if (contentEl) {
        contentEl.innerHTML = this.renderMarkdown(messages[i].content);
      }
    }

    // Remove excess elements if messages were cleared
    while (this.renderedElements.length > messages.length) {
      this.renderedElements.pop()!.remove();
    }

    // Append new messages
    for (let i = this.renderedElements.length; i < messages.length; i++) {
      const el = this.renderMessage(messages[i]);
      this.chatArea.appendChild(el);
      this.renderedElements.push(el);
    }

    this.scrollToBottom();
  }

  private renderMessage(msg: ConversationMessage): HTMLElement {
    const div = document.createElement('div');
    div.className = `message ${msg.role}`;

    const content = document.createElement('div');
    content.className = 'content';
    content.innerHTML = this.renderMarkdown(msg.content);

    div.appendChild(content);
    return div;
  }

  private renderMarkdown(text: string): string {
    // Escape HTML entities
    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    // Code blocks: ```lang\n...\n``` → <pre><code>...</code></pre>
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

    // Inline code: `...` → <code>...</code>
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold: **...** → <strong>...</strong>
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Italic: *...* → <em>...</em>
    html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

    // Links: [text](url) → <a href="url">text</a>
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, url) => {
      const trimmedUrl = (url as string).trim();
      if (/^(https?:|mailto:|\/|#)/i.test(trimmedUrl)) {
        return `<a href="${trimmedUrl}" target="_blank" rel="noopener noreferrer">${text}</a>`;
      }
      return `${text} (${trimmedUrl})`;
    });

    return html;
  }

  scrollToBottom(): void {
    this.chatArea.scrollTop = this.chatArea.scrollHeight;
  }
}
