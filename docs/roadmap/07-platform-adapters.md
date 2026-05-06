# Implementation Plan: Additional Platform Adapters

**Roadmap item:** [05 — Additional Platform Adapters](../../ROADMAP.md#5-additional-platform-adapters)
**Effort estimate:** ~1 day (all three adapters)
**Prerequisites:** Read the following files before starting.

---

## Background reading

Read these files end-to-end before starting:

- `packages/nr-ai-mcp-server/src/platforms/cursor-adapter.ts` — the simplest existing adapter; use as the template
- `packages/nr-ai-mcp-server/src/platforms/types.ts` — `PlatformAdapter`, `NormalizedToolCall`, `PlatformConfig`, `PlatformSessionMetadata` interfaces
- `packages/nr-ai-mcp-server/src/platforms/platform-registry.ts` — how adapters are registered in `createDefaultRegistry()`
- `packages/nr-ai-mcp-server/src/platforms/cursor-adapter.test.ts` — test pattern to follow for each new adapter

---

## Goal

Add three new platform adapters:

1. **ZedAdapter** — Zed editor (fast-growing, native MCP support via `zed-mcp-server`)
2. **ContinueAdapter** — Continue.dev (open-source IDE extension for VS Code and JetBrains)
3. **AmazonQAdapter** — Amazon Q Developer (formerly CodeWhisperer)

Each adapter follows the exact same shape as `CursorAdapter`. The main differences are:
- Detection env vars / config file presence
- Tool name mapping (platform tool names → shared vocabulary)
- Hook install instructions

---

## ✅ Step 1 — ZedAdapter

### Tool name mapping

Zed's MCP tool calls use these names (from the Zed MCP implementation):

```typescript
const ZED_TOOL_MAP: Record<string, string> = {
  // File operations
  open_file: 'Read',
  read_file: 'Read',
  create_file: 'Write',
  write_file: 'Write',
  edit_file: 'Edit',
  delete_file: 'Delete',
  // Search
  search_files: 'Glob',
  find_in_files: 'Grep',
  search_in_file: 'Grep',
  // Terminal
  execute_command: 'Bash',
  run_command: 'Bash',
  // Navigation
  list_files: 'Glob',
  list_directory: 'Glob',
};
```

### Detection heuristics

Zed sets these environment variables when spawning MCP servers:

```typescript
isSupported(): boolean {
  return (
    process.env.ZED_SESSION_ID !== undefined ||
    process.env.ZED_EXTENSION_API_VERSION !== undefined ||
    process.env.MCP_CLIENT === 'zed' ||
    process.env.ZED_ITEM_ID !== undefined
  );
}
```

### Full adapter file

Create `packages/nr-ai-mcp-server/src/platforms/zed-adapter.ts`:

```typescript
import type {
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
  NormalizedToolCall,
} from './types.js';

const ZED_TOOL_MAP: Record<string, string> = {
  open_file: 'Read',
  read_file: 'Read',
  create_file: 'Write',
  write_file: 'Write',
  edit_file: 'Edit',
  delete_file: 'Delete',
  search_files: 'Glob',
  find_in_files: 'Grep',
  search_in_file: 'Grep',
  execute_command: 'Bash',
  run_command: 'Bash',
  list_files: 'Glob',
  list_directory: 'Glob',
};

interface ZedToolCallEvent {
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

export class ZedAdapter implements PlatformAdapter {
  readonly platformName = 'zed';

  async initialize(_config: PlatformConfig): Promise<void> {
    // Zed spawns MCP servers as child processes. Tool calls arrive via stdio.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = raw as ZedToolCallEvent;
    const platformToolName = event.tool ?? 'unknown';
    const toolName = ZED_TOOL_MAP[platformToolName] ?? 'Unknown';

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
    return {
      platform: this.platformName,
      ...(process.env.ZED_EXTENSION_API_VERSION && {
        ideVersion: process.env.ZED_EXTENSION_API_VERSION,
      }),
    };
  }

  getHookInstallInstructions(): string {
    return [
      'Zed Editor Setup:',
      '1. Open Zed Settings (Cmd+,) and go to the "assistant" section',
      '2. Add an MCP server entry:',
      '   {',
      '     "name": "nr-ai-observatory",',
      '     "command": "npx",',
      '     "args": ["nr-ai-mcp-server", "--stdio"],',
      '     "env": {',
      '       "NEW_RELIC_LICENSE_KEY": "<your-key>",',
      '       "NEW_RELIC_ACCOUNT_ID": "<your-account-id>"',
      '     }',
      '   }',
      '3. Restart Zed to activate.',
    ].join('\n');
  }

  isSupported(): boolean {
    return (
      process.env.ZED_SESSION_ID !== undefined ||
      process.env.ZED_EXTENSION_API_VERSION !== undefined ||
      process.env.MCP_CLIENT === 'zed' ||
      process.env.ZED_ITEM_ID !== undefined
    );
  }
}
```

---

## ✅ Step 2 — ContinueAdapter

### Tool name mapping

Continue.dev uses VS Code language server and its own tool naming:

```typescript
const CONTINUE_TOOL_MAP: Record<string, string> = {
  // File operations (Continue built-in tools)
  readFile: 'Read',
  writeFile: 'Write',
  editFile: 'Edit',
  createFile: 'Write',
  deleteFile: 'Delete',
  // Search
  searchFiles: 'Glob',
  grep: 'Grep',
  grepSearch: 'Grep',
  fileSearch: 'Glob',
  // Terminal
  runTerminalCommand: 'Bash',
  terminal: 'Bash',
  // IDE interactions
  viewSubdirectory: 'Glob',
  viewRepoMap: 'Glob',
};
```

### Detection heuristics

Continue sets `CONTINUE_*` env vars or can be detected from the MCP client identifier:

```typescript
isSupported(): boolean {
  return (
    process.env.CONTINUE_SESSION_ID !== undefined ||
    process.env.CONTINUE_SERVER_HOST !== undefined ||
    process.env.MCP_CLIENT === 'continue' ||
    process.env.MCP_CLIENT_NAME === 'continue'
  );
}
```

### Full adapter file

Create `packages/nr-ai-mcp-server/src/platforms/continue-adapter.ts`:

```typescript
import type {
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
  NormalizedToolCall,
} from './types.js';

const CONTINUE_TOOL_MAP: Record<string, string> = {
  readFile: 'Read',
  writeFile: 'Write',
  editFile: 'Edit',
  createFile: 'Write',
  deleteFile: 'Delete',
  searchFiles: 'Glob',
  grep: 'Grep',
  grepSearch: 'Grep',
  fileSearch: 'Glob',
  runTerminalCommand: 'Bash',
  terminal: 'Bash',
  viewSubdirectory: 'Glob',
  viewRepoMap: 'Glob',
};

interface ContinueToolCallEvent {
  tool?: string;
  toolName?: string;
  timestamp?: number;
  durationMs?: number;
  success?: boolean;
  error?: string;
  filepath?: string;
  filePath?: string;
  command?: string;
  inputSizeBytes?: number;
  outputSizeBytes?: number;
  sessionId?: string;
  [key: string]: unknown;
}

export class ContinueAdapter implements PlatformAdapter {
  readonly platformName = 'continue';

  async initialize(_config: PlatformConfig): Promise<void> {
    // Continue.dev communicates via MCP stdio or local HTTP server.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = raw as ContinueToolCallEvent;
    // Continue may use either 'tool' or 'toolName'
    const platformToolName = event.tool ?? event.toolName ?? 'unknown';
    const toolName = CONTINUE_TOOL_MAP[platformToolName] ?? 'Unknown';
    // Continue may use 'filepath' (lowercase p) or 'filePath'
    const filePath = event.filePath ?? event.filepath;

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
      ...(filePath !== undefined && { filePath }),
      ...(event.command !== undefined && { command: event.command }),
      ...(event.sessionId !== undefined && { sessionId: event.sessionId }),
    };
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
      ...(process.env.CONTINUE_VERSION && { ideVersion: process.env.CONTINUE_VERSION }),
    };
  }

  getHookInstallInstructions(): string {
    return [
      'Continue.dev Setup:',
      '1. Open Continue config file (~/.continue/config.json)',
      '2. Add to "mcpServers":',
      '   {',
      '     "name": "nr-ai-observatory",',
      '     "command": "npx",',
      '     "args": ["nr-ai-mcp-server", "--stdio"],',
      '     "env": {',
      '       "NEW_RELIC_LICENSE_KEY": "<your-key>",',
      '       "NEW_RELIC_ACCOUNT_ID": "<your-account-id>"',
      '     }',
      '   }',
      '3. Reload the Continue extension.',
    ].join('\n');
  }

  isSupported(): boolean {
    return (
      process.env.CONTINUE_SESSION_ID !== undefined ||
      process.env.CONTINUE_SERVER_HOST !== undefined ||
      process.env.MCP_CLIENT === 'continue' ||
      process.env.MCP_CLIENT_NAME === 'continue'
    );
  }
}
```

---

## ✅ Step 3 — AmazonQAdapter

### Tool name mapping

Amazon Q Developer uses its own tool naming via the `amazon-q-developer` MCP integration:

```typescript
const AMAZON_Q_TOOL_MAP: Record<string, string> = {
  // File operations
  fs_read: 'Read',
  fs_write: 'Write',
  fs_edit: 'Edit',
  fs_create: 'Write',
  fs_delete: 'Delete',
  // Search
  fs_list: 'Glob',
  fs_find: 'Glob',
  grep: 'Grep',
  search_code: 'Grep',
  // Terminal
  execute_bash: 'Bash',
  run_shell: 'Bash',
  execute_command: 'Bash',
  // Amazon Q specific
  explain_code: 'Read',
  review_code: 'Read',
  transform_code: 'Edit',
};
```

### Detection heuristics

Amazon Q sets `AWS_*` and `Q_*` env vars:

```typescript
isSupported(): boolean {
  return (
    process.env.AMAZON_Q_SESSION_ID !== undefined ||
    process.env.Q_DEVELOPER_SESSION !== undefined ||
    process.env.MCP_CLIENT === 'amazon-q' ||
    process.env.AWS_CODEWHISPERER_SESSION !== undefined
  );
}
```

### Full adapter file

Create `packages/nr-ai-mcp-server/src/platforms/amazon-q-adapter.ts`:

```typescript
import type {
  PlatformAdapter,
  PlatformConfig,
  PlatformSessionMetadata,
  NormalizedToolCall,
} from './types.js';

const AMAZON_Q_TOOL_MAP: Record<string, string> = {
  fs_read: 'Read',
  fs_write: 'Write',
  fs_edit: 'Edit',
  fs_create: 'Write',
  fs_delete: 'Delete',
  fs_list: 'Glob',
  fs_find: 'Glob',
  grep: 'Grep',
  search_code: 'Grep',
  execute_bash: 'Bash',
  run_shell: 'Bash',
  execute_command: 'Bash',
  explain_code: 'Read',
  review_code: 'Read',
  transform_code: 'Edit',
};

interface AmazonQToolCallEvent {
  tool?: string;
  toolName?: string;
  timestamp?: number;
  durationMs?: number;
  success?: boolean;
  error?: string;
  filePath?: string;
  path?: string;
  command?: string;
  inputSizeBytes?: number;
  outputSizeBytes?: number;
  sessionId?: string;
  [key: string]: unknown;
}

export class AmazonQAdapter implements PlatformAdapter {
  readonly platformName = 'amazon-q';

  async initialize(_config: PlatformConfig): Promise<void> {
    // Amazon Q Developer connects via the MCP stdio protocol.
  }

  normalizeToolCall(raw: unknown): NormalizedToolCall {
    const event = raw as AmazonQToolCallEvent;
    const platformToolName = event.tool ?? event.toolName ?? 'unknown';
    const toolName = AMAZON_Q_TOOL_MAP[platformToolName] ?? 'Unknown';
    const filePath = event.filePath ?? event.path;

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
      ...(filePath !== undefined && { filePath }),
      ...(event.command !== undefined && { command: event.command }),
      ...(event.sessionId !== undefined && { sessionId: event.sessionId }),
    };
  }

  getSessionMetadata(): PlatformSessionMetadata {
    return {
      platform: this.platformName,
      ...(process.env.AMAZON_Q_VERSION && { ideVersion: process.env.AMAZON_Q_VERSION }),
    };
  }

  getHookInstallInstructions(): string {
    return [
      'Amazon Q Developer Setup:',
      '1. Open your Amazon Q Developer MCP configuration file',
      '   (typically ~/.aws/amazonq/mcp.json or project-level .amazonq/mcp.json)',
      '2. Add to "mcpServers":',
      '   {',
      '     "nr-ai-observatory": {',
      '       "command": "npx",',
      '       "args": ["nr-ai-mcp-server", "--stdio"],',
      '       "env": {',
      '         "NEW_RELIC_LICENSE_KEY": "<your-key>",',
      '         "NEW_RELIC_ACCOUNT_ID": "<your-account-id>"',
      '       }',
      '     }',
      '   }',
      '3. Restart Amazon Q Developer.',
    ].join('\n');
  }

  isSupported(): boolean {
    return (
      process.env.AMAZON_Q_SESSION_ID !== undefined ||
      process.env.Q_DEVELOPER_SESSION !== undefined ||
      process.env.MCP_CLIENT === 'amazon-q' ||
      process.env.AWS_CODEWHISPERER_SESSION !== undefined
    );
  }
}
```

---

## Step 4 — Register all three adapters

Open `packages/nr-ai-mcp-server/src/platforms/platform-registry.ts`.

### ✅ 4a — Add imports

```typescript
import { ZedAdapter } from './zed-adapter.js';
import { ContinueAdapter } from './continue-adapter.js';
import { AmazonQAdapter } from './amazon-q-adapter.js';
```

### ✅ 4b — Register in `createDefaultRegistry()`

Add the three new adapters **before** `GenericMcpAdapter` (which should always be last as the fallback):

```typescript
export function createDefaultRegistry(): PlatformRegistry {
  const registry = new PlatformRegistry();
  registry.register(new ClaudeCodeAdapter());
  registry.register(new CursorAdapter());
  registry.register(new WindsurfAdapter());
  registry.register(new CopilotAdapter());
  registry.register(new ZedAdapter());
  registry.register(new ContinueAdapter());
  registry.register(new AmazonQAdapter());
  registry.register(new GenericMcpAdapter()); // always last
  return registry;
}
```

---

## ✅ Step 5 — Export from `platforms/index.ts`

Open `packages/nr-ai-mcp-server/src/platforms/index.ts`. Add the three new exports:

```typescript
export { ZedAdapter } from './zed-adapter.js';
export { ContinueAdapter } from './continue-adapter.js';
export { AmazonQAdapter } from './amazon-q-adapter.js';
```

---

## ✅ Step 6 — Write tests

Create a test file for each adapter. The exact pattern from `cursor-adapter.test.ts` must be followed precisely. **Do not use `let adapter` with `beforeEach` — use `const adapter = new XxxAdapter()` at the `describe` block level.** The top-level `stderrSpy` and `savedEnv` save/restore pattern is mandatory.

### `zed-adapter.test.ts`

Create `packages/nr-ai-mcp-server/src/platforms/zed-adapter.test.ts` with this exact content:

```typescript
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ZedAdapter } from './zed-adapter.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  for (const key of ['ZED_SESSION_ID', 'ZED_EXTENSION_API_VERSION', 'ZED_ITEM_ID', 'MCP_CLIENT']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  stderrSpy.mockRestore();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('ZedAdapter', () => {
  const adapter = new ZedAdapter();

  it('has platformName "zed"', () => {
    expect(adapter.platformName).toBe('zed');
  });

  describe('normalizeToolCall', () => {
    it('maps "open_file" to "Read"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'open_file', timestamp: 2000, success: true });
      expect(normalized.toolName).toBe('Read');
      expect(normalized.platformToolName).toBe('open_file');
      expect(normalized.platform).toBe('zed');
    });

    it('maps "read_file" to "Read"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'read_file', timestamp: 2000 });
      expect(normalized.toolName).toBe('Read');
    });

    it('maps "create_file" to "Write"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'create_file', timestamp: 2000 });
      expect(normalized.toolName).toBe('Write');
    });

    it('maps "write_file" to "Write"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'write_file', timestamp: 2000 });
      expect(normalized.toolName).toBe('Write');
    });

    it('maps "edit_file" to "Edit"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'edit_file',
        timestamp: 2000,
        filePath: '/src/app.ts',
      });
      expect(normalized.toolName).toBe('Edit');
      expect(normalized.filePath).toBe('/src/app.ts');
    });

    it('maps "delete_file" to "Delete"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'delete_file', timestamp: 2000 });
      expect(normalized.toolName).toBe('Delete');
    });

    it('maps "search_files" to "Glob"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'search_files', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('maps "find_in_files" to "Grep"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'find_in_files', timestamp: 2000 });
      expect(normalized.toolName).toBe('Grep');
    });

    it('maps "search_in_file" to "Grep"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'search_in_file', timestamp: 2000 });
      expect(normalized.toolName).toBe('Grep');
    });

    it('maps "execute_command" to "Bash"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'execute_command',
        timestamp: 2000,
        command: 'npm test',
      });
      expect(normalized.toolName).toBe('Bash');
      expect(normalized.command).toBe('npm test');
    });

    it('maps "run_command" to "Bash"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'run_command', timestamp: 2000 });
      expect(normalized.toolName).toBe('Bash');
    });

    it('maps "list_files" to "Glob"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'list_files', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('maps "list_directory" to "Glob"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'list_directory', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('maps unknown tool to "Unknown" with platformToolName preserved', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'custom_zed_tool', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('custom_zed_tool');
    });

    it('defaults missing tool name to "unknown"', () => {
      const normalized = adapter.normalizeToolCall({ timestamp: 2000 });
      expect(normalized.platformToolName).toBe('unknown');
      expect(normalized.toolName).toBe('Unknown');
    });

    it('defaults success to true when not provided', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'read_file', timestamp: 2000 });
      expect(normalized.success).toBe(true);
    });

    it('preserves error field', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'edit_file',
        timestamp: 2000,
        success: false,
        error: 'permission denied',
      });
      expect(normalized.success).toBe(false);
      expect(normalized.error).toBe('permission denied');
    });

    it('uses current time when timestamp is missing', () => {
      const before = Date.now();
      const normalized = adapter.normalizeToolCall({ tool: 'read_file' });
      const after = Date.now();
      expect(normalized.timestamp).toBeGreaterThanOrEqual(before);
      expect(normalized.timestamp).toBeLessThanOrEqual(after);
    });

    it('includes inputSizeBytes and outputSizeBytes when present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'read_file',
        timestamp: 2000,
        inputSizeBytes: 50,
        outputSizeBytes: 1000,
      });
      expect(normalized.inputSizeBytes).toBe(50);
      expect(normalized.outputSizeBytes).toBe(1000);
    });

    it('includes sessionId when present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'read_file',
        timestamp: 2000,
        sessionId: 'zed-sess-001',
      });
      expect(normalized.sessionId).toBe('zed-sess-001');
    });
  });

  describe('getSessionMetadata', () => {
    it('returns platform "zed"', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.platform).toBe('zed');
    });

    it('includes ideVersion from ZED_EXTENSION_API_VERSION env var', () => {
      process.env.ZED_EXTENSION_API_VERSION = '0.1.2';
      const meta = adapter.getSessionMetadata();
      expect(meta.ideVersion).toBe('0.1.2');
    });

    it('omits ideVersion when ZED_EXTENSION_API_VERSION is unset', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.ideVersion).toBeUndefined();
    });
  });

  describe('isSupported', () => {
    it('returns true when ZED_SESSION_ID is set', () => {
      process.env.ZED_SESSION_ID = 'abc123';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when ZED_EXTENSION_API_VERSION is set', () => {
      process.env.ZED_EXTENSION_API_VERSION = '0.1.0';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when ZED_ITEM_ID is set', () => {
      process.env.ZED_ITEM_ID = 'item-xyz';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when MCP_CLIENT is "zed"', () => {
      process.env.MCP_CLIENT = 'zed';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns false in a non-Zed environment', () => {
      expect(adapter.isSupported()).toBe(false);
    });
  });

  describe('getHookInstallInstructions', () => {
    it('returns non-empty Zed-specific instructions', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions).toContain('Zed');
    });

    it('mentions NEW_RELIC_LICENSE_KEY', () => {
      expect(adapter.getHookInstallInstructions()).toContain('NEW_RELIC_LICENSE_KEY');
    });

    it('mentions NEW_RELIC_ACCOUNT_ID', () => {
      expect(adapter.getHookInstallInstructions()).toContain('NEW_RELIC_ACCOUNT_ID');
    });
  });

  describe('initialize', () => {
    it('completes without error', async () => {
      await expect(adapter.initialize({})).resolves.toBeUndefined();
    });
  });
});
```

### `continue-adapter.test.ts`

Create `packages/nr-ai-mcp-server/src/platforms/continue-adapter.test.ts` with this exact content:

```typescript
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ContinueAdapter } from './continue-adapter.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  for (const key of ['CONTINUE_SESSION_ID', 'CONTINUE_SERVER_HOST', 'CONTINUE_VERSION', 'MCP_CLIENT', 'MCP_CLIENT_NAME']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  stderrSpy.mockRestore();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('ContinueAdapter', () => {
  const adapter = new ContinueAdapter();

  it('has platformName "continue"', () => {
    expect(adapter.platformName).toBe('continue');
  });

  describe('normalizeToolCall', () => {
    it('maps "readFile" to "Read"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'readFile', timestamp: 2000, success: true });
      expect(normalized.toolName).toBe('Read');
      expect(normalized.platformToolName).toBe('readFile');
      expect(normalized.platform).toBe('continue');
    });

    it('maps "writeFile" to "Write"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'writeFile', timestamp: 2000 });
      expect(normalized.toolName).toBe('Write');
    });

    it('maps "editFile" to "Edit"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'editFile',
        timestamp: 2000,
        filePath: '/src/app.ts',
      });
      expect(normalized.toolName).toBe('Edit');
      expect(normalized.filePath).toBe('/src/app.ts');
    });

    it('maps "createFile" to "Write"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'createFile', timestamp: 2000 });
      expect(normalized.toolName).toBe('Write');
    });

    it('maps "deleteFile" to "Delete"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'deleteFile', timestamp: 2000 });
      expect(normalized.toolName).toBe('Delete');
    });

    it('maps "searchFiles" to "Glob"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'searchFiles', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('maps "grep" to "Grep"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'grep', timestamp: 2000 });
      expect(normalized.toolName).toBe('Grep');
    });

    it('maps "grepSearch" to "Grep"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'grepSearch', timestamp: 2000 });
      expect(normalized.toolName).toBe('Grep');
    });

    it('maps "fileSearch" to "Glob"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'fileSearch', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('maps "runTerminalCommand" to "Bash"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'runTerminalCommand',
        timestamp: 2000,
        command: 'npm test',
      });
      expect(normalized.toolName).toBe('Bash');
      expect(normalized.command).toBe('npm test');
    });

    it('maps "terminal" to "Bash"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'terminal', timestamp: 2000 });
      expect(normalized.toolName).toBe('Bash');
    });

    it('maps "viewSubdirectory" to "Glob"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'viewSubdirectory', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('maps "viewRepoMap" to "Glob"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'viewRepoMap', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('accepts "toolName" field as an alternative to "tool"', () => {
      const normalized = adapter.normalizeToolCall({ toolName: 'readFile', timestamp: 2000 });
      expect(normalized.toolName).toBe('Read');
      expect(normalized.platformToolName).toBe('readFile');
    });

    it('normalizes filepath (lowercase p) to filePath', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'readFile', filepath: '/src/app.ts' });
      expect(normalized.filePath).toBe('/src/app.ts');
    });

    it('maps unknown tool to "Unknown" with platformToolName preserved', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'custom_continue_tool', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('custom_continue_tool');
    });

    it('defaults missing tool name to "unknown"', () => {
      const normalized = adapter.normalizeToolCall({ timestamp: 2000 });
      expect(normalized.platformToolName).toBe('unknown');
      expect(normalized.toolName).toBe('Unknown');
    });

    it('defaults success to true when not provided', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'readFile', timestamp: 2000 });
      expect(normalized.success).toBe(true);
    });

    it('preserves error field', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'editFile',
        timestamp: 2000,
        success: false,
        error: 'permission denied',
      });
      expect(normalized.success).toBe(false);
      expect(normalized.error).toBe('permission denied');
    });

    it('uses current time when timestamp is missing', () => {
      const before = Date.now();
      const normalized = adapter.normalizeToolCall({ tool: 'readFile' });
      const after = Date.now();
      expect(normalized.timestamp).toBeGreaterThanOrEqual(before);
      expect(normalized.timestamp).toBeLessThanOrEqual(after);
    });

    it('includes inputSizeBytes and outputSizeBytes when present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'readFile',
        timestamp: 2000,
        inputSizeBytes: 50,
        outputSizeBytes: 1000,
      });
      expect(normalized.inputSizeBytes).toBe(50);
      expect(normalized.outputSizeBytes).toBe(1000);
    });

    it('includes sessionId when present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'readFile',
        timestamp: 2000,
        sessionId: 'cont-sess-001',
      });
      expect(normalized.sessionId).toBe('cont-sess-001');
    });
  });

  describe('getSessionMetadata', () => {
    it('returns platform "continue"', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.platform).toBe('continue');
    });

    it('includes ideVersion from CONTINUE_VERSION env var', () => {
      process.env.CONTINUE_VERSION = '0.9.200';
      const meta = adapter.getSessionMetadata();
      expect(meta.ideVersion).toBe('0.9.200');
    });

    it('omits ideVersion when CONTINUE_VERSION is unset', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.ideVersion).toBeUndefined();
    });
  });

  describe('isSupported', () => {
    it('returns true when CONTINUE_SESSION_ID is set', () => {
      process.env.CONTINUE_SESSION_ID = 'abc123';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when CONTINUE_SERVER_HOST is set', () => {
      process.env.CONTINUE_SERVER_HOST = 'localhost:3000';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when MCP_CLIENT is "continue"', () => {
      process.env.MCP_CLIENT = 'continue';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when MCP_CLIENT_NAME is "continue"', () => {
      process.env.MCP_CLIENT_NAME = 'continue';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns false in a non-Continue environment', () => {
      expect(adapter.isSupported()).toBe(false);
    });
  });

  describe('getHookInstallInstructions', () => {
    it('returns non-empty Continue-specific instructions', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions).toContain('Continue');
    });

    it('mentions NEW_RELIC_LICENSE_KEY', () => {
      expect(adapter.getHookInstallInstructions()).toContain('NEW_RELIC_LICENSE_KEY');
    });

    it('mentions NEW_RELIC_ACCOUNT_ID', () => {
      expect(adapter.getHookInstallInstructions()).toContain('NEW_RELIC_ACCOUNT_ID');
    });
  });

  describe('initialize', () => {
    it('completes without error', async () => {
      await expect(adapter.initialize({})).resolves.toBeUndefined();
    });
  });
});
```

### `amazon-q-adapter.test.ts`

Create `packages/nr-ai-mcp-server/src/platforms/amazon-q-adapter.test.ts` with this exact content:

```typescript
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { AmazonQAdapter } from './amazon-q-adapter.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  for (const key of ['AMAZON_Q_SESSION_ID', 'Q_DEVELOPER_SESSION', 'AWS_CODEWHISPERER_SESSION', 'AMAZON_Q_VERSION', 'MCP_CLIENT']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  stderrSpy.mockRestore();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('AmazonQAdapter', () => {
  const adapter = new AmazonQAdapter();

  it('has platformName "amazon-q"', () => {
    expect(adapter.platformName).toBe('amazon-q');
  });

  describe('normalizeToolCall', () => {
    it('maps "fs_read" to "Read"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'fs_read', timestamp: 2000, success: true });
      expect(normalized.toolName).toBe('Read');
      expect(normalized.platformToolName).toBe('fs_read');
      expect(normalized.platform).toBe('amazon-q');
    });

    it('maps "fs_write" to "Write"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'fs_write', timestamp: 2000 });
      expect(normalized.toolName).toBe('Write');
    });

    it('maps "fs_edit" to "Edit"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'fs_edit',
        timestamp: 2000,
        filePath: '/src/app.ts',
      });
      expect(normalized.toolName).toBe('Edit');
      expect(normalized.filePath).toBe('/src/app.ts');
    });

    it('maps "fs_create" to "Write"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'fs_create', timestamp: 2000 });
      expect(normalized.toolName).toBe('Write');
    });

    it('maps "fs_delete" to "Delete"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'fs_delete', timestamp: 2000 });
      expect(normalized.toolName).toBe('Delete');
    });

    it('maps "fs_list" to "Glob"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'fs_list', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('maps "fs_find" to "Glob"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'fs_find', timestamp: 2000 });
      expect(normalized.toolName).toBe('Glob');
    });

    it('maps "grep" to "Grep"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'grep', timestamp: 2000 });
      expect(normalized.toolName).toBe('Grep');
    });

    it('maps "search_code" to "Grep"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'search_code', timestamp: 2000 });
      expect(normalized.toolName).toBe('Grep');
    });

    it('maps "execute_bash" to "Bash"', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'execute_bash',
        timestamp: 2000,
        command: 'npm test',
      });
      expect(normalized.toolName).toBe('Bash');
      expect(normalized.command).toBe('npm test');
    });

    it('maps "run_shell" to "Bash"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'run_shell', timestamp: 2000 });
      expect(normalized.toolName).toBe('Bash');
    });

    it('maps "execute_command" to "Bash"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'execute_command', timestamp: 2000 });
      expect(normalized.toolName).toBe('Bash');
    });

    it('maps "explain_code" to "Read"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'explain_code', timestamp: 2000 });
      expect(normalized.toolName).toBe('Read');
    });

    it('maps "review_code" to "Read"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'review_code', timestamp: 2000 });
      expect(normalized.toolName).toBe('Read');
    });

    it('maps "transform_code" to "Edit"', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'transform_code', timestamp: 2000 });
      expect(normalized.toolName).toBe('Edit');
    });

    it('accepts "toolName" field as an alternative to "tool"', () => {
      const normalized = adapter.normalizeToolCall({ toolName: 'fs_read', timestamp: 2000 });
      expect(normalized.toolName).toBe('Read');
      expect(normalized.platformToolName).toBe('fs_read');
    });

    it('normalizes path to filePath', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'fs_read', path: '/src/app.ts' });
      expect(normalized.filePath).toBe('/src/app.ts');
    });

    it('maps unknown tool to "Unknown" with platformToolName preserved', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'custom_q_tool', timestamp: 2000 });
      expect(normalized.toolName).toBe('Unknown');
      expect(normalized.platformToolName).toBe('custom_q_tool');
    });

    it('defaults missing tool name to "unknown"', () => {
      const normalized = adapter.normalizeToolCall({ timestamp: 2000 });
      expect(normalized.platformToolName).toBe('unknown');
      expect(normalized.toolName).toBe('Unknown');
    });

    it('defaults success to true when not provided', () => {
      const normalized = adapter.normalizeToolCall({ tool: 'fs_read', timestamp: 2000 });
      expect(normalized.success).toBe(true);
    });

    it('preserves error field', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'fs_edit',
        timestamp: 2000,
        success: false,
        error: 'permission denied',
      });
      expect(normalized.success).toBe(false);
      expect(normalized.error).toBe('permission denied');
    });

    it('uses current time when timestamp is missing', () => {
      const before = Date.now();
      const normalized = adapter.normalizeToolCall({ tool: 'fs_read' });
      const after = Date.now();
      expect(normalized.timestamp).toBeGreaterThanOrEqual(before);
      expect(normalized.timestamp).toBeLessThanOrEqual(after);
    });

    it('includes inputSizeBytes and outputSizeBytes when present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'fs_read',
        timestamp: 2000,
        inputSizeBytes: 50,
        outputSizeBytes: 1000,
      });
      expect(normalized.inputSizeBytes).toBe(50);
      expect(normalized.outputSizeBytes).toBe(1000);
    });

    it('includes sessionId when present', () => {
      const normalized = adapter.normalizeToolCall({
        tool: 'fs_read',
        timestamp: 2000,
        sessionId: 'q-sess-001',
      });
      expect(normalized.sessionId).toBe('q-sess-001');
    });
  });

  describe('getSessionMetadata', () => {
    it('returns platform "amazon-q"', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.platform).toBe('amazon-q');
    });

    it('includes ideVersion from AMAZON_Q_VERSION env var', () => {
      process.env.AMAZON_Q_VERSION = '1.2.0';
      const meta = adapter.getSessionMetadata();
      expect(meta.ideVersion).toBe('1.2.0');
    });

    it('omits ideVersion when AMAZON_Q_VERSION is unset', () => {
      const meta = adapter.getSessionMetadata();
      expect(meta.ideVersion).toBeUndefined();
    });
  });

  describe('isSupported', () => {
    it('returns true when AMAZON_Q_SESSION_ID is set', () => {
      process.env.AMAZON_Q_SESSION_ID = 'abc123';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when Q_DEVELOPER_SESSION is set', () => {
      process.env.Q_DEVELOPER_SESSION = 'dev-session-123';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when AWS_CODEWHISPERER_SESSION is set', () => {
      process.env.AWS_CODEWHISPERER_SESSION = 'cw-session-xyz';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns true when MCP_CLIENT is "amazon-q"', () => {
      process.env.MCP_CLIENT = 'amazon-q';
      expect(adapter.isSupported()).toBe(true);
    });

    it('returns false in a non-Amazon-Q environment', () => {
      expect(adapter.isSupported()).toBe(false);
    });
  });

  describe('getHookInstallInstructions', () => {
    it('returns non-empty Amazon Q-specific instructions', () => {
      const instructions = adapter.getHookInstallInstructions();
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions).toContain('Amazon Q');
    });

    it('mentions NEW_RELIC_LICENSE_KEY', () => {
      expect(adapter.getHookInstallInstructions()).toContain('NEW_RELIC_LICENSE_KEY');
    });

    it('mentions NEW_RELIC_ACCOUNT_ID', () => {
      expect(adapter.getHookInstallInstructions()).toContain('NEW_RELIC_ACCOUNT_ID');
    });
  });

  describe('initialize', () => {
    it('completes without error', async () => {
      await expect(adapter.initialize({})).resolves.toBeUndefined();
    });
  });
});
```

---

## Step 7 — Update platform registry test

**IMPORTANT:** The existing `platform-registry.test.ts` has hardcoded length and index assertions that will **break** when new adapters are added. You must update those lines as well as adding new tests. Open `packages/nr-ai-mcp-server/src/platforms/platform-registry.test.ts` and make all of the following changes.

### ✅ 7a — Add imports at the top of the file

After the existing imports block (which ends with `import type { PlatformAdapter, PlatformSessionMetadata, NormalizedToolCall } from './types.js';`), add:

```typescript
import { ZedAdapter } from './zed-adapter.js';
import { ContinueAdapter } from './continue-adapter.js';
import { AmazonQAdapter } from './amazon-q-adapter.js';
```

### ✅ 7b — Expand ENV_KEYS to cover all new detection env vars

The existing `ENV_KEYS` array must include the new adapters' detection env vars so they are cleared before each test. Replace the existing `ENV_KEYS` array with:

```typescript
const ENV_KEYS = [
  'CLAUDE_CODE', 'CLAUDE_CODE_VERSION', 'MCP_CLIENT', 'MCP_CLIENT_NAME',
  'CURSOR_SESSION_ID', 'CURSOR_TRACE_ID',
  'WINDSURF_SESSION_ID', 'WINDSURF_CONTEXT_ID',
  'NR_AI_COPILOT_OBSERVER',
  'ZED_SESSION_ID', 'ZED_EXTENSION_API_VERSION', 'ZED_ITEM_ID',
  'CONTINUE_SESSION_ID', 'CONTINUE_SERVER_HOST', 'CONTINUE_VERSION',
  'AMAZON_Q_SESSION_ID', 'Q_DEVELOPER_SESSION', 'AWS_CODEWHISPERER_SESSION', 'AMAZON_Q_VERSION',
];
```

### ✅ 7c — Fix the hardcoded length assertion in `createDefaultRegistry`

Find the `describe('createDefaultRegistry', ...)` block. It currently reads:

```typescript
describe('createDefaultRegistry', () => {
  it('pre-registers all platform adapters in priority order', () => {
    const registry = createDefaultRegistry();
    const registered = registry.getRegistered();

    expect(registered).toHaveLength(5);
    expect(registered[0]).toBeInstanceOf(ClaudeCodeAdapter);
    expect(registered[1]).toBeInstanceOf(CursorAdapter);
    expect(registered[2]).toBeInstanceOf(WindsurfAdapter);
    expect(registered[3]).toBeInstanceOf(CopilotAdapter);
    expect(registered[4]).toBeInstanceOf(GenericMcpAdapter);
  });
});
```

Replace it with:

```typescript
describe('createDefaultRegistry', () => {
  it('pre-registers all platform adapters in priority order', () => {
    const registry = createDefaultRegistry();
    const registered = registry.getRegistered();

    expect(registered).toHaveLength(8);
    expect(registered[0]).toBeInstanceOf(ClaudeCodeAdapter);
    expect(registered[1]).toBeInstanceOf(CursorAdapter);
    expect(registered[2]).toBeInstanceOf(WindsurfAdapter);
    expect(registered[3]).toBeInstanceOf(CopilotAdapter);
    expect(registered[4]).toBeInstanceOf(ZedAdapter);
    expect(registered[5]).toBeInstanceOf(ContinueAdapter);
    expect(registered[6]).toBeInstanceOf(AmazonQAdapter);
    expect(registered[7]).toBeInstanceOf(GenericMcpAdapter);
  });

  it('includes zed, continue, and amazon-q adapters', () => {
    const registry = createDefaultRegistry();
    const names = registry.getRegistered().map(a => a.platformName);
    expect(names).toContain('zed');
    expect(names).toContain('continue');
    expect(names).toContain('amazon-q');
  });

  it('ends with generic-mcp as fallback', () => {
    const registry = createDefaultRegistry();
    const adapters = registry.getRegistered();
    expect(adapters[adapters.length - 1].platformName).toBe('generic-mcp');
  });
});
```

### ✅ 7d — Fix the hardcoded adapter array in `all adapters implement PlatformAdapter interface`

Find the `describe('all adapters implement PlatformAdapter interface', ...)` block. It currently reads:

```typescript
describe('all adapters implement PlatformAdapter interface', () => {
  const adapters: PlatformAdapter[] = [new ClaudeCodeAdapter(), new CursorAdapter(), new WindsurfAdapter(), new CopilotAdapter(), new GenericMcpAdapter()];
```

Replace that one line (the `const adapters` line) with:

```typescript
describe('all adapters implement PlatformAdapter interface', () => {
  const adapters: PlatformAdapter[] = [
    new ClaudeCodeAdapter(),
    new CursorAdapter(),
    new WindsurfAdapter(),
    new CopilotAdapter(),
    new ZedAdapter(),
    new ContinueAdapter(),
    new AmazonQAdapter(),
    new GenericMcpAdapter(),
  ];
```

The `for (const adapter of adapters)` loop and all the `it(...)` blocks inside it remain unchanged — they run automatically for every adapter in the array.

---

## ✅ Step 8 — Export from `src/index.ts`

Open `packages/nr-ai-mcp-server/src/index.ts`. Find the `export { ... } from './platforms/index.js'` block. It currently reads:

```typescript
export {
  ClaudeCodeAdapter,
  CursorAdapter,
  WindsurfAdapter,
  CopilotAdapter,
  parseCopilotUsageResponse,
  GenericMcpAdapter,
  validateReportToolCallInput,
  REPORT_TOOL_CALL_TOOL,
  REPORT_SESSION_START_TOOL,
  REPORT_SESSION_END_TOOL,
  PlatformRegistry,
  createDefaultRegistry,
} from './platforms/index.js';
```

Add the three new adapters to this block:

```typescript
export {
  ClaudeCodeAdapter,
  CursorAdapter,
  WindsurfAdapter,
  CopilotAdapter,
  ZedAdapter,
  ContinueAdapter,
  AmazonQAdapter,
  parseCopilotUsageResponse,
  GenericMcpAdapter,
  validateReportToolCallInput,
  REPORT_TOOL_CALL_TOOL,
  REPORT_SESSION_START_TOOL,
  REPORT_SESSION_END_TOOL,
  PlatformRegistry,
  createDefaultRegistry,
} from './platforms/index.js';
```

---

## ✅ Acceptance criteria

- [x] `npm run build` passes with no TypeScript errors
- [x] `npm test` passes — all three new adapter test files pass
- [x] `createDefaultRegistry()` includes `zed`, `continue`, and `amazon-q` adapters
- [x] `generic-mcp` is still last in the registry
- [x] Each adapter's `normalizeToolCall()` maps at least 5 distinct tool names correctly
- [x] `isSupported()` returns `false` when no detection env vars are set (important: clean up env in tests)
- [x] `getHookInstallInstructions()` mentions both `NEW_RELIC_LICENSE_KEY` and `NEW_RELIC_ACCOUNT_ID`
- [x] All three adapters are exported from `platforms/index.ts`
- [x] All three adapters are exported from `src/index.ts`
- [x] `npm run lint` passes

---

## File checklist

Files to **create**:

```
packages/nr-ai-mcp-server/src/platforms/zed-adapter.ts
packages/nr-ai-mcp-server/src/platforms/zed-adapter.test.ts
packages/nr-ai-mcp-server/src/platforms/continue-adapter.ts
packages/nr-ai-mcp-server/src/platforms/continue-adapter.test.ts
packages/nr-ai-mcp-server/src/platforms/amazon-q-adapter.ts
packages/nr-ai-mcp-server/src/platforms/amazon-q-adapter.test.ts
```

Files to **modify**:

```
packages/nr-ai-mcp-server/src/platforms/platform-registry.ts   — add 3 imports + registrations
packages/nr-ai-mcp-server/src/platforms/index.ts               — add 3 exports
packages/nr-ai-mcp-server/src/platforms/platform-registry.test.ts — update ENV_KEYS, toHaveLength(8), registered[7], adapters array
packages/nr-ai-mcp-server/src/index.ts                         — add 3 exports to re-export block
```
