import { h } from 'preact';
import { signal } from '@preact/signals';
import type { SessionInfo } from '../../shared/acp-types.js';

export { fetchSessions, formatRelativeTime } from './sessions-api.js';

// ─── State ────────────────────────────────────────────────────────────

interface SessionsModalState {
  open: boolean;
  sessions: SessionInfo[];
  supportsResume: boolean;
  onResume: (sessionId: string) => void;
  onNewSession: () => void;
}

const modalState = signal<SessionsModalState | null>(null);

export function openSessionsModal(
  sessions: SessionInfo[],
  supportsResume: boolean,
  onResume: (sessionId: string) => void,
  onNewSession: () => void,
): void {
  modalState.value = { open: true, sessions, supportsResume, onResume, onNewSession };
}

function closeModal(): void {
  modalState.value = null;
}

export { closeModal as closeSessionsModal };

// ─── Components ───────────────────────────────────────────────────────

function SessionCard({
  session,
  supportsResume,
  onResume,
}: {
  session: SessionInfo;
  supportsResume: boolean;
  onResume: (sessionId: string) => void;
}) {
  const text = session.title ?? session.id;
  const displayText = text.length > 80 ? text.slice(0, 77) + '…' : text;

  const meta = formatRelativeTimeInline(session.updatedAt);

  const handleClick = supportsResume
    ? () => { closeModal(); onResume(session.id); }
    : undefined;

  const handleKeyDown = supportsResume
    ? (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          closeModal();
          onResume(session.id);
        }
      }
    : undefined;

  return (
    <li
      class={`session-card${supportsResume ? '' : ' disabled'}`}
      role={supportsResume ? 'button' : 'listitem'}
      tabIndex={supportsResume ? 0 : undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <div class="session-summary">{displayText}</div>
      <div class="session-meta">{meta}</div>
    </li>
  );
}

export function SessionsModal() {
  const state = modalState.value;
  if (!state) return null;

  const { sessions, supportsResume, onResume, onNewSession } = state;

  const handleBackdropClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).classList.contains('sessions-overlay')) {
      closeModal();
    }
  };

  const handleNewSession = () => {
    closeModal();
    onNewSession();
  };

  return (
    <div
      class="sessions-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Recent Sessions"
      onClick={handleBackdropClick}
    >
      <div class="sessions-panel">
        <div class="sessions-panel-header">
          <h2>Recent Sessions</h2>
          <button
            class="sessions-close-btn"
            type="button"
            aria-label="Close"
            onClick={closeModal}
          >
            ✕
          </button>
        </div>

        <button
          class="sessions-new-btn"
          type="button"
          onClick={handleNewSession}
        >
          ＋ New Session
        </button>

        {!supportsResume && (
          <p class="sessions-note">
            Session resume is not supported by this agent.
          </p>
        )}

        <ul class="sessions-list" role="list">
          {sessions.length === 0 ? (
            <li class="sessions-empty">No recent sessions found.</li>
          ) : (
            sessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                supportsResume={supportsResume}
                onResume={onResume}
              />
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

// Inline version to avoid circular import
function formatRelativeTimeInline(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
