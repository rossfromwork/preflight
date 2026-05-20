# nr-ai-agent

SDK wrappers for AI model clients. Automatically instruments API calls from Anthropic, Google Gemini, OpenAI, AWS Bedrock, Mistral, and Cohere — measuring latency, token usage, cost, and errors. All telemetry flows to New Relic.

## Supported Providers

| Provider | Wrapper | Models | Streaming | Reasoning Tokens |
|----------|---------|--------|-----------|------------------|
| **Anthropic** | `wrapAnthropicClient()` | Claude Opus/Sonnet/Haiku | ✅ | ✅ |
| **Google** | `wrapGeminiClient()` | Gemini 1.5/2.0 | ✅ | ✅ |
| **OpenAI** | `wrapOpenAiClient()` | GPT-4o, o1, o3 | ✅ | ✅ |
| **AWS Bedrock** | `wrapBedrockClient()` | Claude, Titan, Llama | ✅ | ✅ |
| **Mistral** | `wrapMistralClient()` | Mistral Large, 7B | ✅ | — |
| **Cohere** | `wrapCohereClient()` | Command R, R+ | ✅ | — |

## Installation

```bash
npm install nr-ai-agent
```

### Optional Dependencies

Choose SDK(s) you want to wrap:

```bash
npm install --save-optional @anthropic-ai/sdk @google/genai openai @aws-sdk/client-bedrock-runtime @mistralai/mistralai cohere-ai
```

## Quick Start

### Anthropic

```typescript
import { init } from 'nr-ai-agent';
import Anthropic from '@anthropic-ai/sdk';

const agent = init({
  licenseKey: process.env.NEW_RELIC_LICENSE_KEY,
  accountId: 12345,
});

const client = new Anthropic();
const wrappedClient = agent.wrapAnthropicClient(client);

// Use normally — events sent automatically
const response = await wrappedClient.messages.create({
  model: 'claude-opus-4-20250805',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello!' }],
});

console.log(response.content[0].type === 'text' && response.content[0].text);
await agent.shutdown();
```

### Google Gemini

```typescript
import { init } from 'nr-ai-agent';
import { GoogleGenAI } from '@google/genai';

const agent = init({
  licenseKey: process.env.NEW_RELIC_LICENSE_KEY,
  accountId: '12345',
});

const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
const wrappedClient = agent.wrapGeminiClient(client);

const response = await wrappedClient.models.generateContent({
  model: 'gemini-2.0-flash',
  contents: 'Hello!',
});
console.log(response.text);

await agent.shutdown();
```

### OpenAI

```typescript
import { init } from 'nr-ai-agent';
import OpenAI from 'openai';

const agent = init({
  licenseKey: process.env.NEW_RELIC_LICENSE_KEY,
  accountId: 12345,
});

const client = new OpenAI();
const wrappedClient = agent.wrapOpenAiClient(client);

const response = await wrappedClient.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }],
});

console.log(response.choices[0].message.content);
await agent.shutdown();
```

### AWS Bedrock

The wrapper intercepts `ConverseCommand` and `ConverseStreamCommand` (the unified Bedrock Converse API). Other commands (e.g. `InvokeModelCommand`) pass through unmodified without instrumentation.

```typescript
import { init } from 'nr-ai-agent';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const agent = init({
  licenseKey: process.env.NEW_RELIC_LICENSE_KEY,
  accountId: 12345,
});

const client = new BedrockRuntimeClient({ region: 'us-west-2' });
const wrappedClient = agent.wrapBedrockClient(client);

const response = await wrappedClient.send(new ConverseCommand({
  modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  messages: [{ role: 'user', content: [{ text: 'Hello!' }] }],
}));

console.log(response.output?.message?.content?.[0].text);
await agent.shutdown();
```

### Streaming

All wrappers support streaming (`stream()` / `streamMessage()` / `stream` parameter):

```typescript
const stream = await wrappedClient.messages.stream({
  model: 'claude-opus-4-20250805',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Count to 10' }],
});

for await (const event of stream) {
  if (event.type === 'content_block_delta') {
    process.stdout.write(event.delta.text);
  }
}
```

## Configuration

```typescript
const agent = init({
  licenseKey: process.env.NEW_RELIC_LICENSE_KEY,  // Required
  accountId: 12345,                                 // Required
  appName: 'my-app',                                // Optional
  recordContent: false,                             // Optional: record message content (default: false)
  highSecurity: false,                              // Optional: force recordContent=false (default: false)
});
```

Or via environment variables:
- `NEW_RELIC_LICENSE_KEY` — 40-char ingest key
- `NEW_RELIC_ACCOUNT_ID` — numeric account ID
- `NEW_RELIC_APP_NAME` — app identifier
- `NEW_RELIC_AI_RECORD_CONTENT` — include message text in telemetry
- `NEW_RELIC_AI_HIGH_SECURITY` — force content recording off

## Events Sent

Every wrapped call produces:
- **AiRequest** — API call initiated (model, parameters, token estimates)
- **AiResponse** — response received (latency, actual tokens, cost in USD)
- **AiMessage** (optional) — message content if `recordContent: true`

See [METRICS_TABLE.md](../../docs/METRICS_TABLE.md) for complete event schema.

## Intelligence & Prediction

Phase 4 features are available on the `NrAiAgent` instance and activate automatically once sufficient data has been collected.

### Semantic Drift Detection

Monitors response embeddings for distributional shift. Requires a `getEmbedding` function.

```typescript
agent.initSemanticDrift({
  feature: 'my-feature',
  getEmbedding: async (text) => myEmbedModel.embed(text),
  similarityThreshold: 0.85,   // flag responses below this cosine similarity
  sampleRate: 0.1,              // sample 10% of responses
});
```

Emits `ai.drift.score`, `ai.drift.centroid_distance`, and `ai.drift.detected` metrics per request.

### Anomaly Detection

Z-score based detection across structural, application, and semantic signals. Records are fed automatically from wrapped SDK calls; anomaly scores flow to `ai.quality.anomaly_score`.

```typescript
const report = agent.getAnomalyReport();
// { compositeScore, signals, anomalousSignals, timestamp }
```

### A/B Experiment Tracking

Define experiments and tag requests to compare model variants:

```typescript
agent.defineExperiment({
  name: 'prompt-v2',
  variants: ['control', 'treatment'],
  metrics: ['latency_ms', 'cost_usd'],
  minSamplesPerVariant: 30,
});

// In request context:
agent.tagRequest('prompt-v2', 'treatment');

// Record additional metric observations:
agent.recordMetricValue('prompt-v2', 'treatment', 'user_rating', 4.5);

// Read results:
const results = agent.getExperimentResults('prompt-v2');
```

Experiment summaries (`AiExperimentSummary`) are emitted every 6 hours. Conclusions (`AiExperimentConclusion`) are emitted once when a statistically significant winner is declared.

### Cost Forecasting

Automatically projects 30-day cost trends using linear regression. Configure alert callbacks:

```typescript
agent.configureCostForecasting({
  onGrowthAlert: ({ growthRatePercent }) => console.warn('Cost growing:', growthRatePercent),
  onBudgetAlert: ({ projectedMonthlyCostUsd, monthlyBudgetUsd }) =>
    console.warn('Over budget:', projectedMonthlyCostUsd, '/', monthlyBudgetUsd),
  growthThresholdPercent: 20,
  monthlyBudgetUsd: 100,
});
```

Emits `AiCostGrowthAlert` and `AiCostForecastAlert` events.

### Recommendation Engine

Analyzes cache usage, model selection, and context pressure to generate recommendations. `AiRecommendation` events are emitted every 5 minutes when enough data has been collected (≥20 requests per feature).

### Automatic OTel Span Emission

When `otlpEndpoint` is configured, every SDK wrapper call automatically emits an OpenTelemetry span following the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/). No code changes are required — spans are emitted alongside the existing `AiRequest`/`AiResponse` events.

```typescript
const agent = init({
  licenseKey: process.env.NEW_RELIC_LICENSE_KEY,
  accountId: 12345,
  otlpEndpoint: 'https://otlp.nr-data.net',
  otlpHeaders: { 'api-key': process.env.NEW_RELIC_LICENSE_KEY },
  transport: 'both',  // 'nr-events-api' | 'otlp' | 'both'
});
```

Each LLM call produces a span named `"{operation} {model}"` (e.g. `"chat claude-opus-4-7"`) with attributes:

| Attribute | Set at | Example |
|-----------|--------|---------|
| `gen_ai.system` | Span start | `anthropic` |
| `gen_ai.request.model` | Span start | `claude-opus-4-7` |
| `gen_ai.operation.name` | Span start | `chat` |
| `gen_ai.request.max_tokens` | Span start | `1024` |
| `gen_ai.usage.input_tokens` | Span end | `45` |
| `gen_ai.usage.output_tokens` | Span end | `120` |
| `gen_ai.response.finish_reason` | Span end | `end_turn` |

When `transport === 'nr-events-api'` (the default), OTLP is not configured and the OTel no-op tracer is used — zero overhead, no span data exported.

### OpenTelemetry Export (opt-in, manual)

For manual span and metric export to any OTLP-compatible backend:

```typescript
const otel = agent.getOTelExporter();
otel.setEndpoint('http://localhost:4318');
otel.setHeaders({ Authorization: 'Bearer my-token' });
await otel.exportSpans(spans);
await otel.exportMetrics(metrics);
```

### Custom Instrumentation

Record arbitrary events, metrics, and spans alongside the automatic telemetry:

```typescript
const metrics = agent.getCustomMetrics();

metrics.recordCustomEvent('MyEvent', { key: 'value' });
metrics.recordCustomMetric('my.counter', 42, { env: 'prod' });

const span = metrics.startCustomSpan('my-operation');
// ... do work ...
span.end();
```

## Testing

```bash
npm test -- packages/nr-ai-agent
```

## TypeScript

- ESM modules with `.js` extensions
- Strict mode enabled
- Peer dependencies on SDK packages (optional)
- Types for all public APIs

## Pricing Data

Token rates are automatically loaded for all providers and models. To use custom rates:

```bash
export NEW_RELIC_AI_CUSTOM_PRICING_FILE=/path/to/pricing.json
```

See [PRICING.md](./PRICING.md) for the schema.

## See Also

- [nr-ai-mcp-server](../nr-ai-mcp-server/) — MCP server for Claude Code integration
- [@nr-ai-observatory/shared](../shared/) — Event transport and utilities
- [ONBOARDING.md](../../docs/ONBOARDING.md) — Full setup guide
