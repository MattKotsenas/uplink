import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/preact';
import { h } from 'preact';
import { Conversation } from '../../src/client/conversation.js';
import { PlanCard } from '../../src/client/ui/plan.js';

afterEach(cleanup);

describe('PlanCard', () => {
  it('renders nothing when no plan exists', () => {
    const conv = new Conversation();
    const { container } = render(<PlanCard conversation={conv} />);
    expect(container.querySelector('.plan-card')).toBeNull();
  });

  it('renders plan entries with status icons', () => {
    const conv = new Conversation();
    conv.handleSessionUpdate({
      sessionUpdate: 'plan',
      entries: [
        { content: 'First task', status: 'completed', priority: 'high' },
        { content: 'Second task', status: 'in_progress', priority: 'medium' },
        { content: 'Third task', status: 'pending', priority: 'low' },
      ],
    });

    const { container } = render(<PlanCard conversation={conv} />);

    expect(container.querySelector('.plan-card')).toBeTruthy();
    expect(container.querySelector('.plan-header')!.textContent).toBe('assignment Plan');

    const entries = container.querySelectorAll('.plan-entry');
    expect(entries.length).toBe(3);

    // Status icons
    const icons = container.querySelectorAll('.plan-status-icon');
    expect(icons[0].textContent).toBe('check_circle');
    expect(icons[1].textContent).toBe('sync');
    expect(icons[2].textContent).toBe('pending');
  });

  it('shows priority labels', () => {
    const conv = new Conversation();
    conv.handleSessionUpdate({
      sessionUpdate: 'plan',
      entries: [
        { content: 'High priority', status: 'pending', priority: 'high' },
      ],
    });

    const { container } = render(<PlanCard conversation={conv} />);
    const priority = container.querySelector('.plan-priority')!;
    expect(priority.textContent).toBe('high');
    expect(priority.classList.contains('priority-high')).toBe(true);
  });

  it('updates when plan changes', async () => {
    const conv = new Conversation();
    conv.handleSessionUpdate({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Step 1', status: 'pending', priority: 'medium' },
      ],
    });
    await new Promise<void>((r) => queueMicrotask(r));

    const { container } = render(<PlanCard conversation={conv} />);
    expect(container.querySelectorAll('.plan-entry').length).toBe(1);

    await act(async () => {
      conv.handleSessionUpdate({
        sessionUpdate: 'plan',
        entries: [
          { content: 'Step 1', status: 'completed', priority: 'medium' },
          { content: 'Step 2', status: 'in_progress', priority: 'medium' },
        ],
      });
      await new Promise<void>((r) => queueMicrotask(r));
    });

    expect(container.querySelectorAll('.plan-entry').length).toBe(2);
    expect(container.querySelector('.plan-status-icon')!.textContent).toBe('check_circle');
  });

  it('applies correct CSS class for in_progress', () => {
    const conv = new Conversation();
    conv.handleSessionUpdate({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Active', status: 'in_progress', priority: 'high' },
      ],
    });

    const { container } = render(<PlanCard conversation={conv} />);
    expect(container.querySelector('.plan-entry.in-progress')).toBeTruthy();
  });
});
