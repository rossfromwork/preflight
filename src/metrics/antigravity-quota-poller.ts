import { exec } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import { promisify } from 'node:util';
import { createLogger } from '../shared/index.js';
import { resolveModelPricing } from '../shared/pricing.js';

const execAsync = promisify(exec);
const logger = createLogger('antigravity-quota-poller');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgyModelQuota {
  /** Raw internal ID from agy (e.g. MODEL_PLACEHOLDER_M132) */
  readonly modelId: string;
  /** Human-readable label from agy (e.g. "Gemini 3.5 Flash (High)") */
  readonly label?: string;
  /** Pricing-table-compatible key resolved from label (e.g. "gemini-3.1-pro") */
  readonly resolvedModelId?: string;
  readonly remainingFraction: number;
  readonly resetTime?: string;
}

export interface AgyQuotaSnapshot {
  readonly timestamp: number;
  /** Remaining prompt credits (Gemini free-tier "turns") */
  readonly promptCreditsRemaining: number;
  /** Total monthly prompt credit allowance */
  readonly promptCreditsTotal: number;
  /** Per-model quota fractions */
  readonly models: readonly AgyModelQuota[];
}

export interface AgyQuotaDelta {
  readonly elapsedMs: number;
  /** Credits consumed since the baseline snapshot */
  readonly creditsConsumed: number;
  /** Best-effort estimated input tokens (heuristic: credits × avg tokens/turn) */
  readonly estimatedInputTokens: number;
  /** Best-effort estimated output tokens */
  readonly estimatedOutputTokens: number;
  /** Estimated cost in USD using Preflight pricing tables */
  readonly estimatedCostUsd: number;
  /** Primary model inferred from largest quota drop */
  readonly primaryModelId: string | null;
}

interface AgyProcessInfo {
  readonly pid: number;
  readonly csrfToken?: string;
  readonly commandLine: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Heuristic average tokens per Gemini prompt credit (one "turn").
// One credit covers one user→model→response round trip. Average turn sizes
// vary widely (short questions vs. multi-file codegen). These defaults are
// intentionally conservative to avoid over-reporting cost — better to show
// a slight underestimate than a surprise overage. Tune in config if needed.
const DEFAULT_AVG_INPUT_TOKENS_PER_CREDIT = 1_500;
const DEFAULT_AVG_OUTPUT_TOKENS_PER_CREDIT = 400;

const CONNECT_PROBE_PATH = '/exa.language_server_pb.LanguageServerService/GetUnleashData';
const CONNECT_STATUS_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
const CONNECT_VALID_STATUSES = new Set([200, 401]);
const PROBE_TIMEOUT_MS = 500;
const REQUEST_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// Model label → pricing table key mapping
// ---------------------------------------------------------------------------

// agy returns human-readable labels alongside opaque MODEL_PLACEHOLDER_* IDs.
// This map translates stripped labels to keys that resolveModelPricing() understands.
// Keys follow Preflight's pricing-data.ts naming (src/shared is vendored — not editable).
// Note: "Gemini 3.5 Flash" is not a publicly documented model name at the knowledge
// cutoff; the mapping to gemini-3.1-pro is a best-effort approximation.
const AGY_LABEL_MODEL_MAP: Record<string, string> = {
  // Gemini models
  'Gemini 3.5 Flash': 'gemini-3.1-pro', // approximate — closest documented equivalent
  'Gemini 3.1 Pro': 'gemini-3.1-pro', // → alias to gemini-3.1-pro-preview
  'Gemini 3.1 Flash Lite': 'gemini-3.1-flash-lite',
  'Gemini 3 Flash': 'gemini-3-flash', // → alias to gemini-3-flash-preview
  'Gemini 2.5 Pro': 'gemini-2.5-pro',
  'Gemini 2.5 Flash': 'gemini-2.5-flash',
  'Gemini 2.5 Flash Lite': 'gemini-2.5-flash-lite',
  'Gemini 2.0 Flash': 'gemini-2.0-flash',
  'Gemini 1.5 Pro': 'gemini-1.5-pro',
  'Gemini 1.5 Flash': 'gemini-1.5-flash',
  // Claude models available via agy (resolve via prefix matching in shared pricing)
  'Claude Sonnet 4.6': 'claude-sonnet-4-6',
  'Claude Opus 4.6': 'claude-opus-4-6',
  'Claude Sonnet 4.5': 'claude-sonnet-4-5',
  'Claude Haiku 4.5': 'claude-haiku-4-5',
  // GPT-OSS models — not in Preflight pricing table, use label as identifier
  // so the model name still surfaces correctly in the dashboard
  'GPT-OSS 120B': 'gpt-oss-120b',
};

// Quality/speed tier suffixes agy appends to label strings
const LABEL_TIER_SUFFIXES = [
  ' (High)',
  ' (Medium)',
  ' (Low)',
  ' (Thinking)',
  ' (Fast)',
  ' (Balanced)',
];

function resolveModelIdFromLabel(label: string): string | null {
  // Strip tier suffix first
  let base = label;
  for (const suffix of LABEL_TIER_SUFFIXES) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }
  const direct = AGY_LABEL_MODEL_MAP[base];
  if (direct) return direct;
  // Secondary: try Preflight's prefix matching via kebab-case conversion
  const kebab = base.toLowerCase().replace(/\s+/g, '-');
  return resolveModelPricing(kebab) ? kebab : null;
}

// ---------------------------------------------------------------------------
// Process detection
// ---------------------------------------------------------------------------

async function detectAgyProcess(): Promise<AgyProcessInfo | null> {
  try {
    const { stdout } = await execAsync('ps aux');
    for (const line of stdout.split('\n')) {
      const lower = line.toLowerCase();

      // Match: explicit language-server mode (IDE extension, has --csrf_token)
      // OR: bare `agy` CLI (interactive terminal session — no extra flags)
      const isLanguageServer =
        lower.includes('antigravity') &&
        (line.includes('--csrf_token') ||
          line.includes('language-server') ||
          line.includes('lsp') ||
          line.includes('exa.language_server_pb'));

      const parts = line.trim().split(/\s+/);
      const command = parts[10] ?? '';
      const isBareAgy = /\bagy\b/.test(command) && parts.length >= 11;

      if (!isLanguageServer && !isBareAgy) continue;

      const pid = parseInt(parts[1], 10);
      if (isNaN(pid)) continue;

      const commandLine = parts.slice(10).join(' ');
      const csrfToken = extractArg(commandLine, '--csrf_token') ?? undefined;

      logger.debug('Detected agy process', { pid, hasCsrf: !!csrfToken, isBareAgy });
      return { pid, csrfToken, commandLine };
    }
  } catch (err) {
    logger.debug('Process detection failed', { err: String(err) });
  }
  return null;
}

function extractArg(commandLine: string, argName: string): string | null {
  const eqMatch = commandLine.match(new RegExp(`${argName}=([^\\s"']+|"[^"]*"|'[^']*')`, 'i'));
  if (eqMatch) return eqMatch[1].replace(/^["']|["']$/g, '');
  const spaceMatch = commandLine.match(
    new RegExp(`${argName}\\s+([^\\s"']+|"[^"]*"|'[^']*')`, 'i'),
  );
  if (spaceMatch) return spaceMatch[1].replace(/^["']|["']$/g, '');
  return null;
}

// ---------------------------------------------------------------------------
// Port discovery
// ---------------------------------------------------------------------------

async function discoverAgyPorts(pid: number): Promise<number[]> {
  try {
    // macOS: lsof lists open listening sockets for the process
    const { stdout } = await execAsync(
      `lsof -Pan -p ${pid} -i TCP -sTCP:LISTEN 2>/dev/null || true`,
    );
    const ports: number[] = [];
    for (const line of stdout.split('\n')) {
      const match = line.match(/:(\d+)\s*\(LISTEN\)/);
      if (match) {
        const port = parseInt(match[1], 10);
        if (!isNaN(port) && !ports.includes(port)) ports.push(port);
      }
    }
    return ports;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Connect RPC HTTP helpers
// ---------------------------------------------------------------------------

function connectPost(
  baseUrl: string,
  path: string,
  body: unknown,
  csrfToken: string | undefined,
  timeoutMs: number,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const bodyStr = JSON.stringify(body);
    const isHttps = baseUrl.startsWith('https://');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(bodyStr)),
      'Connect-Protocol-Version': '1',
    };
    if (csrfToken) headers['X-Codeium-Csrf-Token'] = csrfToken;

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers,
      timeout: timeoutMs,
      rejectUnauthorized: false,
    };

    const protocol = isHttps ? https : http;
    const req = protocol.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => {
        raw += chunk.toString();
      });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode ?? 0, data: raw });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });

    req.write(bodyStr);
    req.end();
  });
}

async function probeConnectPort(
  port: number,
  csrfToken: string | undefined,
): Promise<string | null> {
  for (const scheme of ['https', 'http']) {
    const baseUrl = `${scheme}://127.0.0.1:${port}`;
    try {
      const { status } = await connectPost(
        baseUrl,
        CONNECT_PROBE_PATH,
        { wrapper_data: {} },
        csrfToken,
        PROBE_TIMEOUT_MS,
      );
      if (CONNECT_VALID_STATUSES.has(status)) {
        logger.debug('Found Connect API', { baseUrl, status });
        return baseUrl;
      }
    } catch {
      // Try next
    }
  }
  return null;
}

async function findConnectBaseUrl(
  ports: number[],
  csrfToken: string | undefined,
): Promise<string | null> {
  const results = await Promise.all(ports.map((p) => probeConnectPort(p, csrfToken)));
  return results.find((r) => r !== null) ?? null;
}

// ---------------------------------------------------------------------------
// GetUserStatus → QuotaSnapshot
// ---------------------------------------------------------------------------

async function fetchQuotaSnapshot(
  baseUrl: string,
  csrfToken: string | undefined,
): Promise<AgyQuotaSnapshot | null> {
  try {
    const { status, data } = await connectPost(
      baseUrl,
      CONNECT_STATUS_PATH,
      { metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } },
      csrfToken,
      REQUEST_TIMEOUT_MS,
    );

    if (status < 200 || status >= 300) {
      logger.debug('GetUserStatus non-2xx', { status });
      return null;
    }

    return parseUserStatusResponse(data);
  } catch (err) {
    logger.debug('GetUserStatus request failed', { err: String(err) });
    return null;
  }
}

function parseUserStatusResponse(response: unknown): AgyQuotaSnapshot | null {
  if (typeof response !== 'object' || response === null) return null;
  const d = response as Record<string, unknown>;

  // Response may be nested under 'userStatus'
  const userStatus = (d.userStatus as Record<string, unknown>) ?? d;

  let promptCreditsRemaining = 0;
  let promptCreditsTotal = 0;

  const planStatus = userStatus.planStatus as Record<string, unknown> | undefined;
  if (planStatus) {
    const available = planStatus.availablePromptCredits;
    const planInfo = planStatus.planInfo as Record<string, unknown> | undefined;
    const monthly = planInfo?.monthlyPromptCredits;
    if (typeof available === 'number') promptCreditsRemaining = available;
    if (typeof monthly === 'number') promptCreditsTotal = monthly;
  }

  const models: AgyModelQuota[] = [];
  const cascadeData = userStatus.cascadeModelConfigData as Record<string, unknown> | undefined;
  const clientConfigs = cascadeData?.clientModelConfigs;
  if (Array.isArray(clientConfigs)) {
    for (const cfg of clientConfigs) {
      if (typeof cfg !== 'object' || cfg === null) continue;
      const c = cfg as Record<string, unknown>;
      const modelOrAlias = c.modelOrAlias as Record<string, unknown> | undefined;
      const modelId = typeof modelOrAlias?.model === 'string' ? modelOrAlias.model : null;
      if (!modelId) continue;

      const quotaInfo = c.quotaInfo as Record<string, unknown> | undefined;
      const remainingFraction =
        typeof quotaInfo?.remainingFraction === 'number' ? quotaInfo.remainingFraction : 1;
      const resetTime = typeof quotaInfo?.resetTime === 'string' ? quotaInfo.resetTime : undefined;
      const label = typeof c.label === 'string' ? c.label : undefined;
      const resolvedModelId = label ? (resolveModelIdFromLabel(label) ?? undefined) : undefined;

      models.push({ modelId, label, resolvedModelId, remainingFraction, resetTime });
    }
  }

  return { timestamp: Date.now(), promptCreditsRemaining, promptCreditsTotal, models };
}

// ---------------------------------------------------------------------------
// Delta calculation
// ---------------------------------------------------------------------------

function computeDelta(baseline: AgyQuotaSnapshot, current: AgyQuotaSnapshot): AgyQuotaDelta | null {
  const elapsedMs = current.timestamp - baseline.timestamp;
  if (elapsedMs <= 0) return null;

  const creditsConsumed = Math.max(
    0,
    baseline.promptCreditsRemaining - current.promptCreditsRemaining,
  );

  // Infer the primary model from the largest fraction drop.
  // Prefer resolvedModelId (pricing key) over raw placeholder for cost lookups.
  let primaryModelId: string | null = null;
  let maxDrop = 0;
  for (const curr of current.models) {
    const prev = baseline.models.find((m) => m.modelId === curr.modelId);
    if (!prev) continue;
    const drop = prev.remainingFraction - curr.remainingFraction;
    if (drop > maxDrop) {
      maxDrop = drop;
      primaryModelId = curr.resolvedModelId ?? curr.label ?? curr.modelId;
    }
  }

  // Estimate tokens: credits consumed × average tokens per turn
  const estimatedInputTokens = creditsConsumed * DEFAULT_AVG_INPUT_TOKENS_PER_CREDIT;
  const estimatedOutputTokens = creditsConsumed * DEFAULT_AVG_OUTPUT_TOKENS_PER_CREDIT;

  // Estimate cost using pricing table for the primary model
  let estimatedCostUsd = 0;
  if (primaryModelId && (estimatedInputTokens > 0 || estimatedOutputTokens > 0)) {
    const pricing = resolveModelPricing(primaryModelId);
    if (pricing) {
      estimatedCostUsd =
        (estimatedInputTokens * pricing.inputPerMTok) / 1_000_000 +
        (estimatedOutputTokens * pricing.outputPerMTok) / 1_000_000;
    }
  }

  return {
    elapsedMs,
    creditsConsumed,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedCostUsd,
    primaryModelId,
  };
}

// ---------------------------------------------------------------------------
// AntigravityQuotaPoller
// ---------------------------------------------------------------------------

export interface AntigravityQuotaPollerOptions {
  pollIntervalMs?: number;
}

export type QuotaSnapshotCallback = (
  snapshot: AgyQuotaSnapshot,
  delta: AgyQuotaDelta | null,
) => void;

export class AntigravityQuotaPoller {
  private readonly pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private baselineSnapshot: AgyQuotaSnapshot | null = null;
  private cachedBaseUrl: string | null = null;
  private cachedCsrfToken: string | undefined;

  constructor(options: AntigravityQuotaPollerOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
  }

  start(onSnapshot: QuotaSnapshotCallback): void {
    if (this.timer !== null) return;
    logger.info('Starting quota poller', { pollIntervalMs: this.pollIntervalMs });

    // Fire once immediately, then on interval
    void this.poll(onSnapshot);
    this.timer = setInterval(() => void this.poll(onSnapshot), this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('Quota poller stopped');
  }

  private async poll(onSnapshot: QuotaSnapshotCallback): Promise<void> {
    try {
      const baseUrl = await this.resolveBaseUrl();
      if (!baseUrl) {
        logger.debug('agy Connect API not reachable — skipping poll');
        return;
      }

      const snapshot = await fetchQuotaSnapshot(baseUrl, this.cachedCsrfToken);
      if (!snapshot) return;

      const delta = this.baselineSnapshot ? computeDelta(this.baselineSnapshot, snapshot) : null;

      if (!this.baselineSnapshot) {
        this.baselineSnapshot = snapshot;
        logger.info('Quota baseline captured', {
          credits: snapshot.promptCreditsRemaining,
          total: snapshot.promptCreditsTotal,
          models: snapshot.models.length,
        });
      }

      onSnapshot(snapshot, delta);
    } catch (err) {
      logger.debug('Quota poll error', { err: String(err) });
    }
  }

  private async resolveBaseUrl(): Promise<string | null> {
    // Use cached URL if still reachable
    if (this.cachedBaseUrl) {
      try {
        const { status } = await connectPost(
          this.cachedBaseUrl,
          CONNECT_PROBE_PATH,
          { wrapper_data: {} },
          this.cachedCsrfToken,
          PROBE_TIMEOUT_MS,
        );
        if (CONNECT_VALID_STATUSES.has(status)) return this.cachedBaseUrl;
      } catch {
        // Cache stale — re-detect below
        this.cachedBaseUrl = null;
      }
    }

    const processInfo = await detectAgyProcess();
    if (!processInfo) return null;

    this.cachedCsrfToken = processInfo.csrfToken;
    const ports = await discoverAgyPorts(processInfo.pid);
    if (ports.length === 0) return null;

    const baseUrl = await findConnectBaseUrl(ports, processInfo.csrfToken);
    if (baseUrl) this.cachedBaseUrl = baseUrl;
    return baseUrl;
  }
}
