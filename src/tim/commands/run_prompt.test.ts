import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { getLoggerAdapter } from '../../logging/adapter.js';
import {
  buildClaudeRunPromptArgs,
  buildCodexRunPromptArgs,
  handleRunPromptCommand,
  normalizeStructuredJsonOutput,
  resolveClaudeModel,
  resolveExecutorAlias,
  resolveJsonSchemaOption,
  resolvePromptText,
  resolveReasoningLevel,
  shouldAllowAllTools,
} from './run_prompt.js';

describe('resolveExecutorAlias', () => {
  test('maps claude and codex aliases', () => {
    expect(resolveExecutorAlias('claude')).toBe('claude');
    expect(resolveExecutorAlias('claude-code')).toBe('claude');
    expect(resolveExecutorAlias('codex')).toBe('codex');
    expect(resolveExecutorAlias('codex-cli')).toBe('codex');
    expect(resolveExecutorAlias('  CoDeX  ')).toBe('codex');
    expect(resolveExecutorAlias(undefined)).toBe('claude');
  });

  test('throws for unsupported executors', () => {
    expect(() => resolveExecutorAlias('copy-paste')).toThrow('Unsupported executor "copy-paste"');
  });
});

describe('resolvePromptText', () => {
  test('uses prompt-file before stdin and positional prompt', async () => {
    const prompt = await resolvePromptText(
      'from-arg',
      { promptFile: '/tmp/input.md', stdinIsTTY: false },
      {
        readFile: async () => 'from-file',
        readStdin: async () => 'from-stdin',
      }
    );

    expect(prompt).toBe('from-file');
  });

  test('uses stdin when stdin is not a tty', async () => {
    const prompt = await resolvePromptText(
      'from-arg',
      { stdinIsTTY: false },
      {
        readStdin: async () => 'from-stdin',
      }
    );

    expect(prompt).toBe('from-stdin');
  });

  test('throws when stdin is not a tty but stdin is empty, even if positional arg exists', async () => {
    await expect(
      resolvePromptText(
        'from-arg',
        { stdinIsTTY: false },
        {
          readStdin: async () => '   ',
        }
      )
    ).rejects.toThrow('Prompt is required');
  });

  test('uses positional prompt when stdin is tty and no file is provided', async () => {
    const prompt = await resolvePromptText('from-arg', { stdinIsTTY: true }, {});
    expect(prompt).toBe('from-arg');
  });

  test('throws when no prompt is available', async () => {
    await expect(resolvePromptText(undefined, { stdinIsTTY: true }, {})).rejects.toThrow(
      'Prompt is required'
    );
  });

  test('throws when prompt resolves to only whitespace', async () => {
    await expect(resolvePromptText('   ', { stdinIsTTY: true }, {})).rejects.toThrow(
      'Prompt is required'
    );
  });
});

describe('resolveJsonSchemaOption', () => {
  test('accepts inline json schema', async () => {
    const schema = await resolveJsonSchemaOption('{"type":"object"}');
    expect(schema).toBe('{"type":"object"}');
  });

  test('loads schema from @path', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-run-prompt-schema-test-'));
    try {
      const schemaPath = path.join(tempDir, 'schema.json');
      await fs.writeFile(schemaPath, '{"type":"object","properties":{"answer":{"type":"string"}}}');

      const schema = await resolveJsonSchemaOption(`@${schemaPath}`);
      expect(schema).toContain('"answer"');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('throws when schema is not valid json', async () => {
    await expect(resolveJsonSchemaOption('{bad-json}')).rejects.toThrow('Invalid JSON schema');
  });

  test('throws when @ path is empty', async () => {
    await expect(resolveJsonSchemaOption('@')).rejects.toThrow(
      'JSON schema file path after "@" cannot be empty.'
    );
  });

  test('supports relative @path using cwd', async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'tim-run-prompt-schema-relative-test-')
    );
    try {
      const schemaPath = path.join(tempDir, 'schema.json');
      await fs.writeFile(schemaPath, '{"type":"object","required":["x"]}');

      const schema = await resolveJsonSchemaOption('@schema.json', { cwd: tempDir });
      expect(schema).toContain('"required"');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('resolveReasoningLevel', () => {
  test('accepts valid reasoning levels', () => {
    expect(resolveReasoningLevel('low')).toBe('low');
    expect(resolveReasoningLevel('xhigh')).toBe('xhigh');
    expect(resolveReasoningLevel(undefined)).toBeUndefined();
  });

  test('throws on invalid reasoning level', () => {
    expect(() => resolveReasoningLevel('max')).toThrow();
  });
});

describe('shouldAllowAllTools', () => {
  test('returns true for supported truthy values', () => {
    expect(shouldAllowAllTools('1')).toBe(true);
    expect(shouldAllowAllTools('true')).toBe(true);
    expect(shouldAllowAllTools(' TRUE ')).toBe(true);
  });

  test('returns false for missing or unsupported values', () => {
    expect(shouldAllowAllTools(undefined)).toBe(false);
    expect(shouldAllowAllTools('0')).toBe(false);
    expect(shouldAllowAllTools('yes')).toBe(false);
  });
});

describe('buildClaudeRunPromptArgs', () => {
  test('builds expected args with model and json schema', () => {
    const args = buildClaudeRunPromptArgs({
      prompt: 'hello',
      model: 'sonnet',
      jsonSchema: '{"type":"object"}',
      allowAllTools: true,
    });

    expect(args).toEqual([
      'claude',
      '--no-session-persistence',
      '--verbose',
      '--output-format',
      'stream-json',
      '--model',
      'sonnet',
      '--json-schema',
      '{"type":"object"}',
      '--dangerously-skip-permissions',
      '--print',
      'hello',
    ]);
  });

  test('builds expected args without optional flags', () => {
    const args = buildClaudeRunPromptArgs({ prompt: 'hello' });
    expect(args).toEqual([
      'claude',
      '--no-session-persistence',
      '--verbose',
      '--output-format',
      'stream-json',
      '--print',
      'hello',
    ]);
  });
});

describe('resolveClaudeModel', () => {
  test('returns known claude model families unchanged', () => {
    expect(resolveClaudeModel('claude-3-5-sonnet-latest')).toBe('claude-3-5-sonnet-latest');
    expect(resolveClaudeModel('claude-3-haiku')).toBe('claude-3-haiku');
    expect(resolveClaudeModel('claude-opus-4')).toBe('claude-opus-4');
  });

  test('omits unrecognized model names', () => {
    expect(resolveClaudeModel('gpt-4o')).toBeUndefined();
  });
});

describe('buildCodexRunPromptArgs', () => {
  test('builds expected args with schema and reasoning', () => {
    const args = buildCodexRunPromptArgs({
      prompt: 'hello',
      outputSchemaPath: '/tmp/schema.json',
      reasoningLevel: 'high',
      allowAllTools: false,
      isUsingExternalStorage: true,
      externalRepositoryConfigDir: '/tmp/repo-config',
    });

    expect(args).toEqual([
      'codex',
      '--enable',
      'web_search_request',
      'exec',
      '-c',
      'model_reasoning_effort=high',
      '--sandbox',
      'workspace-write',
      '-c',
      'sandbox_workspace_write.writable_roots=["/tmp/repo-config"]',
      '--output-schema',
      '/tmp/schema.json',
      '--json',
      'hello',
    ]);
  });

  test('uses dangerous mode when allowAllTools is true', () => {
    const args = buildCodexRunPromptArgs({
      prompt: 'hello',
      allowAllTools: true,
    });

    expect(args).toEqual([
      'codex',
      '--enable',
      'web_search_request',
      'exec',
      '-c',
      'model_reasoning_effort=medium',
      '--dangerously-bypass-approvals-and-sandbox',
      '--json',
      'hello',
    ]);
  });

  test('does not add writable_roots when external storage details are incomplete', () => {
    const args = buildCodexRunPromptArgs({
      prompt: 'hello',
      allowAllTools: false,
      isUsingExternalStorage: true,
    });

    expect(args).toEqual([
      'codex',
      '--enable',
      'web_search_request',
      'exec',
      '-c',
      'model_reasoning_effort=medium',
      '--sandbox',
      'workspace-write',
      '--json',
      'hello',
    ]);
  });
});

describe('normalizeStructuredJsonOutput', () => {
  test('throws a descriptive error when json string is invalid', () => {
    expect(() => normalizeStructuredJsonOutput('{bad-json')).toThrow(
      'Failed to parse structured output from executor'
    );
  });

  test('parses json wrapped in markdown code fences', () => {
    expect(normalizeStructuredJsonOutput('```json\n{"answer":"ok"}\n```')).toBe(
      '{\n  "answer": "ok"\n}'
    );
  });
});

describe('handleRunPromptCommand', () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  test('routes execution logs to stderr, writes final output to stdout, and wraps in headless adapter', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stdoutWrites: string[] = [];
    const headlessInvocations: Array<{ enabled: boolean; command: string }> = [];

    await handleRunPromptCommand(
      'run this prompt',
      { executor: 'claude' },
      {},
      {
        loadEffectiveConfigFn: async () => ({ headless: {} }) as any,
        isTunnelActiveFn: () => false,
        runWithHeadlessAdapterIfEnabledFn: async (headlessOptions) => {
          headlessInvocations.push({
            enabled: headlessOptions.enabled,
            command: headlessOptions.command,
          });
          return headlessOptions.callback();
        },
        executeClaudePromptFn: async (_prompt, _options) => {
          getLoggerAdapter()?.log('executor-log');
          return 'final response';
        },
        stdoutWrite: (output) => {
          stdoutWrites.push(output);
        },
        stdinIsTTY: true,
      }
    );

    expect(stderrSpy).toHaveBeenCalledWith('executor-log');
    expect(stdoutWrites).toEqual(['final response\n']);
    expect(headlessInvocations).toEqual([{ enabled: true, command: 'run-prompt' }]);
  });

  test('uses quiet logger adapter when quiet mode is enabled', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stdoutWrites: string[] = [];

    await handleRunPromptCommand(
      'run quietly',
      { executor: 'claude', quiet: true },
      {},
      {
        loadEffectiveConfigFn: async () => ({ headless: {} }) as any,
        isTunnelActiveFn: () => true,
        runWithHeadlessAdapterIfEnabledFn: async (headlessOptions) => headlessOptions.callback(),
        executeClaudePromptFn: async () => {
          getLoggerAdapter()?.log('quiet-log');
          return 'quiet response';
        },
        stdoutWrite: (output) => {
          stdoutWrites.push(output);
        },
        stdinIsTTY: true,
      }
    );

    expect(stderrSpy).not.toHaveBeenCalledWith('quiet-log');
    expect(stdoutWrites).toEqual(['quiet response\n']);
  });

  test('propagates executor failures and does not write stdout', async () => {
    const stdoutWrites: string[] = [];

    await expect(
      handleRunPromptCommand(
        'break',
        { executor: 'codex' },
        {},
        {
          loadEffectiveConfigFn: async () => ({ headless: {} }) as any,
          isTunnelActiveFn: () => true,
          runWithHeadlessAdapterIfEnabledFn: async (headlessOptions) => headlessOptions.callback(),
          executeCodexPromptFn: async () => {
            throw new Error('codex failed');
          },
          stdoutWrite: (output) => {
            stdoutWrites.push(output);
          },
          stdinIsTTY: true,
        }
      )
    ).rejects.toThrow('codex failed');

    expect(stdoutWrites).toEqual([]);
  });

  test('warns when --model is provided for codex executor', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await handleRunPromptCommand(
      'run this prompt',
      { executor: 'codex', model: 'gpt-4o' },
      {},
      {
        loadEffectiveConfigFn: async () => ({ headless: {} }) as any,
        isTunnelActiveFn: () => true,
        runWithHeadlessAdapterIfEnabledFn: async (headlessOptions) => headlessOptions.callback(),
        executeCodexPromptFn: async () => 'codex response',
        stdoutWrite: () => {},
        stdinIsTTY: true,
      }
    );

    expect(stderrSpy).toHaveBeenCalledWith(
      'Ignoring --model for codex executor. This option only applies to claude.'
    );
  });

  test('warns when --reasoning-level is provided for claude executor', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await handleRunPromptCommand(
      'run this prompt',
      { executor: 'claude', reasoningLevel: 'high' },
      {},
      {
        loadEffectiveConfigFn: async () => ({ headless: {} }) as any,
        isTunnelActiveFn: () => true,
        runWithHeadlessAdapterIfEnabledFn: async (headlessOptions) => headlessOptions.callback(),
        executeClaudePromptFn: async () => 'claude response',
        stdoutWrite: () => {},
        stdinIsTTY: true,
      }
    );

    expect(stderrSpy).toHaveBeenCalledWith(
      'Ignoring --reasoning-level for claude executor. This option only applies to codex.'
    );
  });

  test('passes resolved jsonSchema to codex executor', async () => {
    const executeCodexPromptFn = vi.fn(async () => 'codex response');

    await handleRunPromptCommand(
      'run this prompt',
      { executor: 'codex', jsonSchema: '{"type":"object"}' },
      {},
      {
        loadEffectiveConfigFn: async () => ({ headless: {} }) as any,
        isTunnelActiveFn: () => true,
        runWithHeadlessAdapterIfEnabledFn: async (headlessOptions) => headlessOptions.callback(),
        executeCodexPromptFn,
        stdoutWrite: () => {},
        stdinIsTTY: true,
      }
    );

    expect(executeCodexPromptFn).toHaveBeenCalledWith('run this prompt', {
      jsonSchema: '{"type":"object"}',
      reasoningLevel: undefined,
      allowAllTools: false,
      cwd: process.cwd(),
      externalRepositoryConfigDir: undefined,
      isUsingExternalStorage: undefined,
    });
  });

  test('passes allowAllTools=true to claude executor when env value is injected', async () => {
    const executeClaudePromptFn = vi.fn(async () => 'claude response');

    await handleRunPromptCommand(
      'run this prompt',
      { executor: 'claude' },
      {},
      {
        loadEffectiveConfigFn: async () => ({ headless: {} }) as any,
        isTunnelActiveFn: () => true,
        runWithHeadlessAdapterIfEnabledFn: async (headlessOptions) => headlessOptions.callback(),
        executeClaudePromptFn,
        stdoutWrite: () => {},
        stdinIsTTY: true,
        envAllowAllTools: '1',
      }
    );

    expect(executeClaudePromptFn).toHaveBeenCalledWith('run this prompt', {
      model: undefined,
      jsonSchema: undefined,
      allowAllTools: true,
      cwd: process.cwd(),
    });
  });

  test('prefers injected envAllowAllTools over process.env for codex executor', async () => {
    const executeCodexPromptFn = vi.fn(async () => 'codex response');
    const previousAllowAllTools = process.env.ALLOW_ALL_TOOLS;
    process.env.ALLOW_ALL_TOOLS = '1';

    try {
      await handleRunPromptCommand(
        'run this prompt',
        { executor: 'codex' },
        {},
        {
          loadEffectiveConfigFn: async () => ({ headless: {} }) as any,
          isTunnelActiveFn: () => true,
          runWithHeadlessAdapterIfEnabledFn: async (headlessOptions) => headlessOptions.callback(),
          executeCodexPromptFn,
          stdoutWrite: () => {},
          stdinIsTTY: true,
          envAllowAllTools: '0',
        }
      );
    } finally {
      if (previousAllowAllTools === undefined) {
        delete process.env.ALLOW_ALL_TOOLS;
      } else {
        process.env.ALLOW_ALL_TOOLS = previousAllowAllTools;
      }
    }

    expect(executeCodexPromptFn).toHaveBeenCalledWith('run this prompt', {
      jsonSchema: undefined,
      reasoningLevel: undefined,
      allowAllTools: false,
      cwd: process.cwd(),
      externalRepositoryConfigDir: undefined,
      isUsingExternalStorage: undefined,
    });
  });
});
