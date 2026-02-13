import { describe, test, expect } from 'bun:test';
import { getDefaultAllowedTools, buildAllowedToolsList } from './run_claude_subprocess.ts';

describe('getDefaultAllowedTools', () => {
  test('returns an array of tool strings', () => {
    const tools = getDefaultAllowedTools();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
  });

  test('includes core editing tools', () => {
    const tools = getDefaultAllowedTools();
    expect(tools).toContain('Edit');
    expect(tools).toContain('MultiEdit');
    expect(tools).toContain('Write');
  });

  test('includes web tools', () => {
    const tools = getDefaultAllowedTools();
    expect(tools).toContain('WebFetch');
    expect(tools).toContain('WebSearch');
  });

  test('includes git and jj commands', () => {
    const tools = getDefaultAllowedTools();
    expect(tools).toContain('Bash(git diff:*)');
    expect(tools).toContain('Bash(git status:*)');
    expect(tools).toContain('Bash(git log:*)');
    expect(tools).toContain('Bash(git commit:*)');
    expect(tools).toContain('Bash(git add:*)');
    expect(tools).toContain('Bash(jj diff:*)');
    expect(tools).toContain('Bash(jj status)');
    expect(tools).toContain('Bash(jj log:*)');
    expect(tools).toContain('Bash(jj commit:*)');
    expect(tools).toContain('Bash(jj bookmark move:*)');
  });

  test('includes tim commands', () => {
    const tools = getDefaultAllowedTools();
    expect(tools).toContain('Bash(tim add:*)');
    expect(tools).toContain('Bash(tim review:*)');
    expect(tools).toContain('Bash(tim set-task-done:*)');
    expect(tools).toContain('Bash(tim subagent:*)');
  });

  test('includes JS task runner commands for all runners', () => {
    const tools = getDefaultAllowedTools();
    for (const runner of ['npm', 'pnpm', 'yarn', 'bun']) {
      expect(tools).toContain(`Bash(${runner} test:*)`);
      expect(tools).toContain(`Bash(${runner} run build:*)`);
      expect(tools).toContain(`Bash(${runner} run check:*)`);
      expect(tools).toContain(`Bash(${runner} run typecheck:*)`);
      expect(tools).toContain(`Bash(${runner} run lint:*)`);
      expect(tools).toContain(`Bash(${runner} install)`);
      expect(tools).toContain(`Bash(${runner} add:*)`);
    }
  });

  test('includes cargo commands', () => {
    const tools = getDefaultAllowedTools();
    expect(tools).toContain('Bash(cargo add:*)');
    expect(tools).toContain('Bash(cargo build)');
    expect(tools).toContain('Bash(cargo test:*)');
  });
});

describe('buildAllowedToolsList', () => {
  test('returns default tools when includeDefaultTools is true', () => {
    const tools = buildAllowedToolsList({ includeDefaultTools: true });
    expect(tools).toContain('Edit');
    expect(tools).toContain('Bash(git diff:*)');
  });

  test('returns empty array when includeDefaultTools is false and no config', () => {
    const tools = buildAllowedToolsList({ includeDefaultTools: false });
    expect(tools).toEqual([]);
  });

  test('defaults includeDefaultTools to true', () => {
    const tools = buildAllowedToolsList({});
    expect(tools).toContain('Edit');
  });

  test('merges config allowed tools', () => {
    const tools = buildAllowedToolsList({
      includeDefaultTools: false,
      configAllowedTools: ['CustomTool', 'AnotherTool'],
    });
    expect(tools).toEqual(['CustomTool', 'AnotherTool']);
  });

  test('merges shared permissions', () => {
    const tools = buildAllowedToolsList({
      includeDefaultTools: false,
      sharedPermissions: ['SharedTool'],
    });
    expect(tools).toEqual(['SharedTool']);
  });

  test('filters out disallowed tools', () => {
    const tools = buildAllowedToolsList({
      includeDefaultTools: true,
      disallowedTools: ['Edit', 'Write'],
    });
    expect(tools).not.toContain('Edit');
    expect(tools).not.toContain('Write');
    expect(tools).toContain('MultiEdit');
  });

  test('combines all sources and applies filters', () => {
    const tools = buildAllowedToolsList({
      includeDefaultTools: false,
      configAllowedTools: ['ToolA', 'ToolB'],
      sharedPermissions: ['ToolC'],
      disallowedTools: ['ToolB'],
    });
    expect(tools).toEqual(['ToolA', 'ToolC']);
  });
});
