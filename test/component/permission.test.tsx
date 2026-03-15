import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/preact';
import { h } from 'preact';
import { Conversation } from '../../src/client/conversation.js';
import {
  PermissionCard,
  showPermissionRequest,
  cancelAllPermissions,
  activeRequests,
} from '../../src/client/ui/permission.js';
import type { PermissionOption, PermissionOutcome } from '../../src/shared/acp-types.js';

afterEach(() => {
  cleanup();
});

function makeOptions(): PermissionOption[] {
  return [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject-once', name: 'Deny', kind: 'reject_once' },
  ];
}

/** Helper: create a request via showPermissionRequest and return the ActiveRequest from the signal. */
function setupRequest(conversation: Conversation, id: number, title: string, respond: (o: PermissionOutcome) => void = () => {}) {
  showPermissionRequest(conversation, id, `tc-${id}`, title, makeOptions(), respond);
  return activeRequests.value.find(r => r.requestId === id)!;
}

describe('PermissionCard', () => {
  let conversation: Conversation;

  beforeEach(() => {
    conversation = new Conversation();
    cancelAllPermissions(conversation);
  });

  it('renders title and options', () => {
    const req = setupRequest(conversation, 1, 'Edit file.ts');
    render(<PermissionCard req={req} conversation={conversation} />);

    expect(screen.getByText('Edit file.ts')).toBeTruthy();
    expect(screen.getByText('Allow once')).toBeTruthy();
    expect(screen.getByText('Deny')).toBeTruthy();
    expect(screen.getByText('Copilot wants to perform this action. Allow?')).toBeTruthy();
  });

  it('calls respond with selected option on click', () => {
    let received: PermissionOutcome | undefined;
    const req = setupRequest(conversation, 2, 'Run command', (o) => { received = o; });
    render(<PermissionCard req={req} conversation={conversation} />);

    fireEvent.click(screen.getByText('Allow once'));
    expect(received).toEqual({ outcome: 'selected', optionId: 'allow-once' });
  });

  it('collapses to summary after selection', () => {
    const req = setupRequest(conversation, 3, 'Delete file');
    const { container } = render(<PermissionCard req={req} conversation={conversation} />);

    fireEvent.click(screen.getByText('Allow once'));
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(container.querySelector('.permission-request.approved')).toBeTruthy();
  });

  it('shows approved border after allowing', () => {
    const req = setupRequest(conversation, 4, 'Write file');
    const { container } = render(<PermissionCard req={req} conversation={conversation} />);

    fireEvent.click(screen.getByText('Allow once'));
    expect(container.querySelector('.permission-request.approved')).toBeTruthy();
  });

  it('shows denied border after rejecting', () => {
    const req = setupRequest(conversation, 5, 'Execute cmd');
    const { container } = render(<PermissionCard req={req} conversation={conversation} />);

    fireEvent.click(screen.getByText('Deny'));
    expect(container.querySelector('.permission-request.denied')).toBeTruthy();
  });

  it('cancelAll sends cancelled outcome and clears active requests', () => {
    const outcomes: PermissionOutcome[] = [];
    const respond = (o: PermissionOutcome) => { outcomes.push(o); };
    setupRequest(conversation, 6, 'Action A', respond);
    setupRequest(conversation, 7, 'Action B', respond);

    expect(activeRequests.value.length).toBe(2);

    cancelAllPermissions(conversation);

    expect(activeRequests.value.length).toBe(0);
    expect(outcomes).toEqual([
      { outcome: 'cancelled' },
      { outcome: 'cancelled' },
    ]);
  });
});
