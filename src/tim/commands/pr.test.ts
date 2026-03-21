import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
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
const mockSyncPlanPrLinks = mock(async (..._args: unknown[]) => []);
const mockParsePrOrIssueNumber = mock(async (..._args: unknown[]) => null);
const mockGetPrStatusByUrl = mock((_db: unknown, _prUrl: string) => null);
const mockLinkPlanToPr = mock((_db: unknown, _planUuid: string, _prStatusId: number) => {});
const mockUnlinkPlanFromPr = mock((_db: unknown, _planUuid: string, _prStatusId: number) => {});
const mockCleanOrphanedPrStatus = mock((_db: unknown) => {});
const mockReadPlanFile = mock(async (..._args: unknown[]) => ({}));
const mockWritePlanFile = mock(async (..._args: unknown[]) => {});
const mockSyncPlanToDb = mock(async (..._args: unknown[]) => {});

let logs: string[] = [];
let dbHandle: AnyObject;
let currentPlan: AnyObject;
let currentPlanPath: string;
let currentWorkspaceInfo: AnyObject | null;
let currentRefreshedStatuses: Map<string, AnyObject>;
let currentSyncedStatuses: AnyObject[];
let currentParsedIdentifier: AnyObject | null;
let currentCachedDetail: AnyObject | null;
let currentPersistedPlan: AnyObject;
let prModule: typeof import('./pr.js');
let tempDir: string;
let originalCwd: string;

describe('tim/commands/pr', () => {
  beforeAll(async () => {
    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-pr-command-test-'));
    tempDir = await fs.realpath(tempDir);

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
      syncPlanPrLinks: mockSyncPlanPrLinks,
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
    await moduleMocker.mock('../plans.js', () => ({
      readPlanFile: mockReadPlanFile,
      writePlanFile: mockWritePlanFile,
    }));
    await moduleMocker.mock('../db/plan_sync.js', () => ({
      syncPlanToDb: mockSyncPlanToDb,
    }));

    prModule = await import('./pr.js');
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
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
    currentSyncedStatuses = [];
    currentParsedIdentifier = null;
    currentCachedDetail = null;
    currentPersistedPlan = {
      ...currentPlan,
      pullRequest: [],
    };
    process.env.GITHUB_TOKEN = 'test-token';

    mockLog.mockClear();
    mockResolvePlan.mockClear();
    mockGetWorkspaceInfoByPath.mockClear();
    mockGetDatabase.mockClear();
    mockRefreshPrStatus.mockClear();
    mockSyncPlanPrLinks.mockClear();
    mockParsePrOrIssueNumber.mockClear();
    mockGetPrStatusByUrl.mockClear();
    mockLinkPlanToPr.mockClear();
    mockUnlinkPlanFromPr.mockClear();
    mockCleanOrphanedPrStatus.mockClear();
    mockReadPlanFile.mockClear();
    mockWritePlanFile.mockClear();
    mockSyncPlanToDb.mockClear();

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
    mockSyncPlanPrLinks.mockImplementation(async () => currentSyncedStatuses);
    mockParsePrOrIssueNumber.mockImplementation(async () => currentParsedIdentifier);
    mockGetPrStatusByUrl.mockImplementation(() => currentCachedDetail);
    mockLinkPlanToPr.mockImplementation(() => {});
    mockUnlinkPlanFromPr.mockImplementation(() => {});
    mockCleanOrphanedPrStatus.mockImplementation(() => {});
    mockReadPlanFile.mockImplementation(async () => currentPersistedPlan);
    mockWritePlanFile.mockImplementation(async (_planPath: string, plan: unknown) => {
      currentPersistedPlan = plan as AnyObject;
    });
    mockSyncPlanToDb.mockImplementation(async () => {});
  });

  test('status resolves the current workspace plan and syncs each linked PR atomically', async () => {
    currentWorkspaceInfo = {
      originalPlanFilePath: '/tmp/248.plan.md',
    };
    currentPlan.pullRequest = [
      'https://github.com/example/repo/pull/101',
      'https://github.com/example/repo/pull/102',
    ];
    const detail101 = createPrDetail(101, 'First PR', 'success');
    const detail102 = createPrDetail(102, 'Second PR', 'failure');
    currentRefreshedStatuses.set('https://github.com/example/repo/pull/101', detail101);
    currentRefreshedStatuses.set('https://github.com/example/repo/pull/102', detail102);

    await prModule.handlePrStatusCommand(undefined, {}, createNestedCommand());

    expect(mockResolvePlan).toHaveBeenCalledWith('/tmp/248.plan.md', {
      gitRoot: process.cwd(),
      configPath: '/tmp/tim.yml',
    });
    // refreshPrStatus called for each URL (force-fresh)
    expect(mockRefreshPrStatus).toHaveBeenCalledTimes(2);
    // syncPlanPrLinks called to update junctions
    expect(mockSyncPlanPrLinks).toHaveBeenCalledTimes(1);
    expect(mockSyncPlanPrLinks).toHaveBeenCalledWith(dbHandle, 'plan-248', [
      'https://github.com/example/repo/pull/101',
      'https://github.com/example/repo/pull/102',
    ]);
    expect(logs.some((line) => line.includes('example/repo#101: First PR'))).toBe(true);
    expect(logs.some((line) => line.includes('example/repo#102: Second PR'))).toBe(true);
  });

  test('status resolves the current workspace plan from a nested workspace directory', async () => {
    const workspaceDir = path.join(tempDir, 'workspace-root');
    const nestedDir = path.join(workspaceDir, 'src', 'nested');
    await fs.mkdir(nestedDir, { recursive: true });
    currentWorkspaceInfo = {
      originalPlanFilePath: '/tmp/248.plan.md',
    };
    currentPlan.pullRequest = [];
    mockGetWorkspaceInfoByPath.mockImplementation((cwd: string) =>
      path.basename(cwd) === 'workspace-root' ? currentWorkspaceInfo : null
    );

    process.chdir(nestedDir);
    try {
      await prModule.handlePrStatusCommand(undefined, {}, createNestedCommand());
    } finally {
      process.chdir(originalCwd);
    }

    expect(mockGetWorkspaceInfoByPath).toHaveBeenCalledWith(nestedDir);
    expect(mockGetWorkspaceInfoByPath).toHaveBeenCalledWith(path.join(workspaceDir, 'src'));
    expect(mockGetWorkspaceInfoByPath).toHaveBeenCalledWith(workspaceDir);
    expect(mockResolvePlan).toHaveBeenCalledWith('/tmp/248.plan.md', {
      gitRoot: nestedDir,
      configPath: '/tmp/tim.yml',
    });
  });

  test('status reports when a plan has no linked pull requests', async () => {
    currentPlan.pullRequest = [];

    await prModule.handlePrStatusCommand('248', {}, createNestedCommand());

    expect(mockSyncPlanPrLinks).not.toHaveBeenCalled();
    expect(logs).toContain('Plan 248 has no linked pull requests.');
  });

  test('status logs passing, failing, and pending PR states', async () => {
    currentPlan.pullRequest = [
      'https://github.com/example/repo/pull/401',
      'https://github.com/example/repo/pull/402',
      'https://github.com/example/repo/pull/403',
    ];
    const detail401 = createPrDetail(401, 'Passing PR', 'success');
    const detail402 = createPrDetail(402, 'Failing PR', 'failure');
    const detail403 = createPrDetail(403, 'Pending PR', 'pending');
    currentRefreshedStatuses.set('https://github.com/example/repo/pull/401', detail401);
    currentRefreshedStatuses.set('https://github.com/example/repo/pull/402', detail402);
    currentRefreshedStatuses.set('https://github.com/example/repo/pull/403', detail403);

    await prModule.handlePrStatusCommand('248', {}, createNestedCommand());

    expect(mockRefreshPrStatus).toHaveBeenCalledTimes(3);
    expect(logs.some((line) => line.includes('example/repo#401: Passing PR'))).toBe(true);
    expect(logs.some((line) => line.includes('Merge readiness: ready'))).toBe(true);
    expect(logs.some((line) => line.includes('example/repo#402: Failing PR'))).toBe(true);
    expect(logs.some((line) => line.includes('Merge readiness: failing checks'))).toBe(true);
    expect(logs.some((line) => line.includes('example/repo#403: Pending PR'))).toBe(true);
    expect(logs.some((line) => line.includes('Merge readiness: checks pending'))).toBe(true);
  });

  test('status shows partial results when some PR fetches fail', async () => {
    currentPlan.pullRequest = [
      'https://github.com/example/repo/pull/501',
      'https://github.com/example/repo/pull/502',
    ];
    const detail501 = createPrDetail(501, 'Good PR', 'success');
    currentRefreshedStatuses.set('https://github.com/example/repo/pull/501', detail501);
    // PR 502 is NOT in currentRefreshedStatuses, so refreshPrStatus will throw

    await prModule.handlePrStatusCommand('248', {}, createNestedCommand());

    // Successful PR is displayed
    expect(logs.some((line) => line.includes('example/repo#501: Good PR'))).toBe(true);
    // Failed PR shows error
    expect(
      logs.some((line) =>
        line.includes('Failed to fetch status for https://github.com/example/repo/pull/502')
      )
    ).toBe(true);
    // syncPlanPrLinks called with all plan PR URLs (not just successful ones)
    // to avoid removing links for PRs that failed to refresh transiently
    expect(mockSyncPlanPrLinks).toHaveBeenCalledWith(dbHandle, 'plan-248', [
      'https://github.com/example/repo/pull/501',
      'https://github.com/example/repo/pull/502',
    ]);
  });

  test('link validates the PR identifier, refreshes status, links the plan UUID, and persists the plan file', async () => {
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
    expect(mockReadPlanFile).toHaveBeenCalledWith('/tmp/248.plan.md');
    expect(mockWritePlanFile).toHaveBeenCalledWith('/tmp/248.plan.md', {
      ...currentPlan,
      pullRequest: ['https://github.com/example/repo/pull/201'],
    });
    // writePlanFile handles syncPlanToDb internally
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

  test('link rejects explicit GitHub issue URLs', async () => {
    currentParsedIdentifier = { owner: 'example', repo: 'repo', number: 201 };

    await expect(
      prModule.handlePrLinkCommand(
        '248',
        'https://github.com/example/repo/issues/201',
        {},
        createNestedCommand()
      )
    ).rejects.toThrow(
      'Invalid GitHub pull request identifier: https://github.com/example/repo/issues/201'
    );

    expect(mockRefreshPrStatus).not.toHaveBeenCalled();
    expect(mockLinkPlanToPr).not.toHaveBeenCalled();
  });

  test('unlink removes the junction, cleans orphaned PR cache rows, and persists the plan file', async () => {
    currentCachedDetail = createPrDetail(301, 'Cached PR', 'success', 88);
    currentPersistedPlan = {
      ...currentPlan,
      pullRequest: ['https://github.com/example/repo/pull/301'],
    };

    await prModule.handlePrUnlinkCommand(
      '248',
      'https://github.com/example/repo/pull/301',
      {},
      createNestedCommand()
    );

    // Plan file updated first (source of truth)
    expect(mockReadPlanFile).toHaveBeenCalledWith('/tmp/248.plan.md');
    expect(mockWritePlanFile).toHaveBeenCalledWith('/tmp/248.plan.md', {
      ...currentPlan,
      pullRequest: [],
    });
    // DB cleanup best-effort
    expect(mockGetPrStatusByUrl).toHaveBeenCalledWith(
      dbHandle,
      'https://github.com/example/repo/pull/301'
    );
    expect(mockUnlinkPlanFromPr).toHaveBeenCalledWith(dbHandle, 'plan-248', 88);
    expect(mockCleanOrphanedPrStatus).toHaveBeenCalledWith(dbHandle);
    expect(logs.some((line) => line.includes('Unlinked'))).toBe(true);
  });

  test('unlink reports no-op when URL not in plan file, but still cleans DB cache', async () => {
    currentCachedDetail = createPrDetail(302, 'Cached PR', 'success', 89);
    // Plan file has no PR URLs - the URL is only in the DB cache
    currentPersistedPlan = { ...currentPlan, pullRequest: [] };

    await prModule.handlePrUnlinkCommand(
      '248',
      'https://github.com/example/repo/pull/302',
      {},
      createNestedCommand()
    );

    // DB cleanup still happens (best-effort)
    expect(mockUnlinkPlanFromPr).toHaveBeenCalledWith(dbHandle, 'plan-248', 89);
    expect(mockCleanOrphanedPrStatus).toHaveBeenCalledWith(dbHandle);
    // Reports that URL was not linked in plan file
    expect(logs.some((line) => line.includes('was not linked'))).toBe(true);
  });

  test('unlink rejects explicit GitHub issue URLs', async () => {
    currentParsedIdentifier = { owner: 'example', repo: 'repo', number: 302 };

    await expect(
      prModule.handlePrUnlinkCommand(
        '248',
        'https://github.com/example/repo/issues/302',
        {},
        createNestedCommand()
      )
    ).rejects.toThrow(
      'Invalid GitHub pull request identifier: https://github.com/example/repo/issues/302'
    );

    expect(mockGetPrStatusByUrl).not.toHaveBeenCalled();
    expect(mockUnlinkPlanFromPr).not.toHaveBeenCalled();
  });

  test('status requires GITHUB_TOKEN when plan has PRs', async () => {
    delete process.env.GITHUB_TOKEN;
    currentPlan.pullRequest = ['https://github.com/example/repo/pull/101'];

    await expect(prModule.handlePrStatusCommand('248', {}, createNestedCommand())).rejects.toThrow(
      'GITHUB_TOKEN environment variable is required for PR status commands'
    );

    // Plan is resolved first, then token is checked
    expect(mockResolvePlan).toHaveBeenCalled();
    expect(mockRefreshPrStatus).not.toHaveBeenCalled();
  });

  test('status with no PRs succeeds without GITHUB_TOKEN', async () => {
    delete process.env.GITHUB_TOKEN;
    currentPlan.pullRequest = [];

    await prModule.handlePrStatusCommand('248', {}, createNestedCommand());

    expect(logs).toContain('Plan 248 has no linked pull requests.');
  });

  test('link requires GITHUB_TOKEN', async () => {
    delete process.env.GITHUB_TOKEN;

    await expect(
      prModule.handlePrLinkCommand(
        '248',
        'https://github.com/example/repo/pull/201',
        {},
        createNestedCommand()
      )
    ).rejects.toThrow('GITHUB_TOKEN environment variable is required for PR status commands');

    expect(mockResolvePlan).not.toHaveBeenCalled();
  });

  test('unlink succeeds even when no cached PR status exists (best-effort DB cleanup)', async () => {
    currentCachedDetail = null;
    currentPersistedPlan = {
      ...currentPlan,
      pullRequest: ['https://github.com/example/repo/pull/999'],
    };

    await prModule.handlePrUnlinkCommand(
      '248',
      'https://github.com/example/repo/pull/999',
      {},
      createNestedCommand()
    );

    // Plan file updated regardless
    expect(mockWritePlanFile).toHaveBeenCalled();
    // DB cleanup skipped since no cached row exists
    expect(mockUnlinkPlanFromPr).not.toHaveBeenCalled();
    expect(mockCleanOrphanedPrStatus).not.toHaveBeenCalled();
    expect(logs.some((line) => line.includes('Unlinked'))).toBe(true);
  });

  test('status surfaces plan resolution failures for invalid plan identifiers', async () => {
    mockResolvePlan.mockImplementationOnce(async () => {
      throw new Error('Plan not found: 999');
    });

    await expect(prModule.handlePrStatusCommand('999', {}, createNestedCommand())).rejects.toThrow(
      'Plan not found: 999'
    );

    expect(mockSyncPlanPrLinks).not.toHaveBeenCalled();
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
        conclusion:
          checkRollupState === 'success'
            ? 'success'
            : checkRollupState === 'pending'
              ? null
              : checkRollupState,
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
