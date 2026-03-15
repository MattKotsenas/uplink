#!/usr/bin/env node

/**
 * Minimal MCP server that exposes an `ask_user` tool.
 *
 * The Copilot agent spawns this as an MCP server subprocess. When the
 * agent calls the `ask_user` tool, this server:
 * 1. Writes the question to a well-known file
 * 2. Blocks until the answer file appears
 * 3. Returns the answer to the agent
 *
 * The Uplink bridge polls/watches for the question file and surfaces
 * it to the user, then writes the answer file.
 *
 * TODO: Replace file-based exchange with a proper IPC mechanism.
 * File polling is fragile (race conditions, stale files, no cleanup on
 * crash) and adds latency (500ms poll interval). Better alternatives:
 * - Named pipe / Unix domain socket between MCP server and bridge
 * - HTTP callback server (MCP server listens, bridge POSTs answers)
 * - Shared memory / MessageChannel if both run in the same Node process
 * The bridge already has the user's WebSocket, so the missing piece is
 * just MCP server <-> bridge communication.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const EXCHANGE_DIR = process.env.ASK_USER_DIR || join(tmpdir(), 'uplink-ask-user');
mkdirSync(EXCHANGE_DIR, { recursive: true });

let questionCounter = 0;

const server = new McpServer({
  name: 'uplink-tools',
  version: '0.1.0',
});

server.tool(
  'ask_user',
  'Ask the user a question and wait for their response. Use this when you need clarification or input from the user before proceeding.',
  {
    question: z.string().describe('The question to ask the user'),
  },
  async ({ question }) => {
    const id = `q-${++questionCounter}-${Date.now()}`;
    const questionFile = join(EXCHANGE_DIR, `${id}.question.json`);
    const answerFile = join(EXCHANGE_DIR, `${id}.answer.json`);

    // Write the question
    writeFileSync(questionFile, JSON.stringify({ id, question }));

    // Poll for the answer (check every 500ms, timeout after 5 minutes)
    const deadline = Date.now() + 5 * 60 * 1000;
    while (!existsSync(answerFile) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
    }

    if (!existsSync(answerFile)) {
      // Clean up
      try { unlinkSync(questionFile); } catch {}
      return {
        content: [{ type: 'text' as const, text: '[No response from user - timed out]' }],
      };
    }

    const answer = JSON.parse(readFileSync(answerFile, 'utf-8')).answer as string;

    // Clean up
    try { unlinkSync(questionFile); } catch {}
    try { unlinkSync(answerFile); } catch {}

    return {
      content: [{ type: 'text' as const, text: answer }],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP server error: ${err}\n`);
  process.exit(1);
});
