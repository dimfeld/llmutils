import { describe, test, expect } from 'vitest';
import {
  getImplementerPrompt,
  getTddTestsPrompt,
  getTesterPrompt,
} from '../executors/claude_code/agent_prompts.js';

describe('subagent prompt function correctness', () => {
  test('getImplementerPrompt with mode: report includes progress reporting', () => {
    const result = getImplementerPrompt('test context', 42, 'custom instructions', undefined, {
      mode: 'report',
    });

    expect(result.name).toBe('implementer');
    expect(result.prompt).toContain('test context');
    expect(result.prompt).toContain('custom instructions');
    expect(result.prompt).toContain('Report progress, decisions, and blockers to the orchestrator');
    expect(result.prompt).toContain('Do NOT update the plan file directly');
  });

  test('getTesterPrompt with mode: report includes progress reporting', () => {
    const result = getTesterPrompt('test context', 42, 'custom instructions', undefined, {
      mode: 'report',
    });

    expect(result.name).toBe('tester');
    expect(result.prompt).toContain('test context');
    expect(result.prompt).toContain('custom instructions');
    expect(result.prompt).toContain('Report progress, decisions, and blockers to the orchestrator');
  });

  test('getTddTestsPrompt with mode: report includes TDD-first guidance', () => {
    const result = getTddTestsPrompt('test context', 42, 'custom instructions', undefined, {
      mode: 'report',
    });

    expect(result.name).toBe('tdd-tests');
    expect(result.prompt).toContain('test context');
    expect(result.prompt).toContain('custom instructions');
    expect(result.prompt).toContain('tests should initially FAIL');
    expect(result.prompt).toContain('Report progress, decisions, and blockers to the orchestrator');
  });

  test('getImplementerPrompt custom instructions appear in dedicated section', () => {
    const result = getImplementerPrompt('', 42, 'My custom instruction', undefined, {
      mode: 'report',
    });

    expect(result.prompt).toContain('## Custom Instructions');
    expect(result.prompt).toContain('My custom instruction');
  });

  test('getImplementerPrompt without custom instructions omits section', () => {
    const result = getImplementerPrompt('', 42, undefined, undefined, {
      mode: 'report',
    });

    expect(result.prompt).not.toContain('## Custom Instructions');
  });

  test('getTesterPrompt model is passed through', () => {
    const result = getTesterPrompt('', 42, undefined, 'sonnet', {
      mode: 'report',
    });

    expect(result.model).toBe('sonnet');
  });

  test('getImplementerPrompt includes FAILED_PROTOCOL_INSTRUCTIONS', () => {
    const result = getImplementerPrompt('', 42, undefined, undefined, {
      mode: 'report',
    });

    expect(result.prompt).toContain('Failure Protocol');
    expect(result.prompt).toContain('FAILED:');
  });

  test('getTesterPrompt includes FAILED_PROTOCOL_INSTRUCTIONS', () => {
    const result = getTesterPrompt('', 42, undefined, undefined, {
      mode: 'report',
    });

    expect(result.prompt).toContain('Failure Protocol');
    expect(result.prompt).toContain('FAILED:');
  });

  test('getImplementerPrompt skills include using-tim', () => {
    const result = getImplementerPrompt('', 42, undefined, undefined, {
      mode: 'report',
    });

    expect(result.skills).toContain('using-tim');
  });

  test('all prompt functions produce skills with using-tim', () => {
    const impl = getImplementerPrompt('ctx', 1, undefined, undefined, { mode: 'report' });
    const tdd = getTddTestsPrompt('ctx', 1, undefined, undefined, { mode: 'report' });
    const tester = getTesterPrompt('ctx', 1, undefined, undefined, { mode: 'report' });

    expect(impl.skills).toContain('using-tim');
    expect(tdd.skills).toContain('using-tim');
    expect(tester.skills).toContain('using-tim');
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
