export interface CostForecast {
  readonly elapsedMs: number;
  readonly spentUsd: number;
  readonly rateUsdPerMs: number;
  readonly forecastEndOfDayUsd: number | null;
  readonly forecastEndOfWeekUsd: number | null;
  readonly forecastSessionEndUsd: number | null;
  readonly confidenceNote: string;
}

export function buildCostForecast(
  spentUsd: number,
  sessionStartMs: number,
  nowMs: number = Date.now(),
): CostForecast {
  const elapsedMs = nowMs - sessionStartMs;
  if (elapsedMs <= 0 || spentUsd <= 0) {
    return {
      elapsedMs: 0,
      spentUsd: 0,
      rateUsdPerMs: 0,
      forecastEndOfDayUsd: null,
      forecastEndOfWeekUsd: null,
      forecastSessionEndUsd: null,
      confidenceNote: 'Insufficient data for forecast.',
    };
  }

  const rateUsdPerMs = spentUsd / elapsedMs;

  const now = new Date(nowMs);
  const endOfDay = new Date(now);
  endOfDay.setUTCHours(23, 59, 59, 999);
  const msUntilEndOfDay = endOfDay.getTime() - nowMs;
  const forecastEndOfDayUsd = spentUsd + rateUsdPerMs * msUntilEndOfDay;

  const dayOfWeek = now.getUTCDay();
  const msUntilEndOfWeek = (6 - dayOfWeek) * 86_400_000 + msUntilEndOfDay;
  const forecastEndOfWeekUsd = spentUsd + rateUsdPerMs * msUntilEndOfWeek;

  const SESSION_TARGET_MS = 8 * 60 * 60 * 1000;
  const msUntilSessionEnd = Math.max(0, SESSION_TARGET_MS - elapsedMs);
  const forecastSessionEndUsd = spentUsd + rateUsdPerMs * msUntilSessionEnd;

  const elapsedMinutes = elapsedMs / 60_000;
  const confidenceNote =
    elapsedMinutes < 10
      ? 'Low confidence — less than 10 minutes of data.'
      : elapsedMinutes < 30
        ? 'Moderate confidence — based on less than 30 minutes of data.'
        : 'Reasonable confidence — based on 30+ minutes of data.';

  return {
    elapsedMs,
    spentUsd,
    rateUsdPerMs,
    forecastEndOfDayUsd,
    forecastEndOfWeekUsd,
    forecastSessionEndUsd,
    confidenceNote,
  };
}
