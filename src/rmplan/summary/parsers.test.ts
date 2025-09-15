import { describe, expect, it } from 'bun:test';
import { parseExecutorOutput } from './parsers.js';

describe('summary/parsers', () => {
  it('passes through structured executor result', () => {
    const res = parseExecutorOutput('codex-cli', {
      content: 'hello',
      metadata: { sections: [{ title: 'A', body: 'B' }] },
    });
    expect(res.success).toBeTrue();
    expect(res.content).toBe('hello');
    expect((res.metadata as any)?.sections?.[0]?.title).toBe('A');
  });

  it('fails when non-structured data provided', () => {
    const res = parseExecutorOutput('codex-cli', 'plain string is invalid now');
    expect(res.success).toBeFalse();
    expect(String(res.error || '')).toContain('structured');
  });
});
