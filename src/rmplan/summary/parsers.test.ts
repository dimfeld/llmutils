import { describe, expect, it } from 'bun:test';
import {
  parseExecutorOutput,
  parseCodexOutput,
  parseClaudeOutput,
  parseGenericOutput,
} from './parsers.js';

describe('summary/parsers', () => {
  it('parseGenericOutput returns stringified content', () => {
    const res = parseGenericOutput({ a: 1 });
    expect(res.success).toBeTrue();
    expect(res.content).toContain('"a":1');
  });

  it('parseClaudeOutput returns trimmed string', () => {
    const res = parseClaudeOutput('  hello world  ');
    expect(res.success).toBeTrue();
    expect(res.content).toBe('hello world');
  });

  it('parseClaudeOutput extracts last assistant rawMessage from JSONL', () => {
    const jsonl = [
      '{"type":"system","rawMessage":"sys"}',
      '{"type":"assistant","rawMessage":"first"}',
      'not json',
      '{"type":"assistant","rawMessage":"second"}',
    ].join('\n');
    const res = parseClaudeOutput(jsonl);
    expect(res.success).toBeTrue();
    expect(res.content).toBe('second');
    expect((res.metadata as any)?.phase).toBe('orchestrator');
  });

  it('parseClaudeOutput tolerates malformed mixed content', () => {
    const jsonl = ['garbage line', '{ invalid json', '{"type":"assistant","rawMessage":"ok"}'].join(
      '\n'
    );
    const res = parseClaudeOutput(jsonl);
    expect(res.success).toBeTrue();
    expect(res.content).toBe('ok');
  });

  it('parseCodexOutput extracts labeled sections into metadata', () => {
    const raw = `=== Codex Implementer ===\nimpl body\n\n=== Codex Tester ===\ntest body\n\n=== Codex Reviewer ===\nreview body\n`;
    const res = parseCodexOutput(raw);
    expect(res.success).toBeTrue();
    expect(res.metadata).toBeTruthy();
    expect(String((res.metadata as any).implementer)).toContain('impl body');
    expect(String((res.metadata as any).tester)).toContain('test body');
    expect(String((res.metadata as any).reviewer)).toContain('review body');
    expect(res.content).toContain('Implementer:');
    expect(res.content).toContain('Tester:');
    expect(res.content).toContain('Reviewer:');
  });

  it('parseExecutorOutput dispatches by executor name', () => {
    const codex = parseExecutorOutput('codex-cli', '=== Codex Implementer ===\nX');
    expect(codex.success).toBeTrue();
    const claude = parseExecutorOutput('claude-code', 'final');
    expect(claude.content).toBe('final');
    const other = parseExecutorOutput('copy-only', 'anything');
    expect(other.content).toBe('anything');
  });
});
