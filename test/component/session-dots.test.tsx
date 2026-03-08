import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/preact';
import { h } from 'preact';
import { SessionDots } from '../../src/client/ui/session-dots';

afterEach(cleanup);

describe('SessionDots', () => {
  const sessions = [
    { cwd: '/tmp/project-a', label: 'project-a', title: '/tmp/project-a', status: 'idle' as const },
    { cwd: '/tmp/project-b', label: 'project-b', title: '/tmp/project-b', status: 'busy' as const },
    { cwd: '/tmp/project-c', label: 'project-c', title: '/tmp/project-c', status: 'initializing' as const },
  ];

  it('renders one dot per session', () => {
    render(<SessionDots sessions={sessions} activeCwd={sessions[1].cwd} onSelect={() => {}} />);
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('marks the active session dot as selected', () => {
    render(<SessionDots sessions={sessions} activeCwd={sessions[1].cwd} onSelect={() => {}} />);
    const dots = screen.getAllByRole('tab');
    expect(dots[0].getAttribute('aria-selected')).toBe('false');
    expect(dots[1].getAttribute('aria-selected')).toBe('true');
  });

  it('calls onSelect when a dot is clicked', () => {
    const onSelect = vi.fn();
    render(<SessionDots sessions={sessions} activeCwd={sessions[0].cwd} onSelect={onSelect} />);
    fireEvent.click(screen.getAllByRole('tab')[2]);
    expect(onSelect).toHaveBeenCalledWith('/tmp/project-c');
  });

  it('applies state classes to dots', () => {
    render(<SessionDots sessions={sessions} activeCwd={sessions[0].cwd} onSelect={() => {}} />);
    const dots = screen.getAllByRole('tab');
    expect(dots[0].className).toContain('session-dot-status-idle');
    expect(dots[1].className).toContain('session-dot-status-busy');
    expect(dots[2].className).toContain('session-dot-status-initializing');
  });

  it('falls back to disconnected state when status is missing', () => {
    // Edge case: newly restored sessions may not have a status yet.
    render(
      <SessionDots
        sessions={[{ cwd: '/tmp/unknown', label: 'unknown', title: '/tmp/unknown' }]}
        activeCwd="/tmp/unknown"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByRole('tab').className).toContain('session-dot-status-disconnected');
  });

  it('sets accessible label and title for each dot', () => {
    // Edge case: dot-only UI still needs readable labels for assistive tech.
    render(<SessionDots sessions={sessions} activeCwd={sessions[0].cwd} onSelect={() => {}} />);
    const first = screen.getAllByRole('tab')[0];
    expect(first.getAttribute('aria-label')).toBe('Session project-a');
    expect(first.getAttribute('title')).toBe('/tmp/project-a');
  });
});
