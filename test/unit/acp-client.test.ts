import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AcpClient } from '../../src/client/acp-client';

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
    global.WebSocket = vi.fn(() => mockWs) as any;
    (global.WebSocket as any).OPEN = 1;
    (global.WebSocket as any).CONNECTING = 0;
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
    vi.restoreAllMocks();
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

    it('should treat "already loaded" error as successful resume', async () => {
      const modelsCallback = vi.fn();
      const cachedModels = JSON.stringify({
        availableModels: [{ modelId: 'cached-model' }],
        currentModelId: 'cached-model',
      });
      (global.localStorage.getItem as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'uplink-resume-session') return 'sess-already-loaded';
        if (key === 'uplink-cached-models') return cachedModels;
        return null;
      });

      // Create client with onModelsAvailable callback
      const clientWithModels = new AcpClient({
        url: 'ws://test',
        cwd: '/test',
        onModelsAvailable: modelsCallback,
      });
      const spy = vi.spyOn(clientWithModels as any, 'sendRequest');
      spy.mockResolvedValueOnce({ agentCapabilities: { loadSession: true } });
      // session/load fails with "already loaded"
      spy.mockRejectedValueOnce(new Error('Session sess-already-loaded is already loaded'));

      clientWithModels.connect();
      const ws2 = (clientWithModels as any).ws;
      const openCb = ws2.addEventListener.mock.calls.find((c: any) => c[0] === 'open')?.[1];
      openCb();

      await flushAsync();

      const calls = spy.mock.calls.map((c: any) => c[0]);
      expect(calls).not.toContain('session/new');
      expect(clientWithModels.currentSessionId).toBe('sess-already-loaded');
      // Models restored from localStorage cache
      expect(modelsCallback).toHaveBeenCalledWith(
        [{ modelId: 'cached-model' }],
        'cached-model',
      );
    });

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
});
