# NR AI Observatory — MCP Commands Reference

Every MCP tool exposed by the `nr-ai-mcp-server`, what it returns, how it computes each finding, and which trackers it queries.

Tools are conditionally registered — each tool only appears when its required tracker dependencies are provided to `registerTools()`.

---

## Session Tools

### `nr_observe_get_session_stats`

Current session metrics snapshot.

**Parameters:** None

**Returns:**
```json
{
  "session_id": "string",
  "session_duration_ms": 0,
  "tool_calls": 0,
  "tool_calls_by_type": { "Read": 5, "Edit": 3 },
  "success_rate": 0.95,
  "failed_calls": 1,
  "unique_files_read": 12,
  "unique_files_modified": 4,
  "bash_commands_run": 7,
  "search_queries": 3,
  "avg_tool_duration_ms": 45
}
```

**Data source:** `SessionTracker`

**How each field is determined:**
- `tool_calls` — running count incremented on each `recordToolCall()`
- `tool_calls_by_type` — per-tool-name counter map
- `success_rate` — `successCount / totalCount`
- `failed_calls` — count of records where `success === false`
- `unique_files_read` — size of Set collecting file paths from Read/Grep/Glob tools
- `unique_files_modified` — size of Set collecting file paths from Write/Edit tools
- `bash_commands_run` — count of Bash tool calls
- `search_queries` — count of Grep/Glob tool calls
- `avg_tool_duration_ms` — `sum(allDurations) / count(allDurations)` across all tools

**Requires:** `SessionTracker`

Source: `packages/nr-ai-mcp-server/src/tools/session-stats.ts`

---

### `nr_observe_get_session_timeline`

Ordered list of recent tool calls.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `last_n` | number | 20 | Number of most recent tool calls to return |

**Returns:**
```json
{
  "timeline": [
    { "timestamp": "2026-04-21T10:30:00.000Z", "tool": "Read", "duration_ms": 30, "success": true }
  ]
}
```

**Data source:** `SessionTracker`

**How it works:** Returns the last N entries from `SessionTracker.getMetrics().toolCallTimeline`, converting timestamps to ISO format. The timeline is a FIFO array of all tool calls recorded in the session.

**Requires:** `SessionTracker`

Source: `packages/nr-ai-mcp-server/src/tools/session-stats.ts`

---

## Cost Tools

### `nr_observe_report_tokens`

Self-report token usage for cost tracking. Called by Claude Code to report its own token consumption.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `input_tokens` | number | Yes | Input/prompt token count |
| `output_tokens` | number | Yes | Output/completion token count |
| `model` | string | Yes | Model identifier (e.g., `claude-sonnet-4-20250514`) |
| `thinking_tokens` | number | No | Extended thinking token count |
| `cache_read_tokens` | number | No | Prompt cache read token count |
| `cache_creation_tokens` | number | No | Prompt cache creation token count |

**Returns:**
```json
{
  "recorded": true,
  "cost_this_report_usd": 0.0042,
  "session_total_cost_usd": 0.15,
  "model": "claude-sonnet-4-20250514"
}
```

**Data source:** `CostTracker`

**How it works:**
1. Constructs a `TokenUsage` object from the reported counts
2. Calls `CostTracker.recordTokenUsage(usage, model)` which looks up per-token prices from the pricing table (`packages/shared/src/pricing-data.ts`)
3. Cost breakdown: `inputCost = inputTokens * inputPricePerToken`, similarly for output, thinking, cache read, and cache creation tokens
4. Accumulates into session total and per-model totals
5. Returns both the cost for this specific report and the running session total

**Requires:** `CostTracker`

Source: `packages/nr-ai-mcp-server/src/tools/cost-tools.ts`

---

### `nr_observe_get_cost_breakdown`

Session cost breakdown by task, model, and efficiency.

**Parameters:** None

**Returns:**
```json
{
  "total_usd": 0.52,
  "by_model": { "claude-sonnet-4-20250514": 0.40, "claude-haiku-4-5-20251001": 0.12 },
  "by_task": [{ "task_id": "task-001", "cost_usd": 0.25, "tokens_used": 15000 }],
  "cost_per_line_of_code": 0.003,
  "cost_per_file_modified": 0.065,
  "tokens": { "input": 50000, "output": 20000, "thinking": 10000 }
}
```

**Data source:** `CostTracker`, `TaskDetector` (optional)

**How each field is determined:**
- `total_usd` — sum of all token cost reports in the session
- `by_model` — per-model accumulator updated on each `reportTokens` call
- `by_task` — maps `TaskDetector.getCompletedTasks()` to their `estimatedCostUsd` and `tokensUsed`
- `cost_per_line_of_code` — `totalCost / totalLinesChanged` (null if no lines changed)
- `cost_per_file_modified` — `totalCost / uniqueFilesWritten` (null if no files modified)
- `tokens` — running totals by token type from all reports

**Requires:** `CostTracker`; `TaskDetector` for per-task breakdown

Source: `packages/nr-ai-mcp-server/src/tools/cost-tools.ts`

---

## Workflow Tools

### `nr_observe_get_workflow_trace`

Complete tool call trace for a task with anti-pattern and efficiency analysis.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `task_id` | string | most recent | ID of the task to trace |

**Returns:**
```json
{
  "task_id": "task-001",
  "duration_ms": 45000,
  "estimated_cost_usd": 0.25,
  "tool_calls": [
    { "seq": 1, "tool": "Read", "target": "/src/index.ts", "duration_ms": 30, "success": true },
    { "seq": 2, "tool": "Bash", "target": "npm test", "duration_ms": 5000, "success": true, "exit_code": 0 }
  ],
  "anti_patterns": [
    { "type": "thrashing", "file": "/src/index.ts", "iterations": 4, "suggestion": "..." }
  ],
  "efficiency_score": 0.82
}
```

**Data source:** `TaskDetector`, `AntiPatternDetector` (optional), `EfficiencyScorer` (optional)

**How it works:**
1. Finds the task by ID from `TaskDetector.getCompletedTasks()`, or uses the most recent completed task
2. Maps each tool call in the task to a sequenced trace entry with `filePath` or `command` as the target
3. If `AntiPatternDetector` is available, analyzes the task's tool call sequence for anti-patterns
4. If `EfficiencyScorer` is available, computes the task's efficiency score

**Requires:** `TaskDetector`

Source: `packages/nr-ai-mcp-server/src/tools/workflow-tools.ts`

---

### `nr_observe_get_anti_patterns`

Detected anti-patterns for the most recent task.

**Parameters:** None

**Returns:**
```json
[
  { "type": "thrashing", "file": "/src/index.ts", "iterations": 4, "suggestion": "Consider a different approach" },
  { "type": "re_reading", "file": "/src/config.ts", "read_count": 5, "suggestion": "Cache file contents" }
]
```

**Data source:** `TaskDetector`, `AntiPatternDetector`

**Detection algorithms (5 pattern types):**

| Pattern | How Detected | Default Threshold |
|---------|-------------|-------------------|
| **Thrashing** | Tracks `Edit/Write → Bash(test:FAIL)` cycles on the same file. Counts consecutive failures. Resets on test pass. | 3 consecutive failures |
| **Re-reading** | Counts `Read` calls per file path. Flags files read more than the threshold. | 3 reads of same file |
| **Stuck loop** | Detects repeated `Bash` commands with identical arguments. | 3 identical commands |
| **Blind editing** | Counts consecutive `Edit/Write` calls without an intervening `Read` or test run. | 3 edits without verification |
| **Over-delegation** | Counts `Agent` tool spawns in a single task. | 3 agent spawns |

Each detected pattern includes a `suggestion` field with a human-readable recommendation.

**Requires:** `TaskDetector`, `AntiPatternDetector`

Source: `packages/nr-ai-mcp-server/src/tools/workflow-tools.ts`, `packages/nr-ai-mcp-server/src/metrics/anti-patterns.ts`

---

### `nr_observe_get_efficiency_score`

Composite efficiency score for the most recent task and session average.

**Parameters:** None

**Returns:**
```json
{
  "latest": {
    "score": 0.82,
    "components": { "speed": 0.7, "correctness": 1.0, "autonomy": 0.9, "firstAttemptQuality": 0.6 },
    "task_id": "task-001",
    "timestamp": 1713700000000
  },
  "session_average": {
    "score": 0.78,
    "components": { "speed": 0.65, "correctness": 0.95, "autonomy": 0.85, "firstAttemptQuality": 0.7 },
    "tasks_scored": 5
  }
}
```

**Data source:** `EfficiencyScorer`, `TaskDetector` (optional), `AntiPatternDetector` (optional)

**Scoring algorithm (4 equally-weighted components, each 0–1):**

| Component | Formula | Baseline |
|-----------|---------|----------|
| **Speed** | `linesChanged / (durationMs / 1000)` normalized against baseline | 1 line/second = 1.0 |
| **Correctness** | `testsPassed / testsRun` | 0.5 if no tests were run |
| **Autonomy** | `1 - (askedUserQuestions / toolCallCount)` | 1.0 if no questions asked |
| **First-attempt quality** | `1 - (thrashIterations / 3)`, floored at 0 | 1.0 if no thrashing detected |

Final score = weighted average of all four components, clamped to [0, 1].

**On-demand scoring:** When called, the handler scores any unscored completed tasks and always rescores the active task (since it grows over time). Session average is the mean score across all scored tasks.

**Requires:** `EfficiencyScorer`

Source: `packages/nr-ai-mcp-server/src/tools/workflow-tools.ts`, `packages/nr-ai-mcp-server/src/metrics/efficiency-score.ts`

---

### `nr_observe_report_feedback`

Record user quality feedback for a task.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `quality` | string | Yes | `"good"`, `"bad"`, or `"neutral"` |
| `notes` | string | No | Free-text notes about the task quality |
| `task_id` | string | No | Task ID to attach feedback to (default: most recent) |

**Returns:**
```json
{
  "recorded": true,
  "quality": "good",
  "task_id": "task-001",
  "timestamp": 1713700000000
}
```

**Data source:** `FeedbackCollector`

**How it works:** Records the feedback with a timestamp. The `FeedbackCollector` stores all feedback records in memory and can emit `ai.feedback.count` metrics (keyed by quality) via the `MetricAggregator`. Used to correlate efficiency metrics with perceived quality.

**Requires:** `FeedbackCollector`

Source: `packages/nr-ai-mcp-server/src/tools/workflow-tools.ts`

---

## Cross-Session Tools

These tools query persisted session data from disk (`~/.nr-ai-observe/sessions/`). They are only registered when `SessionStore` and related analyzers are available.

### `nr_observe_get_session_history`

Paginated list of past sessions with summary metrics.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `since` | string | — | ISO date to filter from (e.g., `"2026-04-01"`) |
| `developer` | string | — | Filter by developer name |
| `limit` | number | 20 | Maximum sessions to return |

**Returns:**
```json
{
  "sessions": [
    {
      "session_id": "sess-abc",
      "developer": "alice",
      "start_time": "2026-04-21T10:00:00.000Z",
      "duration_ms": 300000,
      "tool_calls": 45,
      "efficiency_score": 0.82,
      "estimated_cost_usd": 0.35,
      "task_count": 3,
      "outcome": "completed",
      "model": "claude-sonnet-4-20250514"
    }
  ],
  "count": 1
}
```

**Data source:** `SessionStore`

**How it works:** Loads all session summary JSON files from `~/.nr-ai-observe/sessions/`, applies optional date and developer filters, returns the last N sessions ordered by start time.

**Requires:** `SessionStore`

Source: `packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts`

---

### `nr_observe_get_weekly_summary`

Weekly aggregate report with per-developer breakdown.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `week` | string | current week | ISO week (e.g., `"2026-W16"`) or `"latest"` |

**Returns:** JSON object with weekly aggregates including per-developer metrics, total cost, average efficiency, test pass rates, tool call counts, and anti-pattern tallies by type.

**Data source:** `WeeklySummaryGenerator`

**How it works:**
1. Resolves the target week (current ISO week if not specified or `"latest"`)
2. Loads or generates the weekly summary by aggregating all sessions in that week
3. Groups metrics by developer
4. Computes: average efficiency, total cost, test pass rates, tool call counts, anti-pattern counts

**Requires:** `WeeklySummaryGenerator`

Source: `packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts`

---

### `nr_observe_get_trends`

Metric trends over time, aggregated by ISO week.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `metric` | string | `"efficiency"` | `"efficiency"`, `"cost"`, `"task_success"`, or `"tool_calls"` |
| `developer` | string | — | Filter by developer name |
| `weeks` | number | 8 | Number of weeks to include |

**Returns:**
```json
{
  "metric": "efficiency",
  "weeks": 8,
  "data_points": [
    { "week": "2026-W14", "value": 0.72 },
    { "week": "2026-W15", "value": 0.78 }
  ]
}
```

**Data source:** `TrendAnalyzer`

**How each metric is aggregated per week:**

| Metric | Aggregation |
|--------|-------------|
| `efficiency` | Mean of `efficiencyScore` across sessions in the week |
| `cost` | Sum of `estimatedCostUsd` across sessions in the week |
| `task_success` | Mean of `taskSuccessRate` across sessions in the week |
| `tool_calls` | Mean of `toolCallCount` across sessions in the week |

**Requires:** `TrendAnalyzer`

Source: `packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts`

---

### `nr_observe_get_collaboration_profile`

Developer collaboration style profile with team comparison.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `developer` | string | `"unknown"` | Developer name |

**Returns:**
```json
{
  "developer": "alice",
  "classification": "Power User",
  "dimensions": { "specificity": 0.8, "autonomy": 0.9, "correctionRate": 0.1, "taskComplexity": 0.6 },
  "session_count": 25,
  "team_comparison": { "specificity": 0.15, "autonomy": 0.1 }
}
```

**Data source:** `CollaborationProfiler`

**Dimension calculations:**

| Dimension | How Computed |
|-----------|-------------|
| **Specificity** | Estimated from tool call patterns and file modification specificity |
| **Autonomy** | `1 - (userCorrections / taskCount)` — how often the developer redirects the AI |
| **Correction rate** | `corrections / sessionCount` — frequency of course corrections |
| **Task complexity** | `(toolCallsPerTask * filesModifiedPerTask) / baseline` |

**Classification rules:**

| Classification | Rule |
|---------------|------|
| Power User | specificity > 0.7 AND autonomy > 0.7 |
| Delegator | specificity < 0.3 AND autonomy > 0.7 |
| Learning | specificity < 0.3 AND correctionRate > 0.5 |
| Collaborative | All others |

Team comparison shows the delta between this developer's dimensions and the team average.

**Requires:** `CollaborationProfiler`

Source: `packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts`, `packages/nr-ai-mcp-server/src/metrics/collaboration-profile.ts`

---

### `nr_observe_get_claudemd_impact`

Before/after impact analysis of the most recent CLAUDE.md change.

**Parameters:** None

**Returns:**
```json
{
  "change": { "file": "CLAUDE.md", "type": "modified", "timestamp": "2026-04-21T10:00:00.000Z" },
  "before": { "avgEfficiencyScore": 0.72, "avgCostUsd": 0.45, "sessionCount": 10 },
  "after": { "avgEfficiencyScore": 0.85, "avgCostUsd": 0.38, "sessionCount": 8 },
  "deltas": { "efficiencyScore": { "value": 0.13, "percentChange": 18.1 } },
  "context_tokens": 1250,
  "verdict": "Positive impact"
}
```

**Data source:** `ClaudeMdTracker`

**How it works:**
1. Detects CLAUDE.md changes by monitoring Write/Edit tool calls targeting `CLAUDE.md` or `.claude/` files
2. Partitions sessions into before/after windows around the change timestamp
3. Computes aggregate metrics for each window (average efficiency, cost, correction rate, tool calls per task, task success rate)
4. Calculates deltas with percent change
5. Estimates context token cost: `charCount * 0.25` (tokens-per-char heuristic)
6. Generates verdict: compares the top changed metrics — "Positive impact" if 2+ improved, "Negative impact" if 2+ degraded, "Mixed impact" otherwise

**Requires:** `ClaudeMdTracker`

Source: `packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts`, `packages/nr-ai-mcp-server/src/metrics/claudemd-tracker.ts`

---

### `nr_observe_get_cost_per_outcome`

Cost attribution by outcome type with waste ratio and ROI estimate.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `since` | string | — | ISO date to filter tasks from |

**Returns:**
```json
{
  "outcome_distribution": {
    "bug_fix": { "count": 3, "totalCost": 0.45, "avgCost": 0.15 },
    "feature": { "count": 2, "totalCost": 0.80, "avgCost": 0.40 },
    "failed_attempt": { "count": 1, "totalCost": 0.20, "avgCost": 0.20 }
  },
  "waste_ratio": 0.12,
  "total_cost": 1.65,
  "total_tasks": 8,
  "roi_estimate": {
    "totalAiCost": 1.65,
    "estimatedHoursSaved": 12.5,
    "estimatedValueUsd": 937.50,
    "roi": 56718
  }
}
```

**Data source:** `CostPerOutcomeAnalyzer`, `TaskDetector`

**Outcome classification (priority order — first match wins):**

| Outcome | Detection Rule |
|---------|---------------|
| `failed_attempt` | Tests failed and never recovered within the task |
| `bug_fix` | Sequence: test FAIL → Edit → test PASS |
| `feature` | New files created (Write tool calls) |
| `configuration` | Only config files modified (`.json`, `.yaml`, `.yml`, `.toml`, etc.) |
| `documentation` | Only `.md` files modified |
| `investigation` | Mostly Read/Grep/Glob calls with few or no modifications |
| `refactor` | Default — existing files modified, tests pass |

**ROI estimation:**
- Hours saved per outcome type: bug_fix=2h, feature=4h, refactor=1.5h, investigation=0.5h, configuration=0.5h, documentation=1h, failed_attempt=0h
- `estimatedValueUsd = hoursSaved * hourlyRate` (default: $75/hr)
- `roi = (estimatedValueUsd - totalAiCost) / totalAiCost * 100`
- `wasteRatio = failedAttemptCost / totalCost`

**Requires:** `CostPerOutcomeAnalyzer`, `TaskDetector`

Source: `packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts`, `packages/nr-ai-mcp-server/src/metrics/cost-per-outcome.ts`

---

### `nr_observe_get_recommendations`

Personalized optimization recommendations from multiple analyzers.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `developer` | string | `"unknown"` | Developer name |
| `topN` | number | — | Maximum recommendations to return |

**Returns:**
```json
{
  "recommendations": [
    {
      "id": "abc123",
      "category": "cost",
      "priority": "high",
      "title": "Reduce failed attempts",
      "detail": "12% of your spend is on tasks that ultimately failed.",
      "evidence": "3 failed tasks totaling $0.20",
      "estimatedSavings": "$0.15/week"
    }
  ],
  "count": 5
}
```

**Data source:** `RecommendationEngine` (aggregates from multiple sub-analyzers)

**Recommendation categories and sources:**

| Category | Source Analyzer | Example |
|----------|----------------|---------|
| Cost optimization | `CostPerOutcomeAnalyzer` | "Reduce failed attempts" |
| Efficiency | `TrendAnalyzer` | "Speed is declining week-over-week" |
| Prompt engineering | `PromptFeedbackEngine` | "Multi-step tasks improve efficiency" |
| CLAUDE.md | `ClaudeMdTracker` | "Update CLAUDE.md with task patterns" |
| Model selection | `TrendAnalyzer` | "Consider switching to a faster model" |

Recommendations are deduplicated by ID (hash of title + category), sorted by priority (high > medium > low), and optionally limited to `topN`.

**Requires:** `RecommendationEngine`

Source: `packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts`, `packages/nr-ai-mcp-server/src/metrics/recommendation-engine.ts`

---

### `nr_observe_get_platform_comparison`

Side-by-side comparison of AI coding platforms on a given metric.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `metric` | string | `"efficiency"` | `"efficiency"`, `"cost"`, `"task_success"`, `"tool_calls"`, or `"error_rate"` |
| `weeks` | number | 4 | Number of weeks to include |

**Returns:**
```json
{
  "metric": "efficiency",
  "weeks": 4,
  "platforms": {
    "claude-code": { "session_count": 20, "average": 0.78 },
    "cursor": { "session_count": 5, "average": 0.65 }
  }
}
```

**Data source:** `SessionStore`

**How each metric is computed per platform:**

| Metric | Aggregation |
|--------|-------------|
| `efficiency` | Mean of `efficiencyScore` across platform's sessions |
| `cost` | Mean of `estimatedCostUsd` |
| `task_success` | Mean of `taskSuccessRate` |
| `tool_calls` | Mean of `toolCallCount` |
| `error_rate` | Mean of `(1 - taskSuccessRate)` |

Sessions are grouped by platform (defaults to `"claude-code"` if not set). Only sessions within the lookback window are included.

**Requires:** `SessionStore`

Source: `packages/nr-ai-mcp-server/src/tools/cross-session-tools.ts`
