import type { TransportOptions, TransportResult } from './types.js';
import { sendWithRetry, resolveRegion, getLogsApiUrl } from './http-client.js';

export interface NrLogEntry {
  timestamp: number;
  message: string;
  attributes?: Record<string, string | number | boolean>;
}

export async function sendLogs(
  logs: NrLogEntry[],
  licenseKey: string,
  options: TransportOptions,
): Promise<TransportResult> {
  if (logs.length === 0) {
    return { success: true, statusCode: null, retryCount: 0 };
  }

  const region = resolveRegion(licenseKey, options.collectorHost ?? null);
  const url = getLogsApiUrl(region);

  return sendWithRetry({
    url,
    body: [{ logs }],
    licenseKey,
    maxRetries: options.maxRetries ?? 3,
    baseDelayMs: options.baseDelayMs ?? 1000,
    maxDelayMs: options.maxDelayMs ?? 30_000,
  });
}
