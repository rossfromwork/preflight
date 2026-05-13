# Implementation Plan: OTel Spans in SDK Wrappers

**Roadmap item:** [19 — OTel Spans in SDK Wrappers](../../ROADMAP.md#19-otel-spans-in-sdk-wrappers)
**Effort estimate:** ~2 days
**Prerequisites:** Read `packages/nr-ai-agent/src/wrappers/anthropic.ts` and all other wrapper files before starting. Item 18 (OTLP Transport) must be complete first — this plan relies on the `OtlpTransport` and the OTel SDK dependencies it introduces.

---

## Goal

Make `nr-ai-agent` emit proper OpenTelemetry trace spans from its SDK wrappers, following the GenAI semantic conventions. Each LLM call — Anthropic, Gemini, OpenAI, Bedrock, Mistral, Cohere — becomes a span with standardized `gen_ai.*` attributes. This fills the gap in the OTel ecosystem where no official auto-instrumentation libraries exist for these SDKs. The project becomes usable as a first-class OTel instrumentation library for Node.js AI applications.

Span emission is independent of the existing `AiRequestRecord` + `HarvestScheduler` path — both run concurrently. Applications using the NR Events API path gain no breaking changes; applications already running an OTel setup gain distributed trace context for every LLM call.

---

## Background reading

Before starting, read these files end-to-end:

- `packages/nr-ai-agent/src/wrappers/anthropic.ts` — the pattern all wrappers follow
- `packages/nr-ai-agent/src/agent.ts` — how `NrAiAgent` is initialized; where the tracer will be set up
- `packages/nr-ai-agent/src/types.ts` — `WrapperConfig`, `AiRequestRecord`
- `packages/shared/src/transport/otlp-transport.ts` (from item 18) — provides `OtlpTransport.getTracer()`
- OTel GenAI span spec: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/

---

## Step 1 — Create `packages/nr-ai-agent/src/tracing.ts`

This module owns the tracer instance for all `nr-ai-agent` spans. It is initialized once by `NrAiAgent` during `init()` and exposed via a module-level getter so individual wrappers can reach it without circular imports.

```typescript
import { trace, type Tracer } from '@opentelemetry/api';
import { createLogger } from '@nr-ai-observatory/shared';

const logger = createLogger('agent-tracing');

const INSTRUMENTATION_SCOPE = 'nr-ai-agent';
const INSTRUMENTATION_VERSION = '1.0.0'; // keep in sync with package.json

let _tracer: Tracer | null = null;

/** Called once during NrAiAgent.init() when OTLP is configured. */
export function initTracer(): void {
  _tracer = trace.getTracer(INSTRUMENTATION_SCOPE, INSTRUMENTATION_VERSION);
  logger.debug('Agent tracer initialized');
}

/**
 * Returns the active tracer, or a no-op tracer if OTel has not been configured.
 * Individual wrappers call this — it is safe to call even when OTLP is disabled.
 */
export function getTracer(): Tracer {
  return _tracer ?? trace.getTracer(INSTRUMENTATION_SCOPE, INSTRUMENTATION_VERSION);
}
```

---

## Step 2 — Define `GenAiSpanAttributes` helper

Create `packages/nr-ai-agent/src/span-attributes.ts` with a helper that converts an `AiRequestRecord` (post-call) into a flat `Record<string, AttributeValue>` following the GenAI semantic conventions:

```typescript
import type { Attributes } from '@opentelemetry/api';
import type { AiRequestRecord } from './types.js';

const PROVIDER_TO_SYSTEM: Record<string, string> = {
  anthropic: 'anthropic',
  google: 'google_genai',
  openai: 'openai',
  bedrock: 'aws.bedrock',
  mistral: 'mistral_ai',
  cohere: 'cohere',
};

const METHOD_TO_OPERATION: Record<string, string> = {
  'messages.create': 'chat',
  'messages.stream': 'chat',
  'models.generateContent': 'generate_content',
  'models.generateContentStream': 'generate_content',
  'models.embedContent': 'embeddings',
  'chat.completions.create': 'chat',
  'converse': 'chat',
  'converse-stream': 'chat',
  'chat.complete': 'chat',
  'chat.stream': 'chat',
  'chat': 'chat',
  'chatStream': 'chat',
};

export function buildSpanName(record: AiRequestRecord): string {
  const operation = METHOD_TO_OPERATION[record.requestMethod] ?? 'chat';
  return `${operation} ${record.requestModel}`;
}

export function buildRequestAttributes(record: AiRequestRecord): Attributes {
  const attrs: Attributes = {
    'gen_ai.system': PROVIDER_TO_SYSTEM[record.provider] ?? record.provider,
    'gen_ai.request.model': record.requestModel,
    'gen_ai.request.stream': record.streaming,
  };

  const operation = METHOD_TO_OPERATION[record.requestMethod];
  if (operation) attrs['gen_ai.operation.name'] = operation;
  if (record.maxTokens !== null) attrs['gen_ai.request.max_tokens'] = record.maxTokens;
  if (record.temperature !== null) attrs['gen_ai.request.temperature'] = record.temperature;
  if (record.topP !== null) attrs['gen_ai.request.top_p'] = record.topP;

  return attrs;
}

export function buildResponseAttributes(record: AiRequestRecord): Attributes {
  const attrs: Attributes = {};

  if (record.model) attrs['gen_ai.response.model'] = record.model;
  if (record.stopReason) attrs['gen_ai.response.finish_reason'] = record.stopReason;

  attrs['gen_ai.usage.input_tokens'] = record.inputTokens;
  attrs['gen_ai.usage.output_tokens'] = record.outputTokens;

  if (record.thinkingTokens > 0) attrs['gen_ai.usage.reasoning.output_tokens'] = record.thinkingTokens;
  if (record.cacheReadTokens > 0) attrs['gen_ai.usage.cache_read.input_tokens'] = record.cacheReadTokens;
  if (record.cacheCreationTokens > 0) attrs['gen_ai.usage.cache_creation.input_tokens'] = record.cacheCreationTokens;

  return attrs;
}
```

---

## Step 3 — Add span creation to wrappers

The pattern is the same for all six wrappers. Using `anthropic.ts` as the template, show the full change for `wrapAnthropicClient`:

### 3a — Import the tracer and attribute builders

Add to the imports in each wrapper file:

```typescript
import { SpanStatusCode } from '@opentelemetry/api';
import { getTracer } from '../tracing.js';
import { buildSpanName, buildRequestAttributes, buildResponseAttributes } from '../span-attributes.js';
```

### 3b — Wrap the SDK call in a span

In the existing non-streaming wrapper, replace the direct promise call with a span-wrapped version. The span starts before the SDK call and ends in both the success and error callbacks:

```typescript
// Before (simplified):
const promise = original.call(this, params, options);
return promise.then(
  response => { /* build record, call onRecord */ return response; },
  err     => { /* build error record, call onRecord */ throw err; },
);

// After:
const tracer = getTracer();
// Build a partial base record for the span name before we have a response
const spanName = `chat ${params.model}`;
const span = tracer.startSpan(spanName, {
  attributes: buildRequestAttributes(base),
});

const promise = original.call(this, params, options);
return promise.then(
  response => {
    timer.stop();
    const record = finalizeRecord(base, response, timer.getMetrics(), config);
    onRecord(record);
    // Add response attributes to span
    span.setAttributes(buildResponseAttributes(record));
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    return response;
  },
  err => {
    const record = buildErrorRecord(base, err, timer, config);
    onRecord(record);
    span.recordException(err instanceof Error ? err : new Error(String(err)));
    span.setStatus({ code: SpanStatusCode.ERROR, message: record.error?.message ?? 'Unknown error' });
    span.end();
    throw err;
  },
);
```

### 3c — Streaming spans

For streaming wrappers, start the span before the stream begins and end it after the last chunk is processed (where `onRecord` is already called). Add response attributes from the completed record before calling `span.end()`.

### 3d — Apply the same pattern to all wrappers

Apply the identical span-creation pattern to:

- `packages/nr-ai-agent/src/wrappers/anthropic.ts`
- `packages/nr-ai-agent/src/wrappers/gemini.ts`
- `packages/nr-ai-agent/src/wrappers/openai.ts`
- `packages/nr-ai-agent/src/wrappers/bedrock.ts`
- `packages/nr-ai-agent/src/wrappers/mistral.ts`
- `packages/nr-ai-agent/src/wrappers/cohere.ts`

---

## Step 4 — Initialize tracer in `agent.ts`

In `NrAiAgent.init()`, after creating the `OtlpTransport` (when `config.transport !== 'nr-events-api'`), call `initTracer()` from `tracing.ts`. This registers the OTel SDK's global tracer provider, making `getTracer()` return an active tracer.

When `transport === 'nr-events-api'` (no OTel configured), `initTracer()` is NOT called — spans will use the OTel no-op tracer which is zero-cost.

---

## Step 5 — Write tests

Create `packages/nr-ai-agent/src/tracing.test.ts`:

```typescript
describe('initTracer', () => {
  it('initTracer() can be called multiple times without throwing', () => {
    expect(() => { initTracer(); initTracer(); }).not.toThrow();
  });
  it('getTracer() returns a Tracer object before initTracer()', () => {
    expect(getTracer()).toBeDefined();
  });
});
```

Create `packages/nr-ai-agent/src/span-attributes.test.ts`:

```typescript
describe('buildRequestAttributes', () => {
  it('maps anthropic provider to gen_ai.system = anthropic', () => {
    const record = makeRecord({ provider: 'anthropic', requestModel: 'claude-sonnet-4-6' });
    const attrs = buildRequestAttributes(record);
    expect(attrs['gen_ai.system']).toBe('anthropic');
    expect(attrs['gen_ai.request.model']).toBe('claude-sonnet-4-6');
  });

  it('maps google to google_genai', () => {
    const record = makeRecord({ provider: 'google' });
    expect(buildRequestAttributes(record)['gen_ai.system']).toBe('google_genai');
  });
});

describe('buildResponseAttributes', () => {
  it('emits token usage attributes', () => {
    const record = makeRecord({ inputTokens: 100, outputTokens: 50, thinkingTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
    const attrs = buildResponseAttributes(record);
    expect(attrs['gen_ai.usage.input_tokens']).toBe(100);
    expect(attrs['gen_ai.usage.output_tokens']).toBe(50);
    expect(attrs['gen_ai.usage.reasoning.output_tokens']).toBeUndefined();
  });

  it('emits reasoning tokens when > 0', () => {
    const record = makeRecord({ thinkingTokens: 200 });
    expect(buildResponseAttributes(record)['gen_ai.usage.reasoning.output_tokens']).toBe(200);
  });
});

describe('buildSpanName', () => {
  it('uses operation + model', () => {
    const record = makeRecord({ requestMethod: 'messages.create', requestModel: 'claude-opus-4-7' });
    expect(buildSpanName(record)).toBe('chat claude-opus-4-7');
  });
});
```

Update each existing wrapper test to assert span lifecycle using a mocked tracer:

```typescript
// In anthropic.test.ts (and all other wrapper tests):
const mockSpan = {
  setAttributes: jest.fn(),
  setStatus: jest.fn(),
  recordException: jest.fn(),
  end: jest.fn(),
};
const mockTracer = { startSpan: jest.fn(() => mockSpan) };
jest.mock('../tracing.js', () => ({ getTracer: () => mockTracer }));

it('starts and ends a span on success', async () => {
  // ... existing test setup ...
  expect(mockTracer.startSpan).toHaveBeenCalledTimes(1);
  expect(mockSpan.end).toHaveBeenCalledTimes(1);
  expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
});

it('records exception and ends span on error', async () => {
  // ... error test setup ...
  expect(mockSpan.recordException).toHaveBeenCalledTimes(1);
  expect(mockSpan.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: SpanStatusCode.ERROR }));
  expect(mockSpan.end).toHaveBeenCalledTimes(1);
});
```

---

## Acceptance criteria

- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] Every wrapper starts a span before the SDK call and ends it after (success and error paths)
- [ ] Span name follows the `"{operation} {model}"` pattern (e.g., `"chat claude-sonnet-4-6"`)
- [ ] Span has `gen_ai.system`, `gen_ai.request.model`, `gen_ai.operation.name` set at span start
- [ ] Span has `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reason` set on span end
- [ ] Error spans call `span.recordException()` and set `SpanStatusCode.ERROR`
- [ ] When `transport === 'nr-events-api'` (no OTel configured), `initTracer()` is not called and wrappers use the no-op tracer — no span data is exported
- [ ] Existing `AiRequestRecord` emission via `onRecord` is unaffected
- [ ] `npm run lint` passes

---

## File checklist

Files to **create**:

```
packages/nr-ai-agent/src/tracing.ts
packages/nr-ai-agent/src/tracing.test.ts
packages/nr-ai-agent/src/span-attributes.ts
packages/nr-ai-agent/src/span-attributes.test.ts
```

Files to **modify**:

```
packages/nr-ai-agent/src/agent.ts                     — call initTracer() when OTel configured
packages/nr-ai-agent/src/wrappers/anthropic.ts        — add span lifecycle
packages/nr-ai-agent/src/wrappers/anthropic.test.ts   — assert span lifecycle
packages/nr-ai-agent/src/wrappers/gemini.ts
packages/nr-ai-agent/src/wrappers/gemini.test.ts
packages/nr-ai-agent/src/wrappers/openai.ts
packages/nr-ai-agent/src/wrappers/openai.test.ts
packages/nr-ai-agent/src/wrappers/bedrock.ts
packages/nr-ai-agent/src/wrappers/bedrock.test.ts
packages/nr-ai-agent/src/wrappers/mistral.ts
packages/nr-ai-agent/src/wrappers/mistral.test.ts
packages/nr-ai-agent/src/wrappers/cohere.ts
packages/nr-ai-agent/src/wrappers/cohere.test.ts
```
