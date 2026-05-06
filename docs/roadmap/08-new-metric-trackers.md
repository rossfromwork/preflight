# Implementation Plan: New Metric Trackers

**Roadmap item:** [06 — New Metric Trackers](../../ROADMAP.md#6-new-metric-trackers)
**Effort estimate:** ~2 days (all four trackers)
**Prerequisites:** Read the existing tracker implementations before starting.

---

## Background reading

Read these files end-to-end before starting:

- `packages/nr-ai-mcp-server/src/metrics/efficiency-score.ts` — the most structurally complete tracker; use as the template
- `packages/nr-ai-mcp-server/src/metrics/cost-tracker.ts` — shows how a tracker maintains running state
- `packages/nr-ai-mcp-server/src/metrics/task-detector.ts` — `AiCodingTask` type; used by TaskCompletionTracker
- `packages/nr-ai-mcp-server/src/storage/types.ts` — `ToolCallRecord` type
- `packages/nr-ai-mcp-server/src/tools/session-stats.ts` — `registerTools()` and `ToolRegistrationOptions`; all new tools register here
- `packages/nr-ai-mcp-server/src/transport/nr-ingest.ts` — how to emit new event/metric types

---

## Goal

Four new tracker classes, each following the `recordToolCall → getMetrics → reset` pattern:

1. **ContextWindowTracker** — measures repeated-read ratio as a proxy for context waste
2. **LatencyTracker** — p50/p95/p99 per tool type and per session
3. **TaskCompletionTracker** — task lifecycle ratios (completed vs. in-progress)
4. **ModelUsageTracker** — which model per request, cost-efficiency per model

---

## ✅ Tracker 1: ContextWindowTracker

### File: `packages/nr-ai-mcp-server/src/metrics/context-window-tracker.ts`

This tracker counts how often the same file path is read more than once in a session. A high repeated-read ratio suggests the model is losing context and re-reading rather than retaining information.

#### Interfaces

```typescript
export interface ContextWindowMetrics {
  readonly uniqueFilesRead: number;
  readonly totalReadOperations: number;
  readonly repeatedReadCount: number;
  readonly repeatedReadRatio: number | null; // repeatedReadCount / totalReadOperations
  readonly topRepeatedFiles: ReadonlyArray<{ file: string; readCount: number }>;
  readonly estimatedWasteRatio: number | null; // fraction of reads that were redundant
}
```

#### Class

```typescript
export class ContextWindowTracker {
  private fileReadCounts = new Map<string, number>();

  recordToolCall(record: ToolCallRecord): void {
    // Only track Read operations that have a filePath
    if (record.toolName !== 'Read' || !record.filePath) return;
    const count = this.fileReadCounts.get(record.filePath as string) ?? 0;
    this.fileReadCounts.set(record.filePath as string, count + 1);
  }

  getMetrics(): ContextWindowMetrics {
    const entries = [...this.fileReadCounts.entries()];
    const totalReadOperations = entries.reduce((sum, [, c]) => sum + c, 0);
    const uniqueFilesRead = entries.length;
    const repeatedReadCount = entries.reduce(
      (sum, [, c]) => sum + Math.max(0, c - 1),
      0,
    );
    const repeatedReadRatio =
      totalReadOperations > 0 ? repeatedReadCount / totalReadOperations : null;

    const topRepeatedFiles = entries
      .filter(([, c]) => c > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([file, readCount]) => ({ file, readCount }));

    const estimatedWasteRatio = repeatedReadRatio;

    return {
      uniqueFilesRead,
      totalReadOperations,
      repeatedReadCount,
      repeatedReadRatio,
      topRepeatedFiles,
      estimatedWasteRatio,
    };
  }

  reset(_sessionId: string): void {
    this.fileReadCounts.clear();
  }
}
```

#### MCP tool

Tool name: `nr_observe_get_context_efficiency`

Description: `"Get context window efficiency metrics: unique vs. repeated file reads, repeated-read ratio, and top re-read files. A high ratio suggests the model is losing context."`

Handler (goes in `analytics-tools.ts`):

```typescript
export function handleGetContextEfficiency(
  tracker: ContextWindowTracker,
): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(tracker.getMetrics(), null, 2) }] };
}
```

#### Tests (`context-window-tracker.test.ts`)

```typescript
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ContextWindowTracker } from './context-window-tracker.js';
import type { ToolCallRecord } from '../storage/types.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('ContextWindowTracker', () => {
  function makeRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
    return {
      id: 'r1',
      sessionId: 's1',
      toolUseId: 'u1',
      toolName: 'Read',
      timestamp: Date.now(),
      durationMs: 10,
      success: true,
      filePath: '/src/app.ts',
      ...overrides,
    } as ToolCallRecord;
  }

  it('returns zeros for empty session', () => {
    const t = new ContextWindowTracker();
    const m = t.getMetrics();
    expect(m.totalReadOperations).toBe(0);
    expect(m.repeatedReadRatio).toBeNull();
  });

  it('counts unique reads with no repeats', () => {
    const t = new ContextWindowTracker();
    t.recordToolCall(makeRecord({ filePath: '/a.ts' }));
    t.recordToolCall(makeRecord({ filePath: '/b.ts' }));
    expect(t.getMetrics().uniqueFilesRead).toBe(2);
    expect(t.getMetrics().repeatedReadCount).toBe(0);
  });

  it('counts repeated reads', () => {
    const t = new ContextWindowTracker();
    t.recordToolCall(makeRecord({ filePath: '/a.ts' }));
    t.recordToolCall(makeRecord({ filePath: '/a.ts' }));
    t.recordToolCall(makeRecord({ filePath: '/a.ts' }));
    expect(t.getMetrics().repeatedReadCount).toBe(2);
  });

  it('ignores non-Read tool calls', () => {
    const t = new ContextWindowTracker();
    t.recordToolCall(makeRecord({ toolName: 'Bash', filePath: undefined }));
    expect(t.getMetrics().totalReadOperations).toBe(0);
  });

  it('ignores Read calls without filePath', () => {
    const t = new ContextWindowTracker();
    t.recordToolCall(makeRecord({ toolName: 'Read', filePath: undefined }));
    expect(t.getMetrics().totalReadOperations).toBe(0);
  });

  it('reset clears all state', () => {
    const t = new ContextWindowTracker();
    t.recordToolCall(makeRecord());
    t.reset('new-session');
    expect(t.getMetrics().totalReadOperations).toBe(0);
  });

  it('topRepeatedFiles returns up to 5 entries sorted by count', () => {
    const t = new ContextWindowTracker();
    for (let i = 0; i < 6; i++) {
      t.recordToolCall(makeRecord({ filePath: `/file-${i}.ts` }));
      t.recordToolCall(makeRecord({ filePath: `/file-${i}.ts` }));
    }
    expect(t.getMetrics().topRepeatedFiles).toHaveLength(5);
  });
});
```

---

## ✅ Tracker 2: LatencyTracker

### File: `packages/nr-ai-mcp-server/src/metrics/latency-tracker.ts`

Accumulates `durationMs` values per tool name and computes p50/p95/p99 percentiles on demand.

#### Interfaces

```typescript
export interface LatencyPercentiles {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
  readonly count: number;
}

export interface LatencyMetrics {
  readonly overall: LatencyPercentiles | null;
  readonly byTool: Readonly<Record<string, LatencyPercentiles>>;
  readonly slowestCalls: ReadonlyArray<{
    toolName: string;
    durationMs: number;
    timestamp: number;
    filePath?: string;
  }>;
}
```

#### Class

```typescript
const MAX_SAMPLES_PER_TOOL = 500;
const MAX_SLOWEST = 10;

export class LatencyTracker {
  private allDurations: number[] = [];
  private byTool = new Map<string, number[]>();
  private slowestCalls: Array<{
    toolName: string;
    durationMs: number;
    timestamp: number;
    filePath?: string;
  }> = [];

  recordToolCall(record: ToolCallRecord): void {
    if (record.durationMs === null || record.durationMs === undefined) return;
    const d = record.durationMs;

    // Overall
    this.allDurations.push(d);

    // Per tool
    const key = record.toolName ?? 'Unknown';
    let arr = this.byTool.get(key);
    if (!arr) {
      arr = [];
      this.byTool.set(key, arr);
    }
    if (arr.length < MAX_SAMPLES_PER_TOOL) arr.push(d);

    // Slowest calls
    this.slowestCalls.push({
      toolName: key,
      durationMs: d,
      timestamp: record.timestamp ?? Date.now(),
      ...(record.filePath && { filePath: record.filePath as string }),
    });
    this.slowestCalls.sort((a, b) => b.durationMs - a.durationMs);
    if (this.slowestCalls.length > MAX_SLOWEST) {
      this.slowestCalls.length = MAX_SLOWEST;
    }
  }

  private computePercentiles(sorted: number[]): LatencyPercentiles {
    const count = sorted.length;
    return {
      p50: sorted[Math.floor(count * 0.5)] ?? 0,
      p95: sorted[Math.floor(count * 0.95)] ?? 0,
      p99: sorted[Math.floor(count * 0.99)] ?? 0,
      min: sorted[0] ?? 0,
      max: sorted[count - 1] ?? 0,
      count,
    };
  }

  getMetrics(): LatencyMetrics {
    const sortedAll = [...this.allDurations].sort((a, b) => a - b);
    const overall = sortedAll.length > 0 ? this.computePercentiles(sortedAll) : null;

    const byTool: Record<string, LatencyPercentiles> = {};
    for (const [tool, durations] of this.byTool) {
      const sorted = [...durations].sort((a, b) => a - b);
      byTool[tool] = this.computePercentiles(sorted);
    }

    return {
      overall,
      byTool,
      slowestCalls: [...this.slowestCalls],
    };
  }

  reset(_sessionId: string): void {
    this.allDurations = [];
    this.byTool.clear();
    this.slowestCalls = [];
  }
}
```

#### MCP tool

Tool name: `nr_observe_get_latency_percentiles`

Description: `"Get p50/p95/p99 latency percentiles for tool calls, broken down by tool type. Use to identify which tools are slowest in the current session."`

Handler (goes in `analytics-tools.ts`):

```typescript
export function handleGetLatencyPercentiles(
  tracker: LatencyTracker,
): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(tracker.getMetrics(), null, 2) }] };
}
```

#### Tests (`latency-tracker.test.ts`)

```typescript
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { LatencyTracker } from './latency-tracker.js';
import type { ToolCallRecord } from '../storage/types.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('LatencyTracker', () => {
  function makeRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
    return {
      id: 'r1',
      sessionId: 's1',
      toolUseId: 'u1',
      toolName: 'Read',
      timestamp: 1000,
      durationMs: 100,
      success: true,
      ...overrides,
    } as ToolCallRecord;
  }

  it('returns null overall for empty tracker', () => {
    const t = new LatencyTracker();
    expect(t.getMetrics().overall).toBeNull();
  });

  it('single call sets p50/p95/p99 to that duration', () => {
    const t = new LatencyTracker();
    t.recordToolCall(makeRecord({ durationMs: 200 }));
    const m = t.getMetrics();
    expect(m.overall?.p50).toBe(200);
    expect(m.overall?.p95).toBe(200);
    expect(m.overall?.p99).toBe(200);
    expect(m.overall?.count).toBe(1);
    expect(m.overall?.min).toBe(200);
    expect(m.overall?.max).toBe(200);
  });

  it('ignores calls with null durationMs', () => {
    const t = new LatencyTracker();
    t.recordToolCall(makeRecord({ durationMs: null as unknown as number }));
    expect(t.getMetrics().overall).toBeNull();
  });

  it('ignores calls with undefined durationMs', () => {
    const t = new LatencyTracker();
    t.recordToolCall(makeRecord({ durationMs: undefined as unknown as number }));
    expect(t.getMetrics().overall).toBeNull();
  });

  it('multiple calls produce correct p50', () => {
    const t = new LatencyTracker();
    // sorted: [100, 200, 300, 400, 500] → p50 = index floor(5 * 0.5) = 2 → 300
    for (const d of [300, 100, 500, 200, 400]) {
      t.recordToolCall(makeRecord({ durationMs: d }));
    }
    const m = t.getMetrics();
    expect(m.overall?.p50).toBe(300);
    expect(m.overall?.min).toBe(100);
    expect(m.overall?.max).toBe(500);
    expect(m.overall?.count).toBe(5);
  });

  it('byTool breakdown uses tool-specific samples', () => {
    const t = new LatencyTracker();
    t.recordToolCall(makeRecord({ toolName: 'Read', durationMs: 50 }));
    t.recordToolCall(makeRecord({ toolName: 'Bash', durationMs: 500 }));
    const m = t.getMetrics();
    expect(m.byTool['Read']?.p50).toBe(50);
    expect(m.byTool['Bash']?.p50).toBe(500);
    expect(m.byTool['Read']?.count).toBe(1);
  });

  it('slowestCalls is sorted descending by duration', () => {
    const t = new LatencyTracker();
    t.recordToolCall(makeRecord({ durationMs: 100 }));
    t.recordToolCall(makeRecord({ durationMs: 500 }));
    t.recordToolCall(makeRecord({ durationMs: 250 }));
    const { slowestCalls } = t.getMetrics();
    expect(slowestCalls[0].durationMs).toBe(500);
    expect(slowestCalls[1].durationMs).toBe(250);
    expect(slowestCalls[2].durationMs).toBe(100);
  });

  it('slowestCalls is capped at 10 entries', () => {
    const t = new LatencyTracker();
    for (let i = 1; i <= 15; i++) {
      t.recordToolCall(makeRecord({ durationMs: i * 10 }));
    }
    const { slowestCalls } = t.getMetrics();
    expect(slowestCalls).toHaveLength(10);
    expect(slowestCalls[0].durationMs).toBe(150);
    expect(slowestCalls[9].durationMs).toBe(60);
  });

  it('slowestCalls includes filePath when present', () => {
    const t = new LatencyTracker();
    t.recordToolCall(makeRecord({ durationMs: 200, filePath: '/src/app.ts' }));
    expect(t.getMetrics().slowestCalls[0].filePath).toBe('/src/app.ts');
  });

  it('reset clears all state', () => {
    const t = new LatencyTracker();
    t.recordToolCall(makeRecord({ durationMs: 100 }));
    t.reset('new-session');
    expect(t.getMetrics().overall).toBeNull();
    expect(Object.keys(t.getMetrics().byTool)).toHaveLength(0);
    expect(t.getMetrics().slowestCalls).toHaveLength(0);
  });
});
```

---

## ✅ Tracker 3: TaskCompletionTracker

### File: `packages/nr-ai-mcp-server/src/metrics/task-completion-tracker.ts`

Tracks the lifecycle of tasks detected by `TaskDetector`. Receives completed `AiCodingTask` objects from `drainNewlyCompletedTasks()`.

**Important:** `AiCodingTask` has no `status` field. Tasks passed to `recordTask()` are always completed tasks — they come from `taskDetector.drainNewlyCompletedTasks()`. The `inProgressTasks` count is derived from `TaskDetector.getMetrics().currentTaskActive` in the tool handler, not stored in this tracker.

#### Interfaces

```typescript
export interface TaskCompletionMetrics {
  readonly completedTasks: number;
  readonly avgTaskDurationMs: number | null;
  readonly avgToolCallsPerTask: number | null;
}
```

#### Class

```typescript
export class TaskCompletionTracker {
  private completed: AiCodingTask[] = [];

  recordTask(task: AiCodingTask): void {
    this.completed.push(task);
  }

  getMetrics(): TaskCompletionMetrics {
    const completedCount = this.completed.length;

    const completedDurations = this.completed
      .map(t => t.durationMs)
      .filter((d): d is number => d !== null && d !== undefined);
    const avgTaskDurationMs =
      completedDurations.length > 0
        ? completedDurations.reduce((s, d) => s + d, 0) / completedDurations.length
        : null;

    const avgToolCallsPerTask =
      completedCount > 0
        ? this.completed.reduce((s, t) => s + t.toolCallCount, 0) / completedCount
        : null;

    return {
      completedTasks: completedCount,
      avgTaskDurationMs,
      avgToolCallsPerTask,
    };
  }

  reset(_sessionId: string): void {
    this.completed = [];
  }
}
```

#### MCP tool

Tool name: `nr_observe_get_task_completion_rate`

Description: `"Get task lifecycle metrics: completion rate, average task duration, and average tool calls per task. Distinguishes completed tasks from in-progress/abandoned."`

Handler (goes in `analytics-tools.ts`). It accepts an optional `taskDetector` to compute `inProgressTasks` and `completionRate` at query time:

```typescript
export function handleGetTaskCompletionRate(
  tracker: TaskCompletionTracker,
  taskDetector?: TaskDetector,
): { content: Array<{ type: 'text'; text: string }> } {
  const metrics = tracker.getMetrics();
  const inProgressTasks = taskDetector?.getMetrics().currentTaskActive ? 1 : 0;
  const totalTasksDetected = metrics.completedTasks + inProgressTasks;
  const completionRate = totalTasksDetected > 0 ? metrics.completedTasks / totalTasksDetected : null;
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(
        { ...metrics, inProgressTasks, totalTasksDetected, completionRate },
        null,
        2,
      ),
    }],
  };
}
```

#### Tests (`task-completion-tracker.test.ts`)

```typescript
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { TaskCompletionTracker } from './task-completion-tracker.js';
import type { AiCodingTask } from './task-detector.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

function makeTask(overrides?: Partial<AiCodingTask>): AiCodingTask {
  return {
    taskId: 'task-001',
    startTime: 1000,
    endTime: 61000,
    durationMs: 60000,
    toolCallCount: 10,
    toolCallsByType: {},
    filesRead: [],
    filesModified: [],
    linesChanged: 50,
    linesAdded: 50,
    linesRemoved: 0,
    bashCommandsRun: 2,
    testsRun: 4,
    testsPassed: 4,
    buildRun: 1,
    buildPassed: 1,
    estimatedCostUsd: 0.50,
    tokensUsed: 5000,
    askedUserQuestions: 0,
    subAgentsSpawned: 0,
    toolCalls: [],
    ...overrides,
  };
}

describe('TaskCompletionTracker', () => {
  it('returns zero completedTasks and null avgs for empty tracker', () => {
    const t = new TaskCompletionTracker();
    const m = t.getMetrics();
    expect(m.completedTasks).toBe(0);
    expect(m.avgTaskDurationMs).toBeNull();
    expect(m.avgToolCallsPerTask).toBeNull();
  });

  it('counts completed tasks correctly', () => {
    const t = new TaskCompletionTracker();
    t.recordTask(makeTask());
    t.recordTask(makeTask({ taskId: 'task-002' }));
    expect(t.getMetrics().completedTasks).toBe(2);
  });

  it('avgTaskDurationMs is the mean of completed task durations', () => {
    const t = new TaskCompletionTracker();
    t.recordTask(makeTask({ durationMs: 10000 }));
    t.recordTask(makeTask({ durationMs: 20000 }));
    expect(t.getMetrics().avgTaskDurationMs).toBe(15000);
  });

  it('avgToolCallsPerTask uses toolCallCount', () => {
    const t = new TaskCompletionTracker();
    t.recordTask(makeTask({ toolCallCount: 4 }));
    t.recordTask(makeTask({ toolCallCount: 6 }));
    expect(t.getMetrics().avgToolCallsPerTask).toBe(5);
  });

  it('reset clears all state', () => {
    const t = new TaskCompletionTracker();
    t.recordTask(makeTask());
    t.reset('new-session');
    const m = t.getMetrics();
    expect(m.completedTasks).toBe(0);
    expect(m.avgTaskDurationMs).toBeNull();
    expect(m.avgToolCallsPerTask).toBeNull();
  });
});
```

---

## ✅ Tracker 4: ModelUsageTracker

### File: `packages/nr-ai-mcp-server/src/metrics/model-usage-tracker.ts`

Tracks which model is used per request (from `nr_observe_report_tokens` calls) and computes cost-per-output-token as an efficiency ratio.

**Note:** `CostTracker` already tracks `costByModel`. `ModelUsageTracker` adds request count, token distribution, and efficiency ratios per model. Its `recordUsage()` is called from `handleReportTokens()` in `cost-tools.ts`.

#### Interfaces

```typescript
export interface ModelStats {
  readonly requestCount: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCostUsd: number;
  readonly costPerOutputToken: number | null;
  readonly avgOutputTokensPerRequest: number | null;
}

export interface ModelUsageMetrics {
  readonly byModel: Readonly<Record<string, ModelStats>>;
  readonly mostUsedModel: string | null;
  readonly mostEfficientModel: string | null; // lowest costPerOutputToken
  readonly totalModelsUsed: number;
}
```

#### Class

```typescript
interface MutableModelStats {
  requestCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

export class ModelUsageTracker {
  private byModel = new Map<string, MutableModelStats>();

  recordUsage(
    model: string,
    inputTokens: number,
    outputTokens: number,
    costUsd: number,
  ): void {
    let stats = this.byModel.get(model);
    if (!stats) {
      stats = { requestCount: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 };
      this.byModel.set(model, stats);
    }
    stats.requestCount++;
    stats.totalInputTokens += inputTokens;
    stats.totalOutputTokens += outputTokens;
    stats.totalCostUsd += costUsd;
  }

  getMetrics(): ModelUsageMetrics {
    const byModel: Record<string, ModelStats> = {};
    let mostUsedModel: string | null = null;
    let maxRequests = 0;
    let mostEfficientModel: string | null = null;
    let lowestCostPerOutputToken = Infinity;

    for (const [model, stats] of this.byModel) {
      const costPerOutputToken =
        stats.totalOutputTokens > 0
          ? stats.totalCostUsd / stats.totalOutputTokens
          : null;
      const avgOutputTokensPerRequest =
        stats.requestCount > 0
          ? stats.totalOutputTokens / stats.requestCount
          : null;

      byModel[model] = {
        requestCount: stats.requestCount,
        totalInputTokens: stats.totalInputTokens,
        totalOutputTokens: stats.totalOutputTokens,
        totalCostUsd: stats.totalCostUsd,
        costPerOutputToken,
        avgOutputTokensPerRequest,
      };

      if (stats.requestCount > maxRequests) {
        maxRequests = stats.requestCount;
        mostUsedModel = model;
      }

      if (costPerOutputToken !== null && costPerOutputToken < lowestCostPerOutputToken) {
        lowestCostPerOutputToken = costPerOutputToken;
        mostEfficientModel = model;
      }
    }

    return {
      byModel,
      mostUsedModel,
      mostEfficientModel,
      totalModelsUsed: this.byModel.size,
    };
  }

  reset(_sessionId: string): void {
    this.byModel.clear();
  }
}
```

#### MCP tool

Tool name: `nr_observe_get_model_usage`

Description: `"Get per-model usage statistics: request counts, token totals, cost, and cost-per-output-token efficiency ratios. Identifies the most-used and most cost-efficient model."`

Handler (goes in `analytics-tools.ts`):

```typescript
export function handleGetModelUsage(
  tracker: ModelUsageTracker,
): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(tracker.getMetrics(), null, 2) }] };
}
```

#### Tests (`model-usage-tracker.test.ts`)

```typescript
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ModelUsageTracker } from './model-usage-tracker.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('ModelUsageTracker', () => {
  it('returns empty state for new tracker', () => {
    const t = new ModelUsageTracker();
    const m = t.getMetrics();
    expect(m.totalModelsUsed).toBe(0);
    expect(m.mostUsedModel).toBeNull();
    expect(m.mostEfficientModel).toBeNull();
    expect(m.byModel).toEqual({});
  });

  it('tracks a single model correctly', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('claude-haiku-4', 1000, 500, 0.01);
    const m = t.getMetrics();
    expect(m.totalModelsUsed).toBe(1);
    expect(m.mostUsedModel).toBe('claude-haiku-4');
    expect(m.byModel['claude-haiku-4']?.requestCount).toBe(1);
    expect(m.byModel['claude-haiku-4']?.totalInputTokens).toBe(1000);
    expect(m.byModel['claude-haiku-4']?.totalOutputTokens).toBe(500);
    expect(m.byModel['claude-haiku-4']?.totalCostUsd).toBeCloseTo(0.01);
  });

  it('accumulates multiple calls to the same model', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('claude-haiku-4', 1000, 500, 0.01);
    t.recordUsage('claude-haiku-4', 2000, 800, 0.02);
    const stats = t.getMetrics().byModel['claude-haiku-4'];
    expect(stats?.requestCount).toBe(2);
    expect(stats?.totalInputTokens).toBe(3000);
    expect(stats?.totalOutputTokens).toBe(1300);
    expect(stats?.totalCostUsd).toBeCloseTo(0.03);
  });

  it('computes costPerOutputToken correctly', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('model-a', 0, 1000, 0.01); // $0.00001 per output token
    const stats = t.getMetrics().byModel['model-a'];
    expect(stats?.costPerOutputToken).toBeCloseTo(0.00001);
  });

  it('costPerOutputToken is null when output tokens are zero', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('model-a', 100, 0, 0.001);
    expect(t.getMetrics().byModel['model-a']?.costPerOutputToken).toBeNull();
  });

  it('avgOutputTokensPerRequest is correct', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('model-a', 0, 200, 0);
    t.recordUsage('model-a', 0, 400, 0);
    expect(t.getMetrics().byModel['model-a']?.avgOutputTokensPerRequest).toBe(300);
  });

  it('mostUsedModel is the model with the highest requestCount', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('claude-haiku-4', 100, 50, 0.001);
    t.recordUsage('claude-sonnet-4', 100, 50, 0.005);
    t.recordUsage('claude-sonnet-4', 100, 50, 0.005);
    expect(t.getMetrics().mostUsedModel).toBe('claude-sonnet-4');
  });

  it('mostEfficientModel has the lowest costPerOutputToken', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('expensive-model', 0, 100, 1.0);  // $0.01 per output token
    t.recordUsage('cheap-model', 0, 100, 0.1);       // $0.001 per output token
    expect(t.getMetrics().mostEfficientModel).toBe('cheap-model');
  });

  it('totalModelsUsed counts distinct models', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('model-a', 100, 50, 0.01);
    t.recordUsage('model-b', 100, 50, 0.01);
    t.recordUsage('model-a', 100, 50, 0.01); // second call to model-a — not counted twice
    expect(t.getMetrics().totalModelsUsed).toBe(2);
  });

  it('reset clears all state', () => {
    const t = new ModelUsageTracker();
    t.recordUsage('claude-haiku-4', 1000, 500, 0.01);
    t.reset('new-session');
    const m = t.getMetrics();
    expect(m.totalModelsUsed).toBe(0);
    expect(m.mostUsedModel).toBeNull();
    expect(m.byModel).toEqual({});
  });
});
```

---

## ✅ Step — Register all four trackers

This step involves four files: a new `analytics-tools.ts`, plus modifications to `session-stats.ts`, `cost-tools.ts`, and `index.ts`.

### ✅ 5a — Create `packages/nr-ai-mcp-server/src/tools/analytics-tools.ts`

Create this file with the following complete content:

```typescript
import type { ContextWindowTracker } from '../metrics/context-window-tracker.js';
import type { LatencyTracker } from '../metrics/latency-tracker.js';
import type { TaskCompletionTracker } from '../metrics/task-completion-tracker.js';
import type { ModelUsageTracker } from '../metrics/model-usage-tracker.js';
import type { TaskDetector } from '../metrics/task-detector.js';

export const CONTEXT_EFFICIENCY_TOOL = {
  name: 'nr_observe_get_context_efficiency',
  description:
    'Get context window efficiency metrics: unique vs. repeated file reads, repeated-read ratio, and top re-read files. A high ratio suggests the model is losing context.',
  inputSchema: { type: 'object' as const, properties: {} },
  annotations: { readOnlyHint: true },
};

export const LATENCY_PERCENTILES_TOOL = {
  name: 'nr_observe_get_latency_percentiles',
  description:
    'Get p50/p95/p99 latency percentiles for tool calls, broken down by tool type. Use to identify which tools are slowest in the current session.',
  inputSchema: { type: 'object' as const, properties: {} },
  annotations: { readOnlyHint: true },
};

export const TASK_COMPLETION_TOOL = {
  name: 'nr_observe_get_task_completion_rate',
  description:
    'Get task lifecycle metrics: completion rate, average task duration, and average tool calls per task. Distinguishes completed tasks from in-progress/abandoned.',
  inputSchema: { type: 'object' as const, properties: {} },
  annotations: { readOnlyHint: true },
};

export const MODEL_USAGE_TOOL = {
  name: 'nr_observe_get_model_usage',
  description:
    'Get per-model usage statistics: request counts, token totals, cost, and cost-per-output-token efficiency ratios. Identifies the most-used and most cost-efficient model.',
  inputSchema: { type: 'object' as const, properties: {} },
  annotations: { readOnlyHint: true },
};

export function handleGetContextEfficiency(
  tracker: ContextWindowTracker,
): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(tracker.getMetrics(), null, 2) }] };
}

export function handleGetLatencyPercentiles(
  tracker: LatencyTracker,
): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(tracker.getMetrics(), null, 2) }] };
}

export function handleGetTaskCompletionRate(
  tracker: TaskCompletionTracker,
  taskDetector?: TaskDetector,
): { content: Array<{ type: 'text'; text: string }> } {
  const metrics = tracker.getMetrics();
  const inProgressTasks = taskDetector?.getMetrics().currentTaskActive ? 1 : 0;
  const totalTasksDetected = metrics.completedTasks + inProgressTasks;
  const completionRate = totalTasksDetected > 0 ? metrics.completedTasks / totalTasksDetected : null;
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(
        { ...metrics, inProgressTasks, totalTasksDetected, completionRate },
        null,
        2,
      ),
    }],
  };
}

export function handleGetModelUsage(
  tracker: ModelUsageTracker,
): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(tracker.getMetrics(), null, 2) }] };
}
```

### ✅ 5b — Modify `packages/nr-ai-mcp-server/src/tools/session-stats.ts`

**Add imports** at the top of the file, after the existing `cross-session-tools.js` import block:

```typescript
import type { ContextWindowTracker } from '../metrics/context-window-tracker.js';
import type { LatencyTracker } from '../metrics/latency-tracker.js';
import type { TaskCompletionTracker } from '../metrics/task-completion-tracker.js';
import type { ModelUsageTracker } from '../metrics/model-usage-tracker.js';
import {
  CONTEXT_EFFICIENCY_TOOL,
  LATENCY_PERCENTILES_TOOL,
  TASK_COMPLETION_TOOL,
  MODEL_USAGE_TOOL,
  handleGetContextEfficiency,
  handleGetLatencyPercentiles,
  handleGetTaskCompletionRate,
  handleGetModelUsage,
} from './analytics-tools.js';
```

**Add to `ToolRegistrationOptions` interface** (the existing interface at the bottom of the options section):

```typescript
contextWindowTracker?: ContextWindowTracker;
latencyTracker?: LatencyTracker;
taskCompletionTracker?: TaskCompletionTracker;
modelUsageTracker?: ModelUsageTracker;
```

**Add to the destructuring** at the top of `registerTools()`, alongside the existing destructuring of `options`:

```typescript
const {
  // ... existing fields ...
  contextWindowTracker,
  latencyTracker,
  taskCompletionTracker,
  modelUsageTracker,
} = options;
```

**Add tool registration conditions** in the `registerTools()` body, after the existing `if (recommendationEngine)` block:

```typescript
if (contextWindowTracker) {
  tools.push(CONTEXT_EFFICIENCY_TOOL);
}
if (latencyTracker) {
  tools.push(LATENCY_PERCENTILES_TOOL);
}
if (taskCompletionTracker) {
  tools.push(TASK_COMPLETION_TOOL);
}
if (modelUsageTracker) {
  tools.push(MODEL_USAGE_TOOL);
}
```

**Add switch cases** in the `CallToolRequestSchema` handler, after the existing `nr_observe_get_platform_comparison` case:

```typescript
case 'nr_observe_get_context_efficiency':
  if (!contextWindowTracker) break;
  return handleGetContextEfficiency(contextWindowTracker);

case 'nr_observe_get_latency_percentiles':
  if (!latencyTracker) break;
  return handleGetLatencyPercentiles(latencyTracker);

case 'nr_observe_get_task_completion_rate':
  if (!taskCompletionTracker) break;
  return handleGetTaskCompletionRate(taskCompletionTracker, taskDetector);

case 'nr_observe_get_model_usage':
  if (!modelUsageTracker) break;
  return handleGetModelUsage(modelUsageTracker);
```

### ✅ 5c — Modify `packages/nr-ai-mcp-server/src/tools/cost-tools.ts`

`ModelUsageTracker.recordUsage()` must be called from `handleReportTokens()` because that's where the model name, token counts, and cost are computed.

**Add import** at the top of `cost-tools.ts`:

```typescript
import type { ModelUsageTracker } from '../metrics/model-usage-tracker.js';
```

**Add an optional third parameter** to `handleReportTokens`:

```typescript
export function handleReportTokens(
  costTracker: CostTracker,
  args: TokenReport,
  modelUsageTracker?: ModelUsageTracker,
) {
```

**Add a call** after `const breakdown = costTracker.recordTokenUsage(usage, safeModel);`:

```typescript
modelUsageTracker?.recordUsage(safeModel, inputTokens, outputTokens, breakdown.totalUsd);
```

The existing `return { content: [...] }` block is unchanged.

**Update the call site** in `session-stats.ts` `CallToolRequestSchema` handler:

```typescript
case 'nr_observe_report_tokens':
  if (!costTracker) break;
  return handleReportTokens(costTracker, args as unknown as TokenReport, modelUsageTracker);
```

### ✅ 5d — Modify `packages/nr-ai-mcp-server/src/index.ts`

**Add imports** after the existing metrics imports:

```typescript
import { ContextWindowTracker } from './metrics/context-window-tracker.js';
import { LatencyTracker } from './metrics/latency-tracker.js';
import { TaskCompletionTracker } from './metrics/task-completion-tracker.js';
import { ModelUsageTracker } from './metrics/model-usage-tracker.js';
```

**Instantiate** the four trackers near the other tracker instantiations (after `const feedbackCollector = new FeedbackCollector();`):

```typescript
const contextWindowTracker = new ContextWindowTracker();
const latencyTracker = new LatencyTracker();
const taskCompletionTracker = new TaskCompletionTracker();
const modelUsageTracker = new ModelUsageTracker();
```

**Wire into `onRecord`** — add these two lines inside the `onRecord` callback, after the `sessionTracker.recordToolCall(record)` call:

```typescript
contextWindowTracker.recordToolCall(record);
latencyTracker.recordToolCall(record);
```

**Wire `taskCompletionTracker`** — add one line inside the `for (const task of taskDetector.drainNewlyCompletedTasks())` loop, after `capturedNrIngest.ingestCodingTask(task)`:

```typescript
taskCompletionTracker.recordTask(task);
```

**Pass all four to `registerTools()`** — add them to the existing `registerTools(mcpServer.server, { ... })` call:

```typescript
registerTools(mcpServer.server, {
  // ... all existing options ...
  contextWindowTracker,
  latencyTracker,
  taskCompletionTracker,
  modelUsageTracker,
});
```

---

## ✅ Acceptance criteria

- [x] `npm run build` passes with no TypeScript errors
- [x] `npm test` passes — all four new test files pass
- [x] All four trackers implement the `recordToolCall | recordTask | recordUsage → getMetrics → reset` pattern
- [x] `nr_observe_get_context_efficiency` returns `ContextWindowMetrics` JSON
- [x] `nr_observe_get_latency_percentiles` returns `LatencyMetrics` JSON
- [x] `nr_observe_get_task_completion_rate` returns JSON with `completedTasks`, `inProgressTasks`, `totalTasksDetected`, `completionRate`, `avgTaskDurationMs`, `avgToolCallsPerTask`
- [x] `nr_observe_get_model_usage` returns `ModelUsageMetrics` JSON
- [x] `reset()` on each tracker produces the same state as a freshly constructed instance
- [x] `npm run lint` passes

---

## File checklist

Files to **create**:

```
packages/nr-ai-mcp-server/src/metrics/context-window-tracker.ts
packages/nr-ai-mcp-server/src/metrics/context-window-tracker.test.ts
packages/nr-ai-mcp-server/src/metrics/latency-tracker.ts
packages/nr-ai-mcp-server/src/metrics/latency-tracker.test.ts
packages/nr-ai-mcp-server/src/metrics/task-completion-tracker.ts
packages/nr-ai-mcp-server/src/metrics/task-completion-tracker.test.ts
packages/nr-ai-mcp-server/src/metrics/model-usage-tracker.ts
packages/nr-ai-mcp-server/src/metrics/model-usage-tracker.test.ts
packages/nr-ai-mcp-server/src/tools/analytics-tools.ts
```

Files to **modify**:

```
packages/nr-ai-mcp-server/src/tools/session-stats.ts  — add 4 imports, 4 tracker options, 4 push conditions, 4 switch cases
packages/nr-ai-mcp-server/src/tools/cost-tools.ts     — add modelUsageTracker import + optional param to handleReportTokens
packages/nr-ai-mcp-server/src/index.ts                — add 4 imports, instantiate + wire all 4 trackers, pass to registerTools
```
