/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/preact';
import { h } from 'preact';
import { Conversation } from '../../src/client/conversation.js';
import {
  PermissionList,
  showPermissionRequest,
  cancelAllPermissions,
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

describe('PermissionCard', () => {
  let conversation: Conversation;

  beforeEach(() => {
    conversation = new Conversation();
    // Clear any leftover state from previous tests
    cancelAllPermissions(conversation);
  });

  it('renders title and options', () => {
    const respond = () => {};
    showPermissionRequest(conversation, 1, 'tc-1', 'Edit file.ts', makeOptions(), respond);

    render(<PermissionList conversation={conversation} />);

    expect(screen.getByText('Edit file.ts')).toBeTruthy();
    expect(screen.getByText('Allow once')).toBeTruthy();
    expect(screen.getByText('Deny')).toBeTruthy();
    expect(screen.getByText('Copilot wants to perform this action. Allow?')).toBeTruthy();
  });

  it('calls respond with selected option on click', () => {
    let received: PermissionOutcome | undefined;
    const respond = (o: PermissionOutcome) => { received = o; };
    showPermissionRequest(conversation, 2, 'tc-2', 'Run command', makeOptions(), respond);

    render(<PermissionList conversation={conversation} />);
    fireEvent.click(screen.getByText('Allow once'));

    expect(received).toEqual({ outcome: 'selected', optionId: 'allow-once' });
  });

  it('collapses to summary after selection', () => {
    const respond = () => {};
    showPermissionRequest(conversation, 3, 'tc-3', 'Delete file', makeOptions(), respond);

    render(<PermissionList conversation={conversation} />);
    fireEvent.click(screen.getByText('Allow once'));

    // After resolution, buttons are gone — collapsed to a summary
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText('Approved')).toBeTruthy();
  });

  it('shows Approved label after allowing', () => {
    const respond = () => {};
    showPermissionRequest(conversation, 4, 'tc-4', 'Write file', makeOptions(), respond);

    render(<PermissionList conversation={conversation} />);
    fireEvent.click(screen.getByText('Allow once'));

    expect(screen.getByText('Approved')).toBeTruthy();
  });

  it('shows Denied label after rejecting', () => {
    const respond = () => {};
    showPermissionRequest(conversation, 5, 'tc-5', 'Execute cmd', makeOptions(), respond);

    render(<PermissionList conversation={conversation} />);
    fireEvent.click(screen.getByText('Deny'));

    expect(screen.getByText('Denied')).toBeTruthy();
  });

  it('cancelAll sends cancelled outcome and clears cards', () => {
    const outcomes: PermissionOutcome[] = [];
    const respond = (o: PermissionOutcome) => { outcomes.push(o); };
    showPermissionRequest(conversation, 6, 'tc-6', 'Action A', makeOptions(), respond);
    showPermissionRequest(conversation, 7, 'tc-7', 'Action B', makeOptions(), respond);

    const { container } = render(<PermissionList conversation={conversation} />);
    expect(container.querySelectorAll('.permission-request').length).toBe(2);

    act(() => {
      cancelAllPermissions(conversation);
    });

    // Signal update triggers re-render — permission cards should be gone
    expect(container.querySelectorAll('.permission-request').length).toBe(0);
    expect(outcomes).toEqual([
      { outcome: 'cancelled' },
      { outcome: 'cancelled' },
    ]);
  });

  it('renders multiple permission requests', () => {
    showPermissionRequest(conversation, 8, 'tc-8', 'First', makeOptions(), () => {});
    showPermissionRequest(conversation, 9, 'tc-9', 'Second', makeOptions(), () => {});

    render(<PermissionList conversation={conversation} />);

    expect(screen.getByText('First')).toBeTruthy();
    expect(screen.getByText('Second')).toBeTruthy();
  });
});
