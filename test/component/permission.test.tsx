import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/preact';
import { Conversation } from '../../src/client/conversation.js';
import {
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

describe('Permission request management', () => {
  let conversation: Conversation;

  beforeEach(() => {
    conversation = new Conversation();
    cancelAllPermissions(conversation);
  });

  it('showPermissionRequest adds to activeRequests with toolCallId', () => {
    showPermissionRequest(conversation, 1, 'tc-1', 'Edit file.ts', makeOptions(), () => {});
    expect(activeRequests.value).toHaveLength(1);
    expect(activeRequests.value[0].toolCallId).toBe('tc-1');
    expect(activeRequests.value[0].title).toBe('Edit file.ts');
  });

  it('auto-approve resolves immediately and calls respond', () => {
    let received: PermissionOutcome | undefined;
    showPermissionRequest(conversation, 2, 'tc-2', 'Run cmd', makeOptions(), (o) => { received = o; }, 'allow-once');
    expect(received).toEqual({ outcome: 'selected', optionId: 'allow-once' });
    expect(activeRequests.value[0].resolved.value).toBe(true);
  });

  it('cancelAll sends cancelled outcome and clears active requests', () => {
    const outcomes: PermissionOutcome[] = [];
    const respond = (o: PermissionOutcome) => { outcomes.push(o); };
    showPermissionRequest(conversation, 6, 'tc-6', 'Action A', makeOptions(), respond);
    showPermissionRequest(conversation, 7, 'tc-7', 'Action B', makeOptions(), respond);

    expect(activeRequests.value.length).toBe(2);

    cancelAllPermissions(conversation);

    expect(activeRequests.value.length).toBe(0);
    expect(outcomes).toEqual([
      { outcome: 'cancelled' },
      { outcome: 'cancelled' },
    ]);
  });
});
