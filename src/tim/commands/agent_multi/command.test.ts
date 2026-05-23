import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { PlanRow } from '../../db/plan.js';
import type { AgentMultiPlan } from './orchestrator.js';

const mocks = vi.hoisted(() => ({
  getGitRoot: vi.fn(),
  resolveProjectContext: vi.fn(),
  getDatabase: vi.fn(),
  getPlanByPlanId: vi.fn(),
  getPlanByUuid: vi.fn(),
  getAgentMultiPlansForProject: vi.fn(),
  isTunnelActive: vi.fn(),
  runWithHeadlessAdapterIfEnabled: vi.fn(),
  updateHeadlessSessionInfo: vi.fn(),
  multiAgentRunnerConstructor: vi.fn(),
  multiAgentRunnerRun: vi.fn(),
}));

vi.mock('../../../common/env.js', () => ({
  buildWorkspaceCommandEnv: vi.fn(async () => ({ PATH: '/usr/bin' })),
}));

vi.mock('../../../lib/server/plan_actions.js', () => ({
  createLogFile: vi.fn(() => ({ fd: 7, path: '/tmp/agent-multi-child.log' })),
}));

vi.mock('../../../common/git.js', () => ({
  getGitRoot: mocks.getGitRoot,
}));

vi.mock('../../plan_materialize.js', () => ({
  resolveProjectContext: mocks.resolveProjectContext,
}));

vi.mock('../../db/database.js', () => ({
  getDatabase: mocks.getDatabase,
}));

vi.mock('../../db/plan.js', () => ({
  getPlanByPlanId: mocks.getPlanByPlanId,
  getPlanByUuid: mocks.getPlanByUuid,
}));

vi.mock('./plan_loader.js', () => ({
  getAgentMultiPlansForProject: mocks.getAgentMultiPlansForProject,
}));

vi.mock('../../../logging/tunnel_client.js', () => ({
  isTunnelActive: mocks.isTunnelActive,
}));

vi.mock('../../headless.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../headless.js')>();
  return {
    ...actual,
    runWithHeadlessAdapterIfEnabled: mocks.runWithHeadlessAdapterIfEnabled,
    updateHeadlessSessionInfo: mocks.updateHeadlessSessionInfo,
  };
});

vi.mock('./orchestrator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./orchestrator.js')>();
  return {
    ...actual,
    MultiAgentRunner: class {
      constructor(options: ConstructorParameters<typeof actual.MultiAgentRunner>[0]) {
        mocks.multiAgentRunnerConstructor(options);
      }

      async run(): Promise<{ success: boolean; states: Map<string, never> }> {
        return mocks.multiAgentRunnerRun();
      }
    },
  };
});

import { buildChildAgentArgs, createBunSpawnAgent, handleAgentMultiCommand } from './command.js';

function makeAgentPlan(overrides: Partial<AgentMultiPlan> = {}): AgentMultiPlan {
  return {
    uuid: 'plan-101',
    planId: 101,
    title: 'Child 101',
    status: 'pending',
    taskCount: 1,
    doneTaskCount: 0,
    dependencies: [],
    parentUuid: 'epic-1',
    ...overrides,
  };
}

function makePlanRow(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    uuid: 'epic-1',
    project_id: 123,
    plan_id: 100,
    title: 'Epic 100',
    goal: null,
    note: null,
    details: null,
    status: 'pending',
    priority: 'medium',
    branch: null,
    simple: null,
    tdd: null,
    discovered_from: null,
    issue: null,
    pull_request: null,
    assigned_to: null,
    base_branch: null,
    base_commit: null,
    base_change_id: null,
    temp: null,
    docs: null,
    changed_files: null,
    plan_generated_at: null,
    review_issues: null,
    docs_updated_at: null,
    lessons_applied_at: null,
    parent_uuid: null,
    base_plan_uuid: null,
    epic: 1,
    revision: 1,
    created_at: '2026-05-15T00:00:00.000Z',
    updated_at: '2026-05-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('agent-multi command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGitRoot.mockResolvedValue('/repo');
    mocks.resolveProjectContext.mockResolvedValue({ projectId: 123 });
    mocks.getDatabase.mockReturnValue({ __db: true });
    mocks.getPlanByPlanId.mockReturnValue(null);
    mocks.getPlanByUuid.mockReturnValue(null);
    mocks.getAgentMultiPlansForProject.mockReturnValue([]);
    mocks.isTunnelActive.mockReturnValue(false);
    mocks.runWithHeadlessAdapterIfEnabled.mockImplementation(async (options: any) =>
      options.callback()
    );
    mocks.multiAgentRunnerRun.mockResolvedValue({ success: true, states: new Map() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('createBunSpawnAgent adds safe child flags for plain CLI defaults', async () => {
    const spawnSpy = vi.spyOn(Bun, 'spawn').mockReturnValue({
      exited: Promise.resolve(0),
      pid: 1234,
    } as never);
    const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation(() => {});

    const spawnAgent = await createBunSpawnAgent({ cwd: '/tmp/repo' });

    const result = spawnAgent(101, '/tmp/repo');

    expect(result.pid).toBe(1234);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [args, options] = spawnSpy.mock.calls[0];
    expect(args).toEqual(['tim', 'agent', '101', '--auto-workspace', '--no-terminal-input']);
    expect(options).toMatchObject({
      cwd: '/tmp/repo',
      env: { PATH: '/usr/bin' },
      stdin: 'ignore',
      stdout: 7,
      stderr: 7,
      detached: true,
    });
    expect(closeSpy).toHaveBeenCalledWith(7);
  });

  test('child agent args default to non-interactive stdin', () => {
    expect(buildChildAgentArgs(101)).toEqual([
      'agent',
      '101',
      '--auto-workspace',
      '--no-terminal-input',
    ]);
  });

  test('child agent args only omit no-terminal-input for explicit terminal input', () => {
    expect(buildChildAgentArgs(101, { terminalInput: true })).toEqual([
      'agent',
      '101',
      '--auto-workspace',
    ]);
  });

  test('attributes headless session to inferred shared parent when --epic is omitted', async () => {
    const parentRow = makePlanRow({ uuid: 'epic-1', plan_id: 100, title: 'Parent epic' });
    mocks.getAgentMultiPlansForProject.mockReturnValue([
      makeAgentPlan({ uuid: 'child-101', planId: 101, parentUuid: 'epic-1' }),
      makeAgentPlan({ uuid: 'child-102', planId: 102, parentUuid: 'epic-1' }),
      makeAgentPlan({ uuid: 'epic-1', planId: 100, taskCount: 0, doneTaskCount: 0 }),
    ]);
    mocks.getPlanByUuid.mockReturnValue(parentRow);

    await handleAgentMultiCommand([101, 102], { maxParallel: 3 }, {});

    expect(mocks.getPlanByPlanId).not.toHaveBeenCalled();
    expect(mocks.getPlanByUuid).toHaveBeenCalledWith({ __db: true }, 'epic-1');
    expect(mocks.runWithHeadlessAdapterIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'agent-multi',
        interactive: false,
      })
    );
    expect(mocks.updateHeadlessSessionInfo).toHaveBeenCalledWith({
      planId: 100,
      planUuid: 'epic-1',
      planTitle: 'Parent epic',
    });
  });

  test('preserves explicit --epic headless attribution', async () => {
    const epicRow = makePlanRow({ uuid: 'explicit-epic', plan_id: 200, title: 'Explicit epic' });
    mocks.getPlanByPlanId.mockReturnValue(epicRow);
    mocks.getAgentMultiPlansForProject.mockReturnValue([
      makeAgentPlan({ uuid: 'child-201', planId: 201, parentUuid: 'explicit-epic' }),
      makeAgentPlan({ uuid: 'child-202', planId: 202, parentUuid: 'explicit-epic' }),
    ]);

    await handleAgentMultiCommand([201, 202], { epic: 200, maxParallel: 3 }, {});

    expect(mocks.getPlanByPlanId).toHaveBeenCalledWith({ __db: true }, 123, 200);
    expect(mocks.getPlanByUuid).not.toHaveBeenCalled();
    expect(mocks.runWithHeadlessAdapterIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({
        interactive: false,
      })
    );
    expect(mocks.updateHeadlessSessionInfo).toHaveBeenCalledWith({
      planId: 200,
      planUuid: 'explicit-epic',
      planTitle: 'Explicit epic',
    });
  });

  test('leaves root-level sibling runs without headless plan attribution', async () => {
    mocks.getAgentMultiPlansForProject.mockReturnValue([
      makeAgentPlan({ uuid: 'root-101', planId: 101, parentUuid: undefined }),
      makeAgentPlan({ uuid: 'root-102', planId: 102, parentUuid: undefined }),
    ]);

    await handleAgentMultiCommand([101, 102], { maxParallel: 3 }, {});

    expect(mocks.getPlanByUuid).not.toHaveBeenCalled();
    expect(mocks.runWithHeadlessAdapterIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({
        interactive: false,
      })
    );
    expect(mocks.updateHeadlessSessionInfo).not.toHaveBeenCalled();
  });

  test('keeps the orchestrator headless session non-interactive even without --non-interactive', async () => {
    mocks.getAgentMultiPlansForProject.mockReturnValue([makeAgentPlan({ uuid: 'child-101' })]);

    await handleAgentMultiCommand([101], { maxParallel: 3 }, {});

    expect(mocks.runWithHeadlessAdapterIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'agent-multi',
        interactive: false,
      })
    );
  });
});
