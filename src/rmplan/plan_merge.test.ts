import { describe, expect, test } from 'bun:test';

import {
  GENERATED_END_DELIMITER,
  GENERATED_START_DELIMITER,
  findResearchSectionStart,
  mergeDetails,
  mergeTasksIntoPlan,
  updateDetailsWithinDelimiters,
} from './plan_merge.js';
import type { PlanSchema } from './planSchema.js';

const basePlan: PlanSchema = {
  id: 42,
  title: 'Original Plan',
  goal: 'Ship feature X',
  details: '# Overview\n\nExisting details\n\n## Research\n- Finding A',
  status: 'pending',
  priority: 'medium',
  generatedBy: 'agent',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  planGeneratedAt: '2024-01-01T00:00:00.000Z',
  promptsGeneratedAt: '2024-01-01T00:00:00.000Z',
  dependencies: [7],
  tasks: [
    {
      title: 'Completed Task',
      description: 'Already done',
      steps: [
        { prompt: 'Step 1', done: true },
        { prompt: 'Step 2', done: true },
      ],
    },
    {
      title: 'Pending Task',
      description: 'Needs work',
      steps: [{ prompt: 'Investigate', done: false }],
    },
  ],
};

describe('findResearchSectionStart', () => {
  test('returns undefined when details missing or section absent', () => {
    expect(findResearchSectionStart()).toBeUndefined();
    expect(findResearchSectionStart('No research heading')).toBeUndefined();
  });

  test('returns index when research section present', () => {
    const details = '# Intro\n\n## Research\nNotes';
    const index = findResearchSectionStart(details);
    expect(index).toBe(details.indexOf('## Research'));
  });
});

describe('mergeDetails', () => {
  test('wraps new content with delimiters when original empty', () => {
    const merged = mergeDetails('Generated content', undefined);
    expect(merged).toBe(
      `${GENERATED_START_DELIMITER}\nGenerated content\n${GENERATED_END_DELIMITER}`
    );
  });

  test('inserts before research section when no delimiters exist', () => {
    const original = '# Intro\n\n## Research\nExisting notes';
    const merged = mergeDetails('Fresh details', original);

    expect(merged?.includes('Fresh details')).toBe(true);
    const researchIndex = merged?.indexOf('## Research');
    expect(researchIndex).toBeDefined();
    const generatedIndex = merged?.indexOf(GENERATED_START_DELIMITER);
    expect(generatedIndex).toBeLessThan(researchIndex ?? 0);
  });

  test('replaces content between existing delimiters', () => {
    const original = `${GENERATED_START_DELIMITER}
Old content
${GENERATED_END_DELIMITER}

## Research
Existing notes`;

    const merged = mergeDetails('New content', original);
    expect(merged).toContain('New content');
    expect(merged).not.toContain('Old content');
    expect((merged?.match(new RegExp(GENERATED_START_DELIMITER, 'g')) ?? []).length).toBe(1);
  });
});

describe('updateDetailsWithinDelimiters', () => {
  const original =
    '# Summary\n\n' +
    `${GENERATED_START_DELIMITER}
Existing generated
${GENERATED_END_DELIMITER}

## Research
- A finding`;

  test('replaces generated block by default', () => {
    const updated = updateDetailsWithinDelimiters('Replacement', original, false);
    expect(updated).toContain('Replacement');
    expect(updated).not.toContain('Existing generated');
    expect(updated).toContain('## Research');
  });

  test('appends when requested', () => {
    const firstUpdate = updateDetailsWithinDelimiters('First update', original, true);
    const secondUpdate = updateDetailsWithinDelimiters('Second update', firstUpdate, true);

    expect(secondUpdate).toContain('Existing generated');
    expect(secondUpdate).toContain('First update');
    expect(secondUpdate).toContain('Second update');
    expect(secondUpdate).toContain('## Research');
  });

  test('creates delimiters when missing while preserving research', () => {
    const withoutDelimiters = '# Summary\n\n## Research\n- Previous notes';
    const updated = updateDetailsWithinDelimiters('Generated block', withoutDelimiters, false);

    expect(updated.indexOf(GENERATED_START_DELIMITER)).toBeLessThan(updated.indexOf('## Research'));
    expect(updated).toContain('Generated block');
    expect(updated).toContain('## Research');
  });
});

describe('mergeTasksIntoPlan', () => {
  test('preserves metadata and completed tasks', async () => {
    const newPlanData: Partial<PlanSchema> = {
      title: 'Updated Plan Title',
      goal: 'Ship feature X faster',
      details: 'Updated details block',
      priority: 'high',
      tasks: [
        {
          title: 'Completed Task [TASK-1]',
          description: 'Should stay untouched',
          steps: [{ prompt: 'Changed', done: false }],
        },
        {
          title: 'Pending Task [TASK-2]',
          description: 'Refined description',
          steps: [
            { prompt: 'Investigate', done: false },
            { prompt: 'Implement', done: false },
          ],
        },
        {
          title: 'New Task Without ID',
          description: 'Follow-up work',
          steps: [{ prompt: 'Do it', done: false }],
        },
      ],
    };

    const merged = await mergeTasksIntoPlan(newPlanData, basePlan);

    expect(merged.id).toBe(basePlan.id);
    expect(merged.parent).toBe(basePlan.parent);
    expect(merged.dependencies).toEqual(basePlan.dependencies);
    expect(merged.priority).toBe('high');
    expect(merged.title).toBe('Updated Plan Title');
    expect(merged.goal).toBe('Ship feature X faster');
    expect(merged.details).toContain(GENERATED_START_DELIMITER);
    expect(merged.details).toContain('Updated details block');

    expect(merged.tasks).toHaveLength(3);
    expect(merged.tasks[0]).toEqual(basePlan.tasks[0]); // completed task preserved
    expect(merged.tasks[1].title).toBe('Pending Task');
    expect(merged.tasks[1].description).toBe('Refined description');
    expect(merged.tasks[2].title).toBe('New Task Without ID');
  });

  test('throws when validation fails', async () => {
    await expect(
      mergeTasksIntoPlan(
        {
          tasks: [
            // Missing description triggers validation error
            // @ts-expect-error - intentional test case with invalid shape
            { title: 'Invalid Task' },
          ],
        },
        basePlan
      )
    ).rejects.toThrow(/Plan data failed validation/);
  });
});
