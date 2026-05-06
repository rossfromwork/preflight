import { createInterface } from 'node:readline/promises';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { sanitizeDeveloper } from '../config.js';
import { runInstallCli } from './cli.js';

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

export function buildConfig(
  existing: Record<string, unknown>,
  inputs: {
    accountId: string;
    licenseKey: string;
    developer: string;
    teamId: string | null;
    projectId: string | null;
    sessionBudgetUsd: number | null;
  },
): Record<string, unknown> {
  return {
    ...existing,
    accountId: inputs.accountId,
    licenseKey: inputs.licenseKey,
    developer: inputs.developer,
    ...(inputs.teamId ? { teamId: inputs.teamId } : {}),
    ...(inputs.projectId ? { projectId: inputs.projectId } : {}),
    ...(inputs.sessionBudgetUsd !== null ? { sessionBudgetUsd: inputs.sessionBudgetUsd } : {}),
  };
}

export async function runSetupWizard(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  print('\n=== NR AI Observatory Setup ===\n');
  print('This wizard will configure observability for your AI coding assistant.');
  print('Press Ctrl+C at any time to cancel.\n');

  const existing = loadExisting();

  // Step 1: Account ID
  const existingAccountId = typeof existing.accountId === 'string' ? existing.accountId : '';
  const accountIdPrompt = existingAccountId
    ? `New Relic Account ID [${existingAccountId}]: `
    : 'New Relic Account ID: ';
  let accountId = (await rl.question(accountIdPrompt)).trim();
  if (!accountId) accountId = existingAccountId;
  if (!/^\d{1,12}$/.test(accountId)) {
    console.error(`Invalid account ID: "${accountId}". Must be 1–12 digits.`);
    rl.close();
    process.exit(1);
  }

  // Step 2: License key
  const existingKey = typeof existing.licenseKey === 'string' ? '(already set)' : '';
  const keyPrompt = existingKey
    ? `New Relic License Key ${existingKey}: `
    : 'New Relic License Key (NEW_RELIC_LICENSE_KEY): ';
  let licenseKey = (await rl.question(keyPrompt)).trim();
  if (!licenseKey && typeof existing.licenseKey === 'string') {
    licenseKey = existing.licenseKey;
  }
  if (!licenseKey) {
    console.error('License key is required.');
    rl.close();
    process.exit(1);
  }

  // Step 3: Developer name
  const defaultDeveloper = typeof existing.developer === 'string'
    ? existing.developer
    : (process.env.USER ?? process.env.USERNAME ?? '');
  const developer = sanitizeDeveloper(
    (await rl.question(`Developer name [${defaultDeveloper}]: `)).trim() || defaultDeveloper,
  );

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

  // Write config
  const config = buildConfig(existing, { accountId, licenseKey, developer, teamId, projectId, sessionBudgetUsd });

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
  }

  // Step 7: Dashboard deploy — show manual command (deploy-dashboard.ts is not a library)
  print('\nTo deploy dashboards, run:');
  print(`  NEW_RELIC_API_KEY=<NRAK-...> NEW_RELIC_ACCOUNT_ID=${accountId} npx tsx scripts/deploy-dashboard.ts --all`);

  rl.close();

  print('\n✓ Setup complete. Start the MCP server with:');
  print('  nr-ai-mcp-server --stdio\n');
}
