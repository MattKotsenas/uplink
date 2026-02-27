import { AcpClient, ConnectionState } from './acp-client.js';
import { Conversation } from './conversation.js';
import { ChatList } from './ui/chat.js';
import { showPermissionRequest, cancelAllPermissions } from './ui/permission.js';
import { fetchSessions, openSessionsModal, SessionsModal } from './ui/sessions.js';
import { CommandPalette, type PaletteItem } from './ui/command-palette.js';
import { getCompletions, parseSlashCommand, setAvailableModels } from './slash-commands.js';
import { render, h } from 'preact';
import 'material-symbols/outlined.css';

// ─── DOM References ───────────────────────────────────────────────────

const chatArea = document.getElementById('chat-area')!;
const promptInput = document.getElementById('prompt-input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;

let yoloMode = localStorage.getItem('uplink-yolo') === 'true';

// ─── Mode ─────────────────────────────────────────────────────────────

type AgentMode = 'chat' | 'plan' | 'autopilot';
let currentMode: AgentMode = (localStorage.getItem('uplink-mode') as AgentMode) ?? 'chat';

function applyMode(mode: AgentMode): void {
  currentMode = mode;
  document.documentElement.setAttribute('data-mode', mode);
  localStorage.setItem('uplink-mode', mode);
}

applyMode(currentMode);

// ─── Theme ────────────────────────────────────────────────────────────

function applyTheme(theme: string): void {
  if (theme === 'auto') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.className = prefersDark ? 'dark' : 'light';
  } else {
    document.documentElement.className = theme;
  }
  localStorage.setItem('uplink-theme', theme);
}

function initTheme(): void {
  const saved = localStorage.getItem('uplink-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved ?? (prefersDark ? 'dark' : 'light');
  applyTheme(theme);
}

initTheme();

// ─── Service Worker ───────────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('SW registration failed:', err);
  });
}

// ─── UI Components ────────────────────────────────────────────────────

const conversation = new Conversation();

// Mount all timeline components into a single chatContainer.
// ChatList renders messages, and child components (tool calls, permissions,
// plans) are passed as children so they appear inline in the message flow.
const chatContainer = document.createElement('div');
chatContainer.className = 'chat-container chat-messages';
chatArea.appendChild(chatContainer);

function renderChat(): void {
  render(
    h(ChatList, { conversation, scrollContainer: chatArea }),
    chatContainer,
  );
}
renderChat();

// Mount Preact sessions modal on body
const sessionsModalContainer = document.createElement('div');
document.body.appendChild(sessionsModalContainer);
render(h(SessionsModal, {}), sessionsModalContainer);

/** Clear all conversation state when session changes. */
function clearConversation(): void {
  conversation.clear();
  cancelAllPermissions(conversation);
}

// ─── WebSocket / ACP Client ──────────────────────────────────────────

const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

let client: AcpClient | null = null;
let clientCwd: string = '';

function updateConnectionStatus(state: ConnectionState): void {
  const el = document.getElementById('connection-status')!;
  // Show "ready" instead of "prompting" since we have the dots indicator
  const displayState = state === 'prompting' ? 'ready' : state;
  el.textContent = displayState;
  el.className = `status-${
    state === 'ready' || state === 'prompting'
      ? 'connected'
      : state === 'connecting' || state === 'initializing'
        ? 'reconnecting'
        : 'disconnected'
  }`;

  sendBtn.disabled = state !== 'ready';
  cancelBtn.hidden = state !== 'prompting';

  conversation.isPrompting = state === 'prompting';
  conversation.notify();
}

async function initializeClient() {
  const tokenResponse = await fetch('/api/token');
  const { token, cwd } = await tokenResponse.json();
  clientCwd = cwd;

  const wsUrl = `${wsProtocol}//${location.host}/ws?token=${encodeURIComponent(token)}`;

  return new AcpClient({
    wsUrl,
    cwd,
    onStateChange: (state) => updateConnectionStatus(state),
    onSessionUpdate: (update) => conversation.handleSessionUpdate(update),
    onModelsAvailable: (models) => setAvailableModels(models),
    onPermissionRequest: (request, respond) => {
      const autoApproveId = yoloMode
        ? request.options.find(
            (o) => o.kind === 'allow_once' || o.kind === 'allow_always',
          )?.optionId
        : undefined;

      showPermissionRequest(
        conversation,
        request.id,
        request.toolCall.toolCallId,
        request.toolCall.title ?? 'Unknown action',
        request.options,
        respond,
        autoApproveId,
      );
    },
    onError: (error) => console.error('ACP error:', error),
  });
}

// ─── Input Handling ───────────────────────────────────────────────────

sendBtn.addEventListener('click', async () => {
  const text = promptInput.value.trim();
  if (!text || !client) return;

  promptInput.value = '';
  promptInput.style.height = 'auto';
  hidePalette();

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
      const remainingPrompt = handleClientCommand(parsed.command, parsed.arg);
      if (!remainingPrompt) return;
      // Mode command with a prompt — send the prompt portion
      promptText = remainingPrompt;
    }
  }

  conversation.addUserMessage(text);

  // In plan mode, prefix the message to instruct the agent to plan
  if (currentMode === 'plan' && !text.startsWith('/')) {
    promptText = `/plan ${promptText}`;
  }

  const MAX_AUTOPILOT_TURNS = 25;

  try {
    let stopReason = await client.prompt(promptText);
    // In autopilot mode, auto-continue when the agent ends its turn
    let turns = 0;
    while (currentMode === 'autopilot' && stopReason === 'end_turn' && turns < MAX_AUTOPILOT_TURNS) {
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
});

cancelBtn.addEventListener('click', () => {
  client?.cancel();
  cancelAllPermissions(conversation);
});

promptInput.addEventListener('keydown', (e) => {
  // Palette keyboard navigation
  if (paletteVisible) {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      paletteSelectedIndex = Math.max(0, paletteSelectedIndex - 1);
      renderPalette();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      paletteSelectedIndex = Math.min(paletteItems.length - 1, paletteSelectedIndex + 1);
      renderPalette();
      return;
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      if (paletteItems[paletteSelectedIndex]) {
        acceptCompletion(paletteItems[paletteSelectedIndex]);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hidePalette();
      return;
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});

promptInput.addEventListener('input', () => {
  promptInput.style.height = 'auto';
  const maxH = 150;
  const scrollH = promptInput.scrollHeight;
  promptInput.style.height = Math.min(scrollH, maxH) + 'px';
  promptInput.style.overflowY = scrollH > maxH ? 'auto' : 'hidden';

  // Dynamic shell-input border when text starts with !
  if (promptInput.value.startsWith('!')) {
    document.documentElement.setAttribute('data-mode', 'shell-input');
  } else {
    document.documentElement.setAttribute('data-mode', currentMode);
  }

  // Show/update command palette when typing /
  if (promptInput.value.startsWith('/')) {
    showPalette();
  } else {
    hidePalette();
  }
});

// ─── Command Palette ──────────────────────────────────────────────────

const paletteMount = document.getElementById('palette-mount')!;
let paletteItems: PaletteItem[] = [];
let paletteSelectedIndex = 0;
let paletteVisible = false;

function renderPalette(): void {
  if (!paletteVisible || paletteItems.length === 0) {
    render(null, paletteMount);
    return;
  }
  render(
    h(CommandPalette, {
      items: paletteItems,
      selectedIndex: paletteSelectedIndex,
      onSelect: (item) => acceptCompletion(item),
      onHover: (i) => { paletteSelectedIndex = i; renderPalette(); },
    }),
    paletteMount,
  );
}

function showPalette(): void {
  const text = promptInput.value;
  paletteItems = getCompletions(text);
  paletteSelectedIndex = 0;
  paletteVisible = paletteItems.length > 0;
  renderPalette();
}

function hidePalette(): void {
  paletteVisible = false;
  renderPalette();
}

function acceptCompletion(item: PaletteItem): void {
  promptInput.value = item.fill;
  promptInput.focus();
  if (item.fill.endsWith(' ')) {
    // Top-level command selected — show sub-options or let user type more
    showPalette();
  } else {
    // Concrete sub-option selected — execute
    hidePalette();
    sendBtn.click();
  }
}

// ─── Slash Command Handlers ───────────────────────────────────────────

/** Handle a client-side command. Returns a remaining prompt to send, or undefined. */
function handleClientCommand(command: string, arg: string): string | undefined {
  switch (command) {
    case '/theme':
      applyTheme(arg || 'auto');
      conversation.addSystemMessage(`Theme set to ${arg || 'auto'}`);
      return undefined;
    case '/yolo': {
      const on = arg === '' || arg === 'on';
      yoloMode = on;
      localStorage.setItem('uplink-yolo', String(yoloMode));
      conversation.addSystemMessage(`Auto-approve ${yoloMode ? 'enabled' : 'disabled'}`);
      return undefined;
    }
    case '/session':
      handleSessionCommand(arg);
      return undefined;
    case '/agent':
      applyMode('chat');
      conversation.addSystemMessage('Switched to agent mode');
      return arg || undefined;
    case '/plan':
      applyMode('plan');
      conversation.addSystemMessage('Switched to plan mode');
      return arg || undefined;
    case '/autopilot':
      applyMode('autopilot');
      conversation.addSystemMessage('Switched to autopilot mode');
      return arg || undefined;
  }
  return undefined;
}

async function handleSessionCommand(arg: string): Promise<void> {
  if (!client || !clientCwd) return;

  if (arg === 'create' || arg === 'new') {
    clearConversation();
    localStorage.removeItem('uplink-resume-session');
    client.disconnect();
    try {
      client = await initializeClient();
      client.connect().catch(console.error);
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
    const sessions = await fetchSessions(clientCwd);
    openSessionsModal(
      sessions,
      client.supportsLoadSession,
      async (sessionId) => {
        clearConversation();
        try {
          await client!.loadSession(sessionId);
        } catch (err) {
          console.error('Failed to load session:', err);
        }
      },
      async () => {
        clearConversation();
        localStorage.removeItem('uplink-resume-session');
        client!.disconnect();
        try {
          client = await initializeClient();
          client.connect().catch(console.error);
        } catch (err) {
          console.error('Failed to create new session:', err);
        }
      },
    );
  }
}

// ─── Connect ──────────────────────────────────────────────────────────

initializeClient().then((c) => {
  client = c;
  client.connect();
}).catch((err) => {
  console.error('Failed to initialize client:', err);
});
