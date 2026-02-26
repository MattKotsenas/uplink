import { h } from 'preact';
import { signal, type Signal } from '@preact/signals';
import { Conversation } from '../conversation.js';
import type {
  PermissionOption,
  PermissionOutcome,
} from '../../shared/acp-types.js';

export type PermissionResponder = (outcome: PermissionOutcome) => void;

interface ActiveRequest {
  requestId: number;
  title: string;
  options: PermissionOption[];
  respond: PermissionResponder;
  resolved: Signal<boolean>;
  selectedOptionId: Signal<string | undefined>;
}

// ─── Shared state ─────────────────────────────────────────────────────

const activeRequests = signal<ActiveRequest[]>([]);

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

function resolveRequest(
  conversation: Conversation,
  req: ActiveRequest,
  optionId: string,
): void {
  if (req.resolved.peek()) return;
  req.respond({ outcome: 'selected', optionId });
  conversation.resolvePermission(req.requestId, optionId);
  req.resolved.value = true;
  req.selectedOptionId.value = optionId;
}

// ─── Components ───────────────────────────────────────────────────────

function PermissionCard({
  req,
  conversation,
}: {
  req: ActiveRequest;
  conversation: Conversation;
}) {
  const resolved = req.resolved.value;

  return (
    <div class={`permission-request${resolved ? ' resolved' : ''}`}>
      <div class="permission-header">
        <span class="permission-icon">🔐</span>
        <span class="permission-title">{req.title}</span>
      </div>
      <div class="permission-message">
        Copilot wants to perform this action. Allow?
      </div>
      <div class="permission-actions">
        {req.options.map((option) => {
          const isAllow = option.kind.startsWith('allow');
          const isSelected = req.selectedOptionId.value === option.optionId;
          const label =
            resolved && isSelected
              ? isAllow
                ? 'Approved'
                : 'Denied'
              : option.name;

          return (
            <button
              key={option.optionId}
              type="button"
              class={`permission-btn ${isAllow ? 'allow' : 'reject'}`}
              disabled={resolved}
              onClick={() => resolveRequest(conversation, req, option.optionId)}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Renders all active permission requests. Mount once in chatArea. */
export function PermissionList({
  conversation,
}: {
  conversation: Conversation;
}) {
  return (
    <>
      {activeRequests.value.map((req) => (
        <PermissionCard
          key={req.requestId}
          req={req}
          conversation={conversation}
        />
      ))}
    </>
  );
}
