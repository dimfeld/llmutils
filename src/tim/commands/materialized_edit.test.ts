import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'yaml';
import { clearAllTimCaches } from '../../testing.js';
import { closeDatabaseForTesting } from '../db/database.js';
import { clearPlanSyncContext } from '../db/plan_sync.js';
import { getMaterializedPlanPath } from '../plan_materialize.js';
import type { PlanSchema } from '../planSchema.js';
import { NoFrontmatterError, readPlanFile, resolvePlanFromDb, writePlanFile } from '../plans.js';

const mockState = vi.hoisted(() => ({
  attempt: 0,
  editorBehavior: undefined as
    | undefined
    | ((editedPath: string, attempt: number) => Promise<void> | void),
  promptConfirm: vi.fn(async () => true),
  warn: vi.fn(),
  error: vi.fn(),
  log: vi.fn(),
  syncHook: undefined as undefined | ((...args: any[]) => Promise<unknown> | unknown),
}));

vi.mock('../../common/input.js', () => ({
  promptConfirm: mockState.promptConfirm,
}));

vi.mock('../../common/process.js', () => ({
  logSpawn: vi.fn((cmd: string[]) => {
    const attempt = ++mockState.attempt;
    const editedPath = cmd[1]!;
    return {
      exitCode: 0,
      exited: Promise.try(async () => {
        await mockState.editorBehavior?.(editedPath, attempt);
        return 0;
      }),
    };
  }),
}));

vi.mock('../../logging.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../logging.js')>();
  return {
    ...actual,
    warn: mockState.warn,
    error: mockState.error,
    log: mockState.log,
    debugLog: vi.fn(),
  };
});

vi.mock('../plan_materialize.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../plan_materialize.js')>();
  return {
    ...actual,
    syncMaterializedPlan: vi.fn(async (...args: any[]) => {
      if (mockState.syncHook) {
        return await mockState.syncHook(...args);
      }
      return await actual.syncMaterializedPlan(...args);
    }),
  };
});

import { editMaterializedPlan, isUserFixableParseError } from './materialized_edit.js';

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('materialized edit retry flow', () => {
  let tempDir: string;
  let planFile: string;
  let basePlan: PlanSchema;

  beforeEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-materialized-edit-'));
    planFile = path.join(tempDir, '12-edit.plan.md');
    await Bun.$`git init`.cwd(tempDir).quiet();
    await Bun.$`git remote add origin https://example.com/acme/materialized-edit-tests.git`
      .cwd(tempDir)
      .quiet();

    basePlan = {
      id: 12,
      title: 'Edit plan',
      goal: 'Verify retry behavior',
      details: 'Original details',
      status: 'pending',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      tasks: [],
    };
    await writePlanFile(planFile, basePlan, {
      cwdForIdentity: tempDir,
      skipUpdatedAt: true,
    });

    mockState.attempt = 0;
    mockState.editorBehavior = undefined;
    mockState.syncHook = undefined;
    mockState.promptConfirm.mockReset();
    mockState.promptConfirm.mockResolvedValue(true);
    mockState.warn.mockClear();
    mockState.error.mockClear();
    mockState.log.mockClear();
  });

  afterEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    vi.clearAllMocks();
    mockState.attempt = 0;
    mockState.editorBehavior = undefined;
    mockState.syncHook = undefined;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('classifies user-fixable parse errors', () => {
    const noFrontmatter = new NoFrontmatterError('/tmp/plan.md');
    const planFileError = Object.assign(new Error('bad schema'), { name: 'PlanFileError' });
    const yamlParseError = Object.assign(new Error('bad yaml'), { name: 'YAMLParseError' });
    const genericError = new Error('uuid mismatch');

    expect(isUserFixableParseError(noFrontmatter)).toBe(true);
    expect(isUserFixableParseError(planFileError)).toBe(true);
    expect(isUserFixableParseError(yamlParseError)).toBe(true);
    expect(isUserFixableParseError(genericError)).toBe(false);
    expect(isUserFixableParseError('not an error')).toBe(false);
  });

  test('syncs a successful edit without prompting again', async () => {
    mockState.editorBehavior = async (editedPath) => {
      const plan = await readPlanFile(editedPath);
      plan.details = 'Edited details';
      await writePlanFile(editedPath, plan, { skipDb: true, skipUpdatedAt: true });
    };

    await editMaterializedPlan(12, tempDir, 'test-editor');

    const resolved = await resolvePlanFromDb('12', tempDir);
    expect(resolved.plan.details).toBe('Edited details');
    expect(mockState.promptConfirm).not.toHaveBeenCalled();
    await expect(Bun.file(getMaterializedPlanPath(tempDir, 12)).exists()).resolves.toBe(false);
  });

  test('re-opens the editor after a YAML parse failure and syncs once fixed', async () => {
    mockState.promptConfirm.mockResolvedValueOnce(true);
    mockState.editorBehavior = async (editedPath, attempt) => {
      if (attempt === 1) {
        await Bun.write(editedPath, '---\ntitle: [broken\n---\n');
        return;
      }

      await writePlanFile(
        editedPath,
        {
          ...basePlan,
          details: 'Recovered after retry',
        },
        { skipDb: true, skipUpdatedAt: true }
      );
    };

    await editMaterializedPlan(12, tempDir, 'test-editor');

    const resolved = await resolvePlanFromDb('12', tempDir);
    expect(resolved.plan.details).toBe('Recovered after retry');
    expect(mockState.promptConfirm).toHaveBeenCalledTimes(1);

    const errorOutput = stripAnsi(
      mockState.error.mock.calls.map((call) => call.map(String).join(' ')).join('\n')
    );
    expect(errorOutput).toContain('Failed to parse edited plan 12');
    expect(errorOutput).toContain('line 1');
    await expect(Bun.file(getMaterializedPlanPath(tempDir, 12)).exists()).resolves.toBe(false);
  });

  test('preserves the materialized file when schema validation fails and the user declines re-edit', async () => {
    mockState.promptConfirm.mockResolvedValueOnce(false);
    mockState.editorBehavior = async (editedPath) => {
      const currentPlan = await readPlanFile(editedPath);
      const { details, ...frontmatter } = currentPlan;
      frontmatter.status = 'invalid_status' as any;
      await Bun.write(editedPath, `---\n${yaml.stringify(frontmatter)}---\n\n${details}\n`);
    };

    await expect(editMaterializedPlan(12, tempDir, 'test-editor')).rejects.toMatchObject({
      name: 'PlanFileError',
    });

    expect(mockState.promptConfirm).toHaveBeenCalledTimes(1);
    const materializedPath = getMaterializedPlanPath(tempDir, 12);
    await expect(Bun.file(materializedPath).exists()).resolves.toBe(true);

    const warningOutput = mockState.warn.mock.calls
      .map((call) => call.map(String).join(' '))
      .join('\n');
    expect(warningOutput).toContain(
      `Failed to sync edited plan 12. Edited file kept at ${materializedPath}`
    );
  });

  test('treats prompt rejection as decline and preserves file with original error', async () => {
    const exitPromptError = new Error('Prompt was cancelled');
    exitPromptError.name = 'ExitPromptError';
    mockState.promptConfirm.mockRejectedValueOnce(exitPromptError);
    mockState.editorBehavior = async (editedPath) => {
      await Bun.write(editedPath, '---\ntitle: [broken\n---\n');
    };

    const err = await editMaterializedPlan(12, tempDir, 'test-editor').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('YAMLParseError');
    expect(mockState.promptConfirm).toHaveBeenCalledTimes(1);
    await expect(Bun.file(getMaterializedPlanPath(tempDir, 12)).exists()).resolves.toBe(true);
  });

  test('retries after NoFrontmatterError when user accepts re-edit', async () => {
    mockState.promptConfirm.mockResolvedValueOnce(true);
    mockState.editorBehavior = async (editedPath, attempt) => {
      if (attempt === 1) {
        await Bun.write(editedPath, 'no frontmatter here, just text');
        return;
      }
      await writePlanFile(
        editedPath,
        { ...basePlan, details: 'Fixed after NoFrontmatterError' },
        { skipDb: true, skipUpdatedAt: true }
      );
    };

    await editMaterializedPlan(12, tempDir, 'test-editor');

    const resolved = await resolvePlanFromDb('12', tempDir);
    expect(resolved.plan.details).toBe('Fixed after NoFrontmatterError');
    expect(mockState.promptConfirm).toHaveBeenCalledTimes(1);

    const errorOutput = stripAnsi(
      mockState.error.mock.calls.map((call) => call.map(String).join(' ')).join('\n')
    );
    expect(errorOutput).toContain('Failed to parse edited plan 12');
    expect(errorOutput).toContain('lacks frontmatter');
  });

  test('does not prompt again for non-parse sync errors', async () => {
    mockState.syncHook = async () => {
      throw new Error('sync exploded');
    };
    mockState.editorBehavior = async (editedPath) => {
      const plan = await readPlanFile(editedPath);
      plan.details = 'Triggers sync failure';
      await writePlanFile(editedPath, plan, { skipDb: true, skipUpdatedAt: true });
    };

    await expect(editMaterializedPlan(12, tempDir, 'test-editor')).rejects.toThrow('sync exploded');

    expect(mockState.promptConfirm).not.toHaveBeenCalled();
    await expect(Bun.file(getMaterializedPlanPath(tempDir, 12)).exists()).resolves.toBe(true);
  });
});
