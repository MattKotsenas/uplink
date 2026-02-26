import { Conversation, TrackedToolCall } from '../conversation.js';
import type { ToolKind, ToolCallContent } from '../../shared/acp-types.js';

export class ToolCallUI {
  private chatArea: HTMLElement;
  private conversation: Conversation;
  private renderedCalls: Map<string, HTMLElement> = new Map();
  private unsubscribe: (() => void) | null = null;

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
    const toolCalls = this.conversation.toolCalls;

    // Remove elements for tool calls that no longer exist
    for (const [id, el] of this.renderedCalls) {
      if (!toolCalls.has(id)) {
        el.remove();
        this.renderedCalls.delete(id);
      }
    }

    for (const [id, tc] of toolCalls) {
      const existing = this.renderedCalls.get(id);
      if (existing) {
        this.updateToolCallElement(existing, tc);
      } else {
        const el = this.createToolCallElement(tc);
        this.chatArea.appendChild(el);
        this.renderedCalls.set(id, el);
      }
    }
  }

  private createToolCallElement(tc: TrackedToolCall): HTMLElement {
    if (tc.kind === 'think') {
      return this.createThinkingElement(tc);
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'tool-call';
    wrapper.dataset.toolCallId = tc.toolCallId;

    const header = document.createElement('div');
    header.className = 'tool-call-header';
    header.addEventListener('click', () => {
      const body = wrapper.querySelector('.tool-call-body') as HTMLElement | null;
      if (body) {
        body.hidden = !body.hidden;
      }
    });

    const kindIcon = document.createElement('span');
    kindIcon.className = 'kind-icon';
    kindIcon.textContent = this.getKindIcon(tc.kind);

    const title = document.createElement('span');
    title.className = 'tool-call-title';
    title.textContent = tc.title;

    const status = document.createElement('span');
    status.className = `status ${tc.status}`;
    status.textContent = tc.status;

    header.appendChild(kindIcon);
    header.appendChild(title);
    header.appendChild(status);
    wrapper.appendChild(header);

    const body = document.createElement('div');
    body.className = 'tool-call-body';
    body.hidden = true;
    if (tc.content.length > 0) {
      body.appendChild(this.renderContent(tc.content));
    }
    wrapper.appendChild(body);

    return wrapper;
  }

  private createThinkingElement(tc: TrackedToolCall): HTMLElement {
    const details = document.createElement('details');
    details.className = 'tool-call tool-call-thinking';
    details.dataset.toolCallId = tc.toolCallId;

    const summary = document.createElement('summary');
    summary.className = 'tool-call-header thinking-header';

    const kindIcon = document.createElement('span');
    kindIcon.className = 'kind-icon';
    kindIcon.textContent = '💭';

    const title = document.createElement('span');
    title.className = 'tool-call-title';
    title.textContent = tc.status === 'completed' ? 'Thought' : 'Thinking…';

    const status = document.createElement('span');
    status.className = `status ${tc.status}`;
    status.textContent = tc.status;

    summary.appendChild(kindIcon);
    summary.appendChild(title);
    summary.appendChild(status);
    details.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'tool-call-body thinking-body';
    if (tc.content.length > 0) {
      body.appendChild(this.renderContent(tc.content));
    }
    details.appendChild(body);

    return details;
  }

  private updateToolCallElement(el: HTMLElement, tc: TrackedToolCall): void {
    const status = el.querySelector('.status');
    if (status) {
      status.className = `status ${tc.status}`;
      status.textContent = tc.status;
    }

    const title = el.querySelector('.tool-call-title');
    if (title) {
      if (tc.kind === 'think') {
        title.textContent = tc.status === 'completed' ? 'Thought' : 'Thinking…';
      } else {
        title.textContent = tc.title;
      }
    }

    const body = el.querySelector('.tool-call-body') as HTMLElement | null;
    if (body) {
      body.replaceChildren();
      if (tc.content.length > 0) {
        body.appendChild(this.renderContent(tc.content));
      }
    }
  }

  private renderContent(content: ToolCallContent[]): DocumentFragment {
    const fragment = document.createDocumentFragment();

    for (const item of content) {
      switch (item.type) {
        case 'content': {
          const block = item.content;
          if (block.type === 'text') {
            const p = document.createElement('div');
            p.textContent = block.text;
            fragment.appendChild(p);
          }
          break;
        }
        case 'diff': {
          const container = document.createElement('div');

          const pathLabel = document.createElement('div');
          pathLabel.textContent = item.path;
          pathLabel.style.fontWeight = '600';
          pathLabel.style.marginBottom = '0.25rem';
          container.appendChild(pathLabel);

          const pre = document.createElement('pre');
          if (item.oldText) {
            const del = document.createElement('span');
            del.style.color = 'var(--danger)';
            del.textContent = item.oldText;
            pre.appendChild(del);
            pre.appendChild(document.createTextNode('\n'));
          }
          const ins = document.createElement('span');
          ins.style.color = 'var(--success)';
          ins.textContent = item.newText;
          pre.appendChild(ins);

          container.appendChild(pre);
          fragment.appendChild(container);
          break;
        }
        case 'terminal': {
          const pre = document.createElement('pre');
          pre.textContent = `Terminal: ${item.terminalId}`;
          fragment.appendChild(pre);
          break;
        }
      }
    }

    return fragment;
  }

  private getKindIcon(kind: ToolKind): string {
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
}
