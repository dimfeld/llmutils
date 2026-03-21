import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';

import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

type AnyObject = Record<string, unknown>;

const mockLog = mock((..._args: unknown[]) => {});
const mockResolvePlan = mock(async (..._args: unknown[]) => ({
  plan: {},
  planPath: '',
}));
const mockGetWorkspaceInfoByPath = mock((_cwd: string) => null);
const mockGetDatabase = mock(() => ({}));
const mockRefreshPrStatus = mock(async (..._args: unknown[]) => ({}));
const mockParsePrOrIssueNumber = mock(async (..._args: unknown[]) => null);
const mockGetPrStatusByUrl = mock((_db: unknown, _prUrl: string) => null);
const mockLinkPlanToPr = mock((_db: unknown, _planUuid: string, _prStatusId: number) => {});
const mockUnlinkPlanFromPr = mock((_db: unknown, _planUuid: string, _prStatusId: number) => {});
const mockCleanOrphanedPrStatus = mock((_db: unknown) => {});

let logs: string[] = [];
let dbHandle: AnyObject;
let currentPlan: AnyObject;
let currentPlanPath: string;
let currentWorkspaceInfo: AnyObject | null;
let currentRefreshedStatuses: Map<string, AnyObject>;
let currentParsedIdentifier: AnyObject | null;
let currentCachedDetail: AnyObject | null;
let prModule: typeof import('./pr.js');

describe('tim/commands/pr', () => {
  beforeAll(async () => {
    await moduleMocker.mock('../../logging.js', () => ({
      log: mockLog,
    }));
    await moduleMocker.mock('../plan_display.js', () => ({
      resolvePlan: mockResolvePlan,
    }));
    await moduleMocker.mock('../workspace/workspace_info.js', () => ({
      getWorkspaceInfoByPath: mockGetWorkspaceInfoByPath,
    }));
    await moduleMocker.mock('../db/database.js', () => ({
      getDatabase: mockGetDatabase,
    }));
    await moduleMocker.mock('../../common/github/pr_status_service.js', () => ({
      refreshPrStatus: mockRefreshPrStatus,
    }));
    await moduleMocker.mock('../../common/github/identifiers.js', () => ({
      parsePrOrIssueNumber: mockParsePrOrIssueNumber,
    }));
    await moduleMocker.mock('../db/pr_status.js', () => ({
      getPrStatusByUrl: mockGetPrStatusByUrl,
      linkPlanToPr: mockLinkPlanToPr,
      unlinkPlanFromPr: mockUnlinkPlanFromPr,
      cleanOrphanedPrStatus: mockCleanOrphanedPrStatus,
    }));

    prModule = await import('./pr.js');
  });

  afterAll(() => {
    moduleMocker.clear();
  });

  beforeEach(() => {
    logs = [];
    dbHandle = { name: 'db-handle' };
    currentPlan = {
      id: 248,
      uuid: 'plan-248',
      title: 'PR status monitoring',
      pullRequest: [],
    };
    currentPlanPath = '/tmp/248.plan.md';
    currentWorkspaceInfo = null;
    currentRefreshedStatuses = new Map();
    currentParsedIdentifier = null;
    currentCachedDetail = null;

    mockLog.mockClear();
    mockResolvePlan.mockClear();
    mockGetWorkspaceInfoByPath.mockClear();
    mockGetDatabase.mockClear();
    mockRefreshPrStatus.mockClear();
    mockParsePrOrIssueNumber.mockClear();
    mockGetPrStatusByUrl.mockClear();
    mockLinkPlanToPr.mockClear();
    mockUnlinkPlanFromPr.mockClear();
    mockCleanOrphanedPrStatus.mockClear();

    mockLog.mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
    mockResolvePlan.mockImplementation(async () => ({
      plan: currentPlan,
      planPath: currentPlanPath,
    }));
    mockGetWorkspaceInfoByPath.mockImplementation(() => currentWorkspaceInfo);
    mockGetDatabase.mockImplementation(() => dbHandle);
    mockRefreshPrStatus.mockImplementation(async (_db: unknown, prUrl: string) => {
      const detail = currentRefreshedStatuses.get(prUrl);
      if (!detail) {
        throw new Error(`Unexpected PR URL in test: ${prUrl}`);
      }
      return detail;
    });
    mockParsePrOrIssueNumber.mockImplementation(async () => currentParsedIdentifier);
    mockGetPrStatusByUrl.mockImplementation(() => currentCachedDetail);
    mockLinkPlanToPr.mockImplementation(() => {});
    mockUnlinkPlanFromPr.mockImplementation(() => {});
    mockCleanOrphanedPrStatus.mockImplementation(() => {});
  });

  test('status resolves the current workspace plan and refreshes each linked PR', async () => {
    currentWorkspaceInfo = {
      originalPlanFilePath: '/tmp/248.plan.md',
    };
    currentPlan.pullRequest = [
      'https://github.com/example/repo/pull/101',
      'https://github.com/example/repo/pull/102',
    ];
    currentRefreshedStatuses.set(
      'https://github.com/example/repo/pull/101',
      createPrDetail(101, 'First PR', 'success')
    );
    currentRefreshedStatuses.set(
      'https://github.com/example/repo/pull/102',
      createPrDetail(102, 'Second PR', 'failure')
    );

    await prModule.handlePrStatusCommand(undefined, {}, createNestedCommand());

    expect(mockResolvePlan).toHaveBeenCalledWith('/tmp/248.plan.md', {
      gitRoot: process.cwd(),
      configPath: '/tmp/tim.yml',
    });
    expect(mockRefreshPrStatus).toHaveBeenCalledTimes(2);
    expect(mockRefreshPrStatus).toHaveBeenNthCalledWith(
      1,
      dbHandle,
      'https://github.com/example/repo/pull/101'
    );
    expect(logs.some((line) => line.includes('example/repo#101: First PR'))).toBe(true);
    expect(logs.some((line) => line.includes('example/repo#102: Second PR'))).toBe(true);
  });

  test('status reports when a plan has no linked pull requests', async () => {
    currentPlan.pullRequest = [];

    await prModule.handlePrStatusCommand('248', {}, createNestedCommand());

    expect(mockRefreshPrStatus).not.toHaveBeenCalled();
    expect(logs).toContain('Plan 248 has no linked pull requests.');
  });

  test('status logs passing, failing, and pending PR states', async () => {
    currentPlan.pullRequest = [
      'https://github.com/example/repo/pull/401',
      'https://github.com/example/repo/pull/402',
      'https://github.com/example/repo/pull/403',
    ];
    currentRefreshedStatuses.set(
      'https://github.com/example/repo/pull/401',
      createPrDetail(401, 'Passing PR', 'success')
    );
    currentRefreshedStatuses.set(
      'https://github.com/example/repo/pull/402',
      createPrDetail(402, 'Failing PR', 'failure')
    );
    currentRefreshedStatuses.set(
      'https://github.com/example/repo/pull/403',
      createPrDetail(403, 'Pending PR', 'pending')
    );

    await prModule.handlePrStatusCommand('248', {}, createNestedCommand());

    expect(mockRefreshPrStatus).toHaveBeenCalledTimes(3);
    expect(logs.some((line) => line.includes('example/repo#401: Passing PR'))).toBe(true);
    expect(logs.some((line) => line.includes('Merge readiness: ready'))).toBe(true);
    expect(logs.some((line) => line.includes('example/repo#402: Failing PR'))).toBe(true);
    expect(logs.some((line) => line.includes('Merge readiness: failing checks'))).toBe(true);
    expect(logs.some((line) => line.includes('example/repo#403: Pending PR'))).toBe(true);
    expect(logs.some((line) => line.includes('Merge readiness: checks pending'))).toBe(true);
  });

  test('link validates the PR identifier, refreshes status, and links the plan UUID', async () => {
    currentParsedIdentifier = { owner: 'example', repo: 'repo', number: 201 };
    currentRefreshedStatuses.set(
      'https://github.com/example/repo/pull/201',
      createPrDetail(201, 'Linked PR', 'pending', 77)
    );

    await prModule.handlePrLinkCommand(
      '248',
      'https://github.com/example/repo/pull/201',
      {},
      createNestedCommand()
    );

    expect(mockResolvePlan).toHaveBeenCalledWith('248', {
      gitRoot: process.cwd(),
      configPath: '/tmp/tim.yml',
    });
    expect(mockParsePrOrIssueNumber).toHaveBeenCalledWith(
      'https://github.com/example/repo/pull/201'
    );
    expect(mockRefreshPrStatus).toHaveBeenCalledWith(
      dbHandle,
      'https://github.com/example/repo/pull/201'
    );
    expect(mockLinkPlanToPr).toHaveBeenCalledWith(dbHandle, 'plan-248', 77);
    expect(logs.some((line) => line.includes('Linked'))).toBe(true);
  });

  test('link rejects invalid GitHub pull request identifiers', async () => {
    currentParsedIdentifier = null;

    await expect(
      prModule.handlePrLinkCommand('248', 'not-a-pr', {}, createNestedCommand())
    ).rejects.toThrow('Invalid GitHub pull request identifier: not-a-pr');

    expect(mockRefreshPrStatus).not.toHaveBeenCalled();
    expect(mockLinkPlanToPr).not.toHaveBeenCalled();
  });

  test('unlink removes the junction and cleans orphaned PR cache rows', async () => {
    currentCachedDetail = createPrDetail(301, 'Cached PR', 'success', 88);

    await prModule.handlePrUnlinkCommand(
      '248',
      'https://github.com/example/repo/pull/301',
      {},
      createNestedCommand()
    );

    expect(mockGetPrStatusByUrl).toHaveBeenCalledWith(
      dbHandle,
      'https://github.com/example/repo/pull/301'
    );
    expect(mockUnlinkPlanFromPr).toHaveBeenCalledWith(dbHandle, 'plan-248', 88);
    expect(mockCleanOrphanedPrStatus).toHaveBeenCalledWith(dbHandle);
    expect(logs.some((line) => line.includes('Unlinked'))).toBe(true);
  });

  test('unlink is idempotent when the cached PR exists but the link is already absent', async () => {
    currentCachedDetail = createPrDetail(302, 'Cached PR', 'success', 89);

    await prModule.handlePrUnlinkCommand(
      '248',
      'https://github.com/example/repo/pull/302',
      {},
      createNestedCommand()
    );

    expect(mockUnlinkPlanFromPr).toHaveBeenCalledWith(dbHandle, 'plan-248', 89);
    expect(mockCleanOrphanedPrStatus).toHaveBeenCalledWith(dbHandle);
    expect(logs.some((line) => line.includes('Unlinked'))).toBe(true);
  });

  test('unlink throws when no cached PR status exists for the URL', async () => {
    currentCachedDetail = null;

    await expect(
      prModule.handlePrUnlinkCommand(
        '248',
        'https://github.com/example/repo/pull/999',
        {},
        createNestedCommand()
      )
    ).rejects.toThrow('No cached PR status found for https://github.com/example/repo/pull/999');

    expect(mockUnlinkPlanFromPr).not.toHaveBeenCalled();
    expect(mockCleanOrphanedPrStatus).not.toHaveBeenCalled();
  });

  test('status surfaces plan resolution failures for invalid plan identifiers', async () => {
    mockResolvePlan.mockImplementationOnce(async () => {
      throw new Error('Plan not found: 999');
    });

    await expect(prModule.handlePrStatusCommand('999', {}, createNestedCommand())).rejects.toThrow(
      'Plan not found: 999'
    );

    expect(mockRefreshPrStatus).not.toHaveBeenCalled();
  });
});

function createNestedCommand(): { parent: { parent: { opts: () => { config: string } } } } {
  return {
    parent: {
      parent: {
        opts: () => ({ config: '/tmp/tim.yml' }),
      },
    },
  };
}

function createPrDetail(
  prNumber: number,
  title: string,
  checkRollupState: string,
  statusId = prNumber
): AnyObject {
  return {
    status: {
      id: statusId,
      pr_url: `https://github.com/example/repo/pull/${prNumber}`,
      owner: 'example',
      repo: 'repo',
      pr_number: prNumber,
      title,
      state: 'open',
      draft: 0,
      mergeable: 'MERGEABLE',
      head_sha: 'sha',
      base_branch: 'main',
      head_branch: 'feature/test',
      review_decision: 'APPROVED',
      check_rollup_state: checkRollupState,
      merged_at: null,
      last_fetched_at: '2026-03-20T00:00:00.000Z',
      created_at: '2026-03-20T00:00:00.000Z',
      updated_at: '2026-03-20T00:00:00.000Z',
    },
    checks: [
      {
        id: statusId * 10,
        pr_status_id: statusId,
        name: 'test',
        source: 'check_run',
        status: checkRollupState === 'pending' ? 'pending' : 'completed',
        conclusion: checkRollupState === 'success' ? 'success' : checkRollupState,
        details_url: null,
        started_at: null,
        completed_at: null,
      },
    ],
    reviews: [
      {
        id: statusId * 100,
        pr_status_id: statusId,
        author: 'alice',
        state: 'APPROVED',
        submitted_at: '2026-03-20T00:00:00.000Z',
      },
    ],
    labels: [],
  };
}
