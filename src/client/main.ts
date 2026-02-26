import { AcpClient, ConnectionState } from './acp-client.js';
import { Conversation } from './conversation.js';
import { ChatList, scrollChatToBottom } from './ui/chat.js';
import { ShellOutput } from './ui/shell.js';
import { showPermissionRequest, cancelAllPermissions, PermissionList } from './ui/permission.js';
import { ToolCallList } from './ui/tool-call.js';
import { PlanCard } from './ui/plan.js';
import { fetchSessions, createSessionListPanel } from './ui/sessions.js';
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
const menuToggle = document.getElementById('menu-toggle')!;
const menuDropdown = document.getElementById('menu-dropdown')!;
const themeToggle = document.getElementById('theme-toggle')!;
const sessionsBtn = document.getElementById('sessions-btn')!;

// ─── Theme ────────────────────────────────────────────────────────────

function initTheme(): void {
  const saved = localStorage.getItem('uplink-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved ?? (prefersDark ? 'dark' : 'light');
  document.documentElement.className = theme;
  updateThemeLabel(theme);
}

function updateThemeLabel(theme: string): void {
  themeToggle.textContent = theme === 'dark' ? '☀️ Light mode' : '🌙 Dark mode';
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

// Mount Preact chat list into chatArea
const chatContainer = document.createElement('div');
chatArea.appendChild(chatContainer);
render(h(ChatList, { conversation, scrollContainer: chatArea }), chatContainer);

// Mount Preact permission list into chatArea
const permissionContainer = document.createElement('div');
chatArea.appendChild(permissionContainer);
render(h(PermissionList, { conversation }), permissionContainer);

// Mount Preact tool call list into chatArea
const toolCallContainer = document.createElement('div');
chatArea.appendChild(toolCallContainer);
render(h(ToolCallList, { conversation }), toolCallContainer);

// Mount Preact plan card into chatArea
const planContainer = document.createElement('div');
chatArea.appendChild(planContainer);
render(h(PlanCard, { conversation }), planContainer);

/** Clear all conversation state and DOM when session changes. */
function clearConversation(): void {
  conversation.clear();
  cancelAllPermissions(conversation);
  // Remove non-tracked elements (shell output, etc.) from chatArea
  while (chatArea.firstChild) {
    chatArea.removeChild(chatArea.firstChild);
  }
}

// ─── WebSocket / ACP Client ──────────────────────────────────────────

const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

let client: AcpClient | null = null;
let clientCwd: string = '';

function updateConnectionStatus(state: ConnectionState): void {
  const el = document.getElementById('connection-status')!;
  el.textContent = state;
  el.className = `status-${
    state === 'ready' || state === 'prompting'
      ? 'connected'
      : state === 'connecting' || state === 'initializing'
        ? 'reconnecting'
        : 'disconnected'
  }`;

  sendBtn.disabled = state !== 'ready';
  cancelBtn.hidden = state !== 'prompting';
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
      showPermissionRequest(
        conversation,
        request.id,
        request.toolCall.toolCallId,
        request.toolCall.title ?? 'Unknown action',
        request.options,
        respond,
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

  conversation.addUserMessage(text);

  try {
    await client.prompt(text);
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

themeToggle.addEventListener('click', () => {
  const current = document.documentElement.className;
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.className = next;
  localStorage.setItem('uplink-theme', next);
  updateThemeLabel(next);
  menuDropdown.hidden = true;
  menuToggle.setAttribute('aria-expanded', 'false');
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
  // We can't resume mid-conversation because --model is a spawn-time flag.
  try {
    await client.sendRawRequest('uplink/set_model', { model: value || undefined });
  } catch {
    // Best-effort
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
  const panel = createSessionListPanel(
    sessions,
    client.supportsLoadSession,
    {
      onResume: async (sessionId) => {
        clearConversation();
        try {
          await client!.loadSession(sessionId);
        } catch (err) {
          console.error('Failed to load session:', err);
        }
      },
      onNewSession: async () => {
        clearConversation();
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
    },
  );
  document.body.appendChild(panel);
});

// ─── Connect ──────────────────────────────────────────────────────────

initializeClient().then((c) => {
  client = c;
  client.connect();
}).catch((err) => {
  console.error('Failed to initialize client:', err);
});
