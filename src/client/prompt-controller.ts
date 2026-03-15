import type { AcpClient } from './acp-client.js';
import type { Conversation } from './conversation.js';
import type { SessionInfo } from '../shared/acp-types.js';
import { parseSlashCommand, findModelName } from './slash-commands.js';

// --- Types -----------------------------------------------------------------

export type AgentMode = 'chat' | 'plan' | 'autopilot';

export interface PromptControllerDeps {
  client: AcpClient;
  conversation: Conversation;
  clientCwd: string;
  getMode: () => AgentMode;
  setMode: (mode: AgentMode) => void;
  yoloMode: () => boolean;
  setYoloMode: (on: boolean) => void;
  setModelLabel: (name: string) => void;
  applyTheme: (theme: string) => void;
  cancelPermissions: (conversation: Conversation) => void;
  fetchSessions: (cwd: string) => Promise<SessionInfo[]>;
  showSessionsModal: (
    sessions: SessionInfo[],
    supportsResume: boolean,
    onResume: (sessionId: string) => Promise<void>,
    onNew: () => Promise<void>,
  ) => void;
}

// --- Helpers ---------------------------------------------------------------

function clearConversation(deps: PromptControllerDeps): void {
  deps.conversation.clear();
  deps.cancelPermissions(deps.conversation);
}

// --- Prompt Flow -----------------------------------------------------------

/** Handle the full prompt flow: shell commands, slash commands, mode prefixing, autopilot loop. */
export async function handleSend(text: string, deps: PromptControllerDeps): Promise<void> {
  const { client, conversation, getMode } = deps;

  // Shell commands: !<command>
  if (text.startsWith('!')) {
    const command = text.slice(1).trim();
    if (!command) return;

    conversation.addUserMessage(`$ ${command}`);

    try {
      const result = await client.sendRawRequest<{
        stdout: string;
        stderr: string;
        exitCode: number;
      }>('uplink/shell', { command });
      conversation.addShellResult(command, result.stdout, result.stderr, result.exitCode);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      conversation.addShellResult(command, '', errorMessage, 1);
    }
    return;
  }

  // Slash commands
  let promptText = text;
  const parsed = parseSlashCommand(text);
  if (parsed) {
    if (parsed.kind === 'client') {
      const remainingPrompt = handleClientCommand(parsed.command, parsed.arg, deps);
      if (!remainingPrompt) return;
      // Mode command with a prompt - send the prompt portion
      promptText = remainingPrompt;
    } else if (parsed.command === '/model' && parsed.arg) {
      const name = findModelName(parsed.arg);
      if (name) {
        deps.setModelLabel(name);
      }
    }
  }

  conversation.addUserMessage(text);

  // In plan mode, prefix the message to instruct the agent to plan
  if (getMode() === 'plan' && !text.startsWith('/')) {
    promptText = `/plan ${promptText}`;
  }

  const MAX_AUTOPILOT_TURNS = 25;

  try {
    let stopReason = await client.prompt(promptText);
    // In autopilot mode, auto-continue when the agent ends its turn
    let turns = 0;
    while (getMode() === 'autopilot' && stopReason === 'end_turn' && turns < MAX_AUTOPILOT_TURNS) {
      turns++;
      conversation.addUserMessage('continue');
      stopReason = await client.prompt('continue');
    }
    if (turns >= MAX_AUTOPILOT_TURNS) {
      conversation.addSystemMessage('Autopilot stopped: reached maximum turns');
    }
  } catch (err) {
    console.error('Prompt error:', err);
  }
}

// --- Slash Command Handlers ------------------------------------------------

/** Handle a client-side slash command. Returns a remaining prompt to send, or undefined. */
export function handleClientCommand(command: string, arg: string, deps: PromptControllerDeps): string | undefined {
  const { conversation, setMode, setYoloMode, applyTheme } = deps;

  switch (command) {
    case '/theme':
      applyTheme(arg || 'auto');
      conversation.addSystemMessage(`Theme set to ${arg || 'auto'}`);
      return undefined;
    case '/yolo': {
      const on = arg === '' || arg === 'on';
      setYoloMode(on);
      conversation.addSystemMessage(`Auto-approve ${on ? 'enabled' : 'disabled'}`);
      return undefined;
    }
    case '/session':
      handleSessionCommand(arg, deps);
      return undefined;
    case '/agent':
      setMode('chat');
      conversation.addSystemMessage('Switched to agent mode');
      return arg || undefined;
    case '/plan':
      setMode('plan');
      conversation.addSystemMessage('Switched to plan mode');
      return arg || undefined;
    case '/autopilot':
      setMode('autopilot');
      conversation.addSystemMessage('Switched to autopilot mode');
      return arg || undefined;
    case '/clear':
      handleClearCommand(deps);
      return undefined;
  }
  return undefined;
}

export async function handleClearCommand(deps: PromptControllerDeps): Promise<void> {
  const { client, conversation } = deps;
  clearConversation(deps);
  // Clear server-side replay buffer
  if (client.currentSessionId) {
    client.sendRawRequest('uplink/clear_history', { sessionId: client.currentSessionId }).catch(() => {});
  }
  // Send /clear to the CLI so it can clear its context
  try {
    await client.prompt('/clear');
  } catch (err) {
    console.error('Failed to send /clear:', err);
  }
}

export async function handleSessionCommand(arg: string, deps: PromptControllerDeps): Promise<void> {
  const { client, conversation, clientCwd } = deps;

  if (arg === 'create' || arg === 'new') {
    clearConversation(deps);
    try {
      await client.newSession();
    } catch (err) {
      console.error('Failed to create new session:', err);
    }
    return;
  }

  if (arg.startsWith('rename ')) {
    const name = arg.slice(7).trim();
    if (!name || !client.currentSessionId) return;
    try {
      await client.sendRawRequest('uplink/rename_session', {
        sessionId: client.currentSessionId,
        summary: name,
      });
      conversation.addSystemMessage(`Session renamed to "${name}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      conversation.addSystemMessage(`Failed to rename: ${msg}`);
    }
    return;
  }

  if (arg === 'list' || arg === '') {
    const sessions = await deps.fetchSessions(clientCwd);
    deps.showSessionsModal(
      sessions,
      client.supportsLoadSession,
      async (sessionId) => {
        clearConversation(deps);
        try {
          await client.loadSession(sessionId);
        } catch (err) {
          console.error('Failed to load session:', err);
        }
      },
      async () => {
        clearConversation(deps);
        try {
          await client.newSession();
        } catch (err) {
          console.error('Failed to create new session:', err);
        }
      },
    );
  }
}
