import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ModuleMocker } from '../../../testing.js';

describe('analyzeReviewFeedback', () => {
  let moduleMocker: ModuleMocker;

  beforeEach(() => {
    moduleMocker = new ModuleMocker(import.meta);
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('returns needs_fixes=false for clearly out-of-scope issues', async () => {
    await moduleMocker.mock('ai', () => ({
      generateObject: mock(async ({ schema, prompt }) => ({
        object: { needs_fixes: false },
      })),
    }));

    await moduleMocker.mock('../../../common/model_factory.ts', () => ({
      createModel: mock(async () => ({}) as any),
    }));

    const { analyzeReviewFeedback } = await import('./review_analysis.ts');

    const res = await analyzeReviewFeedback({
      reviewerOutput:
        'Please also implement a completely new feature mentioned in Task Z (not part of this batch).',
      completedTasks: ['Task A'],
      pendingTasks: ['Task Z'],
      implementerOutput: 'Implemented Task A changes',
    });

    expect(res.needs_fixes).toBe(false);
    expect(res.fix_instructions).toBeUndefined();
  });

  test('returns needs_fixes=true with instructions for in-scope blocking issues', async () => {
    await moduleMocker.mock('ai', () => ({
      generateObject: mock(async () => ({
        object: {
          needs_fixes: true,
          fix_instructions: 'Add null checks in src/foo.ts:42 and update unit tests.',
        },
      })),
    }));

    await moduleMocker.mock('../../../common/model_factory.ts', () => ({
      createModel: mock(async () => ({}) as any),
    }));

    const { analyzeReviewFeedback } = await import('./review_analysis.ts');

    const res = await analyzeReviewFeedback({
      reviewerOutput: 'Null reference bug in current changes causing crash.',
      completedTasks: ['Task A'],
      pendingTasks: [],
      implementerOutput: 'Implemented Task A changes',
    });

    expect(res.needs_fixes).toBe(true);
    expect(res.fix_instructions).toContain('null checks');
  });

  test('includes repository review doc in prompt when provided', async () => {
    const generateObjectSpy = mock(async ({ prompt }) => ({
      object: { needs_fixes: false },
    }));

    await moduleMocker.mock('ai', () => ({
      generateObject: generateObjectSpy,
    }));

    await moduleMocker.mock('../../../common/model_factory.ts', () => ({
      createModel: mock(async () => ({}) as any),
    }));

    const { analyzeReviewFeedback } = await import('./review_analysis.ts');

    const repoDoc = 'Review Notes: Focus on security and tests.';
    await analyzeReviewFeedback({
      reviewerOutput: 'Minor nit: rename variable',
      completedTasks: ['Task A'],
      pendingTasks: ['Task B'],
      implementerOutput: 'Changes...',
      repoReviewDoc: repoDoc,
    });

    // Ensure the prompt included the review doc content
    const promptArg = generateObjectSpy.mock.calls[0]?.[0]?.prompt as string;
    expect(promptArg).toContain(repoDoc);
  });

  test('defaults to needs_fixes=true on model failure', async () => {
    await moduleMocker.mock('ai', () => ({
      generateObject: mock(async () => {
        throw new Error('network error');
      }),
    }));

    await moduleMocker.mock('../../../common/model_factory.ts', () => ({
      createModel: mock(async () => ({}) as any),
    }));

    const { analyzeReviewFeedback } = await import('./review_analysis.ts');

    const res = await analyzeReviewFeedback({
      reviewerOutput: 'Something went wrong',
      completedTasks: [],
      pendingTasks: [],
      implementerOutput: '',
    });

    expect(res.needs_fixes).toBe(true);
    expect(res.fix_instructions).toBeDefined();
  });

  test('includes fixerOutput in prompt when provided', async () => {
    const generateObjectSpy = mock(async ({ prompt }) => ({
      object: { needs_fixes: false },
    }));

    await moduleMocker.mock('ai', () => ({
      generateObject: generateObjectSpy,
    }));

    await moduleMocker.mock('../../../common/model_factory.ts', () => ({
      createModel: mock(async () => ({}) as any),
    }));

    const { analyzeReviewFeedback } = await import('./review_analysis.ts');

    const fixerOutput = 'Applied the requested changes to address the review feedback.';
    await analyzeReviewFeedback({
      reviewerOutput: 'Still has issues after fixes',
      completedTasks: ['Task A'],
      pendingTasks: ['Task B'],
      fixerOutput,
    });

    // Ensure the prompt included the fixer output content
    const promptArg = generateObjectSpy.mock.calls[0]?.[0]?.prompt as string;
    expect(promptArg).toContain(fixerOutput);
    expect(promptArg).toContain("## Coding Agent's Response to Previous Review");
  });

  test('works without implementerOutput when fixerOutput is provided', async () => {
    await moduleMocker.mock('ai', () => ({
      generateObject: mock(async () => ({
        object: { needs_fixes: false },
      })),
    }));

    await moduleMocker.mock('../../../common/model_factory.ts', () => ({
      createModel: mock(async () => ({}) as any),
    }));

    const { analyzeReviewFeedback } = await import('./review_analysis.ts');

    const res = await analyzeReviewFeedback({
      reviewerOutput: 'Review after fixes',
      completedTasks: ['Task A'],
      pendingTasks: [],
      fixerOutput: 'Implemented fixes for the issues',
    });

    expect(res.needs_fixes).toBe(false);
  });
});
