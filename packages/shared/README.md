# @nr-ai-observatory/shared

Foundational transport layer for NR AI Observatory. Handles event creation, token extraction, cost calculation, and delivery to New Relic's Events, Metrics, and Logs APIs.

## What's Inside

### Event Creation
- `createAiRequest()` — AI request event
- `createAiResponse()` — AI response event  
- `createAiMessage()` — message content (optional)
- `aiRequestToNrEvent()` — serialize to New Relic format

### Token Handling
- `extractTokens()` — parse token counts from SDK responses
- `safeInt()` — validate and coerce numeric values

### Pricing
- Token pricing tables for Anthropic, Google, OpenAI, Bedrock, Mistral, Cohere
- `calculateCost()` — USD cost from token counts and model
- `loadCustomPricing()` — optional custom pricing override

### Harvest & Transport
- `HarvestScheduler` — batches and periodically flushes events/metrics; routes based on `transport` config
- `EventBuffer` — in-memory event queue with bounded retry
- `MetricAggregator` — aggregates metrics by name and attributes
- HTTP clients for Events API, Metric API, Logs API
- `OtlpTransport` — wraps OTel SDK for OTLP/HTTP trace and metric export
- `OtlpEventBridge` — converts `NrEventData[]` to OTel log records for OTLP delivery

### Logging
- `createLogger()` — structured JSON logging to stderr
- `redact()` — sanitize secrets before logging

## Usage

### SDK wrapper (Anthropic example)

```typescript
import { init } from 'nr-ai-agent';

const agent = init({
  licenseKey: process.env.NEW_RELIC_LICENSE_KEY,
  accountId: 12345,
  appName: 'my-service',
});

const client = new Anthropic();
const wrappedClient = agent.wrapAnthropicClient(client);

// Use normally — events sent automatically
const response = await wrappedClient.messages.create({
  model: 'claude-opus-4-20250805',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello!' }],
});

await agent.shutdown();
```

### Standalone event creation

```typescript
import { createAiRequest, createAiResponse } from '@nr-ai-observatory/shared';

const req = createAiRequest({
  provider: 'anthropic',
  model: 'claude-opus-4-20250805',
  messageCount: 1,
  streamingEnabled: false,
});

const resp = createAiResponse({
  id: req.id,
  durationMs: 250,
  inputTokens: 45,
  outputTokens: 120,
  thinkingTokens: 0,
  model: 'claude-opus-4-20250805',
  provider: 'anthropic',
  stopReason: 'end_turn',
});
```

## Configuration

Config loads from environment variables (highest priority) → config file → defaults:

```bash
export NEW_RELIC_LICENSE_KEY="175cae4b..."        # 40-char ingest key
export NEW_RELIC_ACCOUNT_ID=12345                  # Account ID
export NEW_RELIC_REGION=us                         # us or eu
export NEW_RELIC_APP_NAME=my-app                   # Application name
export NEW_RELIC_DEVELOPER=alice                   # Developer identifier
export NEW_RELIC_AI_HARVEST_EVENTS_MS=5000         # Event flush interval
export NEW_RELIC_AI_HARVEST_METRICS_MS=60000       # Metric flush interval
export NEW_RELIC_AI_RECORD_CONTENT=false           # Include message content
export NEW_RELIC_AI_HIGH_SECURITY=false            # Never record content if true
```

Or via config file `~/.nr-ai-observe/config.json`:

```json
{
  "licenseKey": "175cae4b...",
  "accountId": 12345,
  "appName": "my-app",
  "developer": "alice",
  "harvestIntervalMs": 5000
}
```

## Testing

```bash
npm test -- packages/shared
```

Exemplary test files:
- `src/harvest/harvest-scheduler.test.ts` — batch flush, retry, concurrent stop
- `src/transport/http-client.test.ts` — HTTP mocking, gzip, error handling
- `src/pricing.ts` — token → USD calculation

## TypeScript

- ESM modules with `.js` extensions (NodeNext resolution)
- Strict mode enabled
- Zero runtime dependencies
- Types for all public APIs

## See Also

- [nr-ai-agent](../nr-ai-agent/) — SDK wrappers
- [nr-ai-mcp-server](../nr-ai-mcp-server/) — MCP server (uses shared)
- [ONBOARDING.md](../../docs/ONBOARDING.md) — Full setup guide
