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

  it('includes progress update guidance without @ prefix', async () => {
    const prompt: string = getFixerPrompt({
      planPath: '/plans/152.plan.md',
      implementerOutput: 'impl',
      testerOutput: 'test',
      completedTaskTitles: [],
      fixInstructions: 'fix it',
    });

    expect(prompt).toContain('Progress Updates (Plan File)');
    expect(prompt).toContain('Update the plan file at: /plans/152.plan.md');
    expect(prompt).not.toContain('@/plans/152.plan.md');
  });
});
