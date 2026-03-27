import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'path';
import { ModuleMocker } from '../../testing.js';
import type { TimConfig } from '../configSchema.js';
import type { PlanSchema } from '../planSchema.js';
import { writePlanToDb } from '../plans.js';
import {
  buildUpdateLessonsPrompt,
  extractLessonsLearned,
  handleUpdateLessonsCommand,
  runUpdateLessons,
} from './update-lessons.js';

describe('update-lessons command', () => {
  const moduleMocker = new ModuleMocker(import.meta);
  let tempDir: string;
  let otherDir: string;
  let planFile: string;
  let originalCwd: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-update-lessons-test-'));
    otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-update-lessons-other-'));
    planFile = path.join(tempDir, 'test-plan.md');
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    moduleMocker.clear();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(otherDir, { recursive: true, force: true });
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

    test('removes lessons-learned subsection from plan context', () => {
      const planData: PlanSchema = {
        id: 177,
        title: 'lessons learned updating',
        status: 'done',
        details: `## Current Progress
### Current State
- Working on docs

### Lessons Learned
- Keep tests small
- Prefer stable interfaces

### Risks / Blockers
- None

## Implementation Notes
- Preserve useful context`,
      };

      const prompt = buildUpdateLessonsPrompt(planData, '- Keep tests small');

      expect(prompt).toContain('## Plan Context');
      expect(prompt).toContain('### Current State');
      expect(prompt).toContain('### Risks / Blockers');
      expect(prompt).toContain('## Implementation Notes');
      expect(prompt).not.toContain('### Lessons Learned');
      expect(prompt).not.toContain('Prefer stable interfaces');
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

    test('uses resolved repoRoot as executor baseDir for cross-repo config', async () => {
      const configPath = path.join(tempDir, '.tim.yml');
      await fs.writeFile(configPath, 'defaultExecutor: codex-cli\n');
      await writePlanToDb(
        {
          id: 8,
          title: 'Cross-repo lessons update',
          goal: 'Apply lessons in the target repo',
          details: `## Current Progress
### Lessons Learned
- Keep cross-repo execution anchored to the target repo.
`,
          tasks: [],
        },
        { cwdForIdentity: tempDir }
      );

      const executeSpy = mock(async () => undefined);
      const buildExecutorAndLogSpy = mock((_executor: string, options: { baseDir: string }) => {
        expect(options.baseDir).toBe(tempDir);
        return { execute: executeSpy };
      });

      await moduleMocker.mock('../../common/input.js', () => ({
        promptCheckbox: async ({ choices }: { choices: Array<{ value: string }> }) =>
          choices.map((choice) => choice.value),
      }));
      await moduleMocker.mock('../configLoader.js', () => ({
        loadEffectiveConfig: async () => ({
          defaultExecutor: 'codex-cli',
          updateDocs: {},
          isUsingExternalStorage: true,
        }),
      }));
      await moduleMocker.mock('../executors/index.js', () => ({
        buildExecutorAndLog: buildExecutorAndLogSpy,
        DEFAULT_EXECUTOR: 'codex-cli',
        defaultModelForExecutor: () => 'test-model',
      }));

      process.chdir(otherDir);

      const mockCommand = {
        parent: {
          opts: () => ({ config: configPath }),
        },
      };

      await handleUpdateLessonsCommand('8', {}, mockCommand);

      expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(executeSpy.mock.calls[0]?.[1]?.planFilePath).toBe(
        path.join(tempDir, '.tim', 'plans', '8.plan.md')
      );
    });
  });

  describe('runUpdateLessons', () => {
    test('returns false when lessons are missing', async () => {
      const content = `## Current Progress
### Current State
- Working through tasks
`;
      await fs.writeFile(planFile, content);

      const planData: PlanSchema = {
        id: 177,
        title: 'lessons learned updating',
        goal: '',
        details: content,
      };

      const didRun = await runUpdateLessons(planData, planFile, {} as TimConfig, {});

      expect(didRun).toBe(false);
    });

    test('resolves repoRoot for string plan args when baseDir is omitted', async () => {
      const helperPlanFile = path.join(tempDir, 'helper-lessons-plan.md');
      await fs.writeFile(
        helperPlanFile,
        `---
id: 188
title: Cross-repo helper lessons update
goal: Run helper in target repo
tasks: []
---

## Current Progress
### Lessons Learned
- Keep helper execution anchored to the target repo.
`
      );

      const executeSpy = mock(async () => undefined);
      const buildExecutorAndLogSpy = mock((_executor: string, options: { baseDir: string }) => {
        expect(options.baseDir).toBe(tempDir);
        return { execute: executeSpy };
      });

      await moduleMocker.mock('../../common/input.js', () => ({
        promptCheckbox: async ({ choices }: { choices: Array<{ value: string }> }) =>
          choices.map((choice) => choice.value),
      }));
      await moduleMocker.mock('../executors/index.js', () => ({
        buildExecutorAndLog: buildExecutorAndLogSpy,
        DEFAULT_EXECUTOR: 'codex-cli',
        defaultModelForExecutor: () => 'test-model',
      }));

      process.chdir(otherDir);

      const didRun = await runUpdateLessons(
        helperPlanFile,
        {
          defaultExecutor: 'codex-cli',
          updateDocs: {},
          isUsingExternalStorage: true,
        } as TimConfig,
        {}
      );

      expect(didRun).toBe(true);
      expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(executeSpy.mock.calls[0]?.[1]?.planFilePath).toBe(helperPlanFile);
    });

    test('uses configPath to resolve target repo for string plan IDs', async () => {
      const configPath = path.join(tempDir, '.tim.yml');
      await fs.writeFile(configPath, 'defaultExecutor: codex-cli\n');
      await writePlanToDb(
        {
          id: 18,
          title: 'Helper config-path lessons update',
          goal: 'Resolve repo from config path',
          details: `## Current Progress
### Lessons Learned
- Keep helper execution anchored to the configured repo.
`,
          tasks: [],
        },
        { cwdForIdentity: tempDir }
      );

      const executeSpy = mock(async () => undefined);
      const buildExecutorAndLogSpy = mock((_executor: string, options: { baseDir: string }) => {
        expect(options.baseDir).toBe(tempDir);
        return { execute: executeSpy };
      });

      await moduleMocker.mock('../../common/input.js', () => ({
        promptCheckbox: async ({ choices }: { choices: Array<{ value: string }> }) =>
          choices.map((choice) => choice.value),
      }));
      await moduleMocker.mock('../executors/index.js', () => ({
        buildExecutorAndLog: buildExecutorAndLogSpy,
        DEFAULT_EXECUTOR: 'codex-cli',
        defaultModelForExecutor: () => 'test-model',
      }));

      process.chdir(otherDir);

      const didRun = await runUpdateLessons(
        '18',
        {
          defaultExecutor: 'codex-cli',
          updateDocs: {},
          isUsingExternalStorage: true,
        } as TimConfig,
        { configPath }
      );

      expect(didRun).toBe(true);
      expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(executeSpy.mock.calls[0]?.[1]?.planFilePath).toBe(
        path.join(tempDir, '.tim', 'plans', '18.plan.md')
      );
    });
  });
});
