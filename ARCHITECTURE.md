# Architecture

This document describes the internal architecture of Copilot Uplink: how the components connect,
how the bridge lifecycle works, and how the system handles reconnection and session resume.

## System Overview

```
┌──────────────┐       WebSocket        ┌──────────────┐       stdio/NDJSON      ┌──────────────┐
│  PWA Client  │◄─────────────────────►│ Bridge Server │◄──────────────────────►│  Copilot CLI  │
│  (browser)   │       (JSON-RPC)       │  (Node.js)   │    (child process)     │  (--acp)      │
└──────────────┘                        └──────────────┘                        └──────────────┘
```

Three components form a pipeline:

1. **PWA Client** — Preact single-page app running in the browser. Drives the ACP protocol,
   renders streaming responses, tool calls, permissions, and plans.
2. **Bridge Server** — Express + WebSocket server. Spawns the Copilot CLI as a child process
   and forwards messages between WebSocket and stdin/stdout. Mostly a dumb pipe with a few
   targeted interceptions.
3. **Copilot CLI** — GitHub's `copilot --acp --stdio` binary. Speaks JSON-RPC 2.0 over
   newline-delimited JSON (NDJSON).

## The Bridge (Dumb Pipe)

The bridge **intentionally does not parse ACP messages**. It reads newline-delimited JSON from
the subprocess stdout and sends each line as a WebSocket text message; in the other direction it
writes incoming WebSocket messages to stdin with a trailing `\n`.

Benefits:

- **Simple** — the bridge is ~100 lines of logic, easy to audit.
- **Testable** — you can verify framing without any ACP knowledge.
- **Protocol-agnostic** — if ACP evolves, only the PWA client needs updating.

### Server-Side Interceptions

The bridge server intercepts a small number of messages for operational reasons:

| Interception | Why |
|---|---|
| `initialize` request | Served from cache (eager init). Client never waits for cold start. |
| `session/new` response | Tracks in-memory for session listing and replay buffer. |
| `session/list` request | Server-originated RPC to the CLI for session listing. |
| `session/load` request | Replays from server-side buffer when session is already active. |
| `uplink/shell` request | Handled server-side (executes shell commands in cwd). |
| `uplink/rename_session` request | Handled server-side (writes to CLI's workspace.yaml). |

All other messages pass through unmodified.

## ACP Protocol

The [Agent Client Protocol](https://agentclientprotocol.com) defines how AI-powered tools
communicate with host applications. The wire format is JSON-RPC 2.0 delimited by newlines (NDJSON).

Key message types the PWA handles:

| Method | Direction | Purpose |
|---|---|---|
| `initialize` | Client → Agent | Negotiate capabilities |
| `session/new` | Client → Agent | Create a conversation session |
| `session/load` | Client → Agent | Load an existing session (replays history) |
| `session/prompt` | Client → Agent | Send a user prompt |
| `session/update` | Agent → Client | Streaming chunks, tool calls, plan updates |
| `session/request_permission` | Agent → Client | Ask user to approve a tool action |
| `session/cancel` | Client → Agent | Cancel a running prompt |

## Bridge Lifecycle

### Cold Start (First Connection)

```
1. CLI starts             → Bridge spawns `copilot --acp --stdio`
2. Eager initialize       → Bridge immediately sends `initialize` (before any client connects)
3. Client connects        → WebSocket opened
4. Client sends init      → Bridge returns cached initialize result (0ms)
5. Client sends session/* → Forwarded to CLI normally
```

**Eager initialization** overlaps the CLI's cold start (~10-30s) with the time the user spends
opening a browser or scanning a QR code. By the time the client connects, the initialize response
is already cached.

### Reconnection (Page Refresh / Mobile Resume)

```
1. Client disconnects     → Bridge stays alive (NOT killed)
2. Client reconnects      → New WebSocket, same bridge process
3. Client sends init      → Served from cache (0ms)
4. Client sends session/load → See "Session Resume" below
```

The bridge process intentionally survives client disconnections. This means:
- No cold start penalty on reconnect
- The Copilot CLI session remains active in memory
- `session/load` for the same session returns "already loaded" (see below)

### Bridge Death

If the Copilot CLI process exits unexpectedly:
1. Bridge detects `close` event
2. Next client message triggers `ensureBridge()` which spawns a fresh process
3. New eager init is sent immediately
4. Client experiences a brief "initializing" state

## Session Management

### How Sessions Work in the Copilot CLI

The Copilot CLI assigns a UUID to each session via `session/new`. Sessions are stored
on the filesystem at `~/.copilot/session-state/{uuid}/`:

```
~/.copilot/session-state/
  6700e43b-742b-43c3-bfa4-5b62cdb2a0c0/
    workspace.yaml      # Session metadata (id, cwd, summary, timestamps)
    events.jsonl        # Full conversation event log
    checkpoints/        # Agent checkpoints
    files/              # Session artifacts
```

The CLI reads these files to serve `session/list` and `session/load` requests.
**The filesystem is the source of truth** — not the SQLite `session-store.db` database.

> **Why not `session-store.db`?**  The DB at `~/.copilot/session-store.db` is used by
> the VS Code Copilot extension, not by the CLI in ACP mode. The CLI never reads from
> or writes to it during ACP communication. Earlier versions of Uplink maintained
> parallel records in this DB via `recordSession()`, which caused test pollution
> (mock sessions accumulating) and state drift. This was removed in favor of using the
> CLI's native session listing.

### Session Listing: Hybrid Approach

The CLI supports a `session/list` method (a Copilot extension, not part of the ACP
standard). It is advertised via `agentCapabilities.sessionCapabilities.list` in the
`initialize` response.

**Request/Response:**
```jsonc
// Request
{"method": "session/list", "params": {"cwd": "C:\\Projects\\uplink"}}

// Response
{
  "sessions": [
    {"sessionId": "6700e43b-...", "cwd": "C:\\Projects\\uplink", "title": "Fix auth bug", "updatedAt": "2026-02-28T..."}
  ],
  "nextCursor": "NTA="  // Base64-encoded cursor for pagination
}
```

**Key behaviors:**
- Returns 50 sessions per page with cursor-based pagination
- Filters by `cwd` when provided
- The CLI auto-generates titles from the first user prompt (~99% of sessions have titles)
- **Limitation:** Newly created sessions don't appear until the CLI process restarts
  (the CLI indexes `workspace.yaml` files at startup and doesn't refresh)

Because of this limitation, Uplink uses a **hybrid listing** approach:

1. **CLI `session/list`** — provides the bulk of historical sessions
2. **In-memory supplement** — a `Map<sessionId, SessionInfo>` on the server tracks sessions
   created during the current bridge's lifetime

The `/api/sessions` endpoint merges both sources, deduplicates by `sessionId`, and sorts
by `updatedAt` descending. The supplement is cleared when the bridge dies (sessions are
tied to the bridge's CLI process).

### Session Rename

There is no ACP method for renaming sessions. The CLI writes a `summary` field to
`workspace.yaml` once (typically after the first prompt). Uplink's `/session rename`
command writes directly to this YAML file, which the CLI reads on the next `session/list`.

### What Uplink Caches vs. Doesn't

| Data | Storage | Lifetime | Purpose |
|------|---------|----------|---------|
| Session replay buffer | In-memory Map per session | Bridge lifetime | Replay conversation on reconnect |
| Recent sessions supplement | In-memory Map | Bridge lifetime | Cover CLI's lazy indexing gap |
| Cached initialize response | In-memory string | Bridge lifetime | Instant reconnect (no cold start) |

Uplink writes **nothing** to disk for session management. All persistence is handled
by the CLI's own filesystem storage.

## Session Resume

Session resume handles the case where a user refreshes the page (or a mobile browser suspends
and resumes the app). The goal: show the conversation history without a cold start.

### The "Already Loaded" Problem

When the bridge stays alive across reconnections, `session/load` for the same session returns
an error:

```json
{"error": {"code": -32602, "message": "Session X is already loaded"}}
```

This is because the CLI still has the session loaded in memory. Unlike loading a *different*
session (which triggers full history replay via `session/update` notifications), reloading the
*same* session is rejected.

### Solution: Server-Side Session Buffer

The server keeps an in-memory buffer of the active session's `session/update` messages plus
synthesized `user_message_chunk` entries from outgoing `session/prompt` calls. When a client
sends `session/load` for the already-active session:

1. The server intercepts the request (does NOT forward to the CLI).
2. It fabricates a success response with the cached session result.
3. It replays all buffered history lines to the client.

The client never sees the "already loaded" error — it receives the same message flow as a
normal `session/load`. The `onSessionUpdate` handler renders messages identically whether
they come from a live stream or a replay.

The buffer is cleared when:
- The bridge process dies and restarts (all buffers lost; `session/load` triggers fresh ACP replay)

Each session has its own independent buffer, so switching between sessions A→B→A
preserves the history for both.

### Session Change Flow

When switching to a *different* session (via session picker or `/session load`):
1. The server clears the buffer and forwards the request to the CLI
2. The CLI unloads the current session, loads the new one, and replays full history
   as `user_message_chunk` and `agent_message_chunk` notifications
3. The server captures these notifications into the new buffer
4. The client renders the replayed history normally

## Logging

The server uses the [`debug`](https://www.npmjs.com/package/debug) package for structured
logging with zero cost when disabled.

### Namespaces

| Namespace | What it logs |
|---|---|
| `uplink:server` | Connection events, WebSocket lifecycle |
| `uplink:bridge` | Bridge spawn, close, errors, stdin/stdout |
| `uplink:session` | Session listing, buffer replay, eager init lifecycle |
| `uplink:timing` | Performance measurements (bridge spawn, initialize, etc.) |

### Enabling

```bash
# Via environment variable
DEBUG=uplink:* npx @mattkotsenas/uplink@latest

# Via CLI flag
npx @mattkotsenas/uplink@latest --verbose

# Specific namespaces only
DEBUG=uplink:timing npx @mattkotsenas/uplink@latest
```

## Message Flow

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
