# Contributing to Copilot Uplink

## Prerequisites

- **Node.js 18+**
- **npm**
- **GitHub Copilot CLI** — needed for real usage; the mock agent covers
  development and testing without it.

## Setup

```bash
git clone https://github.com/MattKotsenas/uplink.git
cd uplink
npm install
```

## Development Mode

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

## Build

```bash
npm run build
```

This compiles the server TypeScript (`tsc`) and bundles the client (`vite build`).

## Testing

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch
```

### Test Layers

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

### Mock Agent

`src/mock/mock-agent.ts` is a standalone Node.js script that speaks ACP over
stdio — the same interface as `copilot --acp --stdio`. It supports seven
scenarios selected by prompt content:

| Prompt contains | Scenario | Behaviour |
|---|---|---|
| *(default)* | `simple-text` | A few `agent_message_chunk` updates, then `end_turn` |
| `tool` | `tool-call` | Tool call → update (completed) → text → `end_turn` |
| `permission` | `permission-required` | Tool call → permission request → waits for response → continues |
| `stream` | `multi-chunk-stream` | Many small text chunks rapidly (tests streaming / backpressure) |
| `plan` | `plan-then-execute` | Plan update → tool calls that fulfil the plan |
| `reason` | `reasoning` | Thinking tool call → completed → text → `end_turn` |
| `refuse` | `error-refusal` | Responds with `stopReason: "refusal"` |

Use these scenarios during development to exercise every UI path without a
real Copilot CLI.

## Releasing

Releases are published to npm automatically via GitHub Actions using
[trusted publishing](https://docs.npmjs.com/trusted-publishers) (no npm
tokens needed).

1. **Update the version** in `package.json`:
   ```bash
   npm version patch   # or minor / major
   ```
2. **Push the commit and tag:**
   ```bash
   git push && git push --tags
   ```
3. **Create a GitHub Release** from the tag — go to
   [Releases](https://github.com/MattKotsenas/uplink/releases) → **Draft a
   new release** → select the tag → add release notes → **Publish release**.
4. The `publish.yml` workflow runs automatically: build → test → `npm publish`.

To verify: check the
[Actions tab](https://github.com/MattKotsenas/uplink/actions/workflows/publish.yml)
and [npm package page](https://www.npmjs.com/package/@mattkotsenas/uplink).

### Testing a package locally before release

```bash
npm pack
npm install -g ./mattkotsenas-uplink-<version>.tgz
uplink --help
```
