import { type Span, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { getMcpTracer } from './mcp-tracer.js';
import { createLogger } from '@nr-ai-observatory/shared';

const logger = createLogger('task-span-tracker');

export class TaskSpanTracker {
  private readonly activeTasks: Map<string, Span> = new Map();

  openTask(taskId: string, label: string, parentContext: ReturnType<typeof context.active>): void {
    if (this.activeTasks.has(taskId)) return;
    const span = getMcpTracer().startSpan(`ai.task ${label}`, {
      attributes: {
        'ai.task.id': taskId,
        'ai.task.label': label,
      },
    }, parentContext);
    this.activeTasks.set(taskId, span);
    logger.debug('Task span opened', { taskId, label });
  }

  closeTask(taskId: string, toolCallCount: number): void {
    const span = this.activeTasks.get(taskId);
    if (!span) return;
    span.setAttributes({ 'ai.task.tool_call_count': toolCallCount });
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    this.activeTasks.delete(taskId);
    logger.debug('Task span closed', { taskId });
  }

  getContext(taskId: string | null, fallback: ReturnType<typeof context.active>): ReturnType<typeof context.active> {
    if (!taskId) return fallback;
    const span = this.activeTasks.get(taskId);
    if (!span) return fallback;
    return trace.setSpan(context.active(), span);
  }

  closeAll(): void {
    for (const [taskId, span] of this.activeTasks) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'session ended with task in progress' });
      span.end();
      logger.debug('Force-closed task span', { taskId });
    }
    this.activeTasks.clear();
  }

  get size(): number {
    return this.activeTasks.size;
  }
}
