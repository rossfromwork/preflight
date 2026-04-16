import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import {
  generateHookEntries,
  generateMcpServerEntry,
  generateNrConfig,
  mergeSettings,
  removeSettings,
  mergeMcpConfig,
  removeMcpConfig,
  detectSettingsPath,
  detectMcpConfigPath,
} from './install-helper.js';

// ---------------------------------------------------------------------------
// Temp directory setup (mirrors collector-script.test.ts)
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = resolve(tmpdir(), `nr-install-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

describe('generateHookEntries', () => {
  it('returns PreToolUse and PostToolUse entries in Claude Code hook format', () => {
    const hooks = generateHookEntries();

    expect(hooks.PreToolUse).toEqual([
      { matcher: '', hooks: [{ type: 'command', command: 'nr-ai-observe pre-tool' }] },
    ]);
    expect(hooks.PostToolUse).toEqual([
      { matcher: '', hooks: [{ type: 'command', command: 'nr-ai-observe post-tool' }] },
    ]);
  });
});

describe('generateMcpServerEntry', () => {
  it('returns nr-ai-observability MCP server config', () => {
    const entry = generateMcpServerEntry();

    expect(entry).toEqual({
      'nr-ai-observability': { command: 'nr-ai-mcp-server', args: ['--stdio'] },
    });
  });
});

describe('generateNrConfig', () => {
  it('returns config with licenseKey and accountId', () => {
    const config = generateNrConfig('NRAK-abc123', '12345');

    expect(config).toEqual({ licenseKey: 'NRAK-abc123', accountId: '12345' });
  });
});

// ---------------------------------------------------------------------------
// detectSettingsPath
// ---------------------------------------------------------------------------

describe('detectSettingsPath', () => {
  it('returns ~/.claude/settings.json for user scope', () => {
    const path = detectSettingsPath('user');

    expect(path).toBe(resolve(homedir(), '.claude', 'settings.json'));
  });

  it('returns cwd/.claude/settings.json for project scope', () => {
    const path = detectSettingsPath('project');

    expect(path).toBe(resolve(process.cwd(), '.claude', 'settings.json'));
  });
});

describe('detectMcpConfigPath', () => {
  it('returns ~/.mcp.json for user scope', () => {
    const path = detectMcpConfigPath('user');

    expect(path).toBe(resolve(homedir(), '.mcp.json'));
  });

  it('returns cwd/.mcp.json for project scope', () => {
    const path = detectMcpConfigPath('project');

    expect(path).toBe(resolve(process.cwd(), '.mcp.json'));
  });
});

// ---------------------------------------------------------------------------
// mergeSettings
// ---------------------------------------------------------------------------

describe('mergeSettings', () => {
  it('creates hooks from empty object (no mcpServers)', () => {
    const result = mergeSettings({});

    expect(result.hooks).toBeDefined();
    const hooks = result.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PostToolUse).toHaveLength(1);

    const pre = hooks.PreToolUse[0] as Record<string, unknown>;
    expect(pre.hooks).toEqual([{ type: 'command', command: 'nr-ai-observe pre-tool' }]);
    const post = hooks.PostToolUse[0] as Record<string, unknown>;
    expect(post.hooks).toEqual([{ type: 'command', command: 'nr-ai-observe post-tool' }]);

    // MCP servers are NOT managed in settings.json
    expect(result.mcpServers).toBeUndefined();
  });

  it('preserves existing hooks and other settings', () => {
    const existing = {
      hooks: {
        PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'my-other-hook' }] }],
        StopToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-bash-guard' }] }],
      },
      otherSetting: true,
    };

    const result = mergeSettings(existing);

    const hooks = result.hooks as Record<string, unknown[]>;
    // Existing PreToolUse hook preserved, ours appended
    expect(hooks.PreToolUse).toHaveLength(2);
    const existingEntry = hooks.PreToolUse[0] as Record<string, unknown>;
    expect((existingEntry.hooks as Array<Record<string, string>>)[0].command).toBe('my-other-hook');
    const ourEntry = hooks.PreToolUse[1] as Record<string, unknown>;
    expect((ourEntry.hooks as Array<Record<string, string>>)[0].command).toBe('nr-ai-observe pre-tool');
    // Non-Pre/Post hook preserved
    expect(hooks.StopToolUse).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-bash-guard' }] }]);

    expect(result.otherSetting).toBe(true);
  });

  it('is idempotent — running twice does not duplicate entries', () => {
    const once = mergeSettings({});
    const twice = mergeSettings(once);

    const hooks = twice.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PostToolUse).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// removeSettings
// ---------------------------------------------------------------------------

describe('removeSettings', () => {
  it('removes only nr-ai-observe hook entries, keeps others', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { matcher: '', hooks: [{ type: 'command', command: 'my-other-hook' }] },
          { matcher: '', hooks: [{ type: 'command', command: 'nr-ai-observe pre-tool' }] },
        ],
        PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'nr-ai-observe post-tool' }] }],
      },
    };

    const result = removeSettings(settings);

    const hooks = result.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toEqual([{ matcher: '', hooks: [{ type: 'command', command: 'my-other-hook' }] }]);
    expect(hooks.PostToolUse).toBeUndefined();
  });

  it('cleans up empty hooks object', () => {
    const settings = mergeSettings({});
    const result = removeSettings(settings);

    expect(result.hooks).toBeUndefined();
  });

  it('returns unchanged object when our entries are not present', () => {
    const settings = {
      hooks: {
        PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'some-other-hook' }] }],
      },
      otherKey: 42,
    };

    const result = removeSettings(settings);

    expect(result).toEqual(settings);
  });
});

// ---------------------------------------------------------------------------
// mergeMcpConfig
// ---------------------------------------------------------------------------

describe('mergeMcpConfig', () => {
  it('creates mcpServers from empty object', () => {
    const result = mergeMcpConfig({});

    expect(result.mcpServers).toBeDefined();
    const servers = result.mcpServers as Record<string, unknown>;
    expect(servers['nr-ai-observability']).toEqual({
      command: 'nr-ai-mcp-server',
      args: ['--stdio'],
    });
  });

  it('preserves existing MCP servers', () => {
    const existing = {
      mcpServers: {
        'my-server': { command: 'my-mcp', args: [] },
      },
    };

    const result = mergeMcpConfig(existing);

    const servers = result.mcpServers as Record<string, unknown>;
    expect(servers['my-server']).toEqual({ command: 'my-mcp', args: [] });
    expect(servers['nr-ai-observability']).toBeDefined();
  });

  it('is idempotent', () => {
    const once = mergeMcpConfig({});
    const twice = mergeMcpConfig(once);

    const servers = twice.mcpServers as Record<string, unknown>;
    expect(Object.keys(servers)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// removeMcpConfig
// ---------------------------------------------------------------------------

describe('removeMcpConfig', () => {
  it('removes nr-ai-observability, keeps other servers', () => {
    const config = {
      mcpServers: {
        'my-server': { command: 'my-mcp', args: [] },
        'nr-ai-observability': { command: 'nr-ai-mcp-server', args: ['--stdio'] },
      },
    };

    const result = removeMcpConfig(config);

    const servers = result.mcpServers as Record<string, unknown>;
    expect(servers['my-server']).toBeDefined();
    expect(servers['nr-ai-observability']).toBeUndefined();
  });

  it('removes mcpServers key when empty', () => {
    const config = mergeMcpConfig({});
    const result = removeMcpConfig(config);

    expect(result.mcpServers).toBeUndefined();
  });

  it('returns unchanged object when our entry is not present', () => {
    const config = {
      mcpServers: {
        'other-server': { command: 'other', args: [] },
      },
    };

    const result = removeMcpConfig(config);

    expect(result).toEqual(config);
  });
});

// ---------------------------------------------------------------------------
// Integration: full install/uninstall cycle with temp files
// ---------------------------------------------------------------------------

describe('integration: install/uninstall cycle', () => {
  it('install produces valid JSON for both settings and MCP config', () => {
    const settingsPath = resolve(tmpDir, 'settings.json');
    const mcpPath = resolve(tmpDir, '.mcp.json');
    writeFileSync(settingsPath, '{}');
    writeFileSync(mcpPath, '{}');

    // Install hooks into settings.json
    const existingSettings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(settingsPath, JSON.stringify(mergeSettings(existingSettings), null, 2));

    // Install MCP server into .mcp.json
    const existingMcp = JSON.parse(readFileSync(mcpPath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(mcpPath, JSON.stringify(mergeMcpConfig(existingMcp), null, 2));

    // Verify settings.json has hooks but no mcpServers
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    expect(settings.hooks).toBeDefined();
    expect(settings.mcpServers).toBeUndefined();
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PostToolUse).toHaveLength(1);

    // Verify .mcp.json has mcpServers
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf-8')) as Record<string, unknown>;
    expect(mcp.mcpServers).toBeDefined();
    const servers = mcp.mcpServers as Record<string, unknown>;
    expect(servers['nr-ai-observability']).toEqual({ command: 'nr-ai-mcp-server', args: ['--stdio'] });
  });

  it('uninstall after install removes our entries but keeps others', () => {
    const settingsPath = resolve(tmpDir, 'settings.json');
    const mcpPath = resolve(tmpDir, '.mcp.json');
    const initialSettings = {
      hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'keep-me' }] }] },
    };
    const initialMcp = {
      mcpServers: { 'keep-server': { command: 'keep', args: [] } },
    };
    writeFileSync(settingsPath, JSON.stringify(initialSettings));
    writeFileSync(mcpPath, JSON.stringify(initialMcp));

    // Install
    let settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(settingsPath, JSON.stringify(mergeSettings(settings), null, 2));
    let mcp = JSON.parse(readFileSync(mcpPath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(mcpPath, JSON.stringify(mergeMcpConfig(mcp), null, 2));

    // Uninstall
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(settingsPath, JSON.stringify(removeSettings(settings), null, 2));
    mcp = JSON.parse(readFileSync(mcpPath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(mcpPath, JSON.stringify(removeMcpConfig(mcp), null, 2));

    const readBackSettings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    const hooks = readBackSettings.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toEqual([{ matcher: '', hooks: [{ type: 'command', command: 'keep-me' }] }]);

    const readBackMcp = JSON.parse(readFileSync(mcpPath, 'utf-8')) as Record<string, unknown>;
    const servers = readBackMcp.mcpServers as Record<string, unknown>;
    expect(servers['keep-server']).toBeDefined();
    expect(servers['nr-ai-observability']).toBeUndefined();
  });

  it('generateNrConfig produces valid config file content', () => {
    const configPath = resolve(tmpDir, 'config.json');
    const config = generateNrConfig('NRAK-test123', '99999');
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const readBack = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(readBack.licenseKey).toBe('NRAK-test123');
    expect(readBack.accountId).toBe('99999');
  });
});
