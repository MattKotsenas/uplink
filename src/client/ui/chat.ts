import { Conversation, ConversationMessage } from '../conversation.js';

export class ChatUI {
  private chatArea: HTMLElement;
  private conversation: Conversation;
  private unsubscribe: (() => void) | null = null;
  private renderedCount = 0;

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

  private render(): void {
    const messages = this.conversation.messages;

    // Update existing message elements that may have changed content (streaming)
    for (let i = 0; i < this.renderedCount && i < messages.length; i++) {
      const el = this.chatArea.children[i] as HTMLElement;
      const contentEl = el.querySelector('.content');
      if (contentEl) {
        contentEl.innerHTML = this.renderMarkdown(messages[i].content);
      }
    }

    // Remove excess elements if messages were cleared
    while (this.chatArea.children.length > messages.length) {
      this.chatArea.removeChild(this.chatArea.lastChild!);
    }

    // Append new messages
    for (let i = this.renderedCount; i < messages.length; i++) {
      this.chatArea.appendChild(this.renderMessage(messages[i]));
    }

    this.renderedCount = messages.length;
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
    html = html.replace(/```(?:\w*)\n([\s\S]*?)```/g, (_match, code: string) => {
      return `<pre><code>${code}</code></pre>`;
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
