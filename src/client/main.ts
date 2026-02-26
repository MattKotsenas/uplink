import { AcpClient, ConnectionState } from './acp-client.js';
import { Conversation } from './conversation.js';
import { ChatUI } from './ui/chat.js';
import { renderShellOutput } from './ui/shell.js';
import { PermissionUI } from './ui/permission.js';
import { ToolCallUI } from './ui/tool-call.js';
import { PlanUI } from './ui/plan.js';
import { fetchSessions, createSessionListPanel } from './ui/sessions.js';

// ─── Constants ────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4';

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
  for (const model of MODELS) {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    modelSelect.appendChild(option);
  }

  const saved = localStorage.getItem('uplink-model') ?? DEFAULT_MODEL;
  modelSelect.value = saved;
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

const chatUI = new ChatUI(chatArea, conversation);
chatUI.attach();

const permissionUI = new PermissionUI(chatArea, conversation);

const toolCallUI = new ToolCallUI(chatArea, conversation);
toolCallUI.attach();

const planUI = new PlanUI(chatArea, conversation);
planUI.attach();

/** Clear all conversation state and DOM when session changes. */
function clearConversation(): void {
  conversation.clear();
  chatUI.clear();
  permissionUI.cancelAll();
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
  const { token, cwd } = await tokenResponse.json();
  clientCwd = cwd;
  const selectedModel = localStorage.getItem('uplink-model') ?? DEFAULT_MODEL;
  const wsUrl = `${wsProtocol}//${location.host}/ws?token=${encodeURIComponent(token)}&model=${encodeURIComponent(selectedModel)}`;

  return new AcpClient({
    wsUrl,
    cwd,
    onStateChange: (state) => updateConnectionStatus(state),
    onSessionUpdate: (update) => conversation.handleSessionUpdate(update),
    onPermissionRequest: (request, respond) => {
      permissionUI.showPermissionRequest(
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
      chatArea.appendChild(renderShellOutput(command, result.stdout, result.stderr, result.exitCode));
      chatUI.scrollToBottom();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      chatArea.appendChild(renderShellOutput(command, '', errorMessage, 1));
      chatUI.scrollToBottom();
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
  permissionUI.cancelAll();
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
  localStorage.setItem('uplink-model', value);

  if (client) {
    try {
      await client.sendRawRequest('uplink/set_model', { model: value });
    } catch {
      // Best-effort — model will be applied via URL parameter on reload
    }
  }
  // Save current session so we can resume after restart
  const currentSessionId = client?.currentSessionId;
  if (currentSessionId) {
    localStorage.setItem('uplink-resume-session', currentSessionId);
  }
  window.location.reload();
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
      onNewSession: () => {
        clearConversation();
        client!.disconnect();
        client!.connect().catch((err) => {
          console.error('Failed to create new session:', err);
        });
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
