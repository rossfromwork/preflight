import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { BudgetTracker } from './budget-tracker.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('BudgetTracker', () => {
  it('returns null status when no budgets configured', () => {
    const t = new BudgetTracker({
      sessionBudgetUsd: null,
      dailyBudgetUsd: null,
      weeklyBudgetUsd: null,
    });
    const s = t.getStatus();
    expect(s.session.budgetUsd).toBeNull();
    expect(s.session.pctUsed).toBeNull();
    expect(s.session.exceeded).toBe(false);
  });

  it('tracks pctUsed correctly', () => {
    const t = new BudgetTracker({
      sessionBudgetUsd: 10,
      dailyBudgetUsd: null,
      weeklyBudgetUsd: null,
    });
    t.updateCost(5, 0, 0);
    expect(t.getStatus().session.pctUsed).toBeCloseTo(50);
  });

  it('fires 50% threshold callback once', () => {
    const events: unknown[] = [];
    const t = new BudgetTracker({
      sessionBudgetUsd: 10,
      dailyBudgetUsd: null,
      weeklyBudgetUsd: null,
      onThreshold: (e) => events.push(e),
    });
    t.updateCost(5, 0, 0);
    t.updateCost(5.1, 0, 0);
    expect(events).toHaveLength(1);
    expect((events[0] as { thresholdPct: number }).thresholdPct).toBe(50);
  });

  it('fires 80% and 100% thresholds independently', () => {
    const events: unknown[] = [];
    const t = new BudgetTracker({
      sessionBudgetUsd: 10,
      dailyBudgetUsd: null,
      weeklyBudgetUsd: null,
      onThreshold: (e) => events.push(e),
    });
    t.updateCost(6, 0, 0);
    expect(events).toHaveLength(1);
    expect((events[0] as { thresholdPct: number }).thresholdPct).toBe(50);
    t.updateCost(8, 0, 0);
    expect(events).toHaveLength(2);
    expect((events[1] as { thresholdPct: number }).thresholdPct).toBe(80);
    t.updateCost(10, 0, 0);
    expect(events).toHaveLength(3);
    expect((events[2] as { thresholdPct: number }).thresholdPct).toBe(100);
  });

  it('marks exceeded when spent > budget', () => {
    const t = new BudgetTracker({
      sessionBudgetUsd: 5,
      dailyBudgetUsd: null,
      weeklyBudgetUsd: null,
    });
    t.updateCost(6, 0, 0);
    expect(t.getStatus().session.exceeded).toBe(true);
    expect(t.getStatus().session.remainingUsd).toBe(0);
  });

  it('resetSession clears session spend and re-arms thresholds', () => {
    const events: unknown[] = [];
    const t = new BudgetTracker({
      sessionBudgetUsd: 10,
      dailyBudgetUsd: null,
      weeklyBudgetUsd: null,
      onThreshold: (e) => events.push(e),
    });
    t.updateCost(6, 0, 0);
    t.resetSession();
    t.updateCost(6, 0, 0);
    expect(events).toHaveLength(2);
  });

  it('tracks daily and weekly budgets independently', () => {
    const events: unknown[] = [];
    const t = new BudgetTracker({
      sessionBudgetUsd: 100,
      dailyBudgetUsd: 10,
      weeklyBudgetUsd: 50,
      onThreshold: (e) => events.push(e),
    });
    t.updateCost(5, 15, 60);
    const periods = (events as Array<{ period: string }>).map((e) => e.period);
    expect(periods).toContain('daily');
    expect(periods).toContain('weekly');
    expect(periods.filter((p) => p === 'daily')).toHaveLength(3);
    expect(periods.filter((p) => p === 'weekly')).toHaveLength(3);
  });

  it('calculates remaining budget correctly', () => {
    const t = new BudgetTracker({
      sessionBudgetUsd: 20,
      dailyBudgetUsd: null,
      weeklyBudgetUsd: null,
    });
    t.updateCost(7, 0, 0);
    const status = t.getStatus().session;
    expect(status.remainingUsd).toBeCloseTo(13);
    expect(status.pctUsed).toBeCloseTo(35);
  });
});
