import { Conversation } from '../conversation.js';
import type {
  PermissionOption,
  PermissionOutcome,
} from '../../shared/acp-types.js';

export type PermissionResponder = (outcome: PermissionOutcome) => void;

export class PermissionUI {
  private readonly activeRequests = new Map<
    number,
    { element: HTMLElement; respond: PermissionResponder }
  >();

  constructor(
    private readonly chatArea: HTMLElement,
    private readonly conversation: Conversation,
  ) {}

  showPermissionRequest(
    requestId: number,
    toolCallId: string,
    title: string,
    options: PermissionOption[],
    respond: PermissionResponder,
  ): void {
    this.removeRequest(requestId);
    this.conversation.trackPermission(requestId, toolCallId, title, options);

    const card = this.createPermissionCard(
      requestId,
      title,
      options,
      respond,
    );

    this.chatArea.appendChild(card);
    this.activeRequests.set(requestId, { element: card, respond });
    this.chatArea.scrollTop = this.chatArea.scrollHeight;
  }

  cancelAll(): void {
    for (const [requestId, { element, respond }] of this.activeRequests) {
      respond({ outcome: 'cancelled' });
      this.conversation.resolvePermission(requestId);
      element.classList.add('resolved');
      element.remove();
    }
    this.activeRequests.clear();
  }

  private createPermissionCard(
    requestId: number,
    title: string,
    options: PermissionOption[],
    respond: PermissionResponder,
  ): HTMLElement {
    const card = document.createElement('div');
    card.className = 'permission-request';

    const header = document.createElement('div');
    header.className = 'permission-header';

    const icon = document.createElement('span');
    icon.className = 'permission-icon';
    icon.textContent = '🔐';

    const titleEl = document.createElement('span');
    titleEl.className = 'permission-title';
    titleEl.textContent = title;

    header.append(icon, titleEl);
    card.appendChild(header);

    const message = document.createElement('div');
    message.className = 'permission-message';
    message.textContent = 'Copilot wants to perform this action. Allow?';
    card.appendChild(message);

    const actions = document.createElement('div');
    actions.className = 'permission-actions';
    card.appendChild(actions);

    for (const option of options) {
      const button = document.createElement('button');
      button.type = 'button';
      const isAllow = option.kind.startsWith('allow');
      const kindClass = isAllow ? 'allow' : 'reject';
      button.className = `permission-btn ${kindClass}`;
      button.dataset.optionId = option.optionId;
      button.textContent = option.name;

      button.addEventListener('click', () => {
        if (card.classList.contains('resolved')) {
          return;
        }

        respond({ outcome: 'selected', optionId: option.optionId });
        this.conversation.resolvePermission(requestId, option.optionId);
        this.resolveCard(requestId, card, actions, button, isAllow);
      });

      actions.appendChild(button);
    }

    return card;
  }

  private resolveCard(
    requestId: number,
    card: HTMLElement,
    actions: HTMLElement,
    selectedButton: HTMLButtonElement,
    isAllow: boolean,
  ): void {
    const buttons = actions.querySelectorAll('button');
    buttons.forEach((btn) => {
      (btn as HTMLButtonElement).disabled = true;
    });

    selectedButton.textContent = isAllow ? 'Approved' : 'Denied';
    card.classList.add('resolved');
    this.activeRequests.delete(requestId);
  }

  private removeRequest(requestId: number): void {
    const existing = this.activeRequests.get(requestId);
    if (!existing) {
      return;
    }
    existing.element.remove();
    this.activeRequests.delete(requestId);
  }
}
