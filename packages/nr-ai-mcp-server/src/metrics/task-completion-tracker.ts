import type { AiCodingTask } from './task-detector.js';

interface TaskSummary {
  readonly durationMs: number;
  readonly toolCallCount: number;
}

export interface TaskCompletionMetrics {
  readonly completedTasks: number;
  readonly avgTaskDurationMs: number | null;
  readonly avgToolCallsPerTask: number | null;
}

export class TaskCompletionTracker {
  private completed: TaskSummary[] = [];

  recordTask(task: AiCodingTask): void {
    this.completed.push({ durationMs: task.durationMs, toolCallCount: task.toolCallCount });
  }

  getMetrics(): TaskCompletionMetrics {
    const completedCount = this.completed.length;

    const avgTaskDurationMs =
      completedCount > 0
        ? this.completed.reduce((s, t) => s + t.durationMs, 0) / completedCount
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
