import { describe, it, expect } from 'bun:test';
import { getFixerPrompt } from './codex_cli/context_composition.ts';

describe('codex_cli fixer prompt includes failure protocol', () => {
  it('getFixerPrompt contains FAILED protocol instructions', async () => {
    const prompt: string = getFixerPrompt({
      implementerOutput: 'impl',
      testerOutput: 'test',
      completedTaskTitles: [],
      fixInstructions: 'fix it',
    });

    expect(prompt).toContain('FAILED:');
    expect(prompt).toContain('Failure Protocol');
  });
});
