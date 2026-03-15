import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AcpClient } from '../../src/client/acp-client';
import { extractModelFromConfigOptions } from '../../src/shared/acp-types';

const flushAsync = () => new Promise(r => setTimeout(r, 0));

describe('AcpClient Bug Fixes', () => {
  let client: AcpClient;
  let mockWs: any;
  const options = {
    wsUrl: 'ws://localhost:3000',
    cwd: '/test/cwd',
    onSessionUpdate: vi.fn(),
    onPermissionRequest: vi.fn(),
    onStateChange: vi.fn(),
    onError: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockWs = {
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      readyState: 1, // OPEN
    };
    const MockWebSocket = vi.fn(function (this: any) {
      return Object.assign(this, mockWs);
    }) as any;
    MockWebSocket.OPEN = 1;
    MockWebSocket.CONNECTING = 0;
    MockWebSocket.prototype = {};
    global.WebSocket = MockWebSocket;
    // Mock localStorage for browser-only APIs
    global.localStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      length: 0,
      key: vi.fn(() => null),
    } as any;
    client = new AcpClient(options);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('configOptions model extraction', () => {
    it('should call onModelsAvailable from configOptions in session/new response', async () => {
      const onModelsAvailable = vi.fn();
      const clientWithModels = new AcpClient({ ...options, onModelsAvailable });

      const sendRequestSpy = vi.spyOn(clientWithModels as any, 'sendRequest');
      // initialize returns capabilities
      sendRequestSpy.mockResolvedValueOnce({ agentCapabilities: {} });
      // session/new returns configOptions with model category
      sendRequestSpy.mockResolvedValueOnce({
        sessionId: 'sess-config',
        configOptions: [{
          type: 'select',
          id: 'model',
          name: 'Model',
          category: 'model',
          currentValue: 'claude-opus-4.6',
          options: [
            { value: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
            { value: 'claude-opus-4.6', name: 'Claude Opus 4.6' },
            { value: 'gpt-5.1', name: 'GPT-5.1' },
          ],
        }],
      });

      clientWithModels.connect();
      const openCallback = mockWs.addEventListener.mock.calls.find(c => c[0] === 'open')?.[1];
      openCallback();
      await flushAsync();

      expect(onModelsAvailable).toHaveBeenCalledWith(
        [
          { modelId: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
          { modelId: 'claude-opus-4.6', name: 'Claude Opus 4.6' },
          { modelId: 'gpt-5.1', name: 'GPT-5.1' },
        ],
        'claude-opus-4.6',
      );
    });

    it('should prefer configOptions over legacy models field', async () => {
      const onModelsAvailable = vi.fn();
      const clientWithModels = new AcpClient({ ...options, onModelsAvailable });

      const sendRequestSpy = vi.spyOn(clientWithModels as any, 'sendRequest');
      sendRequestSpy.mockResolvedValueOnce({ agentCapabilities: {} });
      sendRequestSpy.mockResolvedValueOnce({
        sessionId: 'sess-both',
        // Both legacy and new present - configOptions should win
        models: {
          currentModelId: 'claude-sonnet-4.6',
          availableModels: [
            { modelId: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
          ],
        },
        configOptions: [{
          type: 'select',
          id: 'model',
          name: 'Model',
          category: 'model',
          currentValue: 'claude-opus-4.6',
          options: [
            { value: 'claude-opus-4.6', name: 'Claude Opus 4.6' },
          ],
        }],
      });

      clientWithModels.connect();
      const openCallback = mockWs.addEventListener.mock.calls.find(c => c[0] === 'open')?.[1];
      openCallback();
      await flushAsync();

      // Should be called with configOptions data (opus), not legacy (sonnet)
      expect(onModelsAvailable).toHaveBeenCalledWith(
        [{ modelId: 'claude-opus-4.6', name: 'Claude Opus 4.6' }],
        'claude-opus-4.6',
      );
    });

    it('should handle config_option_update notification for model change', async () => {
      const onModelsAvailable = vi.fn();
      const clientWithModels = new AcpClient({ ...options, onModelsAvailable });

      (clientWithModels as any).sessionId = 'sess-1';
      (clientWithModels as any).ws = mockWs;

      // Simulate receiving a config_option_update notification
      (clientWithModels as any).handleNotification({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-1',
          update: {
            sessionUpdate: 'config_option_update',
            configOptions: [{
              type: 'select',
              id: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'gpt-5.1',
              options: [
                { value: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
                { value: 'gpt-5.1', name: 'GPT-5.1' },
              ],
            }],
          },
        },
      });

      expect(onModelsAvailable).toHaveBeenCalledWith(
        [
          { modelId: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
          { modelId: 'gpt-5.1', name: 'GPT-5.1' },
        ],
        'gpt-5.1',
      );
    });

    it('should fall back to legacy models field when no configOptions', async () => {
      const onModelsAvailable = vi.fn();
      const clientWithModels = new AcpClient({ ...options, onModelsAvailable });

      const sendRequestSpy = vi.spyOn(clientWithModels as any, 'sendRequest');
      sendRequestSpy.mockResolvedValueOnce({ agentCapabilities: {} });
      sendRequestSpy.mockResolvedValueOnce({
        sessionId: 'sess-legacy',
        models: {
          currentModelId: 'claude-sonnet-4.6',
          availableModels: [
            { modelId: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
          ],
        },
      });

      clientWithModels.connect();
      const openCallback = mockWs.addEventListener.mock.calls.find(c => c[0] === 'open')?.[1];
      openCallback();
      await flushAsync();

      expect(onModelsAvailable).toHaveBeenCalledWith(
        [{ modelId: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' }],
        'claude-sonnet-4.6',
      );
    });
  });

  describe('extractModelFromConfigOptions', () => {
    it('should extract model from configOptions with model category', () => {
      const result = extractModelFromConfigOptions([{
        type: 'select',
        id: 'model',
        name: 'Model',
        category: 'model',
        currentValue: 'claude-opus-4.6',
        options: [
          { value: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
          { value: 'claude-opus-4.6', name: 'Claude Opus 4.6' },
        ],
      }]);

      expect(result).toEqual({
        availableModels: [
          { modelId: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
          { modelId: 'claude-opus-4.6', name: 'Claude Opus 4.6' },
        ],
        currentModelId: 'claude-opus-4.6',
      });
    });

    it('should return undefined when no model category config option', () => {
      const result = extractModelFromConfigOptions([{
        type: 'select',
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        currentValue: 'agent',
        options: [{ value: 'agent', name: 'Agent' }],
      }]);

      expect(result).toBeUndefined();
    });

    it('should return undefined for empty configOptions', () => {
      expect(extractModelFromConfigOptions([])).toBeUndefined();
      expect(extractModelFromConfigOptions(undefined as any)).toBeUndefined();
    });

    it('should handle grouped options', () => {
      const result = extractModelFromConfigOptions([{
        type: 'select',
        id: 'model',
        name: 'Model',
        category: 'model',
        currentValue: 'claude-opus-4.6',
        options: [
          {
            group: 'anthropic',
            name: 'Anthropic',
            options: [
              { value: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
              { value: 'claude-opus-4.6', name: 'Claude Opus 4.6' },
            ],
          },
          {
            group: 'openai',
            name: 'OpenAI',
            options: [
              { value: 'gpt-5.1', name: 'GPT-5.1' },
            ],
          },
        ],
      }]);

      expect(result).toEqual({
        availableModels: [
          { modelId: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
          { modelId: 'claude-opus-4.6', name: 'Claude Opus 4.6' },
          { modelId: 'gpt-5.1', name: 'GPT-5.1' },
        ],
        currentModelId: 'claude-opus-4.6',
      });
    });
  });

  describe('Bug 1: Reconnect counter reset', () => {
    it('should NOT reset reconnectAttempts immediately on open', async () => {
      // Access private property for testing
      (client as any).reconnectAttempts = 5;
      
      // Trigger connect and catch the expected rejection
      const connectPromise = client.connect().catch(() => {});
      
      // Simulate WebSocket open
      const openCallback = mockWs.addEventListener.mock.calls.find(c => c[0] === 'open')?.[1];
      expect(openCallback).toBeDefined();
      
      // We need to mock initializeSession to fail to see if reconnectAttempts is preserved/incremented
      // But initializeSession is private and called inside handleOpen.
      // We can spy on sendRequest which is called by initializeSession.
      
      // Spy on private sendRequest
      const sendRequestSpy = vi.spyOn(client as any, 'sendRequest');
      // Use mockImplementation to return a rejected promise that is handled
      sendRequestSpy.mockImplementation(() => Promise.reject(new Error('Init failed')));
      
      // Trigger open
      openCallback();
      
      // Wait for async operations
      await flushAsync();
      
      // Attempts should NOT be reset to 0 if init fails
      // The code sets it to 0 only after success now.
      expect((client as any).reconnectAttempts).not.toBe(0);
      expect((client as any).reconnectAttempts).toBe(5);
    });

    it('should reset reconnectAttempts after successful initialization', async () => {
      (client as any).reconnectAttempts = 5;
      
      // Mock successful init
      const sendRequestSpy = vi.spyOn(client as any, 'sendRequest');
      sendRequestSpy.mockResolvedValueOnce({}); // initialize
      sendRequestSpy.mockResolvedValueOnce({ sessionId: 'sess-123' }); // session/new
      
      client.connect();
      const openCallback = mockWs.addEventListener.mock.calls.find(c => c[0] === 'open')?.[1];
      openCallback();
      
      await flushAsync();
      
      expect((client as any).reconnectAttempts).toBe(0);
      expect(client.connectionState).toBe('ready');
    });
  });

  describe('Bug 2: Permission responder context', () => {
    it('should ignore permission response if session changed', async () => {
      // Setup active session
      (client as any).sessionId = 'session-1';
      (client as any).ws = mockWs;
      
      // Get the responder
      // Access private method
      const createResponder = (client as any).createPermissionResponder('req-1');
      
      // Change session
      (client as any).sessionId = 'session-2';
      
      // Call responder
      createResponder('granted');
      
      // Should NOT send message
      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('should send permission response if session matches', async () => {
      (client as any).sessionId = 'session-1';
      (client as any).ws = mockWs;
      
      const createResponder = (client as any).createPermissionResponder('req-1');
      
      createResponder('granted');
      
      expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('"result":{"outcome":"granted"}'));
    });
  });

  describe('Bug 3: User callbacks try-catch', () => {
    it('should catch error in onSessionUpdate', () => {
      const error = new Error('User callback error');
      options.onSessionUpdate.mockImplementation(() => { throw error; });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      // Trigger notification
      // Access private handleNotification
      (client as any).handleNotification({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { update: {} }
      });
      
      expect(options.onSessionUpdate).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Error in onSessionUpdate'), error);
    });

    it('should catch error in onStateChange', () => {
      const error = new Error('User callback error');
      options.onStateChange.mockImplementation(() => { throw error; });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      // Trigger state change
      (client as any).setState('connecting');
      
      expect(options.onStateChange).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Error in onStateChange'), error);
    });
    
    it('should catch error in onPermissionRequest', () => {
      const error = new Error('User callback error');
      options.onPermissionRequest.mockImplementation(() => { throw error; });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      // Trigger request
      (client as any).handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'session/request_permission',
        params: {}
      });
      
      expect(options.onPermissionRequest).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Error in onPermissionRequest'), error);
    });
  });

   describe('Session resume via localStorage', () => {
    it('should call session/load when uplink-resume-session is set and agent supports it', async () => {
      // Mock localStorage to return a resume session ID
      (global.localStorage.getItem as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'uplink-resume-session') return 'sess-to-resume';
        return null;
      });

      const sendRequestSpy = vi.spyOn(client as any, 'sendRequest');
      // initialize returns loadSession capability
      sendRequestSpy.mockResolvedValueOnce({ agentCapabilities: { loadSession: true } });
      // session/load succeeds
      sendRequestSpy.mockResolvedValueOnce({});

      client.connect();
      const openCallback = mockWs.addEventListener.mock.calls.find(c => c[0] === 'open')?.[1];
      openCallback();

      await flushAsync();

      // Verify session/load was called instead of session/new
      const calls = sendRequestSpy.mock.calls.map(c => c[0]);
      expect(calls).toContain('initialize');
      expect(calls).toContain('session/load');
      expect(calls).not.toContain('session/new');
      expect(client.currentSessionId).toBe('sess-to-resume');
      // Resume key should be preserved for future refreshes
      expect(global.localStorage.removeItem).not.toHaveBeenCalledWith('uplink-resume-session');
    });

    // "already loaded" is now handled server-side (server replays buffered history).
    // The client never sees this error — server fabricates a success response.

    it('should fall back to session/new when session/load fails with non-resume error', async () => {
      (global.localStorage.getItem as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'uplink-resume-session') return 'sess-broken';
        return null;
      });

      const sendRequestSpy = vi.spyOn(client as any, 'sendRequest');
      sendRequestSpy.mockResolvedValueOnce({ agentCapabilities: { loadSession: true } });
      // session/load fails with a real error (not "already loaded")
      sendRequestSpy.mockRejectedValueOnce(new Error('Session not found'));
      // session/new succeeds
      sendRequestSpy.mockResolvedValueOnce({ sessionId: 'sess-new' });

      client.connect();
      const openCallback = mockWs.addEventListener.mock.calls.find(c => c[0] === 'open')?.[1];
      openCallback();

      await flushAsync();

      const calls = sendRequestSpy.mock.calls.map(c => c[0]);
      expect(calls).toContain('session/new');
      expect(client.currentSessionId).toBe('sess-new');
      // Stale resume key should be cleaned up on failure
      expect(global.localStorage.removeItem).toHaveBeenCalledWith('uplink-resume-session');
    });

    it('should skip session/load when agent does not support it', async () => {
      (global.localStorage.getItem as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'uplink-resume-session') return 'sess-no-support';
        return null;
      });

      const sendRequestSpy = vi.spyOn(client as any, 'sendRequest');
      sendRequestSpy.mockResolvedValueOnce({ agentCapabilities: {} }); // no loadSession
      sendRequestSpy.mockResolvedValueOnce({ sessionId: 'sess-new' });

      client.connect();
      const openCallback = mockWs.addEventListener.mock.calls.find(c => c[0] === 'open')?.[1];
      openCallback();

      await flushAsync();

      const calls = sendRequestSpy.mock.calls.map(c => c[0]);
      expect(calls).not.toContain('session/load');
      expect(calls).toContain('session/new');
    });
  });

  describe('Same-session reconnect preservation', () => {
    it('should save sessionId as previousSessionId on close', async () => {
      // Establish a session first
      (client as any).sessionId = 'sess-active';
      (client as any).ws = mockWs;

      // Simulate close
      (client as any).handleClose();

      // previousSessionId should be saved
      expect((client as any).previousSessionId).toBe('sess-active');
      // current sessionId should be cleared
      expect((client as any).sessionId).toBeUndefined();
    });

    it('should pass skipReplay on session/load when reconnecting to the same session', async () => {
      const onClearConversation = vi.fn();
      const clientWithClear = new AcpClient({ ...options, onClearConversation });

      // Simulate a previous session that was disconnected
      (clientWithClear as any).previousSessionId = 'sess-same';

      // localStorage has the same session ID
      (global.localStorage.getItem as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'uplink-resume-session') return 'sess-same';
        return null;
      });

      const sendRequestSpy = vi.spyOn(clientWithClear as any, 'sendRequest');
      sendRequestSpy.mockResolvedValueOnce({ agentCapabilities: { loadSession: true } });
      sendRequestSpy.mockResolvedValueOnce({ sessionId: 'sess-same' });

      clientWithClear.connect();
      const openCallback = mockWs.addEventListener.mock.calls.find(c => c[0] === 'open')?.[1];
      openCallback();
      await flushAsync();

      // session/load should include skipReplay: true
      const loadCall = sendRequestSpy.mock.calls.find(c => c[0] === 'session/load');
      expect(loadCall).toBeDefined();
      expect(loadCall![1]).toHaveProperty('skipReplay', true);
    });

    it('should NOT call onClearConversation on same-session reconnect', async () => {
      const onClearConversation = vi.fn();
      const clientWithClear = new AcpClient({ ...options, onClearConversation });

      // Simulate a previous session that was disconnected
      (clientWithClear as any).previousSessionId = 'sess-same';

      // localStorage has the same session ID
      (global.localStorage.getItem as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'uplink-resume-session') return 'sess-same';
        return null;
      });

      const sendRequestSpy = vi.spyOn(clientWithClear as any, 'sendRequest');
      sendRequestSpy.mockResolvedValueOnce({ agentCapabilities: { loadSession: true } });
      sendRequestSpy.mockResolvedValueOnce({ sessionId: 'sess-same' });

      clientWithClear.connect();
      const openCallback = mockWs.addEventListener.mock.calls.find(c => c[0] === 'open')?.[1];
      openCallback();
      await flushAsync();

      expect(onClearConversation).not.toHaveBeenCalled();
    });

    it('should call onClearConversation when creating a new session', async () => {
      const onClearConversation = vi.fn();
      const clientWithClear = new AcpClient({ ...options, onClearConversation });

      // No previous session, no resume key
      const sendRequestSpy = vi.spyOn(clientWithClear as any, 'sendRequest');
      sendRequestSpy.mockResolvedValueOnce({ agentCapabilities: {} });
      sendRequestSpy.mockResolvedValueOnce({ sessionId: 'sess-brand-new' });

      clientWithClear.connect();
      const openCallback = mockWs.addEventListener.mock.calls.find(c => c[0] === 'open')?.[1];
      openCallback();
      await flushAsync();

      expect(onClearConversation).toHaveBeenCalled();
    });

    it('should call onClearConversation when loading a different session', async () => {
      const onClearConversation = vi.fn();
      const clientWithClear = new AcpClient({ ...options, onClearConversation });

      // Previous session was different
      (clientWithClear as any).previousSessionId = 'sess-old';

      // localStorage has a different session ID
      (global.localStorage.getItem as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'uplink-resume-session') return 'sess-different';
        return null;
      });

      const sendRequestSpy = vi.spyOn(clientWithClear as any, 'sendRequest');
      sendRequestSpy.mockResolvedValueOnce({ agentCapabilities: { loadSession: true } });
      sendRequestSpy.mockResolvedValueOnce({ sessionId: 'sess-different' });

      clientWithClear.connect();
      const openCallback = mockWs.addEventListener.mock.calls.find(c => c[0] === 'open')?.[1];
      openCallback();
      await flushAsync();

      expect(onClearConversation).toHaveBeenCalled();
    });

    it('should NOT pass skipReplay when loading a different session on reconnect', async () => {
      const clientWithClear = new AcpClient({ ...options, onClearConversation: vi.fn() });

      (clientWithClear as any).previousSessionId = 'sess-old';

      (global.localStorage.getItem as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'uplink-resume-session') return 'sess-different';
        return null;
      });

      const sendRequestSpy = vi.spyOn(clientWithClear as any, 'sendRequest');
      sendRequestSpy.mockResolvedValueOnce({ agentCapabilities: { loadSession: true } });
      sendRequestSpy.mockResolvedValueOnce({ sessionId: 'sess-different' });

      clientWithClear.connect();
      const openCallback = mockWs.addEventListener.mock.calls.find(c => c[0] === 'open')?.[1];
      openCallback();
      await flushAsync();

      const loadCall = sendRequestSpy.mock.calls.find(c => c[0] === 'session/load');
      expect(loadCall).toBeDefined();
      expect(loadCall![1]).not.toHaveProperty('skipReplay');
    });
  });
});
