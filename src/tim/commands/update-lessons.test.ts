import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'path';
import type { TimConfig } from '../configSchema.js';
import type { PlanSchema } from '../planSchema.js';
import {
  buildUpdateLessonsPrompt,
  extractLessonsLearned,
  handleUpdateLessonsCommand,
  runUpdateLessons,
} from './update-lessons.js';

describe('update-lessons command', () => {
  let tempDir: string;
  let planFile: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-update-lessons-test-'));
    planFile = path.join(tempDir, 'test-plan.md');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('extractLessonsLearned', () => {
    test('extracts lessons learned content when present', async () => {
      const content = `---
id: 177
title: lessons learned updating
---

## Current Progress
### Current State
- Working on review feedback

### Lessons Learned
- Bun snapshots can hide brittle assertions.
- Review fixes often need broader context updates.

### Risks / Blockers
- None
`;
      await fs.writeFile(planFile, content);

      const lessons = await extractLessonsLearned(planFile);

      expect(lessons).toContain('Bun snapshots can hide brittle assertions.');
      expect(lessons).toContain('Review fixes often need broader context updates.');
    });

    test('returns null when Lessons Learned content is None', async () => {
      const content = `---
id: 177
title: lessons learned updating
---

## Current Progress
### Lessons Learned
- None

### Risks / Blockers
- None
`;
      await fs.writeFile(planFile, content);

      const lessons = await extractLessonsLearned(planFile);

      expect(lessons).toBeNull();
    });

    test('returns null when Lessons Learned section is missing', async () => {
      const content = `---
id: 177
title: lessons learned updating
---

## Current Progress
### Current State
- Working through remaining tasks

### Risks / Blockers
- None
`;
      await fs.writeFile(planFile, content);

      const lessons = await extractLessonsLearned(planFile);

      expect(lessons).toBeNull();
    });

    test('returns null when Current Progress section is missing', async () => {
      const content = `---
id: 177
title: lessons learned updating
---

## Notes
### Lessons Learned
- This should not be read when Current Progress is absent.
`;
      await fs.writeFile(planFile, content);

      const lessons = await extractLessonsLearned(planFile);

      expect(lessons).toBeNull();
    });

    test('ignores Current Progress text in YAML frontmatter', async () => {
      const content = `---
id: 177
title: lessons learned updating
notes: |
  ## Current Progress
  ### Lessons Learned
  - this line is in frontmatter and should be ignored
---

## Notes
- No current progress section in markdown body.
`;
      await fs.writeFile(planFile, content);

      const lessons = await extractLessonsLearned(planFile);

      expect(lessons).toBeNull();
    });
  });

  describe('buildUpdateLessonsPrompt', () => {
    test('includes lessons text, plan context, and process-doc guidance', () => {
      const planData: PlanSchema = {
        id: 177,
        title: 'lessons learned updating',
        goal: 'Capture and apply implementation lessons',
        details: 'Adds post-completion lessons documentation updates',
        status: 'done',
      };
      const lessonsText = `- Parser must handle missing sections safely.
- Review fixes exposed undocumented workflow assumptions.`;

      const prompt = buildUpdateLessonsPrompt(planData, lessonsText);

      expect(prompt).toContain('## Lessons Learned');
      expect(prompt).toContain(lessonsText);
      expect(prompt).toContain('# Plan: lessons learned updating');
      expect(prompt).toContain('## Goal');
      expect(prompt).toContain('Capture and apply implementation lessons');
      expect(prompt).toContain(
        'Focus on documentation about process, conventions, workflows, and gotchas'
      );
      expect(prompt).toContain(
        'Do not focus on feature/API docs unless a lesson directly requires it.'
      );
    });

    test('includes Files to Include section when include patterns are provided', () => {
      const planData: PlanSchema = {
        id: 177,
        title: 'lessons learned updating',
        status: 'done',
      };

      const prompt = buildUpdateLessonsPrompt(planData, '- Lesson one', {
        include: ['CLAUDE.md', 'docs/**/*.md'],
      });

      expect(prompt).toContain('## Files to Include');
      expect(prompt).toContain('Only edit documentation files matching these descriptions:');
      expect(prompt).toContain('- CLAUDE.md');
      expect(prompt).toContain('- docs/**/*.md');
    });

    test('includes Files to Exclude section when exclude patterns are provided', () => {
      const planData: PlanSchema = {
        id: 177,
        title: 'lessons learned updating',
        status: 'done',
      };

      const prompt = buildUpdateLessonsPrompt(planData, '- Lesson one', {
        exclude: ['README.md', '.github/**'],
      });

      expect(prompt).toContain('## Files to Exclude');
      expect(prompt).toContain('Never edit documentation files matching these descriptions:');
      expect(prompt).toContain('- README.md');
      expect(prompt).toContain('- .github/**');
    });
  });

  describe('handleUpdateLessonsCommand', () => {
    test('requires planFile parameter', async () => {
      const mockCommand = {
        parent: {
          opts: () => ({ config: undefined }),
        },
      };

      await expect(handleUpdateLessonsCommand(undefined, {}, mockCommand)).rejects.toThrow(
        'Plan file or ID is required'
      );
    });
  });

  describe('runUpdateLessons', () => {
    test('returns false when lessons are missing', async () => {
      const content = `---
id: 177
title: lessons learned updating
---

## Current Progress
### Current State
- Working through tasks
`;
      await fs.writeFile(planFile, content);

      const didRun = await runUpdateLessons(planFile, {} as TimConfig, {});

      expect(didRun).toBe(false);
    });
  });
});
