import { vi, describe, it, expect, beforeEach } from 'vitest';

import {
  handleSend,
  handleClientCommand,
  handleClearCommand,
  handleSessionCommand,
} from '../../src/client/prompt-controller';
import type { PromptControllerDeps, AgentMode } from '../../src/client/prompt-controller';
import { Conversation } from '../../src/client/conversation';

interface MockClient {
  prompt: ReturnType<typeof vi.fn>;
  sendRawRequest: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  newSession: ReturnType<typeof vi.fn>;
  loadSession: ReturnType<typeof vi.fn>;
  currentSessionId: string | undefined;
  supportsLoadSession: boolean;
}

function createMockDeps(overrides: Partial<{
  client: Partial<MockClient>;
  mode: AgentMode;
  yolo: boolean;
  clientCwd: string;
}> = {}): PromptControllerDeps & { client: MockClient } {
  let mode: AgentMode = overrides.mode ?? 'chat';
  let yolo = overrides.yolo ?? false;

  const client: MockClient = {
    prompt: vi.fn().mockResolvedValue('end_turn' as const),
    sendRawRequest: vi.fn().mockResolvedValue({}),
    cancel: vi.fn(),
    newSession: vi.fn().mockResolvedValue(undefined),
    loadSession: vi.fn().mockResolvedValue(undefined),
    currentSessionId: 'test-session-123',
    supportsLoadSession: true,
    ...overrides.client,
  };

  return {
    client: client as unknown as PromptControllerDeps['client'] & MockClient,
    conversation: new Conversation(),
    clientCwd: overrides.clientCwd ?? '/test/cwd',
    getMode: () => mode,
    setMode: vi.fn((m: AgentMode) => { mode = m; }),
    yoloMode: () => yolo,
    setYoloMode: vi.fn((on: boolean) => { yolo = on; }),
    setModelLabel: vi.fn(),
    applyTheme: vi.fn(),
    cancelPermissions: vi.fn(),
    fetchSessions: vi.fn().mockResolvedValue([]),
    showSessionsModal: vi.fn(),
  } as PromptControllerDeps & { client: MockClient };
}

describe('prompt-controller', () => {
  // ── Shell commands ──────────────────────────────────────────────────

  describe('shell commands (!)', () => {
    it('dispatches uplink/shell and adds command to conversation', async () => {
      const deps = createMockDeps();
      deps.client.sendRawRequest.mockResolvedValue({
        stdout: 'file.txt',
        stderr: '',
        exitCode: 0,
      });

      await handleSend('!ls -la', deps);

      expect(deps.client.sendRawRequest).toHaveBeenCalledWith('uplink/shell', { command: 'ls -la' });
      const userMsg = deps.conversation.messages.value.find(m => m.role === 'user');
      expect(userMsg?.content).toBe('$ ls -la');
    });

    it('adds shell result with stdout and exitCode to conversation on success', async () => {
      const deps = createMockDeps();
      deps.client.sendRawRequest.mockResolvedValue({
        stdout: 'hello world',
        stderr: '',
        exitCode: 0,
      });

      await handleSend('!echo hello', deps);

      const results = [...deps.conversation.shellResults.value.values()];
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        command: 'echo hello',
        stdout: 'hello world',
        exitCode: 0,
      });
    });

    it('adds shell result with error message and exitCode 1 on error', async () => {
      const deps = createMockDeps();
      deps.client.sendRawRequest.mockRejectedValue(new Error('command not found'));

      await handleSend('!badcmd', deps);

      const results = [...deps.conversation.shellResults.value.values()];
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        stderr: 'command not found',
        exitCode: 1,
      });
    });

    it('does nothing for empty ! command', async () => {
      const deps = createMockDeps();

      await handleSend('!', deps);

      expect(deps.client.sendRawRequest).not.toHaveBeenCalled();
      expect(deps.conversation.messages.value).toHaveLength(0);
    });
  });

  // ── Slash commands ──────────────────────────────────────────────────

  describe('slash commands', () => {
    it('/agent switches mode to chat and adds system message', () => {
      const deps = createMockDeps({ mode: 'plan' });

      handleClientCommand('/agent', '', deps);

      expect(deps.setMode).toHaveBeenCalledWith('chat');
      const sysMsg = deps.conversation.messages.value.find(m => m.role === 'system');
      expect(sysMsg?.content).toContain('agent');
    });

    it('/plan switches mode to plan and adds system message', () => {
      const deps = createMockDeps();

      handleClientCommand('/plan', '', deps);

      expect(deps.setMode).toHaveBeenCalledWith('plan');
      const sysMsg = deps.conversation.messages.value.find(m => m.role === 'system');
      expect(sysMsg?.content).toContain('plan');
    });

    it('/autopilot switches mode to autopilot and adds system message', () => {
      const deps = createMockDeps();

      handleClientCommand('/autopilot', '', deps);

      expect(deps.setMode).toHaveBeenCalledWith('autopilot');
      const sysMsg = deps.conversation.messages.value.find(m => m.role === 'system');
      expect(sysMsg?.content).toContain('autopilot');
    });

    it('/agent with prompt text switches mode AND sends prompt', async () => {
      const deps = createMockDeps();

      await handleSend('/agent fix the bug', deps);

      expect(deps.setMode).toHaveBeenCalledWith('chat');
      expect(deps.client.prompt).toHaveBeenCalledWith('fix the bug');

      const userMsg = deps.conversation.messages.value.find(m => m.role === 'user');
      expect(userMsg?.content).toBe('/agent fix the bug');
    });

    it('/theme dark calls applyTheme and adds system message', () => {
      const deps = createMockDeps();

      handleClientCommand('/theme', 'dark', deps);

      expect(deps.applyTheme).toHaveBeenCalledWith('dark');
      const sysMsg = deps.conversation.messages.value.find(m => m.role === 'system');
      expect(sysMsg?.content).toContain('dark');
    });

    it('/yolo enables yolo mode and adds system message', () => {
      const deps = createMockDeps();

      handleClientCommand('/yolo', '', deps);

      expect(deps.setYoloMode).toHaveBeenCalledWith(true);
      const sysMsg = deps.conversation.messages.value.find(m => m.role === 'system');
      expect(sysMsg?.content).toContain('enabled');
    });

    it('/yolo off disables yolo mode', () => {
      const deps = createMockDeps({ yolo: true });

      handleClientCommand('/yolo', 'off', deps);

      expect(deps.setYoloMode).toHaveBeenCalledWith(false);
      const sysMsg = deps.conversation.messages.value.find(m => m.role === 'system');
      expect(sysMsg?.content).toContain('disabled');
    });
  });

  // ── Plan mode prefixing ─────────────────────────────────────────────

  describe('plan mode prefixing', () => {
    it('prefixes prompt with /plan in plan mode', async () => {
      const deps = createMockDeps({ mode: 'plan' });

      await handleSend('write a function', deps);

      expect(deps.client.prompt).toHaveBeenCalledWith('/plan write a function');
    });

    it('sends prompt as-is in chat mode', async () => {
      const deps = createMockDeps({ mode: 'chat' });

      await handleSend('write a function', deps);

      expect(deps.client.prompt).toHaveBeenCalledWith('write a function');
    });
  });

  // ── Autopilot loop ──────────────────────────────────────────────────

  describe('autopilot loop', () => {
    it('auto-continues until non-end_turn stop reason', async () => {
      const deps = createMockDeps({ mode: 'autopilot' });
      deps.client.prompt
        .mockResolvedValueOnce('end_turn')
        .mockResolvedValueOnce('end_turn')
        .mockResolvedValueOnce('end_turn')
        .mockResolvedValueOnce('max_tokens');

      await handleSend('do something', deps);

      expect(deps.client.prompt).toHaveBeenCalledTimes(4);
      const continueMessages = deps.conversation.messages.value.filter(
        m => m.role === 'user' && m.content === 'continue',
      );
      expect(continueMessages).toHaveLength(3);
    });

    it('stops at 25 turns with system message', async () => {
      const deps = createMockDeps({ mode: 'autopilot' });
      deps.client.prompt.mockResolvedValue('end_turn');

      await handleSend('go', deps);

      // 1 initial + 25 continues = 26 total calls
      expect(deps.client.prompt).toHaveBeenCalledTimes(26);
      const sysMsg = deps.conversation.messages.value.find(m => m.role === 'system');
      expect(sysMsg?.content).toContain('maximum turns');
    });

    it('does not auto-continue in chat mode', async () => {
      const deps = createMockDeps({ mode: 'chat' });
      deps.client.prompt.mockResolvedValue('end_turn');

      await handleSend('hello', deps);

      expect(deps.client.prompt).toHaveBeenCalledTimes(1);
    });
  });

  // ── Clear command ───────────────────────────────────────────────────

  describe('handleClearCommand', () => {
    it('clears conversation messages', async () => {
      const deps = createMockDeps();
      deps.conversation.addUserMessage('old message');

      await handleClearCommand(deps);

      expect(deps.conversation.messages.value).toHaveLength(0);
    });

    it('sends uplink/clear_history to server', async () => {
      const deps = createMockDeps();

      await handleClearCommand(deps);

      expect(deps.client.sendRawRequest).toHaveBeenCalledWith(
        'uplink/clear_history',
        { sessionId: 'test-session-123' },
      );
    });

    it('sends /clear to CLI via client.prompt', async () => {
      const deps = createMockDeps();

      await handleClearCommand(deps);

      expect(deps.client.prompt).toHaveBeenCalledWith('/clear');
    });
  });

  // ── Session commands ────────────────────────────────────────────────

  describe('handleSessionCommand', () => {
    it('/session create clears conversation and calls client.newSession', async () => {
      const deps = createMockDeps();
      deps.conversation.addUserMessage('old message');

      await handleSessionCommand('create', deps);

      expect(deps.conversation.messages.value).toHaveLength(0);
      expect(deps.client.newSession).toHaveBeenCalled();
    });

    it('/session rename sends uplink/rename_session with summary', async () => {
      const deps = createMockDeps();

      await handleSessionCommand('rename My Title', deps);

      expect(deps.client.sendRawRequest).toHaveBeenCalledWith(
        'uplink/rename_session',
        { sessionId: 'test-session-123', summary: 'My Title' },
      );
      const sysMsg = deps.conversation.messages.value.find(m => m.role === 'system');
      expect(sysMsg?.content).toContain('My Title');
    });
  });
});
