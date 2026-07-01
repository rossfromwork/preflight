#!/usr/bin/env tsx
/**
 * Demo data generator for Preflight.
 *
 * Produces realistic multi-day, multi-platform session data without using
 * any real AI tokens. Writes session files to the Preflight storage directory
 * and injects live buffer events for one "in-progress" session so the Today
 * page shows a mix of completed and live activity.
 *
 * Usage:
 *   npx tsx scripts/generate-demo-data.ts
 *   npx tsx scripts/generate-demo-data.ts --developer alice_smith
 *   npx tsx scripts/generate-demo-data.ts --clear        # remove demo data only
 *   npx tsx scripts/generate-demo-data.ts --days 5       # sessions across 5 days
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const STORAGE_PATH = resolve(homedir(), '.newrelic-preflight');
const SESSIONS_DIR = resolve(STORAGE_PATH, 'sessions');
const DEVELOPER = opt('--developer', process.env.USER ?? 'demo_user');
const DAYS_BACK = parseInt(opt('--days', '3'), 10);
const CLEAR_ONLY = flag('--clear');
const DEMO_TAG = 'DEMO_GENERATED'; // marker in sessionName for cleanup

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(d: number, hour = 9, min = 0): number {
  const t = new Date();
  t.setDate(t.getDate() - d);
  t.setHours(hour, min, 0, 0);
  return t.getTime();
}

function dateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number, dp = 4): number {
  return parseFloat((Math.random() * (max - min) + min).toFixed(dp));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

// ---------------------------------------------------------------------------
// Session builder
// ---------------------------------------------------------------------------

interface SessionSpec {
  name: string;
  platform: string;
  model: string;
  startDaysAgo: number;
  startHour: number;
  durationMin: number;
  toolBreakdown: Record<string, number>;
  efficiencyScore: number;
  estimatedCostUsd: number;
  tokensInput: number;
  tokensOutput: number;
  linesAdded: number;
  linesRemoved: number;
  antiPatterns?: Array<{ type: string; count: number }>;
  testRunCount?: number;
  testPassCount?: number;
  buildRunCount?: number;
  buildPassCount?: number;
  taskCount?: number;
  repoName?: string;
}

const PROJECT_FILES = [
  'src/components/Dashboard.tsx',
  'src/hooks/useMetrics.ts',
  'src/api/client.ts',
  'src/utils/formatter.ts',
  'src/pages/Overview.tsx',
  'tests/dashboard.test.ts',
  'tests/api.test.ts',
  'src/config/settings.ts',
  'src/services/alerts.ts',
  'src/models/session.ts',
  'terraform/main.tf',
  'terraform/variables.tf',
  '.github/workflows/ci.yml',
  'src/lib/nr-client.ts',
  'src/lib/telemetry.ts',
];

function buildTimeline(
  spec: SessionSpec,
  startTs: number,
): Array<{
  timestamp: number;
  toolName: string;
  durationMs: number;
  success: boolean;
  filePath?: string;
  command?: string;
  isTestCommand?: boolean;
  isBuildCommand?: boolean;
}> {
  const entries = [];
  let ts = startTs + 5000;
  const totalCalls = Object.values(spec.toolBreakdown).reduce((a, b) => a + b, 0);
  const durationPerCall = (spec.durationMin * 60000) / totalCalls;

  for (const [tool, count] of Object.entries(spec.toolBreakdown)) {
    for (let i = 0; i < count; i++) {
      const dur = randInt(50, 3500);
      const entry: (typeof entries)[0] = {
        timestamp: ts,
        toolName: tool,
        durationMs: dur,
        success: Math.random() > 0.05,
      };
      if (tool === 'Read' || tool === 'Write' || tool === 'Edit') {
        entry.filePath = pick(PROJECT_FILES);
      }
      if (tool === 'Bash') {
        const cmds = ['npm test', 'npm run build', 'git status', 'terraform plan', 'grep -r'];
        entry.command = pick(cmds);
        entry.isTestCommand = entry.command === 'npm test';
        entry.isBuildCommand = entry.command === 'npm run build';
      }
      entries.push(entry);
      ts += durationPerCall + randInt(-500, 500);
    }
  }
  return entries;
}

function buildSession(spec: SessionSpec): [string, string, object] {
  const sessionId = randomUUID();
  const startTs = daysAgo(spec.startDaysAgo, spec.startHour);
  const endTs = startTs + spec.durationMin * 60 * 1000;
  const totalCalls = Object.values(spec.toolBreakdown).reduce((a, b) => a + b, 0);

  const antiPatterns = (spec.antiPatterns ?? []).map((ap) => ({
    type: ap.type,
    count: ap.count,
    ts: startTs + randInt(60000, spec.durationMin * 60000 - 60000),
    taskId: randomUUID().slice(0, 8),
    tool: ap.type === 'stuck_loop' ? 'Bash' : ap.type === 'blind_edit' ? 'Edit' : 'Read',
    ...(ap.type === 'stuck_loop' && { iterations: ap.count + 1 }),
    ...(ap.type === 'thrashing_reads' && { readCount: ap.count + 2 }),
    ...(ap.type === 'blind_edit' && { editCount: ap.count }),
  }));

  const writeCount = (spec.toolBreakdown['Write'] ?? 0) + (spec.toolBreakdown['Edit'] ?? 0);
  const readCount = spec.toolBreakdown['Read'] ?? 0;

  const session = {
    sessionId,
    sessionName: `${spec.name} [${DEMO_TAG}]`,
    repoName: spec.repoName ?? 'nr-platform',
    startTime: startTs,
    endTime: endTs,
    durationMs: endTs - startTs,
    toolCallCount: totalCalls,
    developer: DEVELOPER,
    model: spec.model,
    platform: spec.platform,
    toolBreakdown: spec.toolBreakdown,
    filesRead: Array.from({ length: Math.min(readCount, 8) }, () => pick(PROJECT_FILES)),
    filesModified: Array.from({ length: Math.min(writeCount, 5) }, () => pick(PROJECT_FILES)),
    linesAdded: spec.linesAdded,
    linesRemoved: spec.linesRemoved,
    bashCommandCount: spec.toolBreakdown['Bash'] ?? 0,
    testRunCount: spec.testRunCount ?? 0,
    testPassCount: spec.testPassCount ?? 0,
    buildRunCount: spec.buildRunCount ?? 0,
    buildPassCount: spec.buildPassCount ?? 0,
    estimatedCostUsd: spec.estimatedCostUsd,
    tokensInput: spec.tokensInput,
    tokensOutput: spec.tokensOutput,
    tokensThinking: 0,
    efficiencyScore: spec.efficiencyScore,
    antiPatterns,
    taskCount: spec.taskCount ?? randInt(1, 4),
    taskSuccessRate: randFloat(0.7, 1.0, 2),
    toolSuccessRate: randFloat(0.9, 1.0, 2),
    contextCompressions: Math.random() > 0.7 ? 1 : 0,
    agentSpawns: 0,
    userMessages: randInt(4, 18),
    assistantMessages: randInt(4, 18),
    userCorrections: randInt(0, 2),
    outcome: 'completed' as const,
    timeline: buildTimeline(spec, startTs),
  };

  const filename = `${dateKey(startTs)}_${sessionId}.json`;
  return [filename, sessionId, session];
}

// ---------------------------------------------------------------------------
// Session definitions — the "story" for the demo
// ---------------------------------------------------------------------------

const SESSION_SPECS: SessionSpec[] = [
  // ── 2 days ago ────────────────────────────────────────────────────────────
  {
    name: 'auth-service-refactor',
    platform: 'claude-code',
    model: 'claude-sonnet-4-6',
    startDaysAgo: 2,
    startHour: 9,
    durationMin: 47,
    toolBreakdown: { Read: 8, Write: 6, Edit: 12, Bash: 8 },
    efficiencyScore: 0.78,
    estimatedCostUsd: 0.89,
    tokensInput: 48000,
    tokensOutput: 12000,
    linesAdded: 184,
    linesRemoved: 67,
    testRunCount: 3,
    testPassCount: 3,
    buildRunCount: 2,
    buildPassCount: 2,
    taskCount: 3,
    repoName: 'nr-auth-service',
  },
  {
    name: 'dashboard-api-design',
    platform: 'claude-code',
    model: 'claude-opus-4-6',
    startDaysAgo: 2,
    startHour: 11,
    durationMin: 68,
    toolBreakdown: { Read: 12, Write: 8, Edit: 4, Bash: 4, Agent: 2 },
    efficiencyScore: 0.85,
    estimatedCostUsd: 5.2,
    tokensInput: 120000,
    tokensOutput: 28000,
    linesAdded: 312,
    linesRemoved: 45,
    testRunCount: 2,
    testPassCount: 2,
    taskCount: 2,
    repoName: 'nr-dashboard',
  },
  {
    name: 'infra-cost-analysis',
    platform: 'cursor',
    model: 'claude-sonnet-4-6',
    startDaysAgo: 2,
    startHour: 14,
    durationMin: 35,
    toolBreakdown: { Read: 14, Grep: 8, Bash: 6 },
    efficiencyScore: 0.91,
    estimatedCostUsd: 0.54,
    tokensInput: 28000,
    tokensOutput: 8000,
    linesAdded: 0,
    linesRemoved: 0,
    taskCount: 1,
    repoName: 'nr-infra',
  },

  // ── Yesterday ─────────────────────────────────────────────────────────────
  {
    name: 'terraform-module-setup',
    platform: 'cursor',
    model: 'claude-sonnet-4-6',
    startDaysAgo: 1,
    startHour: 9,
    durationMin: 38,
    toolBreakdown: { Read: 6, Write: 10, Edit: 8, Bash: 4 },
    efficiencyScore: 0.72,
    estimatedCostUsd: 0.62,
    tokensInput: 32000,
    tokensOutput: 10000,
    linesAdded: 220,
    linesRemoved: 18,
    antiPatterns: [{ type: 'blind_edit', count: 1 }],
    buildRunCount: 3,
    buildPassCount: 2,
    taskCount: 2,
    repoName: 'nr-infra',
  },
  {
    name: 'ai-feature-integration',
    platform: 'antigravity',
    model: 'gemini-3.1-pro',
    startDaysAgo: 1,
    startHour: 10,
    durationMin: 31,
    toolBreakdown: { Read: 6, Write: 8, Edit: 4, Bash: 4, AskPermission: 1 },
    efficiencyScore: 0.63,
    estimatedCostUsd: 0.0,
    tokensInput: 0,
    tokensOutput: 0,
    linesAdded: 148,
    linesRemoved: 22,
    taskCount: 2,
    repoName: 'nr-ai-features',
  },
  {
    name: 'performance-debug-session',
    platform: 'claude-code',
    model: 'claude-sonnet-4-6',
    startDaysAgo: 1,
    startHour: 13,
    durationMin: 54,
    toolBreakdown: { Bash: 22, Read: 14, Edit: 8, Grep: 6 },
    efficiencyScore: 0.48,
    estimatedCostUsd: 1.34,
    tokensInput: 72000,
    tokensOutput: 18000,
    linesAdded: 94,
    linesRemoved: 38,
    antiPatterns: [
      { type: 'stuck_loop', count: 3 },
      { type: 'thrashing_reads', count: 2 },
    ],
    testRunCount: 8,
    testPassCount: 5,
    taskCount: 1,
    repoName: 'nr-platform',
  },
  {
    name: 'frontend-component-build',
    platform: 'windsurf',
    model: 'gemini-2.5-flash',
    startDaysAgo: 1,
    startHour: 15,
    durationMin: 29,
    toolBreakdown: { Write: 8, Edit: 10, Read: 4, Bash: 4 },
    efficiencyScore: 0.81,
    estimatedCostUsd: 0.04,
    tokensInput: 18000,
    tokensOutput: 6000,
    linesAdded: 196,
    linesRemoved: 44,
    testRunCount: 2,
    testPassCount: 2,
    taskCount: 3,
    repoName: 'nr-dashboard',
  },
  {
    name: 'security-audit-review',
    platform: 'claude-code',
    model: 'claude-opus-4-6',
    startDaysAgo: 1,
    startHour: 16,
    durationMin: 42,
    toolBreakdown: { Read: 18, Grep: 12, Bash: 4, Write: 2 },
    efficiencyScore: 0.87,
    estimatedCostUsd: 3.8,
    tokensInput: 88000,
    tokensOutput: 22000,
    linesAdded: 12,
    linesRemoved: 8,
    taskCount: 1,
    repoName: 'nr-security',
  },

  // ── Today (completed earlier) ──────────────────────────────────────────────
  {
    name: 'monitoring-alerts-config',
    platform: 'claude-code',
    model: 'claude-sonnet-4-6',
    startDaysAgo: 0,
    startHour: 8,
    durationMin: 42,
    toolBreakdown: { Write: 8, Edit: 10, Read: 8, Bash: 5 },
    efficiencyScore: 0.83,
    estimatedCostUsd: 0.78,
    tokensInput: 42000,
    tokensOutput: 11000,
    linesAdded: 167,
    linesRemoved: 34,
    testRunCount: 4,
    testPassCount: 4,
    buildRunCount: 1,
    buildPassCount: 1,
    taskCount: 3,
    repoName: 'nr-platform',
  },
  {
    name: 'code-review-pr-247',
    platform: 'claude-code',
    model: 'claude-sonnet-4-6',
    startDaysAgo: 0,
    startHour: 10,
    durationMin: 22,
    toolBreakdown: { Read: 14, Grep: 6, Bash: 2 },
    efficiencyScore: 0.93,
    estimatedCostUsd: 0.39,
    tokensInput: 20000,
    tokensOutput: 5500,
    linesAdded: 0,
    linesRemoved: 0,
    taskCount: 1,
    repoName: 'nr-auth-service',
  },
  {
    name: 'agentic-research-spike',
    platform: 'antigravity',
    model: 'gemini-3.1-pro',
    startDaysAgo: 0,
    startHour: 11,
    durationMin: 28,
    toolBreakdown: { Read: 8, Write: 4, Bash: 4, AskPermission: 1, TaskManage: 1 },
    efficiencyScore: 0.7,
    estimatedCostUsd: 0.0,
    tokensInput: 0,
    tokensOutput: 0,
    linesAdded: 88,
    linesRemoved: 12,
    taskCount: 2,
    repoName: 'nr-ai-features',
  },
];

// ---------------------------------------------------------------------------
// Live buffer injection — one "in-progress" session for the Today live tail
// ---------------------------------------------------------------------------

function buildLiveBufferEvents(sessionId: string): string[] {
  const now = Date.now();
  const cwd = `/Users/${DEVELOPER}/projects/nr-platform`;
  const lines: string[] = [];

  const calls: Array<{ tool: string; input: object; output: object; dur: number }> = [
    {
      tool: 'Read',
      input: { file_path: 'src/api/client.ts' },
      output: { content_length: 2840 },
      dur: 82,
    },
    {
      tool: 'Read',
      input: { file_path: 'src/hooks/useMetrics.ts' },
      output: { content_length: 1620 },
      dur: 64,
    },
    {
      tool: 'Bash',
      input: { command: 'npm test -- --testPathPattern=metrics' },
      output: { exitCode: 0 },
      dur: 4200,
    },
    {
      tool: 'Edit',
      input: { file_path: 'src/hooks/useMetrics.ts', old_string: 'any', new_string: 'unknown' },
      output: { success: true },
      dur: 120,
    },
    {
      tool: 'Write',
      input: { file_path: 'src/api/types.ts', content: '// generated types' },
      output: { success: true },
      dur: 95,
    },
  ];

  let ts = now - calls.reduce((s, c) => s + c.dur + randInt(500, 2000), 0) - 30000;
  const toolUseIds = calls.map(() => `live_${randomUUID().slice(0, 8)}`);

  for (let i = 0; i < calls.length; i++) {
    const c = calls[i]!;
    const toolUseId = toolUseIds[i]!;
    const preTs = ts;
    const postTs = ts + c.dur;

    lines.push(
      JSON.stringify({
        mode: 'pre',
        tool: c.tool,
        timestamp: preTs,
        inputSize: JSON.stringify(c.input).length,
        inputHash: randomUUID().slice(0, 16),
        toolInput: c.input,
        sessionId,
        cwd,
        toolUseId,
        session_name: 'nr-platform',
        platform: 'claude-code',
      }),
    );
    lines.push(
      JSON.stringify({
        mode: 'post',
        tool: c.tool,
        timestamp: postTs,
        outputSize: 512,
        success: true,
        toolOutput: c.output,
        sessionId,
        cwd,
        toolUseId,
        session_name: 'nr-platform',
        platform: 'claude-code',
      }),
    );

    ts = postTs + randInt(800, 3000);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Clear demo data
// ---------------------------------------------------------------------------

function clearDemoData(): number {
  if (!existsSync(SESSIONS_DIR)) return 0;
  const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  let removed = 0;
  for (const file of files) {
    const p = resolve(SESSIONS_DIR, file);
    try {
      const data = JSON.parse(readFileSync(p, 'utf-8'));
      if (typeof data.sessionName === 'string' && data.sessionName.includes(DEMO_TAG)) {
        unlinkSync(p);
        removed++;
      }
    } catch {
      // skip malformed files
    }
  }
  // Also remove any demo buffer files
  const storageFiles = readdirSync(STORAGE_PATH).filter((f) => f.startsWith('buffer-demo-'));
  for (const f of storageFiles) {
    unlinkSync(resolve(STORAGE_PATH, f));
    removed++;
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  console.log('\n🚀 Preflight Demo Data Generator\n');

  mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });

  if (CLEAR_ONLY) {
    const removed = clearDemoData();
    console.log(`✓ Removed ${removed} demo session file(s)\n`);
    return;
  }

  // Clear existing demo data first
  const cleared = clearDemoData();
  if (cleared > 0) console.log(`  Cleared ${cleared} existing demo file(s)`);

  // Filter specs to the requested number of days
  const specs = SESSION_SPECS.filter((s) => s.startDaysAgo < DAYS_BACK);

  console.log(`  Developer:  ${DEVELOPER}`);
  console.log(`  Days:       ${DAYS_BACK}`);
  console.log(`  Sessions:   ${specs.length}\n`);

  const writtenFiles: string[] = [];
  const summary: Record<string, number> = {};

  for (const spec of specs) {
    const [filename, , session] = buildSession(spec);
    const filepath = resolve(SESSIONS_DIR, filename);
    writeFileSync(filepath, JSON.stringify(session, null, 2) + '\n', { mode: 0o600 });
    writtenFiles.push(filename);

    const key = `${spec.platform}/${spec.model}`;
    summary[key] = (summary[key] ?? 0) + 1;

    const eff = (spec.efficiencyScore * 100).toFixed(0);
    const cost =
      spec.estimatedCostUsd > 0 ? `$${spec.estimatedCostUsd.toFixed(2)}` : '(quota-based)';
    const aps = spec.antiPatterns?.length ? ` ⚠ ${spec.antiPatterns.length} anti-pattern(s)` : '';
    const dLabel =
      spec.startDaysAgo === 0
        ? 'today'
        : spec.startDaysAgo === 1
          ? 'yesterday'
          : `${spec.startDaysAgo}d ago`;
    console.log(
      `  ✓ [${dLabel.padEnd(9)}] ${spec.name.padEnd(32)} ${spec.platform.padEnd(14)} ${spec.model.padEnd(22)} eff=${eff}% cost=${cost}${aps}`,
    );
  }

  // Inject live buffer for one in-progress session today
  const liveSessionId = randomUUID();
  const bufferPath = resolve(STORAGE_PATH, `buffer-${liveSessionId}.jsonl`);
  const bufferLines = buildLiveBufferEvents(liveSessionId);
  writeFileSync(bufferPath, bufferLines.join('\n') + '\n', { mode: 0o600 });
  console.log(
    `\n  ✓ [live      ] active-feature-work                    claude-code     claude-sonnet-4-6      (in progress)`,
  );

  // Print summary
  console.log('\n─────────────────────────────────────────────────────────');
  console.log('  Platform breakdown:');
  for (const [key, count] of Object.entries(summary)) {
    console.log(`    ${key.padEnd(40)} ${count} session(s)`);
  }

  const totalCost = specs.reduce((s, sp) => s + sp.estimatedCostUsd, 0);
  const totalCalls = specs.reduce(
    (s, sp) => s + Object.values(sp.toolBreakdown).reduce((a, b) => a + b, 0),
    0,
  );
  const avgEff = specs.reduce((s, sp) => s + sp.efficiencyScore, 0) / specs.length;

  console.log(`\n  Total sessions:    ${specs.length + 1} (${specs.length} historical + 1 live)`);
  console.log(`  Total tool calls:  ${totalCalls}`);
  console.log(`  Total cost:        $${totalCost.toFixed(2)}`);
  console.log(`  Avg efficiency:    ${(avgEff * 100).toFixed(0)}%`);

  console.log(`\n✅ Done! Open http://localhost:7777 to see the demo data.`);
  console.log(`   Run with --clear to remove all generated sessions.\n`);
}

main();
