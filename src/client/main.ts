import { AcpClient, ConnectionState } from './acp-client.js';
import { Conversation } from './conversation.js';
import { ChatUI } from './ui/chat.js';
import { renderShellOutput } from './ui/shell.js';
import { PermissionUI } from './ui/permission.js';
import { ToolCallUI } from './ui/tool-call.js';
import { PlanUI } from './ui/plan.js';
import { fetchSessions, createSessionListPanel } from './ui/sessions.js';

// Theme: initialize from localStorage or system preference
function initTheme(): void {
  const saved = localStorage.getItem('uplink-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved ?? (prefersDark ? 'dark' : 'light');
  document.documentElement.className = theme;
  updateThemeIcon(theme);
}

function updateThemeIcon(theme: string): void {
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  }
}

initTheme();

// Model selector
const MODELS = [
  'claude-sonnet-4.6', 'claude-sonnet-4.5', 'claude-haiku-4.5',
  'claude-opus-4.6', 'claude-opus-4.6-fast', 'claude-opus-4.5',
  'claude-sonnet-4', 'gemini-3-pro-preview', 'gpt-5.3-codex',
  'gpt-5.2-codex', 'gpt-5.2', 'gpt-5.1-codex-max', 'gpt-5.1-codex',
  'gpt-5.1', 'gpt-5.1-codex-mini', 'gpt-5-mini', 'gpt-4.1',
];

function initModelSelector(): void {
  const select = document.getElementById('model-select') as HTMLSelectElement;
  if (!select) return;

  for (const model of MODELS) {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    select.appendChild(option);
  }

  const saved = localStorage.getItem('uplink-model');
  if (saved) select.value = saved;
}

initModelSelector();

// Register service worker for PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('SW registration failed:', err);
  });
}

// Create instances
const conversation = new Conversation();

const chatArea = document.getElementById('chat-area')!;

const chatUI = new ChatUI(
  chatArea,
  conversation,
);
chatUI.attach();

const permissionUI = new PermissionUI(chatArea, conversation);

const toolCallUI = new ToolCallUI(
  chatArea,
  conversation,
);
toolCallUI.attach();

const planUI = new PlanUI(chatArea, conversation);
planUI.attach();

// Determine WS URL (same origin)
const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

// Fetch session token and connect
async function initializeClient() {
  const tokenResponse = await fetch('/api/token');
  const { token, cwd } = await tokenResponse.json();
  clientCwd = cwd;
  const savedModel = localStorage.getItem('uplink-model');
  let wsUrl = `${wsProtocol}//${location.host}/ws?token=${encodeURIComponent(token)}`;
  if (savedModel) {
    wsUrl += `&model=${encodeURIComponent(savedModel)}`;
  }

  const client = new AcpClient({
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

  return client;
}

// Connection status UI
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

  const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
  const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;
  sendBtn.disabled = state !== 'ready';
  cancelBtn.hidden = state !== 'prompting';
}

// Input handling
const promptInput = document.getElementById('prompt-input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;

let client: AcpClient | null = null;
let clientCwd: string = '';

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

// Theme toggle
const themeToggle = document.getElementById('theme-toggle')!;
themeToggle.addEventListener('click', () => {
  const current = document.documentElement.className;
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.className = next;
  localStorage.setItem('uplink-theme', next);
  updateThemeIcon(next);
});

// Model change
const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
modelSelect.addEventListener('change', async () => {
  const value = modelSelect.value;
  if (value) {
    localStorage.setItem('uplink-model', value);
  } else {
    localStorage.removeItem('uplink-model');
  }

  if (client) {
    try {
      await client.sendRawRequest('uplink/set_model', { model: value || undefined });
    } catch {
      // Best-effort — model will be applied via URL parameter on reload
    }
  }
  // Reload to establish a fresh ACP session with the new model
  window.location.reload();
});

// Sessions button
const sessionsBtn = document.getElementById('sessions-btn')!;
sessionsBtn.addEventListener('click', async () => {
  if (!client || !clientCwd) return;

  const sessions = await fetchSessions(clientCwd);
  const panel = createSessionListPanel(
    sessions,
    client.supportsLoadSession,
    {
      onResume: async (sessionId) => {
        try {
          await client!.loadSession(sessionId);
        } catch (err) {
          console.error('Failed to load session:', err);
        }
      },
      onNewSession: () => {
        // Reconnect to start a fresh session
        client!.disconnect();
        client!.connect().catch((err) => {
          console.error('Failed to create new session:', err);
        });
      },
    },
  );
  document.body.appendChild(panel);
});

// Enter to send (Shift+Enter for newline)
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});

// Auto-resize textarea
promptInput.addEventListener('input', () => {
  promptInput.style.height = 'auto';
  const maxH = 150;
  const scrollH = promptInput.scrollHeight;
  promptInput.style.height = Math.min(scrollH, maxH) + 'px';
  promptInput.style.overflowY = scrollH > maxH ? 'auto' : 'hidden';
});

// Connect!
initializeClient().then((c) => {
  client = c;
  client.connect();
}).catch((err) => {
  console.error('Failed to initialize client:', err);
});
