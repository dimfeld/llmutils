import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('../plan_repo_root.js', () => ({
  resolveRepoRootForPlanArg: vi.fn(),
}));

vi.mock('../plans.js', () => ({
  writePlanFile: vi.fn(),
  resolvePlanFromDb: vi.fn(),
  parsePlanIdFromCliArg: vi.fn((arg: string) => Number(arg)),
}));

vi.mock('../../logging/tunnel_client.js', () => ({
  isTunnelActive: vi.fn(),
}));

vi.mock('../headless.js', () => ({
  runWithHeadlessAdapterIfEnabled: vi.fn(async (options: any) => options.callback()),
}));

vi.mock('../actions.js', () => ({
  executePostApplyCommand: vi.fn(),
}));

vi.mock('./update-docs.js', () => ({
  runUpdateDocs: vi.fn(),
}));

vi.mock('./update-lessons.js', () => ({
  runUpdateLessons: vi.fn(),
}));

vi.mock('../workspace/workspace_setup.js', () => ({
  setupWorkspace: vi.fn(),
}));

vi.mock('../workspace/workspace_roundtrip.js', () => ({
  prepareWorkspaceRoundTrip: vi.fn(),
  runPreExecutionWorkspaceSync: vi.fn(),
  runPostExecutionWorkspaceSync: vi.fn(),
  materializePlansForExecution: vi.fn(async () => undefined),
}));

vi.mock('../plan_materialize.js', () => ({
  materializePlan: vi.fn(),
}));

import { loadEffectiveConfig } from '../configLoader.js';
import { resolveRepoRootForPlanArg } from '../plan_repo_root.js';
import { resolvePlanFromDb, writePlanFile } from '../plans.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { runWithHeadlessAdapterIfEnabled } from '../headless.js';
import { runUpdateDocs } from './update-docs.js';
import { runUpdateLessons } from './update-lessons.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';
import {
  materializePlansForExecution,
  prepareWorkspaceRoundTrip,
  runPostExecutionWorkspaceSync,
  runPreExecutionWorkspaceSync,
} from '../workspace/workspace_roundtrip.js';
import { materializePlan } from '../plan_materialize.js';
import { getFinishRequirements, handleFinishCommand, isPlanReadyToFinish } from './finish.js';
import { executePostApplyCommand } from '../actions.js';

describe('finish command', () => {
  const loadEffectiveConfigSpy = vi.mocked(loadEffectiveConfig);
  const resolveRepoRootForPlanArgSpy = vi.mocked(resolveRepoRootForPlanArg);
  const resolvePlanFromDbSpy = vi.mocked(resolvePlanFromDb);
  const writePlanFileSpy = vi.mocked(writePlanFile);
  const isTunnelActiveSpy = vi.mocked(isTunnelActive);
  const runWithHeadlessAdapterIfEnabledSpy = vi.mocked(runWithHeadlessAdapterIfEnabled);
  const runUpdateDocsSpy = vi.mocked(runUpdateDocs);
  const runUpdateLessonsSpy = vi.mocked(runUpdateLessons);
  const setupWorkspaceSpy = vi.mocked(setupWorkspace);
  const materializePlanSpy = vi.mocked(materializePlan);
  const executePostApplyCommandSpy = vi.mocked(executePostApplyCommand);
  const prepareWorkspaceRoundTripSpy = vi.mocked(prepareWorkspaceRoundTrip);
  const runPreExecutionWorkspaceSyncSpy = vi.mocked(runPreExecutionWorkspaceSync);
  const runPostExecutionWorkspaceSyncSpy = vi.mocked(runPostExecutionWorkspaceSync);
  const materializePlansForExecutionSpy = vi.mocked(materializePlansForExecution);

  const basePlan = {
    id: 314,
    uuid: '11111111-1111-4111-8111-111111111111',
    title: 'finish plan command',
    status: 'needs_review' as const,
    epic: false,
    tasks: [{ title: 'done task', description: 'implemented', done: true }],
  };

  function buildCommand(configPath = '/repo/.tim.yml') {
    return {
      parent: {
        opts: () => ({ config: configPath }),
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    loadEffectiveConfigSpy.mockResolvedValue({
      updateDocs: {
        mode: 'manual',
        applyLessons: true,
      },
    } as any);
    resolveRepoRootForPlanArgSpy.mockResolvedValue('/repo');
    resolvePlanFromDbSpy.mockResolvedValue({
      plan: { ...basePlan },
      planPath: '/repo/.tim/plans/314.plan.md',
    } as any);
    isTunnelActiveSpy.mockReturnValue(false);
    runWithHeadlessAdapterIfEnabledSpy.mockImplementation(async (options: any) =>
      options.callback()
    );
    executePostApplyCommandSpy.mockResolvedValue(true);
    runUpdateDocsSpy.mockResolvedValue(undefined);
    runUpdateLessonsSpy.mockResolvedValue(true);
    setupWorkspaceSpy.mockResolvedValue({
      baseDir: '/repo/workspaces/finish',
      planFile: '/repo/workspaces/finish/.tim/plans/314.plan.md',
      branchCreatedDuringSetup: false,
    } as any);
    prepareWorkspaceRoundTripSpy.mockResolvedValue(null as any);
    runPreExecutionWorkspaceSyncSpy.mockResolvedValue(undefined);
    runPostExecutionWorkspaceSyncSpy.mockResolvedValue(undefined);
    materializePlansForExecutionSpy.mockResolvedValue(undefined);
    materializePlanSpy.mockResolvedValue('/repo/.tim/plans/314.plan.md');
    writePlanFileSpy.mockResolvedValue(undefined);
  });

  test('getFinishRequirements only requires unfinished finalization steps', () => {
    expect(
      getFinishRequirements(
        { docsUpdatedAt: undefined, lessonsAppliedAt: undefined } as any,
        { updateDocs: { mode: 'manual', applyLessons: true } },
        {}
      )
    ).toEqual({
      needsDocs: true,
      needsLessons: true,
      needsExecutor: true,
    });

    expect(
      getFinishRequirements(
        {
          docsUpdatedAt: '2026-04-01T00:00:00.000Z',
          lessonsAppliedAt: '2026-04-02T00:00:00.000Z',
        } as any,
        { updateDocs: { mode: 'never', applyLessons: false } },
        {}
      )
    ).toEqual({
      needsDocs: false,
      needsLessons: false,
      needsExecutor: false,
    });
  });

  test('isPlanReadyToFinish allows done and needs_review, and completed in_progress plans', () => {
    expect(isPlanReadyToFinish({ status: 'done', tasks: [] } as any)).toBe(true);
    expect(isPlanReadyToFinish({ status: 'needs_review', tasks: [] } as any)).toBe(true);
    expect(
      isPlanReadyToFinish({
        status: 'in_progress',
        tasks: [{ done: true }],
      } as any)
    ).toBe(true);
    expect(
      isPlanReadyToFinish({
        status: 'in_progress',
        tasks: [{ done: false }],
      } as any)
    ).toBe(false);
  });

  test('runs docs and lessons when both are still pending', async () => {
    await handleFinishCommand('314', {}, buildCommand());

    expect(runWithHeadlessAdapterIfEnabledSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        command: 'update-docs',
        plan: expect.objectContaining({
          id: 314,
          title: 'finish plan command',
        }),
      })
    );
    expect(runUpdateDocsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 314 }),
      '/repo/.tim/plans/314.plan.md',
      expect.any(Object),
      expect.objectContaining({
        baseDir: '/repo',
        configPath: '/repo/.tim.yml',
      })
    );
    expect(runUpdateLessonsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 314 }),
      '/repo/.tim/plans/314.plan.md',
      expect.any(Object),
      expect.objectContaining({
        baseDir: '/repo',
        configPath: '/repo/.tim.yml',
      })
    );
    expect(writePlanFileSpy).toHaveBeenCalledWith(
      '/repo/.tim/plans/314.plan.md',
      expect.objectContaining({
        status: 'needs_review',
        docsUpdatedAt: expect.any(String),
        lessonsAppliedAt: expect.any(String),
        updatedAt: expect.any(String),
      }),
      { cwdForIdentity: '/repo' }
    );
  });

  test('skips workspace and headless setup when no executor work is needed', async () => {
    loadEffectiveConfigSpy.mockResolvedValue({
      updateDocs: {
        mode: 'never',
        applyLessons: false,
      },
    } as any);
    resolvePlanFromDbSpy.mockResolvedValue({
      plan: {
        ...basePlan,
        docsUpdatedAt: '2026-04-01T00:00:00.000Z',
        lessonsAppliedAt: '2026-04-02T00:00:00.000Z',
      },
      planPath: '/repo/.tim/plans/314.plan.md',
    } as any);

    await handleFinishCommand('314', { workspace: 'finish-task' }, buildCommand());

    expect(runWithHeadlessAdapterIfEnabledSpy).not.toHaveBeenCalled();
    expect(setupWorkspaceSpy).not.toHaveBeenCalled();
    expect(runUpdateDocsSpy).not.toHaveBeenCalled();
    expect(runUpdateLessonsSpy).not.toHaveBeenCalled();
    expect(writePlanFileSpy).toHaveBeenCalledWith(
      '/repo/.tim/plans/314.plan.md',
      expect.objectContaining({
        status: 'needs_review',
        docsUpdatedAt: '2026-04-01T00:00:00.000Z',
        lessonsAppliedAt: '2026-04-02T00:00:00.000Z',
      }),
      { cwdForIdentity: '/repo' }
    );
  });

  test('taskless epics always take the direct finish path', async () => {
    resolvePlanFromDbSpy.mockResolvedValue({
      plan: {
        ...basePlan,
        status: 'pending',
        epic: true,
        tasks: [],
      },
      planPath: '/repo/.tim/plans/314.plan.md',
    } as any);

    await handleFinishCommand('314', { workspace: 'finish-task' }, buildCommand());

    expect(runWithHeadlessAdapterIfEnabledSpy).not.toHaveBeenCalled();
    expect(setupWorkspaceSpy).not.toHaveBeenCalled();
    expect(runUpdateDocsSpy).not.toHaveBeenCalled();
    expect(runUpdateLessonsSpy).not.toHaveBeenCalled();
    expect(writePlanFileSpy).toHaveBeenCalledWith(
      '/repo/.tim/plans/314.plan.md',
      expect.objectContaining({
        status: 'pending',
        epic: true,
        tasks: [],
      }),
      { cwdForIdentity: '/repo' }
    );
  });

  test('only runs missing steps and performs workspace round-trip when workspace execution is requested', async () => {
    resolvePlanFromDbSpy.mockResolvedValue({
      plan: {
        ...basePlan,
        docsUpdatedAt: '2026-04-01T00:00:00.000Z',
      },
      planPath: '/repo/.tim/plans/314.plan.md',
    } as any);
    prepareWorkspaceRoundTripSpy.mockResolvedValue({
      executionWorkspacePath: '/repo/workspaces/finish',
    } as any);
    materializePlansForExecutionSpy.mockResolvedValue(
      '/repo/workspaces/finish/.tim/plans/314.plan.md'
    );

    await handleFinishCommand('314', { workspace: 'finish-task' }, buildCommand());

    expect(setupWorkspaceSpy).toHaveBeenCalled();
    expect(runPreExecutionWorkspaceSyncSpy).toHaveBeenCalled();
    expect(materializePlansForExecutionSpy).toHaveBeenCalledWith('/repo/workspaces/finish', 314);
    expect(runUpdateDocsSpy).not.toHaveBeenCalled();
    expect(runUpdateLessonsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 314 }),
      '/repo/workspaces/finish/.tim/plans/314.plan.md',
      expect.any(Object),
      expect.objectContaining({
        baseDir: '/repo/workspaces/finish',
      })
    );
    expect(runPostExecutionWorkspaceSyncSpy).toHaveBeenCalledWith(
      expect.any(Object),
      'update docs finalization'
    );
  });

  test('rejects plans that are not ready to finish', async () => {
    resolvePlanFromDbSpy.mockResolvedValue({
      plan: {
        ...basePlan,
        status: 'pending',
      },
      planPath: '/repo/.tim/plans/314.plan.md',
    } as any);

    await expect(handleFinishCommand('314', {}, buildCommand())).rejects.toThrow(
      'Plan 314 is not ready to finish.'
    );
  });

  test('rejects in_progress plans with incomplete tasks', async () => {
    resolvePlanFromDbSpy.mockResolvedValue({
      plan: {
        ...basePlan,
        status: 'in_progress',
        tasks: [
          { title: 'done task', description: 'done', done: true },
          { title: 'not done', description: 'not done', done: false },
        ],
      },
      planPath: '/repo/.tim/plans/314.plan.md',
    } as any);

    await expect(handleFinishCommand('314', {}, buildCommand())).rejects.toThrow(
      'Plan 314 is not ready to finish.'
    );
  });

  test('accepts in_progress plans with all tasks complete', async () => {
    resolvePlanFromDbSpy.mockResolvedValue({
      plan: {
        ...basePlan,
        status: 'in_progress',
        tasks: [
          { title: 'done1', description: 'd1', done: true },
          { title: 'done2', description: 'd2', done: true },
        ],
      },
      planPath: '/repo/.tim/plans/314.plan.md',
    } as any);

    await handleFinishCommand('314', {}, buildCommand());

    expect(writePlanFileSpy).toHaveBeenCalledWith(
      '/repo/.tim/plans/314.plan.md',
      expect.objectContaining({ status: 'in_progress' }),
      { cwdForIdentity: '/repo' }
    );
  });

  test('throws when no plan argument is provided', async () => {
    await expect(handleFinishCommand(undefined, {}, buildCommand())).rejects.toThrow(
      'A numeric plan ID is required.'
    );
  });

  test('does not set lessonsAppliedAt when runUpdateLessons returns false', async () => {
    runUpdateLessonsSpy.mockResolvedValue(false);
    loadEffectiveConfigSpy.mockResolvedValue({
      updateDocs: {
        mode: 'never',
        applyLessons: true,
      },
    } as any);

    await handleFinishCommand('314', {}, buildCommand());

    expect(runUpdateLessonsSpy).toHaveBeenCalled();
    expect(writePlanFileSpy).toHaveBeenCalled();
    const writtenPlan = writePlanFileSpy.mock.calls[0]![1];
    expect(writtenPlan.status).toBe('needs_review');
    expect(writtenPlan.lessonsAppliedAt).toBeUndefined();
  });

  test('sets lessonsAppliedAt when runUpdateLessons is skipped due to no lessons found', async () => {
    runUpdateLessonsSpy.mockResolvedValue('skipped-no-lessons' as const);

    await handleFinishCommand('314', {}, buildCommand());

    expect(runUpdateLessonsSpy).toHaveBeenCalled();
    const writtenPlan = writePlanFileSpy.mock.calls[0]![1];
    expect(writtenPlan.status).toBe('needs_review');
    expect(writtenPlan.lessonsAppliedAt).toBeDefined();
    expect(new Date(writtenPlan.lessonsAppliedAt).toISOString()).toBe(writtenPlan.lessonsAppliedAt);
  });

  test('throws when lessons fail but still persists docsUpdatedAt without marking done', async () => {
    runUpdateLessonsSpy.mockRejectedValue(new Error('lessons failed'));

    await expect(handleFinishCommand('314', {}, buildCommand())).rejects.toThrow(
      'Failed to finalize plan 314'
    );

    expect(writePlanFileSpy).toHaveBeenCalledWith(
      '/repo/.tim/plans/314.plan.md',
      expect.objectContaining({
        status: 'needs_review',
        docsUpdatedAt: expect.any(String),
      }),
      { cwdForIdentity: '/repo' }
    );
  });

  test('throws when docs fail but still persists lessonsAppliedAt without marking done', async () => {
    runUpdateDocsSpy.mockRejectedValue(new Error('docs failed'));

    await expect(handleFinishCommand('314', {}, buildCommand())).rejects.toThrow(
      'Failed to finalize plan 314'
    );

    expect(writePlanFileSpy).toHaveBeenCalledWith(
      '/repo/.tim/plans/314.plan.md',
      expect.objectContaining({
        status: 'needs_review',
        lessonsAppliedAt: expect.any(String),
      }),
      { cwdForIdentity: '/repo' }
    );
  });

  test('runs configured postApplyCommands after docs and lessons updates', async () => {
    loadEffectiveConfigSpy.mockResolvedValue({
      updateDocs: {
        mode: 'manual',
        applyLessons: true,
      },
      postApplyCommands: [{ title: 'Post apply', command: 'echo ok' }],
    } as any);

    await handleFinishCommand('314', {}, buildCommand());

    expect(executePostApplyCommandSpy).toHaveBeenCalledWith(
      { title: 'Post apply', command: 'echo ok' },
      '/repo'
    );
    expect(executePostApplyCommandSpy).toHaveBeenCalledTimes(1);
  });

  test('throws when postApplyCommands fail after docs/lessons finish', async () => {
    loadEffectiveConfigSpy.mockResolvedValue({
      updateDocs: {
        mode: 'manual',
        applyLessons: true,
      },
      postApplyCommands: [{ title: 'Post apply', command: 'exit 1' }],
    } as any);
    executePostApplyCommandSpy.mockResolvedValue(false);

    await expect(handleFinishCommand('314', {}, buildCommand())).rejects.toThrow(
      'Failed to finalize plan 314'
    );
    expect(writePlanFileSpy).toHaveBeenCalledWith(
      '/repo/.tim/plans/314.plan.md',
      expect.objectContaining({
        status: 'needs_review',
      }),
      { cwdForIdentity: '/repo' }
    );
    expect(executePostApplyCommandSpy).toHaveBeenCalledWith(
      { title: 'Post apply', command: 'exit 1' },
      '/repo'
    );
  });

  describe('getFinishRequirements edge cases', () => {
    test('applyLessons CLI option overrides config', () => {
      expect(
        getFinishRequirements(
          { docsUpdatedAt: undefined, lessonsAppliedAt: undefined } as any,
          { updateDocs: { mode: 'never', applyLessons: false } },
          { applyLessons: true }
        )
      ).toEqual({
        needsDocs: false,
        needsLessons: true,
        needsExecutor: true,
      });
    });

    test('already-set timestamps are skipped even with permissive config', () => {
      expect(
        getFinishRequirements(
          {
            docsUpdatedAt: '2026-04-01T00:00:00.000Z',
            lessonsAppliedAt: '2026-04-02T00:00:00.000Z',
          } as any,
          { updateDocs: { mode: 'after-completion', applyLessons: true } },
          { applyLessons: true }
        )
      ).toEqual({
        needsDocs: false,
        needsLessons: false,
        needsExecutor: false,
      });
    });

    test('manual mode still requires docs in finish context', () => {
      expect(
        getFinishRequirements(
          { docsUpdatedAt: undefined, lessonsAppliedAt: undefined } as any,
          { updateDocs: { mode: 'manual', applyLessons: true } },
          {}
        )
      ).toEqual({
        needsDocs: true,
        needsLessons: true,
        needsExecutor: true,
      });
    });
  });

  test('materializes plan from DB when planPath is null and executor work needed', async () => {
    resolvePlanFromDbSpy.mockResolvedValue({
      plan: { ...basePlan },
      planPath: null,
    } as any);
    materializePlanSpy.mockResolvedValue('/repo/.tim/plans/314.plan.md');

    await handleFinishCommand('314', {}, buildCommand());

    expect(materializePlanSpy).toHaveBeenCalledWith(314, '/repo');
    // Verify the materialized path was used for docs/lessons execution
    expect(runUpdateDocsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 314 }),
      '/repo/.tim/plans/314.plan.md',
      expect.anything(),
      expect.anything()
    );
    // Verify the materialized path was used for persistence
    expect(writePlanFileSpy).toHaveBeenCalledWith(
      '/repo/.tim/plans/314.plan.md',
      expect.objectContaining({ status: 'needs_review' }),
      expect.anything()
    );
  });

  test('does not materialize plan from DB when planPath is null and no executor work needed', async () => {
    resolvePlanFromDbSpy.mockResolvedValue({
      plan: {
        ...basePlan,
        docsUpdatedAt: '2026-01-01T00:00:00.000Z',
        lessonsAppliedAt: '2026-01-01T00:00:00.000Z',
      },
      planPath: null,
    } as any);

    await handleFinishCommand('314', {}, buildCommand());

    expect(materializePlanSpy).not.toHaveBeenCalled();
    // persistFinishedPlan is called with null planPath
    expect(writePlanFileSpy).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ status: 'needs_review' }),
      expect.anything()
    );
  });

  describe('isPlanReadyToFinish edge cases', () => {
    test('rejects cancelled plans', () => {
      expect(isPlanReadyToFinish({ status: 'cancelled', tasks: [] } as any)).toBe(false);
    });

    test('rejects deferred plans', () => {
      expect(isPlanReadyToFinish({ status: 'deferred', tasks: [] } as any)).toBe(false);
    });

    test('rejects in_progress plans with no tasks', () => {
      expect(isPlanReadyToFinish({ status: 'in_progress', tasks: [] } as any)).toBe(false);
    });

    test('accepts taskless epics regardless of status', () => {
      expect(isPlanReadyToFinish({ status: 'pending', epic: true, tasks: [] } as any)).toBe(true);
      expect(isPlanReadyToFinish({ status: 'in_progress', epic: true, tasks: [] } as any)).toBe(
        true
      );
    });
  });
});
