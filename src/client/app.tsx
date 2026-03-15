import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { AcpClient, type ConnectionState } from './acp-client.js';
import { Conversation } from './conversation.js';
import { ChatList } from './ui/chat.js';
import { showPermissionRequest, cancelAllPermissions } from './ui/permission.js';
import { SessionsModal, openSessionsModal } from './ui/sessions.js';
import { fetchSessions as fetchSessionsApi } from './ui/sessions-api.js';
import { CommandPalette, type PaletteItem } from './ui/command-palette.js';
import { getCompletions, setAvailableModels } from './slash-commands.js';
import { handleSend, type AgentMode } from './prompt-controller.js';

const conversation = new Conversation();

export function App() {
  // ─── State ──────────────────────────────────────────────────────────
  const mode = useSignal<AgentMode>('chat');
  const connectionState = useSignal<ConnectionState>('disconnected');
  const modelLabelText = useSignal('');
  const modelLabelHidden = useSignal(true);
  const yoloMode = useSignal(localStorage.getItem('uplink-yolo') === 'true');
  const paletteItems = useSignal<PaletteItem[]>([]);
  const paletteSelectedIndex = useSignal(0);
  const paletteVisible = useSignal(false);
  const mounted = useSignal(false);

  // ─── Refs ───────────────────────────────────────────────────────────
  const clientRef = useRef<AcpClient | null>(null);
  const clientCwdRef = useRef('');
  const promptInputRef = useRef<HTMLTextAreaElement>(null);
  const chatAreaRef = useRef<HTMLElement>(null);

  // ─── Theme ──────────────────────────────────────────────────────────
  function applyTheme(theme: string): void {
    if (theme === 'auto') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.className = prefersDark ? 'dark' : 'light';
    } else {
      document.documentElement.className = theme;
    }
    localStorage.setItem('uplink-theme', theme);
  }

  // ─── Mode ───────────────────────────────────────────────────────────
  function applyMode(m: AgentMode): void {
    mode.value = m;
    document.documentElement.setAttribute('data-mode', m);
  }

  // ─── Border preview ─────────────────────────────────────────────────
  function updateBorderPreview(): void {
    const input = promptInputRef.current;
    if (!input) return;
    if (input.value.startsWith('!')) {
      document.documentElement.setAttribute('data-mode', 'shell-input');
    } else if (input.value.startsWith('/')) {
      const parts = input.value.slice(1).split(/\s/, 1);
      const cmd = parts[0]?.toLowerCase();
      if (cmd === 'plan' || cmd === 'autopilot') {
        document.documentElement.setAttribute('data-mode', cmd);
      } else if (cmd === 'agent') {
        document.documentElement.setAttribute('data-mode', 'chat');
      } else {
        document.documentElement.setAttribute('data-mode', mode.value);
      }
    } else {
      document.documentElement.setAttribute('data-mode', mode.value);
    }
  }

  // ─── Palette ────────────────────────────────────────────────────────
  function showPalette(): void {
    const input = promptInputRef.current;
    if (!input) return;
    const items = getCompletions(input.value);
    paletteSelectedIndex.value = 0;
    paletteItems.value = items;
    paletteVisible.value = items.length > 0;
  }

  function hidePalette(): void {
    paletteVisible.value = false;
    paletteItems.value = [];
  }

  // ─── Send ───────────────────────────────────────────────────────────
  async function handleSendClick(): Promise<void> {
    const input = promptInputRef.current;
    const client = clientRef.current;
    if (!input || !client) return;

    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    input.style.height = 'auto';
    hidePalette();
    document.documentElement.setAttribute('data-mode', mode.value);

    await handleSend(text, {
      client,
      conversation,
      clientCwd: clientCwdRef.current,
      getMode: () => mode.value,
      setMode: applyMode,
      yoloMode: () => yoloMode.value,
      setYoloMode: (on) => {
        yoloMode.value = on;
        localStorage.setItem('uplink-yolo', String(on));
      },
      setModelLabel: (name: string) => {
        modelLabelText.value = name;
        modelLabelHidden.value = false;
      },
      applyTheme,
      cancelPermissions: (conv) => cancelAllPermissions(conv),
      fetchSessions: (cwd) => fetchSessionsApi(cwd),
      showSessionsModal: openSessionsModal,
    });
  }

  // ─── Cancel ─────────────────────────────────────────────────────────
  function handleCancel(): void {
    clientRef.current?.cancel();
    cancelAllPermissions(conversation);
    if (mode.value === 'autopilot') {
      applyMode('chat');
      conversation.addSystemMessage('Autopilot cancelled');
    }
  }

  // ─── Palette accept ─────────────────────────────────────────────────
  function acceptCompletion(item: PaletteItem): void {
    const input = promptInputRef.current;
    if (!input) return;
    input.value = item.fill;
    input.focus();
    updateBorderPreview();
    if (item.fill.endsWith(' ')) {
      showPalette();
    } else {
      hidePalette();
      handleSendClick();
    }
  }

  // ─── Input handlers ─────────────────────────────────────────────────
  function handleKeyDown(e: KeyboardEvent): void {
    if (paletteVisible.value) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        paletteSelectedIndex.value = Math.max(0, paletteSelectedIndex.value - 1);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        paletteSelectedIndex.value = Math.min(paletteItems.value.length - 1, paletteSelectedIndex.value + 1);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        const item = paletteItems.value[paletteSelectedIndex.value];
        if (item) acceptCompletion(item);
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
      handleSendClick();
    }
  }

  function handleInput(): void {
    const input = promptInputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    const maxH = 150;
    const scrollH = input.scrollHeight;
    input.style.height = Math.min(scrollH, maxH) + 'px';
    input.style.overflowY = scrollH > maxH ? 'auto' : 'hidden';
    updateBorderPreview();
    if (input.value.startsWith('/')) {
      showPalette();
    } else {
      hidePalette();
    }
  }

  // ─── Connection status ──────────────────────────────────────────────
  function updateConnectionStatus(state: ConnectionState): void {
    connectionState.value = state;
    if (state === 'initializing' && conversation.timeline.value.length > 0) {
      conversation.clear();
    }
    conversation.prompting = state === 'prompting';
  }

  // ─── Initialize on mount ────────────────────────────────────────────
  useEffect(() => {
    mounted.value = true;

    // Theme
    const saved = localStorage.getItem('uplink-theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(saved ?? (prefersDark ? 'dark' : 'light'));

    // Mode
    applyMode('chat');

    // Client
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

    async function initializeClient() {
      const tokenResponse = await fetch('/api/token');
      const { token, cwd } = await tokenResponse.json();
      clientCwdRef.current = cwd;

      const wsUrl = `${wsProtocol}//${location.host}/ws?token=${encodeURIComponent(token)}`;

      return new AcpClient({
        wsUrl,
        cwd,
        onStateChange: (state) => updateConnectionStatus(state),
        onSessionUpdate: (update) => conversation.handleSessionUpdate(update),
        onModelsAvailable: (models, currentModelId) => {
          setAvailableModels(models);
          if (currentModelId) {
            const model = models.find((m) => m.modelId === currentModelId);
            modelLabelText.value = model?.name ?? currentModelId;
            modelLabelHidden.value = false;
          }
        },
        onPermissionRequest: (request, respond) => {
          const autoApproveId = yoloMode.value
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

    updateConnectionStatus('disconnected');

    initializeClient().then((c) => {
      clientRef.current = c;
      c.connect();
    }).catch((err) => {
      console.error('Failed to initialize client:', err);
    });
  }, []);

  // ─── Derived state ──────────────────────────────────────────────────
  const state = connectionState.value;
  const displayState = state === 'prompting' ? 'ready' : state;
  const statusClass = `status-${
    state === 'ready' || state === 'prompting'
      ? 'connected'
      : state === 'connecting' || state === 'initializing'
        ? 'reconnecting'
        : 'disconnected'
  }`;
  const sendDisabled = state !== 'ready';
  const sendHidden = state === 'prompting';
  const cancelHidden = state !== 'prompting';

  // ─── Render ─────────────────────────────────────────────────────────
  return (
    <>
      <header id="header">
        <h1>
          <svg class="header-icon" width="24" height="24" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
            <rect width="512" height="512" rx="64" fill="var(--accent)" />
            <g transform="translate(56, 456) scale(0.4167)" fill="#ffffff">
              <path d="M240-100q-58 0-99-41t-41-99q0-58 41-99t99-41q58 0 99 41t41 99q0 22-6.5 42.5T354-159v-27q30 13 62 19.5t64 6.5q134 0 227-93t93-227h80q0 83-31.5 156T763-197q-54 54-127 85.5T480-80q-45 0-88-9.5T309-118q-16 9-33.5 13.5T240-100Zm42.5-97.5Q300-215 300-240t-17.5-42.5Q265-300 240-300t-42.5 17.5Q180-265 180-240t17.5 42.5Q215-180 240-180t42.5-17.5ZM480-340q-58 0-99-41t-41-99q0-58 41-99t99-41q58 0 99 41t41 99q0 58-41 99t-99 41ZM80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q45 0 88 9.5t83 28.5q16-9 33.5-13.5T720-860q58 0 99 41t41 99q0 58-41 99t-99 41q-58 0-99-41t-41-99q0-22 6.5-42.5T606-801v27q-30-13-62-19.5t-64-6.5q-134 0-227 93t-93 227H80Zm640-180q25 0 42.5-17.5T780-720q0-25-17.5-42.5T720-780q-25 0-42.5 17.5T660-720q0 25 17.5 42.5T720-660ZM240-240Zm480-480Z" />
            </g>
          </svg>
          {' '}Copilot Uplink
        </h1>
        <div id="connection-status" class={statusClass}>{displayState}</div>
        <a href="https://github.com/MattKotsenas/uplink" target="_blank" rel="noopener noreferrer" class="header-github" title="GitHub">
          <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
        </a>
      </header>
      <main id="chat-area" ref={chatAreaRef}>
        {mounted.value && chatAreaRef.current && (
          <div class="chat-container chat-messages">
            <ChatList conversation={conversation} scrollContainer={chatAreaRef.current} />
          </div>
        )}
      </main>
      <footer id="input-area">
        <div id="palette-mount">
          {paletteVisible.value && paletteItems.value.length > 0 && (
            <CommandPalette
              items={paletteItems.value}
              selectedIndex={paletteSelectedIndex.value}
              onSelect={acceptCompletion}
              onHover={(i: number) => { paletteSelectedIndex.value = i; }}
            />
          )}
        </div>
        <div id="input-wrapper">
          <textarea
            id="prompt-input"
            ref={promptInputRef}
            placeholder="Prompt or / for commands"
            rows={1}
            aria-label="Message to Copilot"
            onKeyDown={handleKeyDown}
            onInput={handleInput}
          />
          <span id="model-label" hidden={modelLabelHidden.value}>
            {modelLabelText.value}
          </span>
        </div>
        <button id="send-btn" disabled={sendDisabled} hidden={sendHidden} onClick={handleSendClick}>
          Send
        </button>
        <button id="cancel-btn" hidden={cancelHidden} onClick={handleCancel}>
          Cancel
        </button>
      </footer>
      <SessionsModal />
    </>
  );
}
