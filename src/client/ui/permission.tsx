import { signal, type Signal } from '@preact/signals';
import { Conversation } from '../conversation.js';
import type {
  PermissionOption,
  PermissionOutcome,
} from '../../shared/acp-types.js';

export type PermissionResponder = (outcome: PermissionOutcome) => void;

export interface ActiveRequest {
  requestId: number;
  toolCallId: string;
  title: string;
  options: PermissionOption[];
  respond: PermissionResponder;
  resolved: Signal<boolean>;
  selectedOptionId: Signal<string | undefined>;
}

// ─── Shared state ─────────────────────────────────────────────────────

export const activeRequests = signal<ActiveRequest[]>([]);

// ─── Imperative API (used by main.ts) ─────────────────────────────────

export function showPermissionRequest(
  conversation: Conversation,
  requestId: number,
  toolCallId: string,
  title: string,
  options: PermissionOption[],
  respond: PermissionResponder,
  autoApproveOptionId?: string,
): void {
  // Remove any existing request with the same ID
  removeRequest(requestId);
  conversation.trackPermission(requestId, toolCallId, title, options);

  const req: ActiveRequest = {
    requestId,
    toolCallId,
    title,
    options,
    respond,
    resolved: signal(!!autoApproveOptionId),
    selectedOptionId: signal(autoApproveOptionId),
  };

  activeRequests.value = [...activeRequests.value, req];

  if (autoApproveOptionId) {
    respond({ outcome: 'selected', optionId: autoApproveOptionId });
    conversation.resolvePermission(requestId, autoApproveOptionId);
  }
}

export function cancelAllPermissions(conversation: Conversation): void {
  for (const req of activeRequests.value) {
    if (!req.resolved.peek()) {
      req.respond({ outcome: 'cancelled' });
      conversation.resolvePermission(req.requestId);
    }
  }
  activeRequests.value = [];
}

function removeRequest(requestId: number): void {
  activeRequests.value = activeRequests.value.filter(
    (r) => r.requestId !== requestId,
  );
}
