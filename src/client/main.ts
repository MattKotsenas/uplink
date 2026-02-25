import { AcpClient, ConnectionState } from './acp-client.js';
import { Conversation } from './conversation.js';
import { ChatUI } from './ui/chat.js';
import { PermissionUI } from './ui/permission.js';
import { ToolCallUI } from './ui/tool-call.js';
import { PlanUI } from './ui/plan.js';

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
  const { token } = await tokenResponse.json();
  const wsUrl = `${wsProtocol}//${location.host}/ws?token=${encodeURIComponent(token)}`;

  const client = new AcpClient({
    wsUrl,
    cwd: '.',
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

sendBtn.addEventListener('click', async () => {
  const text = promptInput.value.trim();
  if (!text || !client) return;

  conversation.addUserMessage(text);
  promptInput.value = '';
  promptInput.style.height = 'auto';

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
  promptInput.style.height = Math.min(promptInput.scrollHeight, 200) + 'px';
});

// Connect!
initializeClient().then((c) => {
  client = c;
  client.connect();
}).catch((err) => {
  console.error('Failed to initialize client:', err);
});
