import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getUsingJj } from '../../common/git.js';
import { getDatabase } from '../db/database.js';
import { insertReviewIssues, updateReview } from '../db/review.js';
import { buildExecutorAndLog } from '../executors/index.js';
import { getWorkspaceInfoByPath } from '../workspace/workspace_info.js';
import { runReviewGuideWorkflow } from './review_workflow.js';

const mocks = vi.hoisted(() => ({
  lifecycleConstructor: vi.fn(),
}));

vi.mock('../../common/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../common/git.js')>()),
  getUsingJj: vi.fn(),
}));

vi.mock('../db/database.js', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('../db/review.js', () => ({
  insertReviewIssues: vi.fn(),
  updateReview: vi.fn(),
}));

vi.mock('../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(),
}));

vi.mock('../lifecycle.js', () => ({
  LifecycleManager: class {
    constructor(...args: unknown[]) {
      mocks.lifecycleConstructor(...args);
    }

    async startup(): Promise<void> {}

    async shutdown(): Promise<void> {}
  },
}));

vi.mock('../workspace/workspace_info.js', () => ({
  getWorkspaceInfoByPath: vi.fn(),
}));

describe('runReviewGuideWorkflow environment context', () => {
  beforeEach(() => {
    vi.mocked(getUsingJj).mockResolvedValue(false);
    vi.mocked(getDatabase).mockReturnValue({ prepare: vi.fn() } as never);
    vi.mocked(insertReviewIssues).mockReset();
    vi.mocked(updateReview).mockReset();
    vi.mocked(buildExecutorAndLog).mockReset();
    mocks.lifecycleConstructor.mockClear();
    vi.mocked(getWorkspaceInfoByPath).mockReset();

    vi.mocked(buildExecutorAndLog).mockReturnValue({
      execute: vi.fn(async () =>
        JSON.stringify({
          issues: [],
          recommendations: [],
          actionItems: [],
        })
      ),
      filePathPrefix: '',
    } as never);
  });

  test('passes one consistent timEnvironment context to lifecycle and all review executors', async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), 'tim-review-env-'));
    vi.mocked(getWorkspaceInfoByPath).mockReturnValue({
      taskId: 'workspace-1',
      workspacePath: baseDir,
      workspaceType: 'standard',
      branch: 'workspace-record-branch',
      name: 'Workspace 1',
      createdAt: '2026-06-01T00:00:00.000Z',
    });

    await runReviewGuideWorkflow({
      db: {} as never,
      config: {
        environment: {
          TIM_REVIEW_MARKER: '{{branch}}:{{workspaceId}}',
        },
        lifecycle: {
          commands: [
            {
              title: 'review lifecycle',
              command: 'true',
              runIn: ['review'],
            },
          ],
        },
      } as never,
      baseDir,
      review: { id: 42 } as never,
      metadata: {
        kind: 'plan',
        planId: 374,
        planUuid: 'plan-uuid',
        title: 'Plan review',
        goal: null,
        details: null,
        tasks: [],
        parentChain: [],
        completedChildren: [],
        baseBranch: 'main',
        headRef: 'plan-head-ref',
      },
      baseSha: null,
      reviewedSha: 'reviewed-sha',
      diffCatalog: null,
      executorSelection: 'both',
      executorTerminalInput: false,
      executorNoninteractive: true,
    });

    const lifecycleOptions = mocks.lifecycleConstructor.mock.calls[0]?.[5] as
      | { timEnvironment?: unknown }
      | undefined;
    const executorOptions = vi.mocked(buildExecutorAndLog).mock.calls.map((call) => call[1]);

    expect(executorOptions).toHaveLength(5);
    for (const options of executorOptions) {
      expect(options.timEnvironment).toBe(lifecycleOptions?.timEnvironment);
    }
    expect(lifecycleOptions?.timEnvironment?.context).toMatchObject({
      workspaceId: 'workspace-1',
      workspaceName: 'Workspace 1',
      workspacePath: baseDir,
      repoPath: baseDir,
      planId: '374',
      planUuid: 'plan-uuid',
      branch: 'plan-head-ref',
    });
  });
});
