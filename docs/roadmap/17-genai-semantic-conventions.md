# Implementation Plan: GenAI Semantic Convention Mapping

**Roadmap item:** [17 — GenAI Semantic Convention Mapping](../../ROADMAP.md#17-genai-semantic-convention-mapping)
**Effort estimate:** ~0.5 day
**Prerequisites:** Read `packages/shared/src/events/serialize.ts` and `packages/shared/src/events/types.ts` before starting.

---

## Goal

Enrich the `AiRequest`, `AiResponse`, and `AiToolCall` NR events with the standardized `gen_ai.*` attributes defined by the OpenTelemetry GenAI semantic conventions. This is a non-breaking, additive change — existing custom attribute names remain untouched so no NRQL dashboards break. The new attributes make NR's out-of-the-box AI monitoring views work automatically and enable cross-platform queries using standardized field names.

---

## Background reading

Before starting, read these files end-to-end:

- `packages/shared/src/events/serialize.ts` — `aiRequestToNrEvent()` and `aiResponseToNrEvent()` are the two functions to extend
- `packages/shared/src/events/types.ts` — `AiRequest`, `AiResponse`, `AiProvider`, `NrEventData`
- `packages/shared/src/events/serialize.test.ts` (if present) — existing test structure to extend
- The OTel GenAI semantic conventions reference: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/

---

## Step 1 — Define the provider → `gen_ai.system` mapping

At the top of `packages/shared/src/events/serialize.ts`, add a mapping from the internal `AiProvider` union to the `gen_ai.system` string values defined by the OTel GenAI spec:

```typescript
const PROVIDER_TO_GENAI_SYSTEM: Record<string, string> = {
  anthropic: 'anthropic',
  google: 'google_genai',
  openai: 'openai',
  bedrock: 'aws.bedrock',
  mistral: 'mistral_ai',
  cohere: 'cohere',
};
```

---

## Step 2 — Define the `requestMethod` → `gen_ai.operation.name` mapping

The `gen_ai.operation.name` attribute uses a small controlled vocabulary (`chat`, `generate_content`, `text_completion`, `embeddings`). Map the existing internal `AiRequestMethod` values:

```typescript
const METHOD_TO_GENAI_OPERATION: Record<string, string> = {
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
```

---

## Step 3 — Extend `aiRequestToNrEvent()`

Inside `aiRequestToNrEvent()` in `serialize.ts`, after the existing field assignments, add the GenAI semantic convention attributes. Insert before the `return data` statement (or before the `customAttributes` loop):

```typescript
// GenAI semantic convention attributes (OTel spec, experimental)
const genAiSystem = PROVIDER_TO_GENAI_SYSTEM[event.provider] ?? event.provider;
data['gen_ai.system'] = genAiSystem;
data['gen_ai.request.model'] = event.model;

const genAiOperation = METHOD_TO_GENAI_OPERATION[event.requestMethod];
if (genAiOperation) data['gen_ai.operation.name'] = genAiOperation;

if (event.maxTokens !== null) data['gen_ai.request.max_tokens'] = event.maxTokens;
if (event.temperature !== null) data['gen_ai.request.temperature'] = event.temperature;
if (event.topP !== null) data['gen_ai.request.top_p'] = event.topP;
data['gen_ai.request.stream'] = event.streamingEnabled;
```

---

## Step 4 — Extend `aiResponseToNrEvent()`

Inside `aiResponseToNrEvent()`, add after existing assignments:

```typescript
// GenAI semantic convention attributes (OTel spec, experimental)
const genAiSystem = PROVIDER_TO_GENAI_SYSTEM[event.provider] ?? event.provider;
data['gen_ai.system'] = genAiSystem;
data['gen_ai.response.model'] = event.model;

data['gen_ai.usage.input_tokens'] = event.inputTokens;
data['gen_ai.usage.output_tokens'] = event.outputTokens;

if (event.thinkingTokens > 0) data['gen_ai.usage.reasoning.output_tokens'] = event.thinkingTokens;
if (event.cacheReadTokens > 0) data['gen_ai.usage.cache_read.input_tokens'] = event.cacheReadTokens;
if (event.cacheCreationTokens > 0) data['gen_ai.usage.cache_creation.input_tokens'] = event.cacheCreationTokens;

if (event.stopReason !== null) data['gen_ai.response.finish_reason'] = event.stopReason;
```

---

## Step 5 — Extend `toolCallToNrEvent()` (if applicable)

Check `packages/nr-ai-mcp-server/src/transport/nr-ingest.ts` or wherever `AiToolCall` events are serialized for NR. If a similar serializer exists for tool call events, add:

```typescript
// Only for tool calls where a model is available
if (record.model) data['gen_ai.request.model'] = record.model;
if (record.provider) data['gen_ai.system'] = PROVIDER_TO_GENAI_SYSTEM[record.provider] ?? record.provider;
```

If no separate serializer exists for tool calls, skip this step.

---

## Step 6 — Write tests

In `packages/shared/src/events/serialize.test.ts`, add a describe block:

```typescript
describe('GenAI semantic convention attributes', () => {
  describe('aiRequestToNrEvent', () => {
    it('emits gen_ai.system for known providers', () => {
      const event = makeAiRequest({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.system']).toBe('anthropic');
    });

    it('maps google provider to google_genai', () => {
      const event = makeAiRequest({ provider: 'google' });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.system']).toBe('google_genai');
    });

    it('emits gen_ai.request.model', () => {
      const event = makeAiRequest({ model: 'claude-opus-4-7' });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.request.model']).toBe('claude-opus-4-7');
    });

    it('maps messages.create to gen_ai.operation.name = chat', () => {
      const event = makeAiRequest({ requestMethod: 'messages.create' });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.operation.name']).toBe('chat');
    });

    it('maps models.embedContent to gen_ai.operation.name = embeddings', () => {
      const event = makeAiRequest({ requestMethod: 'models.embedContent' });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.operation.name']).toBe('embeddings');
    });

    it('emits gen_ai.request.max_tokens when set', () => {
      const event = makeAiRequest({ maxTokens: 1024 });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.request.max_tokens']).toBe(1024);
    });

    it('omits gen_ai.request.max_tokens when null', () => {
      const event = makeAiRequest({ maxTokens: null });
      const data = aiRequestToNrEvent(event);
      expect(data['gen_ai.request.max_tokens']).toBeUndefined();
    });

    it('emits gen_ai.request.stream', () => {
      const streaming = makeAiRequest({ streamingEnabled: true });
      const notStreaming = makeAiRequest({ streamingEnabled: false });
      expect(aiRequestToNrEvent(streaming)['gen_ai.request.stream']).toBe(true);
      expect(aiRequestToNrEvent(notStreaming)['gen_ai.request.stream']).toBe(false);
    });
  });

  describe('aiResponseToNrEvent', () => {
    it('emits gen_ai.usage.input_tokens and gen_ai.usage.output_tokens', () => {
      const event = makeAiResponse({ inputTokens: 100, outputTokens: 50 });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.usage.input_tokens']).toBe(100);
      expect(data['gen_ai.usage.output_tokens']).toBe(50);
    });

    it('emits gen_ai.usage.reasoning.output_tokens when thinkingTokens > 0', () => {
      const event = makeAiResponse({ thinkingTokens: 200 });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.usage.reasoning.output_tokens']).toBe(200);
    });

    it('omits gen_ai.usage.reasoning.output_tokens when thinkingTokens === 0', () => {
      const event = makeAiResponse({ thinkingTokens: 0 });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.usage.reasoning.output_tokens']).toBeUndefined();
    });

    it('emits gen_ai.usage.cache_read.input_tokens when cacheReadTokens > 0', () => {
      const event = makeAiResponse({ cacheReadTokens: 300 });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.usage.cache_read.input_tokens']).toBe(300);
    });

    it('emits gen_ai.response.finish_reason when stopReason is set', () => {
      const event = makeAiResponse({ stopReason: 'end_turn' });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.response.finish_reason']).toBe('end_turn');
    });

    it('emits gen_ai.response.model', () => {
      const event = makeAiResponse({ model: 'claude-sonnet-4-6' });
      const data = aiResponseToNrEvent(event);
      expect(data['gen_ai.response.model']).toBe('claude-sonnet-4-6');
    });
  });
});
```

Use whatever `makeAiRequest` / `makeAiResponse` factory helpers exist in that test file (or create them following the factory helper pattern).

---

## Acceptance criteria

- [ ] `npm run build` passes
- [ ] `npm test` passes — all new and existing tests green
- [ ] `aiRequestToNrEvent()` emits `gen_ai.system`, `gen_ai.request.model`, `gen_ai.operation.name`, `gen_ai.request.max_tokens`, `gen_ai.request.temperature`, `gen_ai.request.top_p`, `gen_ai.request.stream`
- [ ] `aiResponseToNrEvent()` emits `gen_ai.system`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.reasoning.output_tokens` (when > 0), `gen_ai.usage.cache_read.input_tokens` (when > 0), `gen_ai.usage.cache_creation.input_tokens` (when > 0), `gen_ai.response.finish_reason` (when set)
- [ ] All existing `AiRequest` / `AiResponse` fields remain unchanged in the serialized output (backward compatible)
- [ ] `npm run lint` passes with 0 errors and 0 warnings

---

## File checklist

Files to **modify**:

```
packages/shared/src/events/serialize.ts       — add gen_ai.* attributes to both serializers
packages/shared/src/events/serialize.test.ts  — add GenAI attribute test cases
```

Files to **create**: none.
