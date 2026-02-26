import { AcpClient, ConnectionState } from './acp-client.js';
import { Conversation } from './conversation.js';
import { ChatList, scrollChatToBottom } from './ui/chat.js';
import { ShellOutput } from './ui/shell.js';
import { showPermissionRequest, cancelAllPermissions } from './ui/permission.js';
import { fetchSessions, openSessionsModal, SessionsModal } from './ui/sessions.js';
import { render, h } from 'preact';

// ─── Constants ────────────────────────────────────────────────────────

const MODELS = [
  'claude-sonnet-4.6', 'claude-sonnet-4.5', 'claude-haiku-4.5',
  'claude-opus-4.6', 'claude-opus-4.6-fast', 'claude-opus-4.5',
  'claude-sonnet-4', 'gemini-3-pro-preview', 'gpt-5.3-codex',
  'gpt-5.2-codex', 'gpt-5.2', 'gpt-5.1-codex-max', 'gpt-5.1-codex',
  'gpt-5.1', 'gpt-5.1-codex-mini', 'gpt-5-mini', 'gpt-4.1',
];

// ─── DOM References ───────────────────────────────────────────────────

const chatArea = document.getElementById('chat-area')!;
const promptInput = document.getElementById('prompt-input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;
const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
const modeSelect = document.getElementById('mode-select') as HTMLSelectElement;
const menuToggle = document.getElementById('menu-toggle')!;
const menuDropdown = document.getElementById('menu-dropdown')!;
const themeToggle = document.getElementById('theme-toggle') as HTMLInputElement;
const sessionsBtn = document.getElementById('sessions-btn')!;
const yoloToggle = document.getElementById('yolo-toggle') as HTMLInputElement;

let yoloMode = localStorage.getItem('uplink-yolo') === 'true';

// ─── Mode ─────────────────────────────────────────────────────────────

type AgentMode = 'chat' | 'plan' | 'autopilot';
let currentMode: AgentMode = (localStorage.getItem('uplink-mode') as AgentMode) ?? 'chat';

function applyMode(mode: AgentMode): void {
  currentMode = mode;
  document.documentElement.setAttribute('data-mode', mode);
  modeSelect.value = mode;
  localStorage.setItem('uplink-mode', mode);
}

applyMode(currentMode);

modeSelect.addEventListener('change', () => {
  applyMode(modeSelect.value as AgentMode);
});

// ─── Theme ────────────────────────────────────────────────────────────

function initTheme(): void {
  const saved = localStorage.getItem('uplink-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved ?? (prefersDark ? 'dark' : 'light');
  document.documentElement.className = theme;
  themeToggle.checked = theme === 'dark';
}

initTheme();

// ─── Model Selector ───────────────────────────────────────────────────

function initModelSelector(): void {
  // "Auto" means no --model flag; Copilot picks its default
  const autoOption = document.createElement('option');
  autoOption.value = '';
  autoOption.textContent = 'Auto';
  modelSelect.appendChild(autoOption);

  for (const model of MODELS) {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    modelSelect.appendChild(option);
  }

  const saved = localStorage.getItem('uplink-model');
  if (saved) modelSelect.value = saved;
}

initModelSelector();

// ─── Hamburger Menu ───────────────────────────────────────────────────

menuToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = !menuDropdown.hidden;
  menuDropdown.hidden = isOpen;
  menuToggle.setAttribute('aria-expanded', String(!isOpen));
});

document.addEventListener('click', (e) => {
  if (!menuDropdown.hidden && !menuDropdown.contains(e.target as Node)) {
    menuDropdown.hidden = true;
    menuToggle.setAttribute('aria-expanded', 'false');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !menuDropdown.hidden) {
    menuDropdown.hidden = true;
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.focus();
  }
});

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

/** Clear all conversation state and DOM when session changes. */
const preactContainers: Set<Node> = new Set([chatContainer]);

function clearConversation(): void {
  conversation.clear();
  cancelAllPermissions(conversation);
  // Remove non-tracked elements (shell output, etc.) but preserve Preact mount points
  for (const child of [...chatArea.childNodes]) {
    if (!preactContainers.has(child)) {
      chatArea.removeChild(child);
    }
  }
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
  const { token, cwd, model: serverModel } = await tokenResponse.json();
  clientCwd = cwd;

  // Use explicitly saved model, or let Copilot use its default
  const savedModel = localStorage.getItem('uplink-model');
  let wsUrl = `${wsProtocol}//${location.host}/ws?token=${encodeURIComponent(token)}`;
  if (savedModel) {
    wsUrl += `&model=${encodeURIComponent(savedModel)}`;
  }

  // Update the "Auto" label to show the server's active model if known
  const autoOption = modelSelect.querySelector('option[value=""]') as HTMLOptionElement;
  if (autoOption && serverModel) {
    autoOption.textContent = `Auto (${serverModel})`;
  }

  return new AcpClient({
    wsUrl,
    cwd,
    onStateChange: (state) => updateConnectionStatus(state),
    onSessionUpdate: (update) => conversation.handleSessionUpdate(update),
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
      const container = document.createElement('div');
      chatArea.appendChild(container);
      render(h(ShellOutput, { command, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }), container);
      scrollChatToBottom(chatArea);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const container = document.createElement('div');
      chatArea.appendChild(container);
      render(h(ShellOutput, { command, stdout: '', stderr: errorMessage, exitCode: 1 }), container);
      scrollChatToBottom(chatArea);
    }
    return;
  }

  // /session <name> — rename the current session
  if (text.startsWith('/session ')) {
    const name = text.slice('/session '.length).trim();
    if (!name || !client.currentSessionId) return;

    try {
      await client.sendRawRequest('uplink/rename_session', {
        sessionId: client.currentSessionId,
        summary: name,
      });
      conversation.addUserMessage(`Session renamed to "${name}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      conversation.addUserMessage(`Failed to rename session: ${msg}`);
    }
    return;
  }

  conversation.addUserMessage(text);

  // In plan mode, prefix the message to instruct the agent to plan
  const promptText = currentMode === 'plan' && !text.startsWith('/')
    ? `/plan ${text}`
    : text;

  try {
    let stopReason = await client.prompt(promptText);
    // In autopilot mode, auto-continue when the agent ends its turn
    while (currentMode === 'autopilot' && stopReason === 'end_turn') {
      conversation.addUserMessage('continue');
      stopReason = await client.prompt('continue');
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
});

// ─── Theme Toggle ─────────────────────────────────────────────────────

themeToggle.addEventListener('change', () => {
  const next = themeToggle.checked ? 'dark' : 'light';
  document.documentElement.className = next;
  localStorage.setItem('uplink-theme', next);
});

// ─── Yolo Mode ────────────────────────────────────────────────────────

yoloToggle.checked = yoloMode;

yoloToggle.addEventListener('change', () => {
  yoloMode = yoloToggle.checked;
  localStorage.setItem('uplink-yolo', String(yoloMode));
});

// ─── Model Change ─────────────────────────────────────────────────────

modelSelect.addEventListener('change', async () => {
  const value = modelSelect.value;
  if (value) {
    localStorage.setItem('uplink-model', value);
  } else {
    localStorage.removeItem('uplink-model');
  }

  if (!client) return;

  // Model change requires restarting the copilot process, which starts a new session.
  // Save the current session so the new client can resume it via session/load.
  try {
    await client.sendRawRequest('uplink/set_model', { model: value || undefined });
  } catch {
    // Best-effort
  }

  const resumeSessionId = client.currentSessionId;
  if (resumeSessionId) {
    localStorage.setItem('uplink-resume-session', resumeSessionId);
  }

  // Tear down old client and create a new one with updated URL
  clearConversation();
  client.disconnect();
  try {
    client = await initializeClient();
    client.connect().catch((err) => {
      console.error('Failed to connect after model change:', err);
    });
  } catch (err) {
    console.error('Failed to reinitialize after model change:', err);
  }
});

// ─── Sessions ─────────────────────────────────────────────────────────

sessionsBtn.addEventListener('click', async () => {
  if (!client || !clientCwd) return;
  menuDropdown.hidden = true;

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
        client.connect().catch((err) => {
          console.error('Failed to create new session:', err);
        });
      } catch (err) {
        console.error('Failed to reinitialize for new session:', err);
      }
    },
  );
});

// ─── Connect ──────────────────────────────────────────────────────────

initializeClient().then((c) => {
  client = c;
  client.connect();
}).catch((err) => {
  console.error('Failed to initialize client:', err);
});
