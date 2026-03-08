import { AcpClient, ConnectionState } from './acp-client.js';
import { Conversation } from './conversation.js';
import { ChatList } from './ui/chat.js';
import { showPermissionRequest, cancelAllPermissions } from './ui/permission.js';
import { fetchSessions, openSessionsModal, SessionsModal } from './ui/sessions.js';
import { CommandPalette, type PaletteItem } from './ui/command-palette.js';
import { getCompletions, parseSlashCommand, setAvailableModels, findModelName } from './slash-commands.js';
import { SessionDots, type SessionDotStatus } from './ui/session-dots.js';
import { render, h } from 'preact';
import 'material-symbols/outlined.css';

// ─── DOM References ───────────────────────────────────────────────────

const chatArea = document.getElementById('chat-area')!;
const sessionDotsMount = document.getElementById('session-dots-mount')!;
const swipeHintLeft = document.getElementById('session-swipe-hint-left')!;
const swipeHintRight = document.getElementById('session-swipe-hint-right')!;
const promptInput = document.getElementById('prompt-input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;
const modelLabel = document.getElementById('model-label')!;
const dirLabel = document.getElementById('dir-label')!;

let yoloMode = localStorage.getItem('uplink-yolo') === 'true';

// ─── Mode ─────────────────────────────────────────────────────────────

type AgentMode = 'chat' | 'plan' | 'autopilot';
let currentMode: AgentMode = 'chat';

function applyMode(mode: AgentMode): void {
  currentMode = mode;
  document.documentElement.setAttribute('data-mode', mode);
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

// ─── Session Navigation State ─────────────────────────────────────────

let sessionCwds: string[] = [];
let activeDirCwd: string | null = null;
let sessionToken: string = '';
let sessionSwitchInFlight = false;
const MAX_SESSIONS = 5;
const sessionCwdsStorageKey = `uplink-session-cwds:${location.host}`;
const activeCwdStorageKey = `uplink-active-cwd:${location.host}`;

/** Per-directory state: client + conversation preserved across session switches. */
interface DirContext {
  client: AcpClient;
  conversation: Conversation;
}
const dirContexts = new Map<string, DirContext>();
const sessionDotStatuses = new Map<string, SessionDotStatus>();

function toSessionDotStatus(state: ConnectionState): SessionDotStatus {
  if (state === 'prompting') return 'busy';
  if (state === 'ready') return 'idle';
  if (state === 'connecting' || state === 'initializing') return 'initializing';
  return 'disconnected';
}

function persistSessionCwds(): void {
  sessionCwds = [...new Set(sessionCwds)];
  localStorage.setItem(sessionCwdsStorageKey, JSON.stringify(sessionCwds));
}

function persistActiveCwd(): void {
  if (activeDirCwd) {
    localStorage.setItem(activeCwdStorageKey, activeDirCwd);
  }
}

function loadPersistedSessionCwds(defaultCwd: string): string[] {
  const raw = localStorage.getItem(sessionCwdsStorageKey);
  if (!raw) return [defaultCwd];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [defaultCwd];
    const stored = parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    return [...new Set([...stored, defaultCwd])];
  } catch {
    return [defaultCwd];
  }
}

function loadPersistedActiveCwd(fallbackCwd: string): string {
  const saved = localStorage.getItem(activeCwdStorageKey);
  if (saved && sessionCwds.includes(saved)) {
    return saved;
  }
  return fallbackCwd;
}

/** Extract short display name from path (last 2 segments). */
function shortDirName(dir: string): string {
  const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('/') || dir;
}

/** Extract current folder name from path (last segment). */
function currentFolderName(dir: string): string {
  const normalized = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return dir;
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

let dirTooltipTimer: number | null = null;

function hideDirLabelTooltip(): void {
  delete dirLabel.dataset.tooltipOpen;
  if (dirTooltipTimer != null) {
    window.clearTimeout(dirTooltipTimer);
    dirTooltipTimer = null;
  }
}

function showDirLabelTooltip(): void {
  if (!dirLabel.dataset.fullPath) return;
  dirLabel.dataset.tooltipOpen = 'true';
  if (dirTooltipTimer != null) window.clearTimeout(dirTooltipTimer);
  dirTooltipTimer = window.setTimeout(() => {
    hideDirLabelTooltip();
  }, 2200);
}

dirLabel.setAttribute('role', 'button');
dirLabel.setAttribute('tabindex', '0');
dirLabel.addEventListener('click', (e) => {
  e.stopPropagation();
  showDirLabelTooltip();
});
dirLabel.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    showDirLabelTooltip();
  }
});
document.addEventListener('click', (e) => {
  if (!dirLabel.contains(e.target as Node)) {
    hideDirLabelTooltip();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideDirLabelTooltip();
});

function updateDirLabel(dir: string | null): void {
  if (!dir) {
    hideDirLabelTooltip();
    delete dirLabel.dataset.fullPath;
    dirLabel.removeAttribute('title');
    dirLabel.hidden = true;
    return;
  }
  dirLabel.textContent = currentFolderName(dir);
  dirLabel.title = dir;
  dirLabel.dataset.fullPath = dir;
  dirLabel.setAttribute('aria-label', `Current folder: ${dir}`);
  dirLabel.hidden = false;
}

function renderSessionDots(): void {
  const hasMultipleSessions = sessionCwds.length > 1;
  swipeHintLeft.hidden = !hasMultipleSessions;
  swipeHintRight.hidden = !hasMultipleSessions;

  if (!hasMultipleSessions) {
    sessionDotsMount.hidden = true;
    render(null, sessionDotsMount);
    return;
  }

  sessionDotsMount.hidden = false;
  render(
    h(SessionDots, {
      sessions: sessionCwds.map((cwd) => ({
        cwd,
        label: shortDirName(cwd),
        title: cwd,
        status: sessionDotStatuses.get(cwd) ?? 'disconnected',
      })),
      activeCwd: activeDirCwd ?? undefined,
      onSelect: (cwd: string) => {
        void connectToDirectory(cwd);
      },
    }),
    sessionDotsMount,
  );
}

async function switchSessionByOffset(offset: number): Promise<void> {
  if (sessionSwitchInFlight || !activeDirCwd || sessionCwds.length <= 1) return;
  const currentIndex = sessionCwds.indexOf(activeDirCwd);
  if (currentIndex === -1) return;

  const nextIndex = (currentIndex + offset + sessionCwds.length) % sessionCwds.length;
  const nextCwd = sessionCwds[nextIndex];
  if (!nextCwd || nextCwd === activeDirCwd) return;

  sessionSwitchInFlight = true;
  try {
    await connectToDirectory(nextCwd);
  } finally {
    sessionSwitchInFlight = false;
  }
}

/** Get or create a DirContext for a directory, connecting the AcpClient. */
function getOrCreateDirContext(dir: string): DirContext {
  let ctx = dirContexts.get(dir);
  if (ctx) return ctx;

  if (dirContexts.size >= MAX_SESSIONS) {
    throw new Error(`Session limit reached (max ${MAX_SESSIONS}). Close an existing session first.`);
  }

  const conv = new Conversation();
  const wsUrl = `${wsProtocol}//${location.host}/ws?token=${encodeURIComponent(sessionToken)}&cwd=${encodeURIComponent(dir)}`;
  const acpClient = new AcpClient({
    wsUrl,
    cwd: dir,
    onStateChange: (state) => {
      sessionDotStatuses.set(dir, toSessionDotStatus(state));
      renderSessionDots();
      // Only update UI if this dir is the active one
      if (activeDirCwd === dir) updateConnectionStatus(state, conv);
    },
    onSessionUpdate: (update) => {
      conv.handleSessionUpdate(update);
    },
    onModelsAvailable: (models, currentModelId) => {
      if (activeDirCwd === dir) {
        setAvailableModels(models);
        if (currentModelId) {
          const model = models.find((m) => m.modelId === currentModelId);
          modelLabel.textContent = model?.name ?? currentModelId;
          modelLabel.hidden = false;
        }
      }
    },
    onPermissionRequest: (request, respond) => {
      const autoApproveId = yoloMode
        ? request.options.find(
            (o) => o.kind === 'allow_once' || o.kind === 'allow_always',
          )?.optionId
        : undefined;

      showPermissionRequest(
        conv,
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

  ctx = { client: acpClient, conversation: conv };
  dirContexts.set(dir, ctx);
  sessionDotStatuses.set(dir, toSessionDotStatus(acpClient.connectionState));
  if (!sessionCwds.includes(dir)) {
    sessionCwds = [...sessionCwds, dir];
    persistSessionCwds();
  }
  renderSessionDots();
  return ctx;
}

async function connectToDirectory(dir: string): Promise<DirContext> {
  const ctx = getOrCreateDirContext(dir);
  activeDirCwd = dir;
  persistActiveCwd();
  clientCwd = dir;
  client = ctx.client;
  activeConversation = ctx.conversation;
  updateDirLabel(dir);
  renderChat();
  renderSessionDots();

  // Connect if not already connected
  if (ctx.client.connectionState === 'disconnected') {
    await ctx.client.connect();
  } else {
    // Already connected — just refresh the connection status UI
    updateConnectionStatus(ctx.client.connectionState, ctx.conversation);
  }

  return ctx;
}

// ─── Service Worker ───────────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('SW registration failed:', err);
  });
}

// ─── UI Components ────────────────────────────────────────────────────

let activeConversation = new Conversation();

// Mount all timeline components into a single chatContainer.
const chatContainer = document.createElement('div');
chatContainer.className = 'chat-container chat-messages';
chatArea.appendChild(chatContainer);

function renderChat(): void {
  render(
    h(ChatList, { conversation: activeConversation, scrollContainer: chatArea }),
    chatContainer,
  );
}
renderChat();

// Swipe left/right on mobile chat area to switch between session panes.
let swipeStartX = 0;
let swipeStartY = 0;
let isTrackingSwipe = false;
const SWIPE_THRESHOLD_PX = 48;

chatArea.addEventListener('touchstart', (e) => {
  if (sessionCwds.length <= 1 || e.touches.length !== 1) return;
  const touch = e.touches[0];
  swipeStartX = touch.clientX;
  swipeStartY = touch.clientY;
  isTrackingSwipe = true;
}, { passive: true });

chatArea.addEventListener('touchcancel', () => {
  isTrackingSwipe = false;
}, { passive: true });

chatArea.addEventListener('touchend', (e) => {
  if (!isTrackingSwipe || sessionCwds.length <= 1) return;
  isTrackingSwipe = false;

  const touch = e.changedTouches[0];
  if (!touch) return;

  const dx = touch.clientX - swipeStartX;
  const dy = touch.clientY - swipeStartY;
  if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return;
  if (Math.abs(dx) < Math.abs(dy) * 1.2) return;

  void switchSessionByOffset(dx < 0 ? 1 : -1);
}, { passive: true });

// Mount Preact sessions modal on body
const sessionsModalContainer = document.createElement('div');
document.body.appendChild(sessionsModalContainer);
render(h(SessionsModal, {}), sessionsModalContainer);

/** Clear all conversation state when session changes. */
function clearConversation(): void {
  activeConversation.clear();
  cancelAllPermissions(activeConversation);
}

// ─── WebSocket / ACP Client ──────────────────────────────────────────

const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

let client: AcpClient | null = null;
let clientCwd: string = '';

function updateConnectionStatus(state: ConnectionState, conv?: Conversation): void {
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
  sendBtn.hidden = state === 'prompting';
  cancelBtn.hidden = state !== 'prompting';

  const c = conv ?? activeConversation;
  c.isPrompting = state === 'prompting';
  c.notify();
}

// ─── Input Handling ───────────────────────────────────────────────────

sendBtn.addEventListener('click', async () => {
  const text = promptInput.value.trim();
  if (!text || !client) return;

  promptInput.value = '';
  promptInput.style.height = 'auto';
  hidePalette();
  document.documentElement.setAttribute('data-mode', currentMode);

  // Shell commands: !<command>
  if (text.startsWith('!')) {
    const command = text.slice(1).trim();
    if (!command) return;

    activeConversation.addUserMessage(`$ ${command}`);

    try {
      const result = await client.sendRawRequest<{
        stdout: string;
        stderr: string;
        exitCode: number;
      }>('uplink/shell', { command });
      activeConversation.addShellResult(command, result.stdout, result.stderr, result.exitCode);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      activeConversation.addShellResult(command, '', errorMessage, 1);
    }
    return;
  }

  // Slash commands
  let promptText = text;
  const parsed = parseSlashCommand(text);
  if (parsed) {
    if (parsed.kind === 'client') {
      const remainingPrompt = await handleClientCommand(parsed.command, parsed.arg);
      if (!remainingPrompt) return;
      // Mode command with a prompt — send the prompt portion
      promptText = remainingPrompt;
    } else if (parsed.command === '/model' && parsed.arg) {
      const name = findModelName(parsed.arg);
      if (name) {
        modelLabel.textContent = name;
        modelLabel.hidden = false;
      }
    }
  }

  activeConversation.addUserMessage(text);

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
      activeConversation.addUserMessage('continue');
      stopReason = await client.prompt('continue');
    }
    if (turns >= MAX_AUTOPILOT_TURNS) {
      activeConversation.addSystemMessage('Autopilot stopped: reached maximum turns');
    }
  } catch (err) {
    console.error('Prompt error:', err);
  }
});

cancelBtn.addEventListener('click', () => {
  client?.cancel();
  cancelAllPermissions(activeConversation);
  // Stop autopilot auto-continue loop by switching back to chat mode
  if (currentMode === 'autopilot') {
    applyMode('chat');
    activeConversation.addSystemMessage('Autopilot cancelled');
  }
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

/** Update the input border color to preview the mode implied by the current input text. */
function updateBorderPreview(): void {
  if (promptInput.value.startsWith('!')) {
    document.documentElement.setAttribute('data-mode', 'shell-input');
  } else if (promptInput.value.startsWith('/')) {
    const parts = promptInput.value.slice(1).split(/\s/, 1);
    const cmd = parts[0]?.toLowerCase();
    if (cmd === 'plan' || cmd === 'autopilot') {
      document.documentElement.setAttribute('data-mode', cmd);
    } else if (cmd === 'agent') {
      document.documentElement.setAttribute('data-mode', 'chat');
    } else {
      document.documentElement.setAttribute('data-mode', currentMode);
    }
  } else {
    document.documentElement.setAttribute('data-mode', currentMode);
  }
}

promptInput.addEventListener('input', () => {
  promptInput.style.height = 'auto';
  const maxH = 150;
  const scrollH = promptInput.scrollHeight;
  promptInput.style.height = Math.min(scrollH, maxH) + 'px';
  promptInput.style.overflowY = scrollH > maxH ? 'auto' : 'hidden';

  // Dynamic border preview based on input prefix
  updateBorderPreview();

  // Show/update command palette when typing /
  if (promptInput.value.startsWith('/')) {
    void showPalette();
  } else {
    hidePalette();
  }
});

// ─── Command Palette ──────────────────────────────────────────────────

const paletteMount = document.getElementById('palette-mount')!;
let paletteItems: PaletteItem[] = [];
let paletteSelectedIndex = 0;
let paletteVisible = false;
let paletteQueryId = 0;

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

function getNavigateSessionCompletions(): PaletteItem[] {
  if (sessionCwds.length === 0) return [];

  const ordered = [...sessionCwds].sort((a, b) => {
    if (a === activeDirCwd) return -1;
    if (b === activeDirCwd) return 1;
    return 0;
  });

  return ordered.map((cwd) => ({
    label: shortDirName(cwd),
    detail: cwd,
    fill: `/navigate ${cwd}`,
    executeOnSelect: true,
  }));
}

async function getNavigatePathCompletions(arg: string): Promise<PaletteItem[]> {
  const base = clientCwd || activeDirCwd || '';
  const res = await fetch(
    `/api/path-completions?prefix=${encodeURIComponent(arg)}&base=${encodeURIComponent(base)}`,
  );
  if (!res.ok) return [];

  const data = await res.json() as { completions?: Array<{ path: string; cwd: string }> };
  return (data.completions ?? []).map((entry) => ({
    label: entry.path,
    detail: entry.cwd,
    fill: `/navigate ${entry.path}`,
    executeOnSelect: false,
  }));
}

async function showPalette(): Promise<void> {
  const text = promptInput.value;
  const queryId = ++paletteQueryId;
  let items = getCompletions(text);

  if (text.startsWith('/navigate ')) {
    const arg = text.slice('/navigate '.length);
    if (arg.trim().length === 0) {
      items = getNavigateSessionCompletions();
    } else {
      try {
        items = await getNavigatePathCompletions(arg);
      } catch {
        items = [];
      }
      if (queryId !== paletteQueryId) return;
    }
  }

  paletteItems = items;
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
  updateBorderPreview();
  const shouldExecute = item.executeOnSelect ?? !item.fill.endsWith(' ');
  if (!shouldExecute) {
    // Top-level command selected — show sub-options or let user type more
    void showPalette();
  } else {
    // Concrete sub-option selected — execute
    hidePalette();
    sendBtn.click();
  }
}

// ─── Slash Command Handlers ───────────────────────────────────────────

/** Handle a client-side command. Returns a remaining prompt to send, or undefined. */
async function handleClientCommand(command: string, arg: string): Promise<string | undefined> {
  switch (command) {
    case '/theme':
      applyTheme(arg || 'auto');
      activeConversation.addSystemMessage(`Theme set to ${arg || 'auto'}`);
      return undefined;
    case '/yolo': {
      const on = arg === '' || arg === 'on';
      yoloMode = on;
      localStorage.setItem('uplink-yolo', String(yoloMode));
      activeConversation.addSystemMessage(`Auto-approve ${yoloMode ? 'enabled' : 'disabled'}`);
      return undefined;
    }
    case '/session':
      await handleSessionCommand(arg);
      return undefined;
    case '/navigate':
      if (!arg) {
        activeConversation.addSystemMessage('Usage: /navigate <path>');
        return undefined;
      }
      try {
        await navigateToPath(arg);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        activeConversation.addSystemMessage(`Navigate failed: ${msg}`);
      }
      return undefined;
    case '/exit':
    case '/quit':
      await closeCurrentSession();
      return undefined;
    case '/agent':
      applyMode('chat');
      activeConversation.addSystemMessage('Switched to agent mode');
      return arg || undefined;
    case '/plan':
      applyMode('plan');
      activeConversation.addSystemMessage('Switched to plan mode');
      return arg || undefined;
    case '/autopilot':
      applyMode('autopilot');
      activeConversation.addSystemMessage('Switched to autopilot mode');
      return arg || undefined;
    case '/clear':
      handleClearCommand();
      return undefined;
  }
  return undefined;
}

async function resolveNavigatePath(targetPath: string): Promise<string> {
  const base = clientCwd || activeDirCwd || '';
  const res = await fetch(
    `/api/resolve-path?path=${encodeURIComponent(targetPath)}&base=${encodeURIComponent(base)}`,
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? `Path resolution failed (${res.status})`);
  }

  const data = await res.json() as { cwd: string };
  return data.cwd;
}

async function navigateToPath(targetPath: string): Promise<void> {
  const cwd = await resolveNavigatePath(targetPath);
  await connectToDirectory(cwd);
  if (!client) return;

  clearConversation();
  await client.newSession();
  activeConversation.addSystemMessage(`Navigated to ${cwd}`);
}

/** Close the current session: send exit via ACP, disconnect, tear down bridge, switch away. */
async function closeCurrentSession(): Promise<void> {
  const cwdToClose = activeDirCwd;
  if (!cwdToClose || !client) {
    activeConversation.addSystemMessage('No active session to close.');
    return;
  }

  // Don't allow closing the last session
  if (sessionCwds.length <= 1) {
    activeConversation.addSystemMessage('Cannot close the only session.');
    return;
  }

  // Send exit notification via ACP (best-effort)
  try {
    client.sendRawRequest('exit', {}).catch(() => {});
  } catch { /* ignore */ }

  // Disconnect the client WebSocket
  client.disconnect();
  dirContexts.delete(cwdToClose);
  sessionDotStatuses.delete(cwdToClose);

  // Remove from session list
  sessionCwds = sessionCwds.filter((c) => c !== cwdToClose);
  persistSessionCwds();

  // Tell server to kill bridge and clean up
  try {
    await fetch('/api/session/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: cwdToClose }),
    });
  } catch { /* ignore */ }

  // Switch to the nearest remaining session
  const nextCwd = sessionCwds[0];
  await connectToDirectory(nextCwd);
  renderSessionDots();
  activeConversation.addSystemMessage(`Session closed: ${cwdToClose}`);
}

async function handleClearCommand(): Promise<void> {
  if (!client) return;
  clearConversation();
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

async function handleSessionCommand(arg: string): Promise<void> {
  if (!client || !clientCwd) return;

  if (arg === 'create' || arg === 'new') {
    clearConversation();
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
      activeConversation.addSystemMessage(`Session renamed to "${name}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      activeConversation.addSystemMessage(`Failed to rename: ${msg}`);
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
        try {
          await client!.newSession();
        } catch (err) {
          console.error('Failed to create new session:', err);
        }
      },
    );
  }
}

// ─── Mobile keyboard handling ─────────────────────────────────────────
// Chrome/Edge: VirtualKeyboard API gives env(keyboard-inset-height) in CSS.
// Safari/iOS:  dvh doesn't track the keyboard, so we sync #app to the
//              visual viewport — height for the keyboard, translateY for
//              the scroll offset iOS applies when focusing an input.
const appEl = document.getElementById('app')!;

if ('virtualKeyboard' in navigator) {
  (navigator as any).virtualKeyboard.overlaysContent = true;
} else if (window.visualViewport) {
  const vv = window.visualViewport;
  const sync = () => {
    appEl.style.height = `${vv.height}px`;
    appEl.style.transform = `translateY(${vv.offsetTop}px)`;
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
}

// ─── Connect ──────────────────────────────────────────────────────────

updateConnectionStatus('disconnected');

async function boot(): Promise<void> {
  const tokenRes = await fetch('/api/token');
  const { token, cwd } = await tokenRes.json();

  sessionToken = token;
  sessionCwds = loadPersistedSessionCwds(cwd);
  persistSessionCwds();
  renderSessionDots();

  const initialCwd = loadPersistedActiveCwd(cwd);
  try {
    await connectToDirectory(initialCwd);
  } catch (err) {
    if (initialCwd !== cwd) {
      await connectToDirectory(cwd);
    } else {
      throw err;
    }
  }
}

boot().catch((err) => {
  console.error('Failed to initialize client:', err);
});
