#!/usr/bin/env tsx
/**
 * Demo data generator for Preflight.
 *
 * Produces realistic multi-day, multi-platform session data without using
 * any real AI tokens. Includes git activity, high-cost sessions, and a live
 * simulation mode that keeps writing buffer events while running.
 *
 * Usage:
 *   npm run demo-data                         # generate historical sessions
 *   npm run demo-data -- --live              # live simulation (Ctrl+C to stop)
 *   npm run demo-data -- --developer alice   # custom developer name
 *   npm run demo-data -- --days 5            # more days of history
 *   npm run demo-data -- --clear             # remove all demo data
 */

import {
  writeFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  readFileSync,
} from 'node:fs';
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
const LIVE_MODE = flag('--live');
const LIVE_DURATION_S = parseInt(opt('--duration', '300'), 10); // 5 min default
const DEMO_TAG = 'DEMO_GENERATED';

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
// Data pools
// ---------------------------------------------------------------------------

const PROJECT_FILES = [
  'src/components/Dashboard.tsx',
  'src/hooks/useMetrics.ts',
  'src/api/client.ts',
  'src/utils/formatter.ts',
  'src/pages/Overview.tsx',
  'src/services/alerts.ts',
  'src/models/session.ts',
  'tests/dashboard.test.ts',
  'tests/api.test.ts',
  'terraform/main.tf',
  'terraform/variables.tf',
  'src/lib/nr-client.ts',
  'src/lib/telemetry.ts',
];

const GIT_COMMANDS = [
  'git commit -m "feat: add monitoring dashboard components"',
  'git commit -m "fix: resolve API authentication timeout"',
  'git commit -m "refactor: extract shared telemetry utilities"',
  'git commit -m "test: add coverage for alert service"',
  'git push origin feature/monitoring-v2',
  'git push origin main',
  'git pull origin main',
  'git checkout -b feature/perf-improvements',
  'git diff HEAD~1 --stat',
  'git log --oneline -10',
  'git stash',
  'git stash pop',
];

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
  gitCommands?: number; // number of git commands in this session
  antiPatterns?: Array<{ type: string; count: number }>;
  testRunCount?: number;
  testPassCount?: number;
  buildRunCount?: number;
  buildPassCount?: number;
  taskCount?: number;
  repoName?: string;
}

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

  // Inject git commands into Bash calls
  let gitSlots = spec.gitCommands ?? 0;
  const bashCount = spec.toolBreakdown['Bash'] ?? 0;
  const gitPerBash = bashCount > 0 ? gitSlots / bashCount : 0;
  let gitAccum = 0;

  for (const [tool, count] of Object.entries(spec.toolBreakdown)) {
    for (let i = 0; i < count; i++) {
      const dur = randInt(50, 3500);
      const entry: (typeof entries)[0] = {
        timestamp: ts,
        toolName: tool,
        durationMs: dur,
        success: Math.random() > 0.04,
      };
      if (tool === 'Read' || tool === 'Write' || tool === 'Edit') {
        entry.filePath = pick(PROJECT_FILES);
      }
      if (tool === 'Bash') {
        gitAccum += gitPerBash;
        if (gitAccum >= 1 && gitSlots > 0) {
          // This bash call is a git command
          entry.command = pick(GIT_COMMANDS);
          gitAccum -= 1;
          gitSlots--;
        } else {
          const cmds = [
            'npm test',
            'npm run build',
            'npm run lint',
            'terraform plan',
            'terraform apply -auto-approve',
            'grep -rn "TODO" src/',
            'find src -name "*.ts" | wc -l',
          ];
          entry.command = pick(cmds);
          entry.isTestCommand = entry.command.startsWith('npm test');
          entry.isBuildCommand = entry.command === 'npm run build';
        }
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
// Session definitions
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
    gitCommands: 3,
    testRunCount: 3,
    testPassCount: 3,
    buildRunCount: 2,
    buildPassCount: 2,
    taskCount: 3,
    repoName: 'nr-auth-service',
  },
  {
    // HIGH COST: Opus doing complex architecture work
    name: 'platform-architecture-redesign',
    platform: 'claude-code',
    model: 'claude-opus-4-6',
    startDaysAgo: 2,
    startHour: 10,
    durationMin: 280,
    toolBreakdown: { Read: 48, Write: 22, Edit: 18, Bash: 14, Agent: 6, Grep: 12 },
    efficiencyScore: 0.72,
    estimatedCostUsd: 187.4,
    tokensInput: 4200000,
    tokensOutput: 980000,
    linesAdded: 1240,
    linesRemoved: 380,
    gitCommands: 8,
    testRunCount: 6,
    testPassCount: 5,
    buildRunCount: 4,
    buildPassCount: 4,
    taskCount: 8,
    repoName: 'nr-platform-core',
    antiPatterns: [{ type: 'thrashing_reads', count: 4 }],
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
    gitCommands: 2,
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
    toolBreakdown: { Read: 6, Write: 10, Edit: 8, Bash: 6 },
    efficiencyScore: 0.72,
    estimatedCostUsd: 0.62,
    tokensInput: 32000,
    tokensOutput: 10000,
    linesAdded: 220,
    linesRemoved: 18,
    gitCommands: 4,
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
    gitCommands: 2,
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
    gitCommands: 1,
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
    gitCommands: 3,
    testRunCount: 2,
    testPassCount: 2,
    taskCount: 3,
    repoName: 'nr-dashboard',
  },
  {
    // HIGH COST: Opus doing security audit + remediation
    name: 'security-audit-and-remediation',
    platform: 'claude-code',
    model: 'claude-opus-4-6',
    startDaysAgo: 1,
    startHour: 16,
    durationMin: 195,
    toolBreakdown: { Read: 36, Grep: 24, Bash: 18, Edit: 14, Write: 8 },
    efficiencyScore: 0.84,
    estimatedCostUsd: 124.8,
    tokensInput: 2800000,
    tokensOutput: 640000,
    linesAdded: 342,
    linesRemoved: 188,
    gitCommands: 6,
    testRunCount: 4,
    testPassCount: 4,
    taskCount: 5,
    repoName: 'nr-security',
  },

  // ── Today (completed) ──────────────────────────────────────────────────────
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
    gitCommands: 4,
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
    gitCommands: 2,
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
    gitCommands: 2,
    taskCount: 2,
    repoName: 'nr-ai-features',
  },
];

// ---------------------------------------------------------------------------
// Live simulation
// ---------------------------------------------------------------------------

interface LiveSession {
  id: string;
  name: string;
  platform: string;
  model: string;
  cwd: string;
  bufferPath: string;
  // Pricing: inputPerMTok, outputPerMTok
  inputRate: number;
  outputRate: number;
  callCount: number;
  totalCostUsd: number;
  sprintFactor: number; // multiplier for token volume (1=normal, 5=heavy)
}

const LIVE_SESSION_SPECS: Omit<LiveSession, 'id' | 'bufferPath' | 'callCount' | 'totalCostUsd'>[] =
  [
    {
      name: 'ai-observability-platform',
      platform: 'claude-code',
      model: 'claude-opus-4-6',
      cwd: `/Users/${DEVELOPER}/projects/nr-observability`,
      inputRate: 5.0,
      outputRate: 25.0,
      sprintFactor: 8, // HEAVY — this one hits $100s fast
    },
    {
      name: 'data-pipeline-refactor',
      platform: 'claude-code',
      model: 'claude-sonnet-4-6',
      cwd: `/Users/${DEVELOPER}/projects/nr-pipelines`,
      inputRate: 3.0,
      outputRate: 15.0,
      sprintFactor: 3,
    },
    {
      name: 'terraform-cloud-migration',
      platform: 'cursor',
      model: 'claude-sonnet-4-6',
      cwd: `/Users/${DEVELOPER}/projects/nr-infra`,
      inputRate: 3.0,
      outputRate: 15.0,
      sprintFactor: 2,
    },
    {
      name: 'agent-workflow-research',
      platform: 'antigravity',
      model: 'gemini-3.1-pro',
      cwd: `/Users/${DEVELOPER}/projects/nr-agents`,
      inputRate: 2.0,
      outputRate: 10.0,
      sprintFactor: 2,
    },
    {
      name: 'frontend-dashboard-rebuild',
      platform: 'windsurf',
      model: 'gemini-2.5-flash',
      cwd: `/Users/${DEVELOPER}/projects/nr-dashboard`,
      inputRate: 0.075,
      outputRate: 0.3,
      sprintFactor: 4,
    },
    {
      name: 'security-compliance-scan',
      platform: 'claude-code',
      model: 'claude-opus-4-6',
      cwd: `/Users/${DEVELOPER}/projects/nr-security`,
      inputRate: 5.0,
      outputRate: 25.0,
      sprintFactor: 5, // Also heavy
    },
  ];

const LIVE_TOOLS: Record<string, string[]> = {
  'claude-code': ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent'],
  cursor: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
  antigravity: ['Read', 'Write', 'Edit', 'Bash', 'AskPermission'],
  windsurf: ['Read', 'Edit', 'Write', 'Bash'],
};

const LIVE_BASH_CMDS = [
  'npm test',
  'npm run build',
  'npm run lint',
  'git commit -m "feat: improve performance"',
  'git push origin feature/live-work',
  'git pull origin main',
  'terraform plan',
  'grep -rn "TODO" src/',
  'jest --coverage',
  'eslint src/ --fix',
];

function appendBufferEvent(bufferPath: string, event: object): void {
  appendFileSync(bufferPath, JSON.stringify(event) + '\n');
}

function emitToolCallPair(session: LiveSession): void {
  const now = Date.now();
  const tools = LIVE_TOOLS[session.platform] ?? ['Read', 'Write', 'Bash'];
  const tool = pick(tools);
  const toolUseId = `live_${randomUUID().slice(0, 8)}`;
  const dur = randInt(80, 4000);

  const input: Record<string, unknown> = {};
  const output: Record<string, unknown> = { success: true };
  if (tool === 'Read' || tool === 'Write' || tool === 'Edit') {
    input.file_path = pick(PROJECT_FILES);
    if (tool === 'Write') input.content = '// updated';
  }
  if (tool === 'Bash') {
    input.command = pick(LIVE_BASH_CMDS);
    output.exitCode = 0;
  }

  const base = {
    sessionId: session.id,
    cwd: session.cwd,
    toolUseId,
    session_name: session.name,
    platform: session.platform,
  };

  appendBufferEvent(session.bufferPath, {
    mode: 'pre',
    tool,
    timestamp: now - dur,
    inputSize: 256,
    inputHash: randomUUID().slice(0, 16),
    toolInput: input,
    ...base,
  });
  appendBufferEvent(session.bufferPath, {
    mode: 'post',
    tool,
    timestamp: now,
    outputSize: 512,
    success: true,
    toolOutput: output,
    ...base,
  });
}

function emitTokenEvent(session: LiveSession): void {
  const baseInputK = randInt(8, 32) * session.sprintFactor;
  const baseOutputK = randInt(2, 8) * session.sprintFactor;
  const inputTokens = baseInputK * 1000;
  const outputTokens = baseOutputK * 1000;
  const cost = (inputTokens * session.inputRate + outputTokens * session.outputRate) / 1_000_000;

  session.totalCostUsd += cost;

  appendBufferEvent(session.bufferPath, {
    mode: 'token',
    timestamp: Date.now(),
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    model: session.model,
    sessionId: session.id,
  });
}

function runLiveSimulation(): void {
  console.log('\n🎬 Live simulation mode — press Ctrl+C to stop\n');
  console.log(
    `  Simulating ${LIVE_SESSION_SPECS.length} concurrent sessions for up to ${LIVE_DURATION_S}s\n`,
  );

  // Create live sessions
  const sessions: LiveSession[] = LIVE_SESSION_SPECS.map((spec) => {
    const id = randomUUID();
    const bufferPath = resolve(STORAGE_PATH, `buffer-${id}.jsonl`);
    const session: LiveSession = { id, bufferPath, callCount: 0, totalCostUsd: 0, ...spec };
    writeFileSync(bufferPath, '', { mode: 0o600 });

    console.log(`  ▶ ${spec.name.padEnd(35)} ${spec.platform.padEnd(14)} ${spec.model}`);
    return session;
  });

  console.log(`\n  Tick every ~2s. High-cost sessions (⚡) will trigger budget alerts.\n`);
  console.log(`  Session                              Platform       Cost so far`);
  console.log(`  ${'─'.repeat(70)}`);

  const startTime = Date.now();
  let tick = 0;

  const interval = setInterval(() => {
    tick++;
    const elapsed = (Date.now() - startTime) / 1000;

    // Each tick: emit 1-3 tool call pairs + 1 token event per session
    for (const session of sessions) {
      const callsThisTick = randInt(1, 3);
      for (let i = 0; i < callsThisTick; i++) {
        emitToolCallPair(session);
        session.callCount += callsThisTick;
      }
      // Token events every 3 ticks
      if (tick % 3 === 0) {
        emitTokenEvent(session);
      }
    }

    // Print status every 10 ticks (~20s)
    if (tick % 10 === 0) {
      process.stdout.write('\x1B[2K\r'); // clear line
      for (const session of sessions) {
        const costStr = session.totalCostUsd > 0 ? `$${session.totalCostUsd.toFixed(2)}` : '$0.00';
        const alert =
          session.totalCostUsd > 50 ? ' ⚡ HIGH' : session.totalCostUsd > 10 ? ' ⚠' : '';
        console.log(
          `  ${session.name.padEnd(35)} ${session.platform.padEnd(14)} ${costStr.padStart(10)}${alert}`,
        );
      }
      const totalCost = sessions.reduce((s, sess) => s + sess.totalCostUsd, 0);
      const totalCalls = sessions.reduce((s, sess) => s + sess.callCount, 0);
      console.log(
        `\n  Elapsed: ${elapsed.toFixed(0)}s | Calls: ${totalCalls} | Total cost: $${totalCost.toFixed(2)}\n`,
      );
    }

    // Stop after duration
    if (elapsed >= LIVE_DURATION_S) {
      clearInterval(interval);
      cleanup(sessions);
    }
  }, 2000);

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    clearInterval(interval);
    cleanup(sessions);
    process.exit(0);
  });

  // Keep process alive
  process.stdin.resume();
}

function cleanup(sessions: LiveSession[]): void {
  console.log('\n\n  Cleaning up live session buffers...');
  for (const session of sessions) {
    if (existsSync(session.bufferPath)) {
      unlinkSync(session.bufferPath);
    }
  }
  const totalCost = sessions.reduce((s, sess) => s + sess.totalCostUsd, 0);
  console.log(`  Done. Final cost simulated: $${totalCost.toFixed(2)}\n`);
}

// ---------------------------------------------------------------------------
// Clear demo data
// ---------------------------------------------------------------------------

function clearDemoData(): number {
  if (!existsSync(SESSIONS_DIR)) return 0;
  let removed = 0;
  for (const file of readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'))) {
    const p = resolve(SESSIONS_DIR, file);
    try {
      const data = JSON.parse(readFileSync(p, 'utf-8'));
      if (typeof data.sessionName === 'string' && data.sessionName.includes(DEMO_TAG)) {
        unlinkSync(p);
        removed++;
      }
    } catch {
      // skip
    }
  }
  // Remove any stale live buffers
  for (const f of readdirSync(STORAGE_PATH).filter((f) => f.startsWith('buffer-demo-'))) {
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

  if (LIVE_MODE) {
    runLiveSimulation();
    return;
  }

  const cleared = clearDemoData();
  if (cleared > 0) console.log(`  Cleared ${cleared} existing demo file(s)`);

  const specs = SESSION_SPECS.filter((s) => s.startDaysAgo < DAYS_BACK);
  console.log(`  Developer: ${DEVELOPER}  |  Days: ${DAYS_BACK}  |  Sessions: ${specs.length}\n`);

  const summary: Record<string, number> = {};

  for (const spec of specs) {
    const [filename, , session] = buildSession(spec);
    writeFileSync(resolve(SESSIONS_DIR, filename), JSON.stringify(session, null, 2) + '\n', {
      mode: 0o600,
    });

    const key = `${spec.platform}/${spec.model}`;
    summary[key] = (summary[key] ?? 0) + 1;

    const eff = (spec.efficiencyScore * 100).toFixed(0);
    const cost =
      spec.estimatedCostUsd > 50
        ? `💰 $${spec.estimatedCostUsd.toFixed(2)} HIGH`
        : spec.estimatedCostUsd > 0
          ? `$${spec.estimatedCostUsd.toFixed(2)}`
          : '(quota-based)';
    const aps = spec.antiPatterns?.length ? ` ⚠ ${spec.antiPatterns.length} pattern(s)` : '';
    const git = spec.gitCommands ? ` 🔀 ${spec.gitCommands} git` : '';
    const dLabel =
      spec.startDaysAgo === 0
        ? 'today'
        : spec.startDaysAgo === 1
          ? 'yesterday'
          : `${spec.startDaysAgo}d ago`;
    console.log(
      `  ✓ [${dLabel.padEnd(9)}] ${spec.name.padEnd(38)} ${spec.platform.padEnd(14)} eff=${eff}% cost=${cost}${aps}${git}`,
    );
  }

  console.log('\n─────────────────────────────────────────────────────────────────────');
  const totalCost = specs.reduce((s, sp) => s + sp.estimatedCostUsd, 0);
  const totalCalls = specs.reduce(
    (s, sp) => s + Object.values(sp.toolBreakdown).reduce((a, b) => a + b, 0),
    0,
  );
  const avgEff = specs.reduce((s, sp) => s + sp.efficiencyScore, 0) / specs.length;
  const highCost = specs.filter((s) => s.estimatedCostUsd > 50);

  console.log(
    `\n  Sessions: ${specs.length}  |  Tool calls: ${totalCalls}  |  Total cost: $${totalCost.toFixed(2)}  |  Avg efficiency: ${(avgEff * 100).toFixed(0)}%`,
  );
  if (highCost.length) {
    console.log(
      `  ⚡ High-cost sessions: ${highCost.map((s) => `${s.name} ($${s.estimatedCostUsd.toFixed(0)})`).join(', ')}`,
    );
  }
  console.log(`\n✅ Done! Open http://localhost:7777 to see the data.`);
  console.log(`   For live simulation: npm run demo-data -- --live\n`);
}

main();
