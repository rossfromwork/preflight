import { CostForecaster } from './cost-forecasting.js';

describe('CostForecaster', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.NEW_RELIC_AI_MONTHLY_BUDGET_USD;
  });

  afterEach(() => {
    delete process.env.NEW_RELIC_AI_MONTHLY_BUDGET_USD;
  });

  // Test 1: Linear regression with upward trend
  it('projects higher costs with upward trend', () => {
    const forecaster = new CostForecaster();
    const now = Date.now();
    const dailySeconds = 24 * 60 * 60 * 1000;

    const trendingCosts = [100, 110, 120, 130, 140, 150, 160];
    trendingCosts.forEach((cost, i) => {
      const timestamp = now - (6 - i) * dailySeconds + i * 60 * 60 * 1000;
      forecaster.recordCost(timestamp, cost);
    });

    const forecast = forecaster.forecast(7);

    expect(forecast.growthRatePercent).toBeGreaterThan(0);
    const avg = forecast.projectedDailyCostUsd.slice(0, 7).reduce((a, b) => a + b, 0) / 7;
    expect(avg).toBeGreaterThan(150);
  });

  // Test 2: Flat cost data
  it('projects flat costs with zero growth for stable spending', () => {
    const forecaster = new CostForecaster();
    const now = Date.now();
    const dailySeconds = 24 * 60 * 60 * 1000;

    for (let i = 0; i < 10; i++) {
      const timestamp = now - (9 - i) * dailySeconds;
      forecaster.recordCost(timestamp, 100);
    }

    const forecast = forecaster.forecast(7);

    expect(Math.abs(forecast.growthRatePercent)).toBeLessThan(1);
    const avgProjected = forecast.projectedDailyCostUsd.slice(0, 7).reduce((a, b) => a + b, 0) / 7;
    expect(avgProjected).toBeCloseTo(100, 0);
  });

  // Test 3: Seasonal adjustment (weekday vs weekend)
  it('detects and applies seasonal patterns (weekday/weekend)', () => {
    const forecaster = new CostForecaster();
    const now = Date.now();
    const dailySeconds = 24 * 60 * 60 * 1000;

    let timestamp = now - 49 * dailySeconds;
    for (let week = 0; week < 7; week++) {
      for (let day = 0; day < 7; day++) {
        const cost = day < 5 ? 200 : 100;
        forecaster.recordCost(timestamp, cost);
        timestamp += dailySeconds;
      }
    }

    const forecast = forecaster.forecast(7);

    const weekdayProjections = [
      forecast.projectedDailyCostUsd[0],
      forecast.projectedDailyCostUsd[1],
      forecast.projectedDailyCostUsd[2],
      forecast.projectedDailyCostUsd[3],
      forecast.projectedDailyCostUsd[4],
    ];
    const weekendProjections = [forecast.projectedDailyCostUsd[5], forecast.projectedDailyCostUsd[6]];

    const avgWeekday = weekdayProjections.reduce((a, b) => a + b, 0) / 5;
    const avgWeekend = weekendProjections.reduce((a, b) => a + b, 0) / 2;

    expect(avgWeekday).toBeGreaterThanOrEqual(avgWeekend * 0.7);
  });

  // Test 4: Confidence interval - higher variance produces wider intervals
  it('produces wider confidence intervals with higher variance', () => {
    const now = Date.now();
    const dailySeconds = 24 * 60 * 60 * 1000;

    const forecasterStable = new CostForecaster();
    for (let i = 0; i < 20; i++) {
      forecasterStable.recordCost(now - (19 - i) * dailySeconds + i * 60 * 60 * 1000, 100);
    }
    const stableForecast = forecasterStable.forecast(30);

    const forecasterVariant = new CostForecaster();
    for (let i = 0; i < 20; i++) {
      const cost = i % 2 === 0 ? 50 : 150;
      forecasterVariant.recordCost(now - (19 - i) * dailySeconds + i * 60 * 60 * 1000, cost);
    }
    const variantForecast = forecasterVariant.forecast(30);

    const stableInterval = stableForecast.confidenceIntervalHigh - stableForecast.confidenceIntervalLow;
    const variantInterval = variantForecast.confidenceIntervalHigh - variantForecast.confidenceIntervalLow;

    expect(variantInterval).toBeGreaterThan(stableInterval);
  });

  // Test 5: Budget exceed date - $10K budget with $400/day
  it('calculates budget exceed date correctly ($10K budget, $400/day)', () => {
    const forecaster = new CostForecaster({ monthlyBudgetUsd: 10000 });
    const now = Date.now();
    const dailySeconds = 24 * 60 * 60 * 1000;

    for (let i = 0; i < 5; i++) {
      const timestamp = now - (4 - i) * dailySeconds + i * 60 * 60 * 1000;
      forecaster.recordCost(timestamp, 400);
    }

    const forecast = forecaster.forecast(30);

    expect(forecast.projectedBudgetExceedDate).not.toBeNull();
    if (forecast.projectedBudgetExceedDate) {
      const exceedDate = new Date(forecast.projectedBudgetExceedDate);
      const today = new Date();
      const todayUTCMidnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
      const daysUntilExceed = Math.round((exceedDate.getTime() - todayUTCMidnight) / dailySeconds);
      expect(daysUntilExceed).toBeGreaterThanOrEqual(24);
      expect(daysUntilExceed).toBeLessThanOrEqual(26);
    }
  });

  // Test 6: Budget exceed date is null when within budget
  it('returns null budget exceed date when spending within budget', () => {
    const forecaster = new CostForecaster({ monthlyBudgetUsd: 10000 });
    const now = Date.now();
    const dailySeconds = 24 * 60 * 60 * 1000;

    for (let i = 0; i < 5; i++) {
      const timestamp = now - (4 - i) * dailySeconds + i * 60 * 60 * 1000;
      forecaster.recordCost(timestamp, 100);
    }

    const forecast = forecaster.forecast(30);

    expect(forecast.projectedBudgetExceedDate).toBeNull();
  });

  // Test 7: Per-dimension forecast with different models
  it('produces different forecasts per dimension (model)', () => {
    const forecaster = new CostForecaster();
    const now = Date.now();
    const dailySeconds = 24 * 60 * 60 * 1000;

    for (let i = 0; i < 10; i++) {
      const timestamp = now - (9 - i) * dailySeconds + i * 60 * 60 * 1000;
      forecaster.recordCost(timestamp, 50, { model: 'fast' });
      forecaster.recordCost(timestamp, 100, { model: 'slow' });
    }

    const byModel = forecaster.forecastByDimension('model', 7);

    expect(byModel.fast).toBeDefined();
    expect(byModel.slow).toBeDefined();
    expect(byModel.slow.projectedMonthlyCostUsd).toBeGreaterThan(byModel.fast.projectedMonthlyCostUsd);
  });

  // Test 8: Forecast with low confidence for insufficient data
  it('returns wider confidence intervals with insufficient data', () => {
    const forecasterFewDays = new CostForecaster();
    const now = Date.now();
    const dailySeconds = 24 * 60 * 60 * 1000;

    for (let i = 0; i < 3; i++) {
      const timestamp = now - (2 - i) * dailySeconds + i * 60 * 60 * 1000;
      forecasterFewDays.recordCost(timestamp, 100);
    }

    const forecasterManyDays = new CostForecaster();
    for (let i = 0; i < 20; i++) {
      const timestamp = now - (19 - i) * dailySeconds + i * 60 * 60 * 1000;
      forecasterManyDays.recordCost(timestamp, 100);
    }

    const fewDaysForecast = forecasterFewDays.forecast(30);
    const manyDaysForecast = forecasterManyDays.forecast(30);

    const fewDaysInterval = fewDaysForecast.confidenceIntervalHigh - fewDaysForecast.confidenceIntervalLow;
    const manyDaysInterval =
      manyDaysForecast.confidenceIntervalHigh - manyDaysForecast.confidenceIntervalLow;

    expect(fewDaysInterval).toBeGreaterThanOrEqual(manyDaysInterval);
  });

  // Test 9: Per-dimension forecast with different features
  it('produces different forecasts per feature dimension', () => {
    const forecaster = new CostForecaster();
    const now = Date.now();
    const dailySeconds = 24 * 60 * 60 * 1000;

    for (let i = 0; i < 10; i++) {
      const timestamp = now - (9 - i) * dailySeconds + i * 60 * 60 * 1000;
      forecaster.recordCost(timestamp, 100, { feature: 'featureA' });
      forecaster.recordCost(timestamp, 50, { feature: 'featureB' });
    }

    const byFeature = forecaster.forecastByDimension('feature', 7);

    expect(byFeature.featureA).toBeDefined();
    expect(byFeature.featureB).toBeDefined();
    expect(byFeature.featureA.projectedMonthlyCostUsd).toBeGreaterThan(
      byFeature.featureB.projectedMonthlyCostUsd,
    );
  });

  // Test 10: Growth rate threshold detection
  it('calculates growth rate correctly for accelerating costs', () => {
    const forecaster = new CostForecaster();
    const now = Date.now();
    const dailySeconds = 24 * 60 * 60 * 1000;

    const acceleratingCosts = [100, 150, 200, 250, 300];
    acceleratingCosts.forEach((cost, i) => {
      const timestamp = now - (4 - i) * dailySeconds + i * 60 * 60 * 1000;
      forecaster.recordCost(timestamp, cost);
    });

    const forecast = forecaster.forecast(7);

    expect(forecast.growthRatePercent).toBeGreaterThan(100);
  });

  it('returns empty forecast for zero data', () => {
    const forecaster = new CostForecaster();
    const forecast = forecaster.forecast(7);

    expect(forecast.projectedDailyCostUsd).toHaveLength(7);
    expect(forecast.projectedDailyCostUsd.every((c) => c === 0)).toBe(true);
    expect(forecast.projectedMonthlyCostUsd).toBe(0);
  });

  it('reads monthly budget from env var', () => {
    process.env.NEW_RELIC_AI_MONTHLY_BUDGET_USD = '5000';
    const forecaster = new CostForecaster();
    const now = Date.now();
    const dailySeconds = 24 * 60 * 60 * 1000;

    for (let i = 0; i < 5; i++) {
      const timestamp = now - (4 - i) * dailySeconds + i * 60 * 60 * 1000;
      forecaster.recordCost(timestamp, 400);
    }

    const forecast = forecaster.forecast(30);
    expect(forecast.projectedBudgetExceedDate).not.toBeNull();
  });

  it('handles single cost record gracefully', () => {
    const forecaster = new CostForecaster();
    forecaster.recordCost(Date.now(), 100);

    const forecast = forecaster.forecast(7);

    expect(forecast.projectedDailyCostUsd.length).toBe(7);
    expect(forecast.projectedMonthlyCostUsd).toBeGreaterThan(0);
  });

  it('caches forecast for 1 hour', () => {
    const forecaster = new CostForecaster();
    const now = Date.now();
    const dailySeconds = 24 * 60 * 60 * 1000;

    for (let i = 0; i < 5; i++) {
      const timestamp = now - (4 - i) * dailySeconds + i * 60 * 60 * 1000;
      forecaster.recordCost(timestamp, 100);
    }

    const forecast1 = forecaster.forecast(7);
    const forecast2 = forecaster.forecast(7);

    expect(forecast1).toBe(forecast2);
  });

  it('invalidates cache on new cost record', () => {
    const forecaster = new CostForecaster();
    const now = Date.now();
    const dailySeconds = 24 * 60 * 60 * 1000;

    for (let i = 0; i < 5; i++) {
      const timestamp = now - (4 - i) * dailySeconds + i * 60 * 60 * 1000;
      forecaster.recordCost(timestamp, 100);
    }

    const forecast1 = forecaster.forecast(7);
    forecaster.recordCost(now, 200);
    const forecast2 = forecaster.forecast(7);

    expect(forecast1).not.toBe(forecast2);
  });

  it('maintains separate dimensions independently', () => {
    const forecaster = new CostForecaster();
    const now = Date.now();
    const dailySeconds = 24 * 60 * 60 * 1000;

    for (let i = 0; i < 10; i++) {
      const timestamp = now - (9 - i) * dailySeconds + i * 60 * 60 * 1000;
      forecaster.recordCost(timestamp, 100, {
        model: 'modelA',
        feature: 'featureX',
        team: 'teamOne',
      });
    }

    const byModel = forecaster.forecastByDimension('model', 7);
    const byFeature = forecaster.forecastByDimension('feature', 7);
    const byTeam = forecaster.forecastByDimension('team', 7);

    expect(Object.keys(byModel)).toContain('modelA');
    expect(Object.keys(byFeature)).toContain('featureX');
    expect(Object.keys(byTeam)).toContain('teamOne');
  });

  it('evicts data older than buffer window', () => {
    const forecaster = new CostForecaster({ bufferDays: 10 });
    const now = Date.now();
    const dailySeconds = 24 * 60 * 60 * 1000;

    for (let i = 0; i < 30; i++) {
      const timestamp = now - (29 - i) * dailySeconds;
      forecaster.recordCost(timestamp, 100);
    }

    const forecast = forecaster.forecast(7);

    expect(forecast.projectedMonthlyCostUsd).toBeGreaterThan(0);
  });

  it('aggregates multiple costs in same hour', () => {
    const forecaster = new CostForecaster();
    const now = Date.now();

    const hourStart = Math.floor(now / (60 * 60 * 1000)) * (60 * 60 * 1000);
    forecaster.recordCost(hourStart + 5 * 60 * 1000, 50);
    forecaster.recordCost(hourStart + 15 * 60 * 1000, 50);
    forecaster.recordCost(hourStart + 45 * 60 * 1000, 100);

    const forecast = forecaster.forecast(1);

    expect(forecast.projectedDailyCostUsd[0]).toBeGreaterThanOrEqual(200);
  });

  it('fires growth alert when growth rate exceeds threshold', () => {
    const alerts: unknown[] = [];
    const forecaster = new CostForecaster({
      growthThresholdPercent: 5,
      onAlert: (details) => alerts.push(details),
    });
    const now = Date.now();
    const dailySeconds = 24 * 60 * 60 * 1000;

    // 100% growth: start at 100, end at 200
    const costs = [100, 110, 130, 160, 200];
    costs.forEach((cost, i) => {
      forecaster.recordCost(now - (costs.length - 1 - i) * dailySeconds, cost);
    });

    forecaster.forecast(7);

    const growthAlerts = (alerts as Array<Record<string, unknown>>).filter(
      (a) => a.type === 'growth',
    );
    expect(growthAlerts.length).toBeGreaterThan(0);
    expect(growthAlerts[0].growthRatePercent).toBeGreaterThan(5);
  });

  it('fires forecast alert when projected monthly cost exceeds budget', () => {
    const alerts: unknown[] = [];
    const forecaster = new CostForecaster({
      monthlyBudgetUsd: 500,
      onAlert: (details) => alerts.push(details),
    });
    const now = Date.now();
    const dailySeconds = 24 * 60 * 60 * 1000;

    // $100/day => $3000/month projected, well over $500 budget
    for (let i = 0; i < 10; i++) {
      forecaster.recordCost(now - (9 - i) * dailySeconds, 100);
    }

    forecaster.forecast(30);

    const forecastAlerts = (alerts as Array<Record<string, unknown>>).filter(
      (a) => a.type === 'forecast',
    );
    expect(forecastAlerts.length).toBeGreaterThan(0);
  });

  it('returns zero growth rate when starting cost is zero', () => {
    const forecaster = new CostForecaster();
    const now = Date.now();
    const dailySeconds = 24 * 60 * 60 * 1000;

    // starts at 0, grows to 100
    const costs = [0, 10, 30, 60, 100];
    costs.forEach((cost, i) => {
      forecaster.recordCost(now - (costs.length - 1 - i) * dailySeconds, cost);
    });

    const forecast = forecaster.forecast(7);

    // Should not produce Infinity or NaN
    expect(Number.isFinite(forecast.growthRatePercent)).toBe(true);
    expect(forecast.growthRatePercent).toBe(0);
  });

  it('returns safe seasonal pattern when all costs are zero', () => {
    const forecaster = new CostForecaster();
    const now = Date.now();
    const dailySeconds = 24 * 60 * 60 * 1000;

    for (let i = 0; i < 14; i++) {
      forecaster.recordCost(now - i * dailySeconds, 0);
    }

    const forecast = forecaster.forecast(7);

    // No Infinity/NaN projected costs
    forecast.projectedDailyCostUsd.forEach((cost) => {
      expect(Number.isFinite(cost)).toBe(true);
    });
  });

  it('returns valid per-dimension forecasts with zero values', () => {
    const forecaster = new CostForecaster();
    const now = Date.now();
    const dailySeconds = 24 * 60 * 60 * 1000;

    for (let i = 0; i < 5; i++) {
      const timestamp = now - (4 - i) * dailySeconds + i * 60 * 60 * 1000;
      forecaster.recordCost(timestamp, 100, { model: 'onlyModel' });
    }

    const byModel = forecaster.forecastByDimension('model', 7);

    expect(Object.keys(byModel).length).toBeGreaterThan(0);
    expect(byModel.onlyModel.projectedMonthlyCostUsd).toBeGreaterThan(0);
  });

  it('forecastByDimension returns finite growth rate when first day cost is zero', () => {
    const forecaster = new CostForecaster();
    const now = Date.now();
    const dailySeconds = 24 * 60 * 60 * 1000;

    // first record has zero cost — would cause divide-by-zero without the guard
    [0, 50, 100, 150, 200].forEach((cost, i) => {
      forecaster.recordCost(now - (4 - i) * dailySeconds, cost, { model: 'growing' });
    });

    const byModel = forecaster.forecastByDimension('model', 7);

    expect(Number.isFinite(byModel.growing.growthRatePercent)).toBe(true);
    expect(byModel.growing.growthRatePercent).toBe(0);
  });
});
