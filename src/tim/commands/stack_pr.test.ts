import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { TimConfig } from '../configSchema.js';
import type { PlanSchema } from '../planSchema.js';

const {
  detectExistingPrUrlSpy,
  isTunnelActiveSpy,
  loadEffectiveConfigSpy,
  resolvePlanByBranchSpy,
  resolvePlanByNumericIdSpy,
  resolveRepoRootSpy,
  runPrStackingSpy,
  runWithHeadlessAdapterIfEnabledSpy,
  setupWorkspaceSpy,
} = vi.hoisted(() => ({
  detectExistingPrUrlSpy: vi.fn(async () => 'https://github.com/acme/repo/pull/42'),
  isTunnelActiveSpy: vi.fn(() => false),
  loadEffectiveConfigSpy: vi.fn(async () => ({ terminalInput: false })),
  resolvePlanByBranchSpy: vi.fn(),
  resolvePlanByNumericIdSpy: vi.fn(),
  resolveRepoRootSpy: vi.fn(async () => '/repo'),
  runPrStackingSpy: vi.fn(async () => ({ ran: true, changedLines: 500 })),
  runWithHeadlessAdapterIfEnabledSpy: vi.fn(
    async ({ callback }: { callback: () => Promise<void> }) => callback()
  ),
  setupWorkspaceSpy: vi.fn(async () => ({
    baseDir: '/workspace',
    planFile: '/workspace/12.plan.md',
  })),
}));

vi.mock('./create_pr.js', () => ({
  detectExistingPrUrl: detectExistingPrUrlSpy,
}));
vi.mock('../../logging/tunnel_client.js', () => ({
  isTunnelActive: isTunnelActiveSpy,
}));
vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: loadEffectiveConfigSpy,
}));
vi.mock('../plans.js', () => ({
  parsePlanIdFromCliArg: (arg: string) => Number(arg),
  resolvePlanByBranch: resolvePlanByBranchSpy,
  resolvePlanByNumericId: resolvePlanByNumericIdSpy,
}));
vi.mock('../plan_repo_root.js', () => ({
  resolveRepoRoot: resolveRepoRootSpy,
}));
vi.mock('../pr_stacking/runner.js', () => ({
  runPrStacking: runPrStackingSpy,
}));
vi.mock('../headless.js', () => ({
  runWithHeadlessAdapterIfEnabled: runWithHeadlessAdapterIfEnabledSpy,
}));
vi.mock('../workspace/workspace_setup.js', () => ({
  setupWorkspace: setupWorkspaceSpy,
}));

import { handlePrStackCommand } from './stack_pr.js';

const plan: PlanSchema = {
  id: 12,
  uuid: 'plan-uuid',
  title: 'Stack the pull request',
  branch: 'feature/stack',
  tasks: [],
};

const config = { terminalInput: false } as TimConfig;

describe('handlePrStackCommand', () => {
  beforeEach(() => {
    detectExistingPrUrlSpy.mockClear();
    isTunnelActiveSpy.mockClear();
    loadEffectiveConfigSpy.mockClear();
    loadEffectiveConfigSpy.mockResolvedValue(config);
    resolvePlanByBranchSpy.mockReset();
    resolvePlanByBranchSpy.mockResolvedValue({ plan, planPath: '/repo/12.plan.md' });
    resolvePlanByNumericIdSpy.mockReset();
    resolvePlanByNumericIdSpy.mockResolvedValue({ plan, planPath: '/repo/12.plan.md' });
    resolveRepoRootSpy.mockClear();
    resolveRepoRootSpy.mockResolvedValue('/repo');
    runPrStackingSpy.mockClear();
    runPrStackingSpy.mockResolvedValue({ ran: true, changedLines: 500 });
    runWithHeadlessAdapterIfEnabledSpy.mockClear();
    runWithHeadlessAdapterIfEnabledSpy.mockImplementation(
      async ({ callback }: { callback: () => Promise<void> }) => callback()
    );
    setupWorkspaceSpy.mockClear();
    setupWorkspaceSpy.mockResolvedValue({
      baseDir: '/workspace',
      planFile: '/workspace/12.plan.md',
    });
  });

  test('runs manually without requiring stacking configuration', async () => {
    await handlePrStackCommand('12', { nonInteractive: true }, {});

    expect(detectExistingPrUrlSpy).toHaveBeenCalledWith('feature/stack', '/repo');
    expect(resolvePlanByNumericIdSpy).toHaveBeenCalledWith(12, '/repo');
    expect(runPrStackingSpy).toHaveBeenCalledWith({
      plan,
      planFilePath: '/repo/12.plan.md',
      mainPrUrl: 'https://github.com/acme/repo/pull/42',
      baseDir: '/repo',
      repoPath: '/repo',
      config,
      terminalInput: false,
      manual: true,
    });
  });

  test('uses the selected workspace for the stacking run', async () => {
    await handlePrStackCommand('12', { workspace: 'stack-workspace', nonInteractive: true }, {});

    expect(setupWorkspaceSpy).toHaveBeenCalledWith(
      {
        workspace: 'stack-workspace',
        autoWorkspace: undefined,
        nonInteractive: true,
        planId: 12,
        planUuid: 'plan-uuid',
        checkoutBranch: 'feature/stack',
        createBranch: false,
        allowPrimaryWorkspaceWhenLocked: true,
      },
      '/repo',
      '/repo/12.plan.md',
      config,
      'tim pr stack'
    );
    expect(runPrStackingSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        baseDir: '/workspace',
        planFilePath: '/workspace/12.plan.md',
        manual: true,
      })
    );
  });

  test('resolves a branch name to its plan', async () => {
    await handlePrStackCommand('feature/stack', { nonInteractive: true }, {});

    expect(resolvePlanByBranchSpy).toHaveBeenCalledWith('feature/stack', '/repo');
    expect(resolvePlanByNumericIdSpy).not.toHaveBeenCalled();
  });
});
