import { h } from 'preact';

export type SessionDotStatus = 'idle' | 'busy' | 'initializing' | 'disconnected';

interface SessionDotItem {
  cwd: string;
  label: string;
  title: string;
  status?: SessionDotStatus;
}

interface SessionDotsProps {
  sessions: SessionDotItem[];
  activeCwd?: string;
  onSelect: (cwd: string) => void;
}

export function SessionDots({ sessions, activeCwd, onSelect }: SessionDotsProps) {
  return (
    <div class="session-carousel" aria-label="Session carousel">
      <div class="session-dots-track" role="tablist" aria-label="Sessions">
        {sessions.map((session) => (
          <button
            key={session.cwd}
            type="button"
            class={`session-dot session-dot-status-${session.status ?? 'disconnected'} ${session.cwd === activeCwd ? 'active' : ''}`}
            title={session.title}
            role="tab"
            aria-selected={session.cwd === activeCwd}
            aria-label={`Session ${session.label}`}
            onClick={() => onSelect(session.cwd)}
          />
        ))}
      </div>
    </div>
  );
}
