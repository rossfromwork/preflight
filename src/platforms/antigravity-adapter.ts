import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type {
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
  NormalizedToolCall,
} from './types.js';
import { AGY_TOOL_MAP } from '../hooks/collector-script.js';

interface AgyToolCallEvent {
  tool?: string;
  timestamp?: number;
  durationMs?: number;
  success?: boolean;
  error?: string;
  filePath?: string;
  command?: string;
  inputSizeBytes?: number;
  outputSizeBytes?: number;
  sessionId?: string;
  [key: string]: unknown;
}

/**
 * Platform adapter for Antigravity CLI (agy).
 *
 * Integration model:
 *   - **Hooks** (`~/.gemini/config/hooks.json`): PreToolUse/PostToolUse handlers
 *     invoke `preflight-collector` on every tool call. The collector normalises
 *     agy's toolCall-based payload into Preflight's canonical format and writes
 *     to the per-session buffer file.
 *   - **MCP server** (`~/.gemini/antigravity-cli/settings.json`): agy spawns
 *     `preflight --stdio` as a child process, providing live session analytics
 *     via the `nr_observe_*` tool suite.
 *
 * Configure both with: `preflight install --platform antigravity`
 */
export class AntigravityAdapter implements PlatformAdapter {
  readonly platformName = 'antigravity';

  async initialize(_config: PlatformConfig): Promise<void> {
    // Antigravity uses hooks + MCP — both wired via preflight install --platform antigravity.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = raw as AgyToolCallEvent;
    const platformToolName = event.tool ?? 'unknown';
    const toolName = AGY_TOOL_MAP[platformToolName] ?? platformToolName;

    return {
      toolName,
      platformToolName,
      platform: this.platformName,
      timestamp: event.timestamp ?? Date.now(),
      durationMs: event.durationMs ?? null,
      success: event.success ?? true,
      ...(event.error !== undefined && { error: event.error }),
      ...(event.inputSizeBytes !== undefined && { inputSizeBytes: event.inputSizeBytes }),
      ...(event.outputSizeBytes !== undefined && { outputSizeBytes: event.outputSizeBytes }),
      ...(event.filePath !== undefined && { filePath: event.filePath }),
      ...(event.command !== undefined && { command: event.command }),
      ...(event.sessionId !== undefined && { sessionId: event.sessionId }),
    };
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return { platform: this.platformName };
  }

  getHookInstallInstructions(): string {
    return [
      'Antigravity CLI (agy) Setup:',
      '1. Run: preflight install --platform antigravity',
      '   This writes PreToolUse/PostToolUse hooks to ~/.gemini/config/hooks.json',
      '   and registers the MCP server in ~/.gemini/antigravity-cli/settings.json',
      '2. Restart agy — hooks and MCP load at session start',
      '3. Verify with /hooks and /mcp inside agy',
    ].join('\n');
  }

  isSupported(): boolean {
    // Explicit override takes precedence
    if (process.env.MCP_CLIENT === 'antigravity') return true;
    // agy may set this env var when spawning MCP child processes
    if (process.env.AGY_SESSION_ID !== undefined) return true;
    // Presence of the agy data directory indicates this machine runs agy
    return existsSync(resolve(homedir(), '.gemini', 'antigravity-cli'));
  }
}
