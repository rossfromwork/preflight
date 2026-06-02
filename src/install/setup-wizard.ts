import { createInterface } from 'node:readline/promises';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { normalizeDeveloperName } from '../config.js';
import { runInstallCli, verifyBinaryOnPath } from './cli.js';

const DEFAULT_STORAGE_PATH = resolve(homedir(), '.nr-ai-observe');
const CONFIG_PATH = resolve(DEFAULT_STORAGE_PATH, 'config.json');

function print(msg = ''): void {
  process.stdout.write(msg + '\n');
}

function loadExisting(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export type WizardMode = 'cloud' | 'local' | 'both';

export function buildConfig(
  existing: Record<string, unknown>,
  inputs: {
    accountId: string;
    licenseKey: string;
    developer: string;
    teamId: string | null;
    projectId: string | null;
    sessionBudgetUsd: number | null;
    mode?: WizardMode;
    dashboardPort?: number | null;
  },
): Record<string, unknown> {
  const mode = inputs.mode ?? 'cloud';
  const includeNrCreds = mode !== 'local';
  return {
    ...existing,
    ...(inputs.mode ? { mode } : {}),
    ...(includeNrCreds
      ? { accountId: inputs.accountId, licenseKey: inputs.licenseKey }
      : {}),
    developer: inputs.developer,
    ...(inputs.teamId ? { teamId: inputs.teamId } : {}),
    ...(inputs.projectId ? { projectId: inputs.projectId } : {}),
    ...(inputs.sessionBudgetUsd !== null ? { sessionBudgetUsd: inputs.sessionBudgetUsd } : {}),
    ...(inputs.dashboardPort != null
      ? { dashboard: { port: inputs.dashboardPort, host: '127.0.0.1', openOnStart: false } }
      : {}),
  };
}

function parseModeAnswer(raw: string, fallback: WizardMode): WizardMode {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '' || trimmed === fallback) return fallback;
  if (trimmed === 'cloud' || trimmed === '1') return 'cloud';
  if (trimmed === 'local' || trimmed === '2') return 'local';
  if (trimmed === 'both' || trimmed === '3') return 'both';
  return fallback;
}

export async function runSetupWizard(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  print('\n=== NR AI Observatory Setup ===\n');
  print('This wizard will configure observability for your AI coding assistant.');
  print('Press Ctrl+C at any time to cancel.\n');

  const existing = loadExisting();

  // Step 0: Mode
  const existingMode =
    typeof existing.mode === 'string' &&
    (existing.mode === 'cloud' || existing.mode === 'local' || existing.mode === 'both')
      ? (existing.mode as WizardMode)
      : 'cloud';
  print('Modes:');
  print('  1) cloud — ship telemetry to New Relic (default)');
  print('  2) local — keep all data on this machine, run a local dashboard');
  print('  3) both  — ship to NR AND run the local dashboard');
  const modeRaw = await rl.question(`Which mode? [${existingMode}]: `);
  const mode = parseModeAnswer(modeRaw, existingMode);

  // Step 1+2: NR credentials (skip in local mode)
  let accountId = '';
  let licenseKey = '';
  if (mode !== 'local') {
    const existingAccountId = typeof existing.accountId === 'string' ? existing.accountId : '';
    const accountIdPrompt = existingAccountId
      ? `New Relic Account ID [${existingAccountId}]: `
      : 'New Relic Account ID: ';
    accountId = (await rl.question(accountIdPrompt)).trim();
    if (!accountId) accountId = existingAccountId;
    if (!/^\d{1,12}$/.test(accountId)) {
      console.error(`Invalid account ID: "${accountId}". Must be 1–12 digits.`);
      rl.close();
      process.exit(1);
    }

    const existingKey = typeof existing.licenseKey === 'string' ? '(already set)' : '';
    const keyPrompt = existingKey
      ? `New Relic License Key ${existingKey}: `
      : 'New Relic License Key (NEW_RELIC_LICENSE_KEY): ';
    licenseKey = (await rl.question(keyPrompt)).trim();
    if (!licenseKey && typeof existing.licenseKey === 'string') {
      licenseKey = existing.licenseKey;
    }
    if (!licenseKey) {
      console.error('License key is required.');
      rl.close();
      process.exit(1);
    }
  }

  // Step 3: Developer name
  const defaultDeveloper = typeof existing.developer === 'string'
    ? existing.developer
    : normalizeDeveloperName(process.env.USER ?? process.env.USERNAME ?? '');
  const rawInput = (await rl.question(`Developer name [${defaultDeveloper}]: `)).trim() || defaultDeveloper;
  const developer = normalizeDeveloperName(rawInput);
  if (developer !== rawInput) {
    print(`  → Normalized to: ${developer}`);
  }

  // Step 4: Optional fields
  const existingTeamId = typeof existing.teamId === 'string' ? existing.teamId : null;
  const teamIdAnswer = (await rl.question(`Team ID [${existingTeamId ?? 'optional'}]: `)).trim();
  const teamId = teamIdAnswer || existingTeamId;

  const existingProjectId = typeof existing.projectId === 'string' ? existing.projectId : null;
  const projectIdAnswer = (await rl.question(`Project ID [${existingProjectId ?? 'auto-detect from git'}]: `)).trim();
  const projectId = projectIdAnswer || existingProjectId;

  // Step 5: Budget caps
  const existingBudget = typeof existing.sessionBudgetUsd === 'number' ? String(existing.sessionBudgetUsd) : null;
  const sessionBudgetStr = (await rl.question(`Session budget USD [${existingBudget ?? 'no limit'}]: `)).trim() || (existingBudget ?? '');
  let sessionBudgetUsd: number | null = null;
  if (sessionBudgetStr) {
    const parsed = parseFloat(sessionBudgetStr);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`Invalid session budget "${sessionBudgetStr}": must be a positive number.`);
      rl.close();
      process.exit(1);
    }
    sessionBudgetUsd = parsed;
  }

  // Step 5b: Dashboard port (local/both only)
  let dashboardPort: number | null = null;
  if (mode === 'local' || mode === 'both') {
    const existingDashboard =
      existing.dashboard && typeof existing.dashboard === 'object'
        ? (existing.dashboard as { port?: number })
        : null;
    const defaultPort = existingDashboard?.port ?? 7777;
    const portStr = (
      await rl.question(`Local dashboard port (loopback only) [${defaultPort}]: `)
    ).trim();
    if (portStr) {
      const parsed = parseInt(portStr, 10);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 65536) {
        console.error(`Invalid port "${portStr}": must be 1–65535.`);
        rl.close();
        process.exit(1);
      }
      dashboardPort = parsed;
    } else {
      dashboardPort = defaultPort;
    }
  }

  // Write config
  const config = buildConfig(existing, {
    accountId,
    licenseKey,
    developer,
    teamId,
    projectId,
    sessionBudgetUsd,
    mode,
    dashboardPort,
  });

  mkdirSync(DEFAULT_STORAGE_PATH, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  print(`\nConfig written to ${CONFIG_PATH}`);

  // Step 6: Hook install
  // Config is already written above; pass no credentials to install so it only
  // wires hooks and MCP without overwriting the config we just wrote.
  const installHooks = (await rl.question('\nInstall Claude Code hooks now? [Y/n]: ')).trim().toLowerCase();
  if (installHooks !== 'n') {
    print('\nRunning hook installer...');
    await runInstallCli(['install']);
    print('Hooks installed.');

    if (verifyBinaryOnPath()) {
      print('✓ nr-ai-observe is on your PATH');
    } else {
      print('\n⚠ nr-ai-observe is not on your PATH.');
      print('  Claude Code hooks will fail with "command not found" until this is resolved.');
      print('  Fix: run `npm link` in the project directory, or install globally:');
      print('    npm install -g nr-ai-observatory');
    }
  }

  // Step 7: Dashboard deploy — show manual command (deploy-dashboard.ts is not a library)
  if (mode !== 'local') {
    print('\nTo deploy dashboards, run:');
    print(`  NEW_RELIC_API_KEY=<NRAK-...> NEW_RELIC_ACCOUNT_ID=${accountId} npx tsx scripts/deploy-dashboard.ts --all`);
    print(`\nFor a personal dashboard pre-filtered to you:`);
    print(`  NEW_RELIC_API_KEY=<NRAK-...> NEW_RELIC_ACCOUNT_ID=${accountId} npx tsx scripts/deploy-dashboard.ts ai-coding-assistant-personal.json --developer ${developer}`);

    print(`\nFor personal alerts scoped to you:`);
    print(`  NEW_RELIC_API_KEY=<NRAK-...> NEW_RELIC_ACCOUNT_ID=${accountId} npx tsx scripts/deploy-alerts.ts --developer ${developer}`);
  } else {
    print(`\nLocal mode: open the dashboard at http://127.0.0.1:${dashboardPort ?? 7777} once Claude Code starts.`);
  }

  rl.close();

  print('\n✓ Setup complete. Start the MCP server with:');
  print('  nr-ai-mcp-server --stdio\n');
}
