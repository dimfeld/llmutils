import { describe, it, expect } from 'bun:test';
import { CodexCliExecutor } from './codex_cli.ts';

describe('codex_cli fixer prompt includes failure protocol', () => {
  it('getFixerPrompt contains FAILED protocol instructions', async () => {
    const exec = new CodexCliExecutor(
      {},
      { baseDir: process.cwd() },
      {} as any
    );

    // Access the private method via any-cast to validate prompt contents
    const prompt: string = (exec as any).getFixerPrompt({
      implementerOutput: 'impl',
      testerOutput: 'test',
      completedTaskTitles: [],
      fixInstructions: 'fix it',
    });

    expect(prompt).toContain('FAILED:');
    expect(prompt).toContain('Failure Protocol');
  });
});

