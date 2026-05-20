import { SpanStatusCode, context } from '@opentelemetry/api';
import { TaskSpanTracker } from './task-span-tracker.js';

const mockSpan = {
  setAttributes: jest.fn(),
  setStatus: jest.fn(),
  recordException: jest.fn(),
  end: jest.fn(),
};

const mockTracer = { startSpan: jest.fn(() => mockSpan) };

jest.mock('./mcp-tracer.js', () => ({ getMcpTracer: () => mockTracer }));

describe('TaskSpanTracker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('openTask creates a span with correct attributes', () => {
    const tracker = new TaskSpanTracker();
    const parentContext = context.active();

    tracker.openTask('task-1', 'Fix bug in auth', parentContext);

    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      'ai.task Fix bug in auth',
      {
        attributes: {
          'ai.task.id': 'task-1',
          'ai.task.label': 'Fix bug in auth',
        },
      },
      parentContext,
    );
  });

  test('openTask is idempotent', () => {
    const tracker = new TaskSpanTracker();
    const parentContext = context.active();

    tracker.openTask('task-1', 'Fix bug', parentContext);
    tracker.openTask('task-1', 'Fix bug', parentContext);

    expect(mockTracer.startSpan).toHaveBeenCalledTimes(1);
  });

  test('closeTask sets attributes and ends the span', () => {
    const tracker = new TaskSpanTracker();
    const parentContext = context.active();

    tracker.openTask('task-1', 'Fix bug', parentContext);
    tracker.closeTask('task-1', 10);

    expect(mockSpan.setAttributes).toHaveBeenCalledWith({
      'ai.task.tool_call_count': 10,
    });
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  test('closeTask removes task from active map', () => {
    const tracker = new TaskSpanTracker();
    const parentContext = context.active();

    tracker.openTask('task-1', 'Fix bug', parentContext);
    expect(tracker.size).toBe(1);

    tracker.closeTask('task-1', 5);
    expect(tracker.size).toBe(0);
  });

  test('closeTask ignores non-existent task', () => {
    const tracker = new TaskSpanTracker();
    tracker.closeTask('non-existent-task', 5);

    expect(mockSpan.setAttributes).not.toHaveBeenCalled();
    expect(mockSpan.end).not.toHaveBeenCalled();
  });

  test('getContext returns parent context when task ID is null', () => {
    const tracker = new TaskSpanTracker();
    const parentContext = context.active();

    const result = tracker.getContext(null, parentContext);
    expect(result).toBe(parentContext);
  });

  test('getContext returns fallback when task not found', () => {
    const tracker = new TaskSpanTracker();
    const parentContext = context.active();

    const result = tracker.getContext('non-existent-task', parentContext);
    expect(result).toBe(parentContext);
  });

  test('getContext returns task context when task is active', () => {
    const tracker = new TaskSpanTracker();
    const parentContext = context.active();

    tracker.openTask('task-1', 'Fix bug', parentContext);
    tracker.getContext('task-1', parentContext);

    // Context should be different from parent (contains the task span)
    expect(mockTracer.startSpan).toHaveBeenCalled();
  });

  test('closeAll ends all active task spans', () => {
    const tracker = new TaskSpanTracker();
    const parentContext = context.active();

    tracker.openTask('task-1', 'Task 1', parentContext);
    tracker.openTask('task-2', 'Task 2', parentContext);
    tracker.openTask('task-3', 'Task 3', parentContext);

    expect(tracker.size).toBe(3);
    tracker.closeAll();

    expect(tracker.size).toBe(0);
    expect(mockSpan.end).toHaveBeenCalledTimes(3);
  });

  test('closeAll sets ERROR status on all spans (interrupted tasks)', () => {
    const tracker = new TaskSpanTracker();
    const parentContext = context.active();

    tracker.openTask('task-1', 'Task 1', parentContext);
    tracker.openTask('task-2', 'Task 2', parentContext);

    tracker.closeAll();

    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'session ended with task in progress',
    });
    expect(mockSpan.setStatus).toHaveBeenCalledTimes(2);
  });

  test('size property returns correct count', () => {
    const tracker = new TaskSpanTracker();
    const parentContext = context.active();

    expect(tracker.size).toBe(0);

    tracker.openTask('task-1', 'Task 1', parentContext);
    expect(tracker.size).toBe(1);

    tracker.openTask('task-2', 'Task 2', parentContext);
    expect(tracker.size).toBe(2);

    tracker.closeTask('task-1', 5);
    expect(tracker.size).toBe(1);
  });
});
