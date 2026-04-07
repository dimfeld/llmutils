import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('../plan_repo_root.js', () => ({
  resolveRepoRootForPlanArg: vi.fn(),
}));

vi.mock('../ensure_plan_in_db.js', () => ({
  resolvePlanFromDbOrSyncFile: vi.fn(),
}));

vi.mock('../plans.js', () => ({
  writePlanFile: vi.fn(),
}));

vi.mock('../../logging/tunnel_client.js', () => ({
  isTunnelActive: vi.fn(),
}));

vi.mock('../headless.js', () => ({
  runWithHeadlessAdapterIfEnabled: vi.fn(async (options: any) => options.callback()),
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

import { loadEffectiveConfig } from '../configLoader.js';
import { resolveRepoRootForPlanArg } from '../plan_repo_root.js';
import { resolvePlanFromDbOrSyncFile } from '../ensure_plan_in_db.js';
import { writePlanFile } from '../plans.js';
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
import {
  getFinishRequirements,
  handleFinishCommand,
  isPlanReadyToFinish,
} from './finish.js';

describe('finish command', () => {
  const loadEffectiveConfigSpy = vi.mocked(loadEffectiveConfig);
  const resolveRepoRootForPlanArgSpy = vi.mocked(resolveRepoRootForPlanArg);
  const resolvePlanFromDbOrSyncFileSpy = vi.mocked(resolvePlanFromDbOrSyncFile);
  const writePlanFileSpy = vi.mocked(writePlanFile);
  const isTunnelActiveSpy = vi.mocked(isTunnelActive);
  const runWithHeadlessAdapterIfEnabledSpy = vi.mocked(runWithHeadlessAdapterIfEnabled);
  const runUpdateDocsSpy = vi.mocked(runUpdateDocs);
  const runUpdateLessonsSpy = vi.mocked(runUpdateLessons);
  const setupWorkspaceSpy = vi.mocked(setupWorkspace);
  const prepareWorkspaceRoundTripSpy = vi.mocked(prepareWorkspaceRoundTrip);
  const runPreExecutionWorkspaceSyncSpy = vi.mocked(runPreExecutionWorkspaceSync);
  const runPostExecutionWorkspaceSyncSpy = vi.mocked(runPostExecutionWorkspaceSync);
  const materializePlansForExecutionSpy = vi.mocked(materializePlansForExecution);

  const basePlan = {
    id: 314,
    uuid: '11111111-1111-4111-8111-111111111111',
    title: 'finish plan command',
    status: 'needs_review' as const,
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
    resolvePlanFromDbOrSyncFileSpy.mockResolvedValue({
      plan: { ...basePlan },
      planPath: '/repo/.tim/plans/314.plan.md',
    } as any);
    isTunnelActiveSpy.mockReturnValue(false);
    runWithHeadlessAdapterIfEnabledSpy.mockImplementation(async (options: any) =>
      options.callback()
    );
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
        command: 'finish',
        plan: expect.objectContaining({
          id: 314,
          title: 'finish plan command',
        }),
      })
    );
    expect(runUpdateDocsSpy).toHaveBeenCalledWith(
      '/repo/.tim/plans/314.plan.md',
      expect.any(Object),
      expect.objectContaining({
        baseDir: '/repo',
        configPath: '/repo/.tim.yml',
      })
    );
    expect(runUpdateLessonsSpy).toHaveBeenCalledWith(
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
        status: 'done',
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
    resolvePlanFromDbOrSyncFileSpy.mockResolvedValue({
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
        status: 'done',
        docsUpdatedAt: '2026-04-01T00:00:00.000Z',
        lessonsAppliedAt: '2026-04-02T00:00:00.000Z',
      }),
      { cwdForIdentity: '/repo' }
    );
  });

  test('only runs missing steps and performs workspace round-trip when workspace execution is requested', async () => {
    resolvePlanFromDbOrSyncFileSpy.mockResolvedValue({
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
      '/repo/workspaces/finish/.tim/plans/314.plan.md',
      expect.any(Object),
      expect.objectContaining({
        baseDir: '/repo/workspaces/finish',
      })
    );
    expect(runPostExecutionWorkspaceSyncSpy).toHaveBeenCalledWith(
      expect.any(Object),
      'finish plan finalization'
    );
  });

  test('rejects plans that are not ready to finish', async () => {
    resolvePlanFromDbOrSyncFileSpy.mockResolvedValue({
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
});
