import { describe, it, expect, afterEach } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

function spawnMockAgent(): { process: ChildProcess, send: (msg: object) => void, messages: () => Promise<any[]> } {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'cmd.exe' : 'npx';
  const args = isWin ? ['/c', 'npx', 'tsx', 'src/mock/mock-agent.ts', '--acp', '--stdio'] : ['tsx', 'src/mock/mock-agent.ts', '--acp', '--stdio'];
  
  const child = spawn(cmd, args, {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    env: { ...process.env, NO_COLOR: '1' } // Disable color to avoid ANSI codes
  });
  
  const received: any[] = [];
  const rl = createInterface({ input: child.stdout! });
  rl.on('line', (line) => {
    // console.log('Line received:', line);
    if (!line.trim()) return;
    try { 
        const msg = JSON.parse(line);
        received.push(msg); 
    } catch (e) {
        // console.error('Failed to parse line:', line);
    }
  });

  child.stderr?.on('data', (data) => {
      console.error(`stderr: ${data}`); 
  });
  
  return {
    process: child,
    send: (msg) => {
        child.stdin!.write(JSON.stringify(msg) + '\n');
    },
    messages: () => new Promise(resolve => {
        setTimeout(() => resolve([...received]), 3500);
    })
  };
}

describe('Mock ACP Agent', () => {
  let agent: ReturnType<typeof spawnMockAgent> | undefined;

  afterEach(() => {
    if (agent?.process) {
      agent.process.kill();
      agent = undefined;
    }
  });

  it('1. Initialize handshake', { timeout: 40000 }, async () => {
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

    const msgs = await agent.messages();
    const response = msgs.find(m => m.id === 1);
    
    expect(response).toBeDefined();
    expect(response.result).toBeDefined();
    expect(response.result.protocolVersion).toBe(1);
    expect(response.result.agentCapabilities).toBeDefined();
    expect(response.result.agentInfo).toEqual({ name: 'mock-agent', version: '0.1.0' });
  });

  it('2. Session/new', { timeout: 30000 }, async () => {
    agent = spawnMockAgent();
    agent.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: {} }
    });
    
    agent.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: process.cwd(), mcpServers: [] }
    });

    const msgs = await agent.messages();
    const response = msgs.find(m => m.id === 2);
    
    expect(response).toBeDefined();
    expect(response.result).toBeDefined();
    expect(response.result.sessionId).toBeDefined();
    expect(typeof response.result.sessionId).toBe('string');
    expect(response.result.sessionId).toContain('mock-session-');
  });

  it('3. Simple text scenario', { timeout: 30000 }, async () => {
    agent = spawnMockAgent();
    
    agent.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
    agent.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
    
    await agent.messages(); 

    agent.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId: 'mock-session-123',
        prompt: [{ type: 'text', text: 'simple' }]
      }
    });

    const msgs = await agent.messages();
    
    // Get notifications that came AFTER the prompt (simple heuristic: look for agent_message_chunk)
    // Or just look at all messages, since we have new ones.
    const chunks = msgs
        .filter(m => !m.id && m.method === 'session/update' && m.params.update.sessionUpdate === 'agent_message_chunk')
        .map(m => m.params.update.content);
    
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0].text).toBe('Hello ');
    expect(chunks[1].text).toBe('from ');
    expect(chunks[2].text).toBe('mock agent!');

    const response = msgs.find(m => m.id === 3);
    expect(response).toBeDefined();
    expect(response.result.stopReason).toBe('end_turn');
  });

  it('4. Tool call scenario', { timeout: 30000 }, async () => {
    agent = spawnMockAgent();
    
    agent.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
    agent.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
    await agent.messages();

    agent.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId: 'mock-session-123',
        prompt: [{ type: 'text', text: 'tool' }]
      }
    });

    const msgs = await agent.messages();
    const updates = msgs.filter(m => !m.id && m.method === 'session/update').map(m => m.params.update);
    
    const toolCall = updates.find(u => u.sessionUpdate === 'tool_call');
    expect(toolCall).toBeDefined();
    expect(toolCall.toolCallId).toBe('tc1');
    expect(toolCall.status).toBe('pending');
    
    const inProgress = updates.find(u => u.sessionUpdate === 'tool_call_update' && u.status === 'in_progress');
    expect(inProgress).toBeDefined();
    
    const completed = updates.find(u => u.sessionUpdate === 'tool_call_update' && u.status === 'completed');
    expect(completed).toBeDefined();
    expect(completed.content).toBeDefined();
    
    const response = msgs.find(m => m.id === 3);
    expect(response).toBeDefined();
    expect(response.result.stopReason).toBe('end_turn');
  });

  it('5. Permission required scenario', { timeout: 40000 }, async () => {
    agent = spawnMockAgent();
    
    agent.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
    agent.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
    await agent.messages();

    agent.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId: 'mock-session-123',
        prompt: [{ type: 'text', text: 'permission' }]
      }
    });

    // Wait for permission request
    let msgs = await agent.messages();
    const permRequest = msgs.find(m => m.method === 'session/request_permission');
    expect(permRequest).toBeDefined();
    expect(permRequest.id).toBeDefined();
    expect(permRequest.params.options).toBeDefined();

    // Send permission granted
    agent.send({
      jsonrpc: '2.0',
      id: permRequest.id,
      result: { 
          outcome: { 
            outcome: 'selected', 
            optionId: 'allow' 
          } 
      }
    });

    // Wait for completion (needs another delay for subsequent messages)
    // Use longer wait for permission scenario - mock needs time to process response
    await new Promise(resolve => setTimeout(resolve, 5000));
    msgs = await agent.messages();
    
    // Debug output
    // console.log('All messages:', JSON.stringify(msgs, null, 2));

    const updates = msgs.filter(m => !m.id && m.method === 'session/update').map(m => m.params.update);
    
    // Check if we received the permission response logic
    const completed = updates.find(u => u.sessionUpdate === 'tool_call_update' && u.status === 'completed');
    if (!completed) {
        // console.log('Updates received:', updates);
    }
    expect(completed).toBeDefined();
    
    const response = msgs.find(m => m.id === 3);
    expect(response).toBeDefined();
    expect(response.result.stopReason).toBe('end_turn');
  });

  it('6. Permission denied scenario', { timeout: 40000 }, async () => {
    agent = spawnMockAgent();
    
    agent.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
    agent.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
    await agent.messages();

    agent.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId: 'mock-session-123',
        prompt: [{ type: 'text', text: 'permission' }]
      }
    });

    let msgs = await agent.messages();
    const permRequest = msgs.find(m => m.method === 'session/request_permission');
    expect(permRequest).toBeDefined();
    
    // Send permission rejected
    agent.send({
      jsonrpc: '2.0',
      id: permRequest.id,
      result: { 
          outcome: { 
              outcome: 'selected', 
              optionId: 'reject' 
          } 
      }
    });

    msgs = await agent.messages();
    const updates = msgs.filter(m => !m.id && m.method === 'session/update').map(m => m.params.update);
    
    const failed = updates.find(u => u.sessionUpdate === 'tool_call_update' && u.status === 'failed');
    expect(failed).toBeDefined();
    
    const chunk = updates.find(u => u.sessionUpdate === 'agent_message_chunk' && u.content.text === 'Permission denied.');
    expect(chunk).toBeDefined();
    
    const response = msgs.find(m => m.id === 3);
    expect(response).toBeDefined();
    expect(response.result.stopReason).toBe('end_turn');
  });

  it('7. Refusal scenario', { timeout: 30000 }, async () => {
    agent = spawnMockAgent();
    
    agent.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
    agent.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
    await agent.messages();

    agent.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId: 'mock-session-123',
        prompt: [{ type: 'text', text: 'refuse' }]
      }
    });

    const msgs = await agent.messages();
    const response = msgs.find(m => m.id === 3);
    expect(response).toBeDefined();
    expect(response.result.stopReason).toBe('refusal');
    
    const updates = msgs.filter(m => !m.id && m.method === 'session/update').map(m => m.params.update);
    const chunk = updates.find(u => u.sessionUpdate === 'agent_message_chunk');
    expect(chunk).toBeDefined();
    expect(chunk.content.text).toBe('I cannot do that.');
  });

  it('8. Cancel scenario', { timeout: 30000 }, async () => {
    agent = spawnMockAgent();
    
    agent.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
    agent.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
    await agent.messages();

    // Send stream prompt
    agent.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId: 'mock-session-123',
        prompt: [{ type: 'text', text: 'stream' }]
      }
    });

    // Immediately cancel
    agent.send({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: 'mock-session-123' }
    });

    const msgs = await agent.messages();
    const response = msgs.find(m => m.id === 3);
    expect(response).toBeDefined();
    expect(response.result.stopReason).toBe('cancelled');
  });

  it('9. JSON-RPC correctness', { timeout: 30000 }, async () => {
    agent = spawnMockAgent();
    
    agent.send({ jsonrpc: '2.0', id: 'req-1', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
    
    let msgs = await agent.messages();
    const response = msgs.find(m => m.id === 'req-1');
    
    // Check request-response correlation
    expect(response).toBeDefined();
    expect(response.jsonrpc).toBe('2.0');
    
    // Check notifications
    agent.send({ jsonrpc: '2.0', id: 'req-2', method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
    
    // Send simple prompt
    agent.send({
      jsonrpc: '2.0',
      id: 'req-3',
      method: 'session/prompt',
      params: {
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'simple' }]
      }
    });

    msgs = await agent.messages();
    const notifications = msgs.filter(m => !m.id);
    
    notifications.forEach(n => {
      expect(n.jsonrpc).toBe('2.0');
      expect(n.method).toBeDefined();
      expect(n.params).toBeDefined();
    });
  });
});
