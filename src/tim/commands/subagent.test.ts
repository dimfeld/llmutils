import { describe, test, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  getImplementerPrompt,
  getTddTestsPrompt,
  getTesterPrompt,
  getVerifierAgentPrompt,
} from '../executors/claude_code/agent_prompts.js';

describe('subagent prompt function correctness', () => {
  test('getImplementerPrompt with mode: report includes progress reporting', () => {
    const result = getImplementerPrompt('test context', '42', 'custom instructions', undefined, {
      mode: 'report',
    });

    expect(result.name).toBe('implementer');
    expect(result.prompt).toContain('test context');
    expect(result.prompt).toContain('custom instructions');
    expect(result.prompt).toContain('Report progress, decisions, and blockers to the orchestrator');
    expect(result.prompt).toContain('Do NOT update the plan file directly');
  });

  test('getTesterPrompt with mode: report includes progress reporting', () => {
    const result = getTesterPrompt('test context', '42', 'custom instructions', undefined, {
      mode: 'report',
    });

    expect(result.name).toBe('tester');
    expect(result.prompt).toContain('test context');
    expect(result.prompt).toContain('custom instructions');
    expect(result.prompt).toContain('Report progress, decisions, and blockers to the orchestrator');
  });

  test('getTddTestsPrompt with mode: report includes TDD-first guidance', () => {
    const result = getTddTestsPrompt('test context', '42', 'custom instructions', undefined, {
      mode: 'report',
    });

    expect(result.name).toBe('tdd-tests');
    expect(result.prompt).toContain('test context');
    expect(result.prompt).toContain('custom instructions');
    expect(result.prompt).toContain('tests should initially FAIL');
    expect(result.prompt).toContain('Report progress, decisions, and blockers to the orchestrator');
  });

  test('getVerifierAgentPrompt with mode: report includes progress reporting', () => {
    const result = getVerifierAgentPrompt(
      'test context',
      '42',
      'custom instructions',
      undefined,
      false,
      false,
      {
        mode: 'report',
      }
    );

    expect(result.name).toBe('verifier');
    expect(result.prompt).toContain('test context');
    expect(result.prompt).toContain('custom instructions');
    expect(result.prompt).toContain('Report progress, decisions, and blockers to the orchestrator');
  });

  test('getImplementerPrompt custom instructions appear in dedicated section', () => {
    const result = getImplementerPrompt('context', '42', 'My custom instruction', undefined, {
      mode: 'report',
    });

    expect(result.prompt).toContain('## Custom Instructions');
    expect(result.prompt).toContain('My custom instruction');
  });

  test('getImplementerPrompt without custom instructions omits section', () => {
    const result = getImplementerPrompt('context', '42', undefined, undefined, {
      mode: 'report',
    });

    expect(result.prompt).not.toContain('## Custom Instructions');
  });

  test('getTesterPrompt model is passed through', () => {
    const result = getTesterPrompt('context', '42', undefined, 'sonnet', {
      mode: 'report',
    });

    expect(result.model).toBe('sonnet');
  });

  test('getVerifierAgentPrompt model is passed through', () => {
    const result = getVerifierAgentPrompt('context', '42', undefined, 'haiku', false, false, {
      mode: 'report',
    });

    expect(result.model).toBe('haiku');
  });

  test('getImplementerPrompt includes FAILED_PROTOCOL_INSTRUCTIONS', () => {
    const result = getImplementerPrompt('context', '42', undefined, undefined, {
      mode: 'report',
    });

    expect(result.prompt).toContain('Failure Protocol');
    expect(result.prompt).toContain('FAILED:');
  });

  test('getTesterPrompt includes FAILED_PROTOCOL_INSTRUCTIONS', () => {
    const result = getTesterPrompt('context', '42', undefined, undefined, {
      mode: 'report',
    });

    expect(result.prompt).toContain('Failure Protocol');
    expect(result.prompt).toContain('FAILED:');
  });

  test('getVerifierAgentPrompt includes FAILED_PROTOCOL_INSTRUCTIONS', () => {
    const result = getVerifierAgentPrompt('context', '42', undefined, undefined, false, false, {
      mode: 'report',
    });

    expect(result.prompt).toContain('Failure Protocol');
    expect(result.prompt).toContain('FAILED:');
  });

  test('getImplementerPrompt skills include using-tim', () => {
    const result = getImplementerPrompt('context', '42', undefined, undefined, {
      mode: 'report',
    });

    expect(result.skills).toContain('using-tim');
  });

  test('all prompt functions produce skills with using-tim', () => {
    const impl = getImplementerPrompt('ctx', '1', undefined, undefined, { mode: 'report' });
    const tdd = getTddTestsPrompt('ctx', '1', undefined, undefined, { mode: 'report' });
    const tester = getTesterPrompt('ctx', '1', undefined, undefined, { mode: 'report' });
    const verifier = getVerifierAgentPrompt('ctx', '1', undefined, undefined, false, false, {
      mode: 'report',
    });

    expect(impl.skills).toContain('using-tim');
    expect(tdd.skills).toContain('using-tim');
    expect(tester.skills).toContain('using-tim');
    expect(verifier.skills).toContain('using-tim');
  });
});

describe('allowed tools in getDefaultAllowedTools', () => {
  test('Bash(tim subagent:*) is in the default allowed tools list', async () => {
    const { getDefaultAllowedTools } =
      await import('../executors/claude_code/run_claude_subprocess.ts');
    const tools = getDefaultAllowedTools();
    expect(tools).toContain('Bash(tim subagent:*)');
  });

  test('Bash(tim subagent:*) coexists with other tim tools', async () => {
    const { getDefaultAllowedTools } =
      await import('../executors/claude_code/run_claude_subprocess.ts');
    const tools = getDefaultAllowedTools();

    expect(tools).toContain('Bash(tim add:*)');
    expect(tools).toContain('Bash(tim review:*)');
    expect(tools).toContain('Bash(tim set-task-done:*)');
    expect(tools).toContain('Bash(tim subagent:*)');
  });
});

describe('subagent command registration in tim.ts', () => {
  test('registers subagent command with all four subcommands', async () => {
    const sourceFile = path.join(import.meta.dirname, '..', 'tim.ts');
    const source = await fs.readFile(sourceFile, 'utf-8');

    expect(source).toContain("command('subagent')");
    expect(source).toContain('Run a subagent for the orchestrator');
    expect(source).toContain("'implementer'");
    expect(source).toContain("'tester'");
    expect(source).toContain("'tdd-tests'");
    expect(source).toContain("'verifier'");
  });

  test('subcommands accept required options', async () => {
    const sourceFile = path.join(import.meta.dirname, '..', 'tim.ts');
    const source = await fs.readFile(sourceFile, 'utf-8');

    expect(source).toContain('<planFile>');
    expect(source).toContain("'--input <text>'");
    expect(source).toContain("'--input-file <paths...>'");
    expect(source).toContain("'--output-file <path>'");
    expect(source).toContain("'-x, --executor <name>'");
    expect(source).toContain("'-m, --model <model>'");
  });

  test('subcommands import and call handleSubagentCommand', async () => {
    const sourceFile = path.join(import.meta.dirname, '..', 'tim.ts');
    const source = await fs.readFile(sourceFile, 'utf-8');

    expect(source).toContain("import('./commands/subagent.js')");
    expect(source).toContain('handleSubagentCommand');
  });

  test('subcommand default executor is claude-code', async () => {
    const sourceFile = path.join(import.meta.dirname, '..', 'tim.ts');
    const source = await fs.readFile(sourceFile, 'utf-8');

    expect(source).toContain("'claude-code'");
  });

  test('subcommand executor option uses .choices() for validation', async () => {
    const sourceFile = path.join(import.meta.dirname, '..', 'tim.ts');
    const source = await fs.readFile(sourceFile, 'utf-8');

    expect(source).toContain(".choices(['codex-cli', 'claude-code'])");
  });
});
