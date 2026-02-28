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

    it('tool_call_update appends content rather than replacing', () => {
      conversation.handleSessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_1',
        title: 'Run command',
        kind: 'execute',
        status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: 'Running...' } }]
      });

      // Second update appends more content
      conversation.handleSessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_1',
        content: [{ type: 'content', content: { type: 'text', text: 'Output line 1' } }]
      });

      const tc = conversation.toolCalls.get('call_1');
      expect(tc?.content).toHaveLength(2);
      expect(tc?.content[0]).toEqual({ type: 'content', content: { type: 'text', text: 'Running...' } });
      expect(tc?.content[1]).toEqual({ type: 'content', content: { type: 'text', text: 'Output line 1' } });
    });

    it('tool_call_update with empty content does not erase existing content', () => {
      conversation.handleSessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_1',
        title: 'Run command',
        kind: 'execute',
        status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: 'Output here' } }]
      });

      // Update with status change and empty content array — should NOT lose content
      conversation.handleSessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_1',
        status: 'failed',
        content: []
      });

      const tc = conversation.toolCalls.get('call_1');
      expect(tc?.status).toBe('failed');
      expect(tc?.content).toHaveLength(1);
      expect(tc?.content[0]).toEqual({ type: 'content', content: { type: 'text', text: 'Output here' } });
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
      // Empty text should not create a new message (avoids empty bubbles / HR artifacts)
      expect(conversation.messages).toHaveLength(0);

      // But empty text should still append to an existing message
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' }
      });
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' }
      });
      expect(conversation.messages).toHaveLength(1);
      expect(conversation.messages[0].content).toBe('hello');
    });

    it('agent_thought_chunk creates a think tool call', () => {
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Starting interactive diff review' }
      });

      expect(conversation.messages).toHaveLength(0);
      expect(conversation.toolCalls.size).toBe(1);
      const tc = [...conversation.toolCalls.values()][0];
      expect(tc.kind).toBe('think');
      expect(tc.status).toBe('in_progress');
      expect(tc.content[0]).toEqual({
        type: 'content',
        content: { type: 'text', text: 'Starting interactive diff review' }
      });
    });

    it('consecutive agent_thought_chunks accumulate into same tool call', () => {
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'The user wants' }
      });
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: ' to start' }
      });
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: ' a delve session.' }
      });

      expect(conversation.toolCalls.size).toBe(1);
      const tc = [...conversation.toolCalls.values()][0];
      expect(tc.content).toHaveLength(1);
      expect(tc.content[0]).toEqual({
        type: 'content',
        content: { type: 'text', text: 'The user wants to start a delve session.' }
      });
    });

    it('agent_message_chunk after agent_thought_chunk completes thinking', () => {
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Let me think...' }
      });
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Here is the answer.' }
      });

      const tc = [...conversation.toolCalls.values()][0];
      expect(tc.status).toBe('completed');
      expect(conversation.messages).toHaveLength(1);
      expect(conversation.messages[0].content).toBe('Here is the answer.');
    });

    it('whitespace-only text chunks do not create new messages', () => {
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '\n\n' }
      });

      expect(conversation.messages).toHaveLength(0);
    });

    it('trims leading newlines from agent message first chunk', () => {
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '\n\nHello' }
      });

      expect(conversation.messages).toHaveLength(1);
      expect(conversation.messages[0].content).toBe('Hello');
    });

    it('trims leading newlines across multiple initial chunks', () => {
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '\n' }
      });
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '\n' }
      });
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello' }
      });

      expect(conversation.messages).toHaveLength(1);
      expect(conversation.messages[0].content).toBe('Hello');
    });

    it('preserves newlines in the middle of agent messages', () => {
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello' }
      });
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '\n\nWorld' }
      });

      expect(conversation.messages[0].content).toBe('Hello\n\nWorld');
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
      conversation.addShellResult('ls', 'out', '', 0);

      conversation.clear();

      expect(conversation.messages).toHaveLength(0);
      expect(conversation.toolCalls.size).toBe(0);
      expect(conversation.permissions).toHaveLength(0);
      expect(conversation.plan).toBeNull();
      expect(conversation.shellResults.size).toBe(0);
    });
  });

  describe('Timeline ordering — most recently updated item closest to bottom', () => {
    it('agent message moves below tool call when text continues after tool call', () => {
      // 1. Agent starts streaming
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Let me check...' }
      });
      // Timeline: [msg-0]
      expect(conversation.timeline).toEqual([
        { type: 'message', index: 0 }
      ]);

      // 2. Tool call arrives
      conversation.handleSessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc1',
        title: 'Read file',
        kind: 'read',
        status: 'pending'
      });
      // Timeline: [msg-0, toolCall-tc1]
      expect(conversation.timeline).toEqual([
        { type: 'message', index: 0 },
        { type: 'toolCall', toolCallId: 'tc1' }
      ]);

      // 3. Agent continues streaming after tool call
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' Here are the results.' }
      });
      // Timeline should now be: [toolCall-tc1, msg-0]
      // The agent message moved to the bottom because it was most recently updated
      expect(conversation.timeline).toEqual([
        { type: 'toolCall', toolCallId: 'tc1' },
        { type: 'message', index: 0 }
      ]);
    });

    it('agent message moves below permission when text continues', () => {
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'I need to...' }
      });
      conversation.trackPermission(1, 'tc1', 'Allow?', [
        { optionId: 'yes', name: 'Yes', kind: 'allow_once' }
      ]);

      // Agent resumes
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' Done.' }
      });

      expect(conversation.timeline).toEqual([
        { type: 'permission', requestId: 1 },
        { type: 'message', index: 0 }
      ]);
    });

    it('message stays at end during normal streaming (no unnecessary reorder)', () => {
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'First chunk' }
      });
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' second chunk' }
      });

      // Should still be a single entry at the end — no movement needed
      expect(conversation.timeline).toEqual([
        { type: 'message', index: 0 }
      ]);
    });

    it('multiple tool calls interleaved with message', () => {
      conversation.addUserMessage('hello');
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Checking...' }
      });
      conversation.handleSessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc1',
        title: 'Read',
        kind: 'read',
        status: 'pending'
      });
      conversation.handleSessionUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc2',
        title: 'Write',
        kind: 'edit',
        status: 'pending'
      });
      // Agent resumes text
      conversation.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' All done.' }
      });

      // User message stays first, agent message moves after both tool calls
      expect(conversation.timeline).toEqual([
        { type: 'message', index: 0 },  // user
        { type: 'toolCall', toolCallId: 'tc1' },
        { type: 'toolCall', toolCallId: 'tc2' },
        { type: 'message', index: 1 }   // agent (moved to end)
      ]);
    });
  });

  describe('Shell results in timeline', () => {
    it('addShellResult adds a shell entry to the timeline', () => {
      conversation.addShellResult('echo hello', 'hello\n', '', 0);

      expect(conversation.shellResults.size).toBe(1);
      const sr = conversation.shellResults.get(0);
      expect(sr).toEqual({ id: 0, command: 'echo hello', stdout: 'hello\n', stderr: '', exitCode: 0 });
      expect(conversation.timeline).toEqual([{ type: 'shell', id: 0 }]);
    });

    it('shell results appear inline with messages in timeline order', () => {
      conversation.addUserMessage('$ echo hello');
      conversation.addShellResult('echo hello', 'hello\n', '', 0);
      conversation.addUserMessage('next message');

      expect(conversation.timeline).toEqual([
        { type: 'message', index: 0 },
        { type: 'shell', id: 0 },
        { type: 'message', index: 1 },
      ]);
    });

    it('clear() resets shell results', () => {
      conversation.addShellResult('ls', 'file.txt\n', '', 0);
      conversation.clear();

      expect(conversation.shellResults.size).toBe(0);
      expect(conversation.timeline).toHaveLength(0);
    });

    it('shell IDs increment across multiple results', () => {
      conversation.addShellResult('cmd1', 'out1', '', 0);
      conversation.addShellResult('cmd2', 'out2', '', 1);

      expect(conversation.shellResults.get(0)!.command).toBe('cmd1');
      expect(conversation.shellResults.get(1)!.command).toBe('cmd2');
      expect(conversation.timeline).toEqual([
        { type: 'shell', id: 0 },
        { type: 'shell', id: 1 },
      ]);
    });
  });
});
