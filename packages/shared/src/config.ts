import type { LogLevel } from './logger.js';

export interface AgentConfig {
  readonly licenseKey: string;
  readonly appName: string;
  readonly enabled: boolean;
  readonly recordContent: boolean;
  readonly costTrackingEnabled: boolean;
  readonly qualityTrackingEnabled: boolean;
  readonly conversationTrackingEnabled: boolean;
  readonly thinkingTrackingEnabled: boolean;
  readonly customPricingFile: string | null;
  readonly contentMaxLength: number;
  readonly highSecurity: boolean;
  readonly logLevel: LogLevel;
  readonly collectorHost: string | null;
  readonly accountId: string | null;
  readonly attributionDefaults: Record<string, string> | null;
  readonly otlpEndpoint: string | null;
  readonly otlpHeaders: Readonly<Record<string, string>>;
  readonly transport: 'nr-events-api' | 'otlp' | 'both';
}

function envBool(key: string, defaultValue: boolean): boolean {
  const val = process.env[key]?.toLowerCase();
  if (val === 'true' || val === '1') return true;
  if (val === 'false' || val === '0') return false;
  return defaultValue;
}

function envInt(key: string, defaultValue: number, bounds?: { min?: number; max?: number }): number {
  const val = process.env[key];
  if (val === undefined) return defaultValue;
  const parsed = parseInt(val, 10);
  if (Number.isNaN(parsed)) return defaultValue;
  if (bounds?.min !== undefined && parsed < bounds.min) return bounds.min;
  if (bounds?.max !== undefined && parsed > bounds.max) return bounds.max;
  return parsed;
}

function envLogLevel(key: string, defaultValue: LogLevel): LogLevel {
  const val = process.env[key]?.toLowerCase();
  if (val === 'debug' || val === 'info' || val === 'warn' || val === 'error') return val;
  return defaultValue;
}

function buildAttributionDefaults(
  overrideDefaults?: Record<string, string> | null,
): Record<string, string> | null {
  const result: Record<string, string> = {};

  // Env-var defaults for the four standard attribution fields
  const envFeature = process.env.NEW_RELIC_AI_ATTRIBUTION_FEATURE;
  const envTeam = process.env.NEW_RELIC_AI_ATTRIBUTION_TEAM;
  const envUser = process.env.NEW_RELIC_AI_ATTRIBUTION_USER;
  const envEnvironment = process.env.NEW_RELIC_AI_ATTRIBUTION_ENVIRONMENT;

  if (envFeature) result.feature = envFeature;
  if (envTeam) result.team = envTeam;
  if (envUser) result.user = envUser;
  if (envEnvironment) result.environment = envEnvironment;

  // Merge override defaults (they win over env vars)
  if (overrideDefaults) {
    for (const [k, v] of Object.entries(overrideDefaults)) {
      result[k] = v;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

function parseOtlpHeaders(headerString: string | undefined): Record<string, string> {
  if (!headerString) return {};
  const result: Record<string, string> = {};
  const pairs = headerString.split(',');
  for (const pair of pairs) {
    const [key, value] = pair.split('=');
    if (key && value) {
      result[key.trim()] = value.trim();
    }
  }
  return result;
}

export function loadConfig(overrides?: Partial<AgentConfig>): Readonly<AgentConfig> {
  const licenseKey = overrides?.licenseKey ?? process.env.NEW_RELIC_LICENSE_KEY;
  if (!licenseKey) {
    throw new Error(
      'Missing required configuration: NEW_RELIC_LICENSE_KEY. ' +
        'Set the NEW_RELIC_LICENSE_KEY environment variable or pass licenseKey in options.',
    );
  }

  const appName = overrides?.appName ?? process.env.NEW_RELIC_APP_NAME;
  if (!appName) {
    throw new Error(
      'Missing required configuration: NEW_RELIC_APP_NAME. ' +
        'Set the NEW_RELIC_APP_NAME environment variable or pass appName in options.',
    );
  }

  const accountId = overrides?.accountId ?? process.env.NEW_RELIC_ACCOUNT_ID ?? null;
  if (accountId !== null && !/^\d{1,12}$/.test(accountId)) {
    throw new Error(
      'Invalid configuration: NEW_RELIC_ACCOUNT_ID must be 1–12 decimal digits. ' +
        `Received: "${accountId}"`,
    );
  }

  const highSecurity = overrides?.highSecurity ?? envBool('NEW_RELIC_AI_HIGH_SECURITY', false);

  const recordContent = highSecurity
    ? false
    : (overrides?.recordContent ?? envBool('NEW_RELIC_AI_RECORD_CONTENT', false));

  // Build global attribution defaults from env vars and/or overrides
  const attributionDefaults = buildAttributionDefaults(overrides?.attributionDefaults);

  const config: AgentConfig = {
    licenseKey,
    appName,
    enabled: overrides?.enabled ?? envBool('NEW_RELIC_AI_ENABLED', true),
    recordContent,
    costTrackingEnabled:
      overrides?.costTrackingEnabled ?? envBool('NEW_RELIC_AI_COST_TRACKING', true),
    qualityTrackingEnabled:
      overrides?.qualityTrackingEnabled ?? envBool('NEW_RELIC_AI_QUALITY_TRACKING', true),
    conversationTrackingEnabled:
      overrides?.conversationTrackingEnabled ?? envBool('NEW_RELIC_AI_CONVERSATION_TRACKING', true),
    thinkingTrackingEnabled:
      overrides?.thinkingTrackingEnabled ?? envBool('NEW_RELIC_AI_THINKING_TRACKING', true),
    customPricingFile:
      overrides?.customPricingFile ?? process.env.NEW_RELIC_AI_CUSTOM_PRICING_FILE ?? null,
    contentMaxLength:
      overrides?.contentMaxLength ?? envInt('NEW_RELIC_AI_CONTENT_MAX_LENGTH', 4096, { min: 1, max: 1_048_576 }),
    highSecurity,
    logLevel: overrides?.logLevel ?? envLogLevel('NEW_RELIC_AI_LOG_LEVEL', 'info'),
    collectorHost: overrides?.collectorHost ?? process.env.NEW_RELIC_HOST ?? null,
    accountId,
    attributionDefaults,
    otlpEndpoint: overrides?.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null,
    otlpHeaders: overrides?.otlpHeaders ?? parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
    transport: overrides?.transport ?? 'nr-events-api',
  };

  return Object.freeze(config);
}
