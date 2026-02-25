import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Conversation } from '../../src/client/conversation';
import type { SessionUpdate, PermissionOption, PlanEntry } from '../../src/shared/acp-types';

describe('Conversation', () => {
  let conversation: Conversation;

  beforeEach(() => {
    conversation = new Conversation();
  });

  describe('Text chunk accumulation', () => {
    it('Single agent_message_chunk creates a new agent message', () => {
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello' }
      });

      expect(conversation.messages).toHaveLength(1);
      expect(conversation.messages[0]).toMatchObject({
        role: 'agent',
        content: 'Hello'
      });
    });

    it('Multiple agent_message_chunks accumulate into the same message', () => {
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello' }
      });
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' World' }
      });

      expect(conversation.messages).toHaveLength(1);
      expect(conversation.messages[0]).toMatchObject({
        role: 'agent',
        content: 'Hello World'
      });
    });

    it('User message followed by agent chunks creates separate messages', () => {
      conversation.addUserMessage('Hi there');
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Greetings' }
      });

      expect(conversation.messages).toHaveLength(2);
      expect(conversation.messages[0]).toMatchObject({
        role: 'user',
        content: 'Hi there'
      });
      expect(conversation.messages[1]).toMatchObject({
        role: 'agent',
        content: 'Greetings'
      });
    });

    it('Two agent messages separated by a user message', () => {
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'First' }
      });
      conversation.addUserMessage('User reply');
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Second' }
      });

      expect(conversation.messages).toHaveLength(3);
      expect(conversation.messages[0].content).toBe('First');
      expect(conversation.messages[1].content).toBe('User reply');
      expect(conversation.messages[2].content).toBe('Second');
    });
  });

  describe('Tool call lifecycle', () => {
    it('tool_call creates a new TrackedToolCall', () => {
      conversation.handleSessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_1',
        title: 'Read File',
        kind: 'read',
        status: 'pending',
        content: [],
        locations: []
      });

      expect(conversation.toolCalls.size).toBe(1);
      const call = conversation.toolCalls.get('call_1');
      expect(call).toBeDefined();
      expect(call?.title).toBe('Read File');
      expect(call?.status).toBe('pending');
    });

    it('tool_call_update updates status (pending -> in_progress -> completed)', () => {
      // Create initial call
      conversation.handleSessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_1',
        title: 'Read File',
        kind: 'read',
        status: 'pending'
      });

      // Update to in_progress
      conversation.handleSessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_1',
        status: 'in_progress'
      });
      expect(conversation.toolCalls.get('call_1')?.status).toBe('in_progress');

      // Update to completed
      conversation.handleSessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_1',
        status: 'completed'
      });
      expect(conversation.toolCalls.get('call_1')?.status).toBe('completed');
    });

    it('tool_call_update adds content', () => {
      conversation.handleSessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_1',
        title: 'List Files',
        kind: 'execute',
        status: 'in_progress'
      });

      const content = [{ type: 'content' as const, content: { type: 'text' as const, text: 'file1.txt' } }];
      conversation.handleSessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_1',
        content: content
      });

      expect(conversation.toolCalls.get('call_1')?.content).toEqual(content);
    });

    it('Multiple tool calls tracked by different toolCallIds', () => {
      conversation.handleSessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_1',
        title: 'First',
        kind: 'read',
        status: 'pending'
      });
      conversation.handleSessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_2',
        title: 'Second',
        kind: 'edit',
        status: 'pending'
      });

      expect(conversation.toolCalls.size).toBe(2);
      expect(conversation.toolCalls.has('call_1')).toBe(true);
      expect(conversation.toolCalls.has('call_2')).toBe(true);
    });

    it('activeToolCalls returns only non-completed ones', () => {
      conversation.handleSessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'active_1',
        title: 'Active',
        kind: 'read',
        status: 'in_progress'
      });
      conversation.handleSessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'done_1',
        title: 'Done',
        kind: 'read',
        status: 'completed'
      });
      conversation.handleSessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'failed_1',
        title: 'Failed',
        kind: 'read',
        status: 'failed'
      });

      const active = conversation.activeToolCalls;
      expect(active).toHaveLength(1);
      expect(active[0].toolCallId).toBe('active_1');
    });
  });

  describe('Permission tracking', () => {
    const options: PermissionOption[] = [
      { optionId: 'opt1', name: 'Yes', kind: 'allow_once' },
      { optionId: 'opt2', name: 'No', kind: 'reject_once' }
    ];

    it('trackPermission creates a TrackedPermission', () => {
      conversation.trackPermission(123, 'call_1', 'Allow access?', options);

      expect(conversation.permissions).toHaveLength(1);
      expect(conversation.permissions[0]).toMatchObject({
        requestId: 123,
        toolCallId: 'call_1',
        title: 'Allow access?',
        resolved: false
      });
    });

    it('resolvePermission marks it resolved with optionId', () => {
      conversation.trackPermission(123, 'call_1', 'Allow access?', options);
      conversation.resolvePermission(123, 'opt1');

      expect(conversation.permissions[0].resolved).toBe(true);
      expect(conversation.permissions[0].selectedOptionId).toBe('opt1');
    });

    it('pendingPermissions returns only unresolved ones', () => {
      conversation.trackPermission(1, 'call_1', 'Req 1', options);
      conversation.trackPermission(2, 'call_2', 'Req 2', options);
      conversation.resolvePermission(1, 'opt1');

      const pending = conversation.pendingPermissions;
      expect(pending).toHaveLength(1);
      expect(pending[0].requestId).toBe(2);
    });
  });

  describe('Plan tracking', () => {
    it('Plan update creates/replaces plan entries', () => {
      const entries: PlanEntry[] = [
        { content: 'Step 1', priority: 'high', status: 'pending' }
      ];
      conversation.handleSessionUpdate({
        sessionUpdate: 'plan',
        entries
      });

      expect(conversation.plan).toEqual({ entries });
    });

    it('Second plan update replaces first completely', () => {
      const initialEntries: PlanEntry[] = [
        { content: 'Step 1', priority: 'high', status: 'pending' }
      ];
      conversation.handleSessionUpdate({
        sessionUpdate: 'plan',
        entries: initialEntries
      });

      const newEntries: PlanEntry[] = [
        { content: 'Step A', priority: 'low', status: 'in_progress' }
      ];
      conversation.handleSessionUpdate({
        sessionUpdate: 'plan',
        entries: newEntries
      });

      expect(conversation.plan?.entries).toHaveLength(1);
      expect(conversation.plan?.entries[0].content).toBe('Step A');
    });
  });

  describe('Change notification', () => {
    it('onChange listener called after addUserMessage', () => {
      const listener = vi.fn();
      conversation.onChange(listener);
      conversation.addUserMessage('test');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('onChange listener called after handleSessionUpdate', () => {
      const listener = vi.fn();
      conversation.onChange(listener);
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hi' }
      });
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('Unsubscribe stops notifications', () => {
      const listener = vi.fn();
      const unsubscribe = conversation.onChange(listener);
      
      conversation.addUserMessage('first');
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      conversation.addUserMessage('second');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('Multiple listeners all notified', () => {
      const listenerA = vi.fn();
      const listenerB = vi.fn();
      conversation.onChange(listenerA);
      conversation.onChange(listenerB);

      conversation.addUserMessage('test');
      expect(listenerA).toHaveBeenCalledTimes(1);
      expect(listenerB).toHaveBeenCalledTimes(1);
    });
  });

  describe('Edge cases', () => {
    it('tool_call_update for unknown toolCallId (should not crash)', () => {
      expect(() => {
        conversation.handleSessionUpdate({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'unknown_id',
          status: 'completed'
        });
      }).not.toThrow();
    });

    it('Empty text in agent_message_chunk', () => {
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' }
      });
      // Should create message even if empty? Or append nothing?
      // Based on implementation: appendAgentText creates a message if not exists
      expect(conversation.messages).toHaveLength(1);
      expect(conversation.messages[0].content).toBe('');
    });

    it('clear() resets everything', () => {
      conversation.addUserMessage('user');
      conversation.handleSessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 't',
        kind: 'read',
        status: 'pending'
      });
      conversation.trackPermission(1, 'c1', 'p', []);
      conversation.handleSessionUpdate({
        sessionUpdate: 'plan',
        entries: []
      });

      conversation.clear();

      expect(conversation.messages).toHaveLength(0);
      expect(conversation.toolCalls.size).toBe(0);
      expect(conversation.permissions).toHaveLength(0);
      expect(conversation.plan).toBeNull();
    });
  });
});
