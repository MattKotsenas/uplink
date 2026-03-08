import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

interface MockAgent {
  process: ChildProcess;
  send: (msg: object) => void;
  /** Wait until a message matching `predicate` arrives (or timeout). Returns all received messages. */
  waitFor: (predicate: (msgs: any[]) => boolean, timeout?: number) => Promise<any[]>;
  /** Convenience: wait for a response with the given id. */
  waitForResponse: (id: string | number, timeout?: number) => Promise<any[]>;
  /** All messages received so far. */
  received: any[];
  /** Clear received messages (for test isolation). */
  clearReceived: () => void;
}

function spawnMockAgent(): MockAgent {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'cmd.exe' : 'npx';
  const args = isWin
    ? ['/c', 'npx', 'tsx', 'src/mock/mock-agent.ts', '--acp', '--stdio']
    : ['tsx', 'src/mock/mock-agent.ts', '--acp', '--stdio'];

  const child = spawn(cmd, args, {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    env: { ...process.env, NO_COLOR: '1' },
  });

  const received: any[] = [];
  const waiters: Array<{ predicate: (msgs: any[]) => boolean; resolve: (msgs: any[]) => void }> = [];

  const rl = createInterface({ input: child.stdout! });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      received.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].predicate(received)) {
          waiters[i].resolve([...received]);
          waiters.splice(i, 1);
        }
      }
    } catch {
      // non-JSON line (e.g. npm output), ignore
    }
  });

  function waitFor(predicate: (msgs: any[]) => boolean, timeout = 15000): Promise<any[]> {
    if (predicate(received)) return Promise.resolve([...received]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`waitFor timed out after ${timeout}ms. Received ${received.length} messages.`));
      }, timeout);
      waiters.push({
        predicate,
        resolve: (msgs) => {
          clearTimeout(timer);
          resolve(msgs);
        },
      });
    });
  }

  function waitForResponse(id: string | number, timeout?: number): Promise<any[]> {
    return waitFor((msgs) => msgs.some((m) => m.id === id && (m.result || m.error)), timeout);
  }

  function clearReceived(): void {
    received.length = 0;
  }

  return { process: child, send: (msg) => child.stdin!.write(JSON.stringify(msg) + '\n'), waitFor, waitForResponse, received, clearReceived };
}

describe('Mock ACP Agent', () => {
  let agent: MockAgent;
  let sessionId: string;
  let nextId = 100;

  function id() { return nextId++; }

  beforeAll(async () => {
    agent = spawnMockAgent();

    // Initialize once for all tests
    const initId = id();
    agent.send({
      jsonrpc: '2.0', id: initId, method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } },
    });
    await agent.waitForResponse(initId);

    const initResponse = agent.received.find(m => m.id === initId);
    expect(initResponse.result.protocolVersion).toBe(1);
    expect(initResponse.result.agentInfo).toEqual({ name: 'mock-agent', title: 'Mock Agent', version: '0.1.0' });

    // Create session once for all tests
    const sessionNewId = id();
    agent.send({ jsonrpc: '2.0', id: sessionNewId, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
    await agent.waitForResponse(sessionNewId);
    sessionId = agent.received.find(m => m.id === sessionNewId).result.sessionId;
    expect(sessionId).toContain('mock-session-');
  }, 20000);

  afterAll(() => {
    agent?.process.kill();
  });

  beforeEach(() => {
    agent.clearReceived();
  });

  it('simple text scenario', async () => {
    const promptId = id();
    agent.send({
      jsonrpc: '2.0', id: promptId, method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'simple' }] },
    });

    await agent.waitForResponse(promptId);
    const chunks = agent.received
      .filter(m => !m.id && m.method === 'session/update' && m.params.update.sessionUpdate === 'agent_message_chunk')
      .map(m => m.params.update.content);

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0].text).toBe('Hello ');
    expect(chunks[1].text).toBe('from ');
    expect(chunks[2].text).toBe('mock agent!');

    const response = agent.received.find(m => m.id === promptId);
    expect(response.result.stopReason).toBe('end_turn');
  });

  it('tool call lifecycle', async () => {
    const promptId = id();
    agent.send({
      jsonrpc: '2.0', id: promptId, method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'tool' }] },
    });

    await agent.waitForResponse(promptId);
    const updates = agent.received
      .filter(m => !m.id && m.method === 'session/update')
      .map(m => m.params.update);

    const toolCall = updates.find(u => u.sessionUpdate === 'tool_call');
    expect(toolCall).toBeDefined();
    expect(toolCall.toolCallId).toBe('tc1');
    expect(toolCall.status).toBe('pending');

    expect(updates.find(u => u.sessionUpdate === 'tool_call_update' && u.status === 'in_progress')).toBeDefined();
    expect(updates.find(u => u.sessionUpdate === 'tool_call_update' && u.status === 'completed')).toBeDefined();

    expect(agent.received.find(m => m.id === promptId).result.stopReason).toBe('end_turn');
  });

  it('permission granted flow', async () => {
    const promptId = id();
    agent.send({
      jsonrpc: '2.0', id: promptId, method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'permission' }] },
    });

    await agent.waitFor(msgs => msgs.some(m => m.method === 'session/request_permission'));
    const permRequest = agent.received.find(m => m.method === 'session/request_permission');
    expect(permRequest.params.options).toBeDefined();

    agent.send({
      jsonrpc: '2.0', id: permRequest.id,
      result: { outcome: { outcome: 'selected', optionId: 'allow' } },
    });

    await agent.waitForResponse(promptId);
    const updates = agent.received
      .filter(m => !m.id && m.method === 'session/update')
      .map(m => m.params.update);

    expect(updates.find(u => u.sessionUpdate === 'tool_call_update' && u.status === 'completed')).toBeDefined();
    expect(agent.received.find(m => m.id === promptId).result.stopReason).toBe('end_turn');
  });

  it('permission denied flow', async () => {
    const promptId = id();
    agent.send({
      jsonrpc: '2.0', id: promptId, method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'permission' }] },
    });

    await agent.waitFor(msgs => msgs.some(m => m.method === 'session/request_permission'));
    const permRequest = agent.received.find(m => m.method === 'session/request_permission');

    agent.send({
      jsonrpc: '2.0', id: permRequest.id,
      result: { outcome: { outcome: 'selected', optionId: 'reject' } },
    });

    await agent.waitForResponse(promptId);
    const updates = agent.received
      .filter(m => !m.id && m.method === 'session/update')
      .map(m => m.params.update);

    expect(updates.find(u => u.sessionUpdate === 'tool_call_update' && u.status === 'failed')).toBeDefined();
    expect(updates.find(u => u.sessionUpdate === 'agent_message_chunk' && u.content.text === 'Permission denied.')).toBeDefined();
    expect(agent.received.find(m => m.id === promptId).result.stopReason).toBe('end_turn');
  });

  it('refusal scenario', async () => {
    const promptId = id();
    agent.send({
      jsonrpc: '2.0', id: promptId, method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'refuse' }] },
    });

    await agent.waitForResponse(promptId);
    expect(agent.received.find(m => m.id === promptId).result.stopReason).toBe('refusal');

    const chunk = agent.received
      .filter(m => !m.id && m.method === 'session/update')
      .find(m => m.params.update.sessionUpdate === 'agent_message_chunk');
    expect(chunk.params.update.content.text).toBe('I cannot do that.');
  });

  it('cancel mid-stream', async () => {
    const promptId = id();
    agent.send({
      jsonrpc: '2.0', id: promptId, method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'stream' }] },
    });

    await agent.waitFor(msgs => msgs.some(
      m => m.method === 'session/update' && m.params?.update?.sessionUpdate === 'agent_message_chunk',
    ));

    agent.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });

    await agent.waitForResponse(promptId);
    expect(agent.received.find(m => m.id === promptId).result.stopReason).toBe('cancelled');
  });

  it('session/load returns already-loaded error for active session', async () => {
    const loadId = id();
    agent.send({
      jsonrpc: '2.0', id: loadId, method: 'session/load',
      params: { sessionId, cwd: process.cwd(), mcpServers: [] },
    });

    await agent.waitForResponse(loadId);
    const response = agent.received.find(m => m.id === loadId);
    expect(response.error).toBeDefined();
    expect(response.error.message).toContain('already loaded');
  });

  it('/clear scenario', async () => {
    const promptId = id();
    agent.send({
      jsonrpc: '2.0', id: promptId, method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: '/clear' }] },
    });

    await agent.waitForResponse(promptId);
    const chunks = agent.received
      .filter(m => !m.id && m.method === 'session/update' && m.params.update.sessionUpdate === 'agent_message_chunk')
      .map(m => m.params.update.content);

    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toBe('Conversation cleared.');
    expect(agent.received.find(m => m.id === promptId).result.stopReason).toBe('end_turn');
  });

  it('JSON-RPC envelope correctness', async () => {
    const promptId = id();
    agent.send({
      jsonrpc: '2.0', id: promptId, method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'simple' }] },
    });

    await agent.waitForResponse(promptId);

    // All messages must have jsonrpc: '2.0'
    agent.received.forEach(m => {
      expect(m.jsonrpc).toBe('2.0');
    });

    // Notifications must not have id
    const notifications = agent.received.filter(m => m.method);
    notifications.forEach(n => {
      expect(n.id).toBeUndefined();
      expect(n.params).toBeDefined();
    });
  });
});
