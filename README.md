# ⬆ Copilot Uplink

**Remote control for GitHub Copilot CLI from your phone or any browser.**

<!-- Badges: uncomment when CI / npm publish are set up
[![Build](https://img.shields.io/github/actions/workflow/status/YOUR_ORG/copilot-uplink/ci.yml?branch=main)](https://github.com/YOUR_ORG/copilot-uplink/actions)
[![npm](https://img.shields.io/npm/v/copilot-uplink)](https://www.npmjs.com/package/copilot-uplink)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
-->

## What Is This?

Copilot Uplink gives you a full chat interface to GitHub Copilot CLI — from
your phone, a tablet, or any browser. Think of it like Claude Code's
"Remote Control", but for Copilot CLI.

A lightweight Node.js bridge spawns `copilot --acp --stdio` as a child
process, translates between WebSocket and NDJSON (the ACP wire format), and
serves a Progressive Web App that renders streaming responses, tool calls,
permissions, and agent plans. Add a Microsoft Dev Tunnel and the whole thing
is reachable from anywhere.

```mermaid
graph LR
    PWA["PWA Client<br/>(browser)"] <-->|"HTTPS / WSS<br/>via devtunnel"| Bridge["Bridge Server<br/>(Node.js)"]
    Bridge <-->|"stdio / NDJSON<br/>child process"| Copilot["copilot --acp<br/>--stdio"]
    Bridge -.-|"Serves PWA static files<br/>+ WebSocket endpoint"| PWA
```

## Quick Start

```bash
# Run directly (no install required)
npx copilot-uplink

# Start with remote access via devtunnel
npx copilot-uplink --tunnel
```

## How It Works

1. **Copilot CLI** runs locally in ACP mode (`copilot --acp --stdio`),
   speaking newline-delimited JSON-RPC over stdin/stdout.
2. **Bridge server** spawns the CLI as a child process and bridges messages
   between its stdin/stdout and a WebSocket endpoint — acting as a dumb pipe
   that never interprets ACP messages.
3. **PWA** connects over WebSocket, drives the full ACP lifecycle
   (`initialize` → `session/new` → `session/prompt`), and renders the
   streaming response.
4. **Dev Tunnel** (optional) exposes the bridge server over HTTPS so you can
   reach it from your phone or any remote browser.

### Message Flow

```mermaid
sequenceDiagram
    participant PWA
    participant Bridge
    participant Copilot as Copilot (stdio)

    PWA->>Bridge: WS connect
    Bridge->>Copilot: spawn copilot --acp --stdio

    PWA->>Bridge: WS: initialize
    Bridge->>Copilot: stdin: initialize\n
    Copilot->>Bridge: stdout: result\n
    Bridge->>PWA: WS: result

    PWA->>Bridge: WS: session/prompt
    Bridge->>Copilot: stdin: session/prompt\n
    loop Streaming
        Copilot->>Bridge: stdout: session/update\n
        Bridge->>PWA: WS: session/update
    end

    Copilot->>Bridge: stdout: request_permission\n
    Bridge->>PWA: WS: request_permission
    PWA->>Bridge: WS: permission response
    Bridge->>Copilot: stdin: permission response\n

    Copilot->>Bridge: stdout: result\n
    Bridge->>PWA: WS: prompt result
```

## Features

- 💬 **Chat** with streaming responses
- 🔧 **Tool call visibility** — see reads, edits, executes, and more with kind icons and status
- 🔐 **Permission approve / deny** — surface permission requests with option buttons
- 📋 **Agent plan tracking** — view plan entries with priority and status
- 📱 **PWA** — installable on your phone's home screen
- 🌐 **Remote access** via Microsoft Dev Tunnel
- 🔄 **Auto-reconnect** with exponential backoff (1 s → 30 s max)
- 🌙 **Dark / light theme**

## Getting the PWA on Your Phone

1. **Start with tunnel:**
   ```bash
   npx copilot-uplink --tunnel
   ```
2. **Scan the QR code** printed in your terminal with your phone's camera.
3. **Add to Home Screen** — your browser will offer an "Install" or
   "Add to Home Screen" prompt because the app ships a Web App Manifest and
   Service Worker.
4. **(Optional) Use a persistent tunnel** so the URL stays the same across
   restarts:
   ```bash
   # One-time setup
   devtunnel create my-uplink
   devtunnel port create my-uplink -p 3000

   # Reuse every time
   npx copilot-uplink --tunnel-id my-uplink
   ```

With a persistent tunnel the installed PWA always connects to the same URL.
If the bridge is offline the cached app shell still opens instantly; it shows
a reconnection banner and retries automatically.

## CLI Reference

```
npx copilot-uplink [options]
```

| Flag | Description | Default |
|---|---|---|
| `--port <n>` | Port for the bridge server | `3000` |
| `--tunnel` | Start a devtunnel for remote access | off |
| `--no-tunnel` | Explicitly disable tunnel | — |
| `--tunnel-id <name>` | Use a persistent devtunnel (implies `--tunnel`) | — |
| `--cwd <path>` | Working directory for the Copilot subprocess | current dir |
| `--help` | Show help and exit | — |

## Development

### Prerequisites

- **Node.js 18+**
- **npm**
- **GitHub Copilot CLI** — needed for real usage; the mock agent covers
  development and testing without it.

### Setup

```bash
git clone https://github.com/YOUR_ORG/copilot-uplink.git
cd copilot-uplink
npm install
```

### Development Mode

Run the bridge with the **mock agent** so you don't need Copilot CLI
installed:

**macOS / Linux:**
```bash
COPILOT_COMMAND="npx tsx src/mock/mock-agent.ts --acp --stdio" npm run dev
```

**Windows (PowerShell):**
```powershell
$env:COPILOT_COMMAND="npx tsx src/mock/mock-agent.ts --acp --stdio"
npm run dev
```

Vite serves the PWA with hot-reload; changes to `src/client/` are reflected
instantly.

### Build

```bash
npm run build
```

This compiles the server TypeScript (`tsc`) and bundles the client (`vite build`).

### Testing

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch
```

#### Test Layers

| Layer | Location | What it covers |
|---|---|---|
| **Unit** | `test/unit/bridge.test.ts` | NDJSON framing, message routing, process lifecycle |
| **Unit** | `test/unit/acp-client.test.ts` | ACP protocol logic, JSON-RPC id correlation, state machine |
| **Unit** | `test/unit/conversation.test.ts` | Chunk accumulation, tool call tracking, plan tracking |
| **Unit** | `test/unit/mock-agent.test.ts` | Verifies mock agent produces valid ACP message sequences |
| **Integration** | `test/integration/full-flow.test.ts` | Full WS client → bridge → mock agent flows: happy path, tool calls, permissions, cancellation, multi-turn |

All automated tests use the **mock agent** as the subprocess so they run
without a real Copilot CLI installation. The bridge picks up the command from
the `COPILOT_COMMAND` environment variable; integration tests start the
bridge on a random port (`:0`) to avoid conflicts.

## Architecture Deep Dive

### The Bridge (Dumb Pipe)

The bridge **intentionally does not parse ACP messages**. It reads
newline-delimited JSON from the subprocess stdout and sends each line as a
WebSocket text message; in the other direction it writes incoming WebSocket
messages to stdin with a trailing `\n`.

Benefits:

- **Simple** — the bridge is ~100 lines of logic, easy to audit.
- **Testable** — you can verify framing without any ACP knowledge.
- **Protocol-agnostic** — if ACP evolves, only the PWA client needs updating.

### ACP Protocol

The [Agent Client Protocol](https://agentclientprotocol.com) defines how
AI-powered tools communicate with host applications. The wire format is
JSON-RPC 2.0 delimited by newlines (NDJSON).

Key message types the PWA handles:

| Method | Direction | Purpose |
|---|---|---|
| `initialize` | Client → Agent | Negotiate capabilities |
| `session/new` | Client → Agent | Create a conversation session |
| `session/prompt` | Client → Agent | Send a user prompt |
| `session/update` | Agent → Client | Streaming chunks, tool calls, plan updates |
| `session/request_permission` | Agent → Client | Ask user to approve a tool action |
| `session/cancel` | Client → Agent | Cancel a running prompt |

### Mock Agent

`src/mock/mock-agent.ts` is a standalone Node.js script that speaks ACP over
stdio — the same interface as `copilot --acp --stdio`. It supports six
scenarios selected by prompt content:

| Prompt contains | Scenario | Behaviour |
|---|---|---|
| *(default)* | `simple-text` | A few `agent_message_chunk` updates, then `end_turn` |
| `tool` | `tool-call` | Tool call → update (completed) → text → `end_turn` |
| `permission` | `permission-required` | Tool call → permission request → waits for response → continues |
| `stream` | `multi-chunk-stream` | Many small text chunks rapidly (tests streaming / backpressure) |
| `plan` | `plan-then-execute` | Plan update → tool calls that fulfil the plan |
| `refuse` | `error-refusal` | Responds with `stopReason: "refusal"` |

Use these scenarios during development to exercise every UI path without a
real Copilot CLI.

## Limitations (v1)

- **Single session only** — one browser client at a time.
- **No session resume** across bridge restarts.
- **No file system / terminal proxying** — the PWA does not provide
  client-side FS or terminal capabilities back to the agent.
- **No authentication** beyond devtunnel's built-in defaults.

## Roadmap Ideas

- Session persistence and resume across restarts
- Multi-session support (multiple browser tabs / devices)
- File explorer integration
- Push notifications for long-running tasks
- Syntax-highlighted diffs in tool call output

## License

[MIT](LICENSE)
