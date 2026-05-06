import { describe, it, expect } from '@jest/globals';
import { buildCostForecast } from './cost-forecast.js';

describe('buildCostForecast', () => {
  it('returns zero-state for no spend', () => {
    const f = buildCostForecast(0, Date.now() - 60_000);
    expect(f.forecastEndOfDayUsd).toBeNull();
    expect(f.forecastEndOfWeekUsd).toBeNull();
    expect(f.forecastSessionEndUsd).toBeNull();
  });

  it('returns a positive end-of-day forecast for ongoing spend', () => {
    const startMs = Date.now() - 30 * 60_000;
    const f = buildCostForecast(1.5, startMs);
    expect(f.forecastEndOfDayUsd).toBeGreaterThan(1.5);
    expect(f.rateUsdPerMs).toBeGreaterThan(0);
  });

  it('confidenceNote mentions low confidence for <10 minutes', () => {
    const startMs = Date.now() - 5 * 60_000;
    const f = buildCostForecast(0.1, startMs);
    expect(f.confidenceNote).toMatch(/Low confidence/i);
  });

  it('confidenceNote mentions moderate confidence for <30 minutes', () => {
    const startMs = Date.now() - 15 * 60_000;
    const f = buildCostForecast(0.5, startMs);
    expect(f.confidenceNote).toMatch(/Moderate confidence/i);
  });

  it('confidenceNote mentions reasonable confidence for 30+ minutes', () => {
    const startMs = Date.now() - 45 * 60_000;
    const f = buildCostForecast(2.0, startMs);
    expect(f.confidenceNote).toMatch(/Reasonable confidence/i);
  });

  it('computes correct spending rate', () => {
    const startMs = Date.now() - 60_000;
    const f = buildCostForecast(1.0, startMs);
    expect(f.rateUsdPerMs).toBeCloseTo(1.0 / 60_000, 8);
  });

  it('forecasts end-of-session cost correctly', () => {
    const startMs = Date.now() - 30 * 60_000;
    const f = buildCostForecast(1.0, startMs);
    expect(f.forecastSessionEndUsd).toBeGreaterThan(1.0);
    expect(f.forecastSessionEndUsd).toBeLessThan(100);
  });

  it('returns correct elapsed time', () => {
    const elapsedMs = 3 * 60_000;
    const startMs = Date.now() - elapsedMs;
    const f = buildCostForecast(1.0, startMs);
    expect(f.elapsedMs).toBeCloseTo(elapsedMs, -2);
  });
});
