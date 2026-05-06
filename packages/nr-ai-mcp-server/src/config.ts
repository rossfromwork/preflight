import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '@nr-ai-observatory/shared';
import type { LogLevel } from '@nr-ai-observatory/shared';
import type { CliOptions } from './types.js';
import type { UpstreamConfig } from './proxy/types.js';

const logger = createLogger('mcp-config');

export interface McpServerConfig {
  readonly licenseKey: string;
  readonly accountId: string;
  readonly appName: string;
  readonly developer: string;
  readonly teamId: string | null;
  readonly projectId: string | null;
  readonly orgId: string | null;
  readonly model: string;
  readonly enabled: boolean;
  readonly highSecurity: boolean;
  readonly recordContent: boolean;
  readonly redactionPatterns: readonly RegExp[];
  readonly hookBufferPath: string;
  readonly storagePath: string;
  readonly harvestIntervalMs: { readonly events: number; readonly metrics: number };
  readonly sessionBudgetUsd: number | null;
  readonly dailyBudgetUsd: number | null;
  readonly weeklyBudgetUsd: number | null;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly collectorHost: string | null;
  readonly proxyUpstreams: readonly UpstreamConfig[];
  readonly nrApiKey: string | null;
  readonly digestWebhookUrl: string | null;
  readonly digestSchedule: string; // cron expression, default: "0 9 * * 1" (Monday 9am)
  readonly retainSessionsDays: number | null;
}

const DEFAULT_STORAGE_PATH = resolve(homedir(), '.nr-ai-observe');

const DEFAULT_REDACTION_PATTERNS: RegExp[] = [
  /\b(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|PRIVATE_KEY)\b[\s]*[=:]\s*\S+/gi,
  /(?:sk-|ghp_|gho_|github_pat_|xoxb-|xoxp-|Bearer\s+)\S+/g,
  /-----BEGIN[\s\S]{0,65536}?-----END[^\n]{0,256}-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIzaSy[0-9A-Za-z_-]{33}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bxox[a-z]-[0-9A-Za-z-]+/g,
];

// N-07: strip control chars and truncate before the value reaches any NR event field or log
export function sanitizeDeveloper(raw: string): string {
  return raw.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 128) || 'unknown';
}

function sanitizeOrgField(value: string | null | undefined): string | null {
  if (!value) return null;
  const sanitized = value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 128);
  return sanitized || null;
}

function inferDeveloper(): string {
  if (process.env.USER) return sanitizeDeveloper(process.env.USER);
  if (process.env.USERNAME) return sanitizeDeveloper(process.env.USERNAME);
  try {
    return sanitizeDeveloper(execSync('git config user.name', { encoding: 'utf-8', timeout: 2000 }).trim());
  } catch {
    return 'unknown';
  }
}

function inferProjectId(): string | null {
  try {
    const remote = execSync('git remote get-url origin', {
      encoding: 'utf-8',
      timeout: 2000,
    }).trim();
    // Extract "org/repo" from HTTPS or SSH remotes:
    // https://github.com/org/repo.git  → org/repo
    // git@github.com:org/repo.git      → org/repo
    const match = remote.match(/[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
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

function loadConfigFile(filePath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    logger.warn('Failed to parse config file — ignoring', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

function resolveCollectorHost(
  licenseKey: string,
  explicit: string | null,
): string | null {
  if (explicit) return explicit;
  if (licenseKey.toLowerCase().startsWith('eu01')) {
    return 'eu';
  }
  return null;
}

function isValidUpstream(u: unknown): u is UpstreamConfig {
  if (typeof u !== 'object' || u === null) return false;
  const obj = u as Record<string, unknown>;
  if (typeof obj.name !== 'string') return false;
  if (obj.transportType !== 'http' && obj.transportType !== 'stdio') return false;
  if (obj.transportType === 'http' && typeof obj.url !== 'string') return false;
  if (obj.transportType === 'stdio' && typeof obj.command !== 'string') return false;
  return true;
}

function parseProxyUpstreams(
  envValue: string | undefined,
  fileValue: unknown,
): readonly UpstreamConfig[] {
  // Env var takes precedence (JSON string)
  if (envValue) {
    try {
      const parsed = JSON.parse(envValue);
      if (!Array.isArray(parsed)) {
        logger.warn(
          'NEW_RELIC_AI_MCP_PROXY_UPSTREAMS must be a JSON array — ignoring env var value',
        );
      } else {
        const valid = parsed.filter((u: unknown) => {
          if (isValidUpstream(u)) return true;
          logger.warn('Skipping invalid proxy upstream entry (missing name, transportType, or url/command)', { entry: u });
          return false;
        });
        return valid as UpstreamConfig[];
      }
    } catch {
      logger.warn('Invalid JSON in NEW_RELIC_AI_MCP_PROXY_UPSTREAMS env var');
    }
  }
  // Config file
  if (Array.isArray(fileValue)) {
    const valid = fileValue.filter((u: unknown) => {
      if (isValidUpstream(u)) return true;
      logger.warn('Skipping invalid proxy upstream entry (missing name, transportType, or url/command)', { entry: u });
      return false;
    });
    return valid as UpstreamConfig[];
  }
  return [];
}

export function loadMcpConfig(cliOptions?: Partial<CliOptions>): Readonly<McpServerConfig> {
  const configFilePath = cliOptions?.config ?? resolve(DEFAULT_STORAGE_PATH, 'config.json');
  const file = loadConfigFile(configFilePath);

  // --- licenseKey: CLI has no flag for this, so env > file ---
  const licenseKey =
    process.env.NEW_RELIC_LICENSE_KEY ??
    (typeof file.licenseKey === 'string' ? file.licenseKey : undefined);
  if (!licenseKey) {
    throw new Error(
      'Missing required configuration: licenseKey. ' +
        'Set the NEW_RELIC_LICENSE_KEY environment variable or add "licenseKey" to ' +
        configFilePath +
        '.',
    );
  }

  // --- accountId: env > file ---
  const accountId =
    process.env.NEW_RELIC_ACCOUNT_ID ??
    (typeof file.accountId === 'string' ? file.accountId : undefined);
  if (!accountId) {
    throw new Error(
      'Missing required configuration: accountId. ' +
        'Set the NEW_RELIC_ACCOUNT_ID environment variable or add "accountId" to ' +
        configFilePath +
        '.',
    );
  }
  if (!/^\d{1,12}$/.test(accountId)) {
    throw new Error(
      'Invalid configuration: accountId must be 1–12 decimal digits. ' +
        `Received: "${accountId}"`,
    );
  }

  // --- Build config with priority: CLI > env > file > defaults ---
  const storagePath =
    process.env.NEW_RELIC_AI_MCP_STORAGE_PATH ??
    (typeof file.storagePath === 'string' ? file.storagePath : DEFAULT_STORAGE_PATH);

  // N-10: highSecurity must be resolved before recordContent so it can override it
  const highSecurity = envBool(
    'NEW_RELIC_AI_HIGH_SECURITY',
    typeof file.highSecurity === 'boolean' ? file.highSecurity : false,
  );

  const config: McpServerConfig = {
    licenseKey,
    accountId,

    appName:
      process.env.NEW_RELIC_AI_MCP_APP_NAME ??
      (typeof file.appName === 'string' ? file.appName : 'nr-ai-mcp-server'),

    model:
      process.env.NEW_RELIC_AI_MODEL ??
      (typeof file.model === 'string' ? file.model : 'claude-sonnet-4-6'),

    developer: sanitizeDeveloper(
      process.env.NEW_RELIC_AI_MCP_DEVELOPER ??
      (typeof file.developer === 'string' ? file.developer : inferDeveloper()),
    ),

    teamId: sanitizeOrgField(
      process.env.NEW_RELIC_AI_TEAM_ID ??
      (typeof file.teamId === 'string' ? file.teamId : null),
    ),

    projectId: sanitizeOrgField(
      process.env.NEW_RELIC_AI_PROJECT_ID ??
      (typeof file.projectId === 'string' ? file.projectId : inferProjectId()),
    ),

    orgId: sanitizeOrgField(
      process.env.NEW_RELIC_AI_ORG_ID ??
      (typeof file.orgId === 'string' ? file.orgId : null),
    ),

    enabled:
      envBool('NEW_RELIC_AI_MCP_ENABLED', typeof file.enabled === 'boolean' ? file.enabled : true),

    highSecurity,

    // N-10: highSecurity forces recordContent off regardless of other settings
    recordContent: highSecurity ? false : envBool(
      'NEW_RELIC_AI_MCP_RECORD_CONTENT',
      typeof file.recordContent === 'boolean' ? file.recordContent : false,
    ),

    redactionPatterns: DEFAULT_REDACTION_PATTERNS,

    hookBufferPath:
      process.env.NEW_RELIC_AI_MCP_BUFFER_PATH ??
      (typeof file.hookBufferPath === 'string'
        ? file.hookBufferPath
        : resolve(storagePath, 'buffer.jsonl')),

    storagePath,

    harvestIntervalMs: {
      events: envInt(
        'NEW_RELIC_AI_MCP_HARVEST_EVENTS_MS',
        typeof file.harvestEventsMs === 'number' ? file.harvestEventsMs : 5000,
        { min: 100, max: 3_600_000 },
      ),
      metrics: envInt(
        'NEW_RELIC_AI_MCP_HARVEST_METRICS_MS',
        typeof file.harvestMetricsMs === 'number' ? file.harvestMetricsMs : 60000,
        { min: 100, max: 3_600_000 },
      ),
    },

    sessionBudgetUsd: (() => {
      const raw = process.env.NEW_RELIC_AI_SESSION_BUDGET_USD;
      if (raw) { const v = parseFloat(raw); if (Number.isFinite(v) && v > 0) return v; }
      return typeof file.sessionBudgetUsd === 'number' ? file.sessionBudgetUsd : null;
    })(),

    dailyBudgetUsd: (() => {
      const raw = process.env.NEW_RELIC_AI_DAILY_BUDGET_USD;
      if (raw) { const v = parseFloat(raw); if (Number.isFinite(v) && v > 0) return v; }
      return typeof file.dailyBudgetUsd === 'number' ? file.dailyBudgetUsd : null;
    })(),

    weeklyBudgetUsd: (() => {
      const raw = process.env.NEW_RELIC_AI_WEEKLY_BUDGET_USD;
      if (raw) { const v = parseFloat(raw); if (Number.isFinite(v) && v > 0) return v; }
      return typeof file.weeklyBudgetUsd === 'number' ? file.weeklyBudgetUsd : null;
    })(),

    port: cliOptions?.port ?? envInt(
      'NEW_RELIC_AI_MCP_PORT',
      typeof file.port === 'number' ? file.port : 9847,
      { min: 1, max: 65535 },
    ),

    logLevel: cliOptions?.logLevel ?? envLogLevel(
      'NEW_RELIC_AI_MCP_LOG_LEVEL',
      typeof file.logLevel === 'string' &&
        ['debug', 'info', 'warn', 'error'].includes(file.logLevel)
        ? (file.logLevel as LogLevel)
        : 'info',
    ),

    collectorHost: resolveCollectorHost(
      licenseKey,
      process.env.NEW_RELIC_HOST ??
        (typeof file.collectorHost === 'string' ? file.collectorHost : null),
    ),

    proxyUpstreams: parseProxyUpstreams(
      process.env.NEW_RELIC_AI_MCP_PROXY_UPSTREAMS,
      file.proxyUpstreams,
    ),

    nrApiKey:
      process.env.NEW_RELIC_API_KEY ??
      (typeof file.nrApiKey === 'string' ? file.nrApiKey : null),

    digestWebhookUrl:
      process.env.NEW_RELIC_AI_DIGEST_WEBHOOK_URL ??
      (typeof file.digestWebhookUrl === 'string' ? file.digestWebhookUrl : null),

    digestSchedule:
      process.env.NEW_RELIC_AI_DIGEST_SCHEDULE ??
      (typeof file.digestSchedule === 'string' ? file.digestSchedule : '0 9 * * 1'),

    retainSessionsDays: (() => {
      const raw = process.env.NEW_RELIC_AI_RETAIN_SESSIONS_DAYS;
      if (raw) {
        const v = parseInt(raw, 10);
        if (Number.isFinite(v) && v > 0) return v;
      }
      return typeof file.retainSessionsDays === 'number' ? file.retainSessionsDays : null;
    })(),
  };

  logger.debug('Configuration loaded', {
    appName: config.appName,
    developer: config.developer,
    teamId: config.teamId,
    projectId: config.projectId,
    orgId: config.orgId,
    enabled: config.enabled,
    highSecurity: config.highSecurity,
    recordContent: config.recordContent,
    storagePath: config.storagePath,
    port: config.port,
    collectorHost: config.collectorHost ?? 'us (default)',
    sessionBudgetUsd: config.sessionBudgetUsd,
    dailyBudgetUsd: config.dailyBudgetUsd,
    weeklyBudgetUsd: config.weeklyBudgetUsd,
  });

  return Object.freeze(config);
}

const MAX_REDACT_LEN = 1_048_576; // 1 MB

export function redactSensitive(value: string, patterns?: readonly RegExp[]): string {
  const pats = patterns ?? DEFAULT_REDACTION_PATTERNS;
  let result = value.length > MAX_REDACT_LEN ? value.slice(0, MAX_REDACT_LEN) : value;
  for (const pattern of pats) {
    // Clone the regex to reset lastIndex for global patterns
    const re = new RegExp(pattern.source, pattern.flags);
    result = result.replace(re, '[REDACTED]');
  }
  return result;
}
