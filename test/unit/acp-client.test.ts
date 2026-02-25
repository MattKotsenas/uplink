import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AcpClient } from '../../src/client/acp-client';
import { WebSocket } from 'ws';

// Mock WebSocket
const mockWs = {
  send: vi.fn(),
  close: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  readyState: 1 // OPEN
};

// Mock global WebSocket
global.WebSocket = vi.fn(() => mockWs) as any;
(global.WebSocket as any).OPEN = 1;
(global.WebSocket as any).CONNECTING = 0;

describe('AcpClient Bug Fixes', () => {
  let client: AcpClient;
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
      await new Promise(resolve => setTimeout(resolve, 10));
      
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
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
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
});
