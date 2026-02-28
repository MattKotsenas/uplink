import { describe, it, expect, afterEach } from 'vitest';
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
      // Check all pending waiters
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
    // Already satisfied?
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

  return { process: child, send: (msg) => child.stdin!.write(JSON.stringify(msg) + '\n'), waitFor, waitForResponse, received };
}

describe('Mock ACP Agent', () => {
  let agent: MockAgent | undefined;

  afterEach(() => {
    if (agent?.process) {
      agent.process.kill();
      agent = undefined;
    }
  });

  it('1. Initialize handshake', { timeout: 20000 }, async () => {
    agent = spawnMockAgent();
    agent.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    });

    await agent.waitForResponse(1);
    const response = agent.received.find(m => m.id === 1);
    
    expect(response).toBeDefined();
    expect(response.result).toBeDefined();
    expect(response.result.protocolVersion).toBe(1);
    expect(response.result.agentCapabilities).toBeDefined();
    expect(response.result.agentInfo).toEqual({ name: 'mock-agent', title: 'Mock Agent', version: '0.1.0' });
  });

  it('2. Session/new', { timeout: 20000 }, async () => {
    agent = spawnMockAgent();
    agent.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
    await agent.waitForResponse(1);

    agent.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
    await agent.waitForResponse(2);
    const response = agent.received.find(m => m.id === 2);
    
    expect(response).toBeDefined();
    expect(response.result).toBeDefined();
    expect(response.result.sessionId).toBeDefined();
    expect(typeof response.result.sessionId).toBe('string');
    expect(response.result.sessionId).toContain('mock-session-');
  });

  it('3. Simple text scenario', { timeout: 20000 }, async () => {
    agent = spawnMockAgent();
    agent.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
    await agent.waitForResponse(1);
    agent.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
    await agent.waitForResponse(2);

    agent.send({
      jsonrpc: '2.0', id: 3, method: 'session/prompt',
      params: { sessionId: 'mock-session-123', prompt: [{ type: 'text', text: 'simple' }] }
    });

    await agent.waitForResponse(3);
    const msgs = agent.received;
    
    const chunks = msgs
        .filter(m => !m.id && m.method === 'session/update' && m.params.update.sessionUpdate === 'agent_message_chunk')
        .map(m => m.params.update.content);
    
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0].text).toBe('Hello ');
    expect(chunks[1].text).toBe('from ');
    expect(chunks[2].text).toBe('mock agent!');

    const response = msgs.find(m => m.id === 3);
    expect(response.result.stopReason).toBe('end_turn');
  });

  it('4. Tool call scenario', { timeout: 20000 }, async () => {
    agent = spawnMockAgent();
    agent.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
    await agent.waitForResponse(1);
    agent.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
    await agent.waitForResponse(2);

    agent.send({
      jsonrpc: '2.0', id: 3, method: 'session/prompt',
      params: { sessionId: 'mock-session-123', prompt: [{ type: 'text', text: 'tool' }] }
    });

    await agent.waitForResponse(3);
    const updates = agent.received
      .filter(m => !m.id && m.method === 'session/update')
      .map(m => m.params.update);
    
    const toolCall = updates.find(u => u.sessionUpdate === 'tool_call');
    expect(toolCall).toBeDefined();
    expect(toolCall.toolCallId).toBe('tc1');
    expect(toolCall.status).toBe('pending');
    
    const inProgress = updates.find(u => u.sessionUpdate === 'tool_call_update' && u.status === 'in_progress');
    expect(inProgress).toBeDefined();
    
    const completed = updates.find(u => u.sessionUpdate === 'tool_call_update' && u.status === 'completed');
    expect(completed).toBeDefined();
    expect(completed.content).toBeDefined();
    
    const response = agent.received.find(m => m.id === 3);
    expect(response.result.stopReason).toBe('end_turn');
  });

  it('5. Permission required scenario', { timeout: 20000 }, async () => {
    agent = spawnMockAgent();
    agent.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
    await agent.waitForResponse(1);
    agent.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
    await agent.waitForResponse(2);

    agent.send({
      jsonrpc: '2.0', id: 3, method: 'session/prompt',
      params: { sessionId: 'mock-session-123', prompt: [{ type: 'text', text: 'permission' }] }
    });

    // Wait for permission request notification (has an id but it's a server-to-client request)
    await agent.waitFor(msgs => msgs.some(m => m.method === 'session/request_permission'));
    const permRequest = agent.received.find(m => m.method === 'session/request_permission');
    expect(permRequest).toBeDefined();
    expect(permRequest.params.options).toBeDefined();

    // Grant permission
    agent.send({
      jsonrpc: '2.0', id: permRequest.id,
      result: { outcome: { outcome: 'selected', optionId: 'allow' } }
    });

    // Wait for prompt completion
    await agent.waitForResponse(3);
    const updates = agent.received
      .filter(m => !m.id && m.method === 'session/update')
      .map(m => m.params.update);
    
    const completed = updates.find(u => u.sessionUpdate === 'tool_call_update' && u.status === 'completed');
    expect(completed).toBeDefined();
    
    const response = agent.received.find(m => m.id === 3);
    expect(response.result.stopReason).toBe('end_turn');
  });

  it('6. Permission denied scenario', { timeout: 20000 }, async () => {
    agent = spawnMockAgent();
    agent.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
    await agent.waitForResponse(1);
    agent.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
    await agent.waitForResponse(2);

    agent.send({
      jsonrpc: '2.0', id: 3, method: 'session/prompt',
      params: { sessionId: 'mock-session-123', prompt: [{ type: 'text', text: 'permission' }] }
    });

    await agent.waitFor(msgs => msgs.some(m => m.method === 'session/request_permission'));
    const permRequest = agent.received.find(m => m.method === 'session/request_permission');
    
    // Deny permission
    agent.send({
      jsonrpc: '2.0', id: permRequest.id,
      result: { outcome: { outcome: 'selected', optionId: 'reject' } }
    });

    await agent.waitForResponse(3);
    const updates = agent.received
      .filter(m => !m.id && m.method === 'session/update')
      .map(m => m.params.update);
    
    const failed = updates.find(u => u.sessionUpdate === 'tool_call_update' && u.status === 'failed');
    expect(failed).toBeDefined();
    
    const chunk = updates.find(u => u.sessionUpdate === 'agent_message_chunk' && u.content.text === 'Permission denied.');
    expect(chunk).toBeDefined();
    
    const response = agent.received.find(m => m.id === 3);
    expect(response.result.stopReason).toBe('end_turn');
  });

  it('7. Refusal scenario', { timeout: 20000 }, async () => {
    agent = spawnMockAgent();
    agent.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
    await agent.waitForResponse(1);
    agent.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
    await agent.waitForResponse(2);

    agent.send({
      jsonrpc: '2.0', id: 3, method: 'session/prompt',
      params: { sessionId: 'mock-session-123', prompt: [{ type: 'text', text: 'refuse' }] }
    });

    await agent.waitForResponse(3);
    const response = agent.received.find(m => m.id === 3);
    expect(response.result.stopReason).toBe('refusal');
    
    const updates = agent.received
      .filter(m => !m.id && m.method === 'session/update')
      .map(m => m.params.update);
    const chunk = updates.find(u => u.sessionUpdate === 'agent_message_chunk');
    expect(chunk).toBeDefined();
    expect(chunk.content.text).toBe('I cannot do that.');
  });

  it('8. Cancel scenario', { timeout: 20000 }, async () => {
    agent = spawnMockAgent();
    agent.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
    await agent.waitForResponse(1);
    agent.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
    await agent.waitForResponse(2);

    // Send stream prompt
    agent.send({
      jsonrpc: '2.0', id: 3, method: 'session/prompt',
      params: { sessionId: 'mock-session-123', prompt: [{ type: 'text', text: 'stream' }] }
    });

    // Wait for the first chunk to confirm the stream started
    await agent.waitFor(msgs => msgs.some(
      m => m.method === 'session/update' && m.params?.update?.sessionUpdate === 'agent_message_chunk'
    ));

    // Now cancel
    agent.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'mock-session-123' } });

    await agent.waitForResponse(3);
    const response = agent.received.find(m => m.id === 3);
    expect(response.result.stopReason).toBe('cancelled');
  });

  it('9. JSON-RPC correctness', { timeout: 20000 }, async () => {
    agent = spawnMockAgent();
    agent.send({ jsonrpc: '2.0', id: 'req-1', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
    
    await agent.waitForResponse('req-1');
    const response = agent.received.find(m => m.id === 'req-1');
    
    expect(response).toBeDefined();
    expect(response.jsonrpc).toBe('2.0');
    
    agent.send({ jsonrpc: '2.0', id: 'req-2', method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
    await agent.waitForResponse('req-2');

    agent.send({
      jsonrpc: '2.0', id: 'req-3', method: 'session/prompt',
      params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'simple' }] }
    });

    await agent.waitForResponse('req-3');
    const notifications = agent.received.filter(m => !m.id);
    
    notifications.forEach(n => {
      expect(n.jsonrpc).toBe('2.0');
      expect(n.method).toBeDefined();
      expect(n.params).toBeDefined();
    });
  });
});
