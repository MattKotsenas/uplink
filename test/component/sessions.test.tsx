import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, act } from '@testing-library/preact';
import { h } from 'preact';
import {
  SessionsModal,
  openSessionsModal,
  closeSessionsModal,
} from '../../src/client/ui/sessions.js';
import type { SessionInfo } from '../../src/shared/acp-types.js';

afterEach(() => {
  closeSessionsModal();
  cleanup();
});

function makeSessions(): SessionInfo[] {
  return [
    {
      id: 's-1',
      cwd: '/projects/test',
      title: 'Fix authentication bug',
      updatedAt: new Date().toISOString(),
    },
    {
      id: 's-2',
      cwd: '/projects/test',
      title: 'Add dark mode',
      updatedAt: new Date(Date.now() - 3600000).toISOString(),
    },
  ];
}

describe('SessionsModal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<SessionsModal />);
    expect(container.querySelector('.sessions-overlay')).toBeNull();
  });

  it('renders sessions when opened', () => {
    render(<SessionsModal />);
    act(() => {
      openSessionsModal(makeSessions(), true, () => {}, () => {});
    });

    expect(screen.getByText('Recent Sessions')).toBeTruthy();
    expect(screen.getByText('Fix authentication bug')).toBeTruthy();
    expect(screen.getByText('Add dark mode')).toBeTruthy();
  });

  it('shows empty state', () => {
    render(<SessionsModal />);
    act(() => {
      openSessionsModal([], true, () => {}, () => {});
    });

    expect(screen.getByText('No recent sessions found.')).toBeTruthy();
  });

  it('shows resume-not-supported note', () => {
    render(<SessionsModal />);
    act(() => {
      openSessionsModal(makeSessions(), false, () => {}, () => {});
    });

    expect(
      screen.getByText('Session resume is not supported by this agent.'),
    ).toBeTruthy();
  });

  it('calls onResume when clicking a session card', () => {
    let resumedId = '';
    render(<SessionsModal />);
    act(() => {
      openSessionsModal(makeSessions(), true, (id) => { resumedId = id; }, () => {});
    });

    fireEvent.click(screen.getByText('Fix authentication bug'));
    expect(resumedId).toBe('s-1');
  });

  it('calls onNewSession when clicking new session button', () => {
    let called = false;
    render(<SessionsModal />);
    act(() => {
      openSessionsModal(makeSessions(), true, () => {}, () => { called = true; });
    });

    fireEvent.click(screen.getByText('＋ New Session'));
    expect(called).toBe(true);
  });

  it('closes on close button click', () => {
    const { container } = render(<SessionsModal />);
    act(() => {
      openSessionsModal(makeSessions(), true, () => {}, () => {});
    });

    expect(container.querySelector('.sessions-overlay')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(container.querySelector('.sessions-overlay')).toBeNull();
  });

  it('disables session cards when resume not supported', () => {
    render(<SessionsModal />);
    act(() => {
      openSessionsModal(makeSessions(), false, () => {}, () => {});
    });

    const cards = document.querySelectorAll('.session-card');
    for (const card of cards) {
      expect(card.classList.contains('disabled')).toBe(true);
    }
  });
});
