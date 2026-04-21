# nr-ai-observatory

Observability for AI coding assistants. Captures tool calls, token usage, cost, and developer workflow patterns from Claude Code, Cursor, Windsurf, and Copilot — and sends everything to New Relic.

## Documentation

- [Requirements](#requirements)
- [Getting started](#getting-started)
- [Packages](#packages)
- [Building](#building)
- [Testing](#testing)
- [Running the MCP server](#running-the-mcp-server)
- [Configuration](#configuration)
- [Resources](#resources)

---

## Requirements

- **Node.js**: v24 via nvm (Node Version Manager)
- **npm**: Comes with Node.js (workspaces support required)
- **New Relic account**: License key and account ID for telemetry ingestion

---

## Getting started

### nvm (Node Version Manager)

Check if nvm is installed:

```bash
nvm --version
```

If not, install it:

```bash
brew install nvm
```

### Node.js

Install and use the project's required Node version (defined in `.nvmrc`):

```bash
nvm install
nvm use
```

### Install dependencies

```bash
npm install
```

This installs dependencies for all packages in the workspace.

---

## Packages

This is an npm workspaces monorepo with four packages:

| Package | Path | Description |
|---------|------|-------------|
| `@nr-ai-observatory/shared` | `packages/shared` | Transport layer, event buffer, pricing table, harvest scheduler, and configuration utilities shared across all packages |
| `nr-ai-agent` | `packages/nr-ai-agent` | SDK wrapper agent — wraps Anthropic Claude and Google Gemini clients to automatically capture and report AI usage to New Relic |
| `nr-ai-mcp-server` | `packages/nr-ai-mcp-server` | MCP server + observability platform — hooks into Claude Code to capture tool calls, computes efficiency/cost/anti-pattern metrics, and exposes MCP tools for querying session data |
| `test-app` | `packages/test-app` | End-to-end integration test harness for `nr-ai-agent` |

### Dependency graph

```
test-app
  └─> nr-ai-agent
        └─> @nr-ai-observatory/shared

nr-ai-mcp-server
  └─> @nr-ai-observatory/shared
```

---

## Building

Build all packages (respects project references):

```bash
npm run build
```

Build a specific package (must build `shared` first):

```bash
npx tsc -b packages/shared
npx tsc -b packages/nr-ai-mcp-server
```

Clean build output:

```bash
npm run build:clean
```

---

## Testing

```bash
npm test                                    # Run all tests
npx jest -- packages/shared/               # Run tests for a single package
npx jest -- src/metrics/cost-tracker.test.ts  # Run a single test file
```

Jest runs with `maxWorkers: 1` to avoid deadlocks in stdio integration tests.

---

## Running the MCP server

### As a Claude Code MCP server (stdio mode)

```bash
nr-ai-mcp-server --stdio
```

This is the mode used when Claude Code connects to the server as an MCP tool provider. The server communicates over stdin/stdout using the Model Context Protocol.

### As an HTTP proxy (proxy mode)

```bash
nr-ai-mcp-server --port 9847
```

Starts an HTTP server that forwards requests to upstream MCP servers while recording tool call metrics and proxy overhead.

### Hook collector

The hook collector binary is installed as a Claude Code hook that captures PreToolUse/PostToolUse events:

```bash
nr-ai-observe
```

---

## Configuration

Configuration is loaded with the following priority: **CLI arguments > environment variables > config file > defaults**.

### Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEW_RELIC_LICENSE_KEY` | Yes | — | New Relic ingest license key |
| `NEW_RELIC_ACCOUNT_ID` | Yes | — | New Relic account ID |
| `NEW_RELIC_AI_MCP_APP_NAME` | No | `nr-ai-mcp-server` | Application name in NR |
| `NEW_RELIC_AI_MCP_DEVELOPER` | No | `$USER` / git user | Developer identifier |
| `NEW_RELIC_AI_MCP_ENABLED` | No | `true` | Enable/disable the server |
| `NEW_RELIC_AI_MCP_RECORD_CONTENT` | No | `false` | Record tool input/output content |
| `NEW_RELIC_AI_MCP_STORAGE_PATH` | No | `~/.nr-ai-observe` | Local storage directory |
| `NEW_RELIC_AI_MCP_PORT` | No | `9847` | HTTP proxy port |
| `NEW_RELIC_AI_MCP_LOG_LEVEL` | No | `info` | Log level (`debug`, `info`, `warn`, `error`) |
| `NEW_RELIC_HOST` | No | Auto-detect | Collector host (auto-detects EU from license key) |
| `NEW_RELIC_AI_MCP_PROXY_UPSTREAMS` | No | `[]` | JSON array of upstream MCP server configs |

### Config file

```bash
nr-ai-mcp-server --config ~/.nr-ai-observe/config.json
```

---

## Resources

- [ONBOARDING.md](./ONBOARDING.md) — Start here if you're new to the project
- [CLAUDE.md](./CLAUDE.md) — Full technical reference (architecture, conventions, patterns)
- [TEST_PATTERNS.md](./TEST_PATTERNS.md) — Testing conventions, mock patterns, and exemplary test files
- [METRICS_TABLE.md](./METRICS_TABLE.md) — Every event, metric, and log entry sent to New Relic
- [COMMANDS_TABLE.md](./COMMANDS_TABLE.md) — All MCP tools: parameters, return structure, and computation logic
- [New Relic Docs](https://docs.newrelic.com/)
