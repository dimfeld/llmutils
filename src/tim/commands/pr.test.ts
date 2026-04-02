import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, afterAll, beforeEach, describe, expect, vi, test } from 'vitest';

import { clearGitHubTokenCache } from '../../common/github/token.js';
import { handlePrStatusCommand, handlePrLinkCommand, handlePrUnlinkCommand } from './pr.js';

type AnyObject = Record<string, unknown>;

vi.mock('../../logging.js', () => ({
  log: vi.fn((..._args: unknown[]) => {}),
}));

vi.mock('../plan_display.js', () => ({
  resolvePlan: vi.fn(async (..._args: unknown[]) => ({
    plan: {},
    planPath: '',
  })),
}));

vi.mock('../workspace/workspace_info.js', () => ({
  getWorkspaceInfoByPath: vi.fn((_cwd: string) => null),
}));

vi.mock('../db/database.js', () => ({
  getDatabase: vi.fn(() => ({})),
}));

vi.mock('../../common/github/pr_status_service.js', () => ({
  refreshPrStatus: vi.fn(async (..._args: unknown[]) => ({})),
  ensurePrStatusFresh: vi.fn(async (..._args: unknown[]) => ({})),
  syncPlanPrLinks: vi.fn(async (..._args: unknown[]) => []),
}));

vi.mock('../../common/github/webhook_client.js', () => ({
  getWebhookServerUrl: vi.fn(() => null),
}));

vi.mock('../../common/github/webhook_ingest.js', () => ({
  ingestWebhookEvents: vi.fn(async (..._args: unknown[]) => ({
    eventsIngested: 0,
    prsUpdated: [],
    errors: [],
  })),
  formatWebhookIngestErrors: (errors: string[]) =>
    errors.length > 0 ? `Webhook ingestion had issues: ${errors.join('; ')}` : undefined,
}));

vi.mock('../../common/github/pull_requests.js', () => ({
  fetchOpenPullRequests: vi.fn(async (..._args: unknown[]) => []),
}));

vi.mock('../../common/github/identifiers.js', () => ({
  canonicalizePrUrl: vi.fn((identifier: string) => identifier),
  parsePrOrIssueNumber: vi.fn(async (..._args: unknown[]) => null),
  validatePrIdentifier: vi.fn((_identifier: string) => {}),
  deduplicatePrUrls: vi.fn((urls: string[]) => ({ valid: urls, invalid: [] })),
}));

vi.mock('../db/pr_status.js', () => ({
  getPrStatusByUrl: vi.fn((_db: unknown, _prUrl: string) => null),
  getPrStatusForPlan: vi.fn((_db: unknown, _planUuid: string, _prUrls?: string[]) => []),
  linkPlanToPr: vi.fn((_db: unknown, _planUuid: string, _prStatusId: number) => {}),
  unlinkPlanFromPr: vi.fn((_db: unknown, _planUuid: string, _prStatusId: number) => {}),
  cleanOrphanedPrStatus: vi.fn((_db: unknown) => {}),
}));

vi.mock('../plans.js', () => ({
  readPlanFile: vi.fn(async (..._args: unknown[]) => ({})),
  resolvePlanFromDb: vi.fn(async (..._args: unknown[]) => ({
    plan: {},
    planPath: '',
  })),
  writePlanFile: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('../db/plan_sync.js', () => ({
  syncPlanToDb: vi.fn(async (..._args: unknown[]) => {}),
}));

import { log as mockLogFn } from '../../logging.js';
import { resolvePlan as mockResolvePlanFn } from '../plan_display.js';
import { getWorkspaceInfoByPath as mockGetWorkspaceInfoByPathFn } from '../workspace/workspace_info.js';
import { getDatabase as mockGetDatabaseFn } from '../db/database.js';
import {
  refreshPrStatus as mockRefreshPrStatusFn,
  ensurePrStatusFresh as mockEnsurePrStatusFreshFn,
  syncPlanPrLinks as mockSyncPlanPrLinksFn,
} from '../../common/github/pr_status_service.js';
import { getWebhookServerUrl as mockGetWebhookServerUrlFn } from '../../common/github/webhook_client.js';
import { ingestWebhookEvents as mockIngestWebhookEventsFn } from '../../common/github/webhook_ingest.js';
import { fetchOpenPullRequests as mockFetchOpenPullRequestsFn } from '../../common/github/pull_requests.js';
import {
  canonicalizePrUrl as mockCanonicalizePrUrlFn,
  parsePrOrIssueNumber as mockParsePrOrIssueNumberFn,
  validatePrIdentifier as mockValidatePrIdentifierFn,
} from '../../common/github/identifiers.js';
import {
  getPrStatusByUrl as mockGetPrStatusByUrlFn,
  getPrStatusForPlan as mockGetPrStatusForPlanFn,
  linkPlanToPr as mockLinkPlanToPrFn,
  unlinkPlanFromPr as mockUnlinkPlanFromPrFn,
  cleanOrphanedPrStatus as mockCleanOrphanedPrStatusFn,
} from '../db/pr_status.js';
import {
  readPlanFile as mockReadPlanFileFn,
  resolvePlanFromDb as mockResolvePlanFromDbFn,
  writePlanFile as mockWritePlanFileFn,
} from '../plans.js';
import { syncPlanToDb as mockSyncPlanToDbFn } from '../db/plan_sync.js';

const mockLog = vi.mocked(mockLogFn);
const mockResolvePlan = vi.mocked(mockResolvePlanFn);
const mockGetWorkspaceInfoByPath = vi.mocked(mockGetWorkspaceInfoByPathFn);
const mockGetDatabase = vi.mocked(mockGetDatabaseFn);
const mockRefreshPrStatus = vi.mocked(mockRefreshPrStatusFn);
const mockEnsurePrStatusFresh = vi.mocked(mockEnsurePrStatusFreshFn);
const mockSyncPlanPrLinks = vi.mocked(mockSyncPlanPrLinksFn);
const mockGetWebhookServerUrl = vi.mocked(mockGetWebhookServerUrlFn);
const mockIngestWebhookEvents = vi.mocked(mockIngestWebhookEventsFn);
const mockCanonicalizePrUrl = vi.mocked(mockCanonicalizePrUrlFn);
const mockParsePrOrIssueNumber = vi.mocked(mockParsePrOrIssueNumberFn);
const mockValidatePrIdentifier = vi.mocked(mockValidatePrIdentifierFn);
const mockGetPrStatusByUrl = vi.mocked(mockGetPrStatusByUrlFn);
const mockGetPrStatusForPlan = vi.mocked(mockGetPrStatusForPlanFn);
const mockLinkPlanToPr = vi.mocked(mockLinkPlanToPrFn);
const mockUnlinkPlanFromPr = vi.mocked(mockUnlinkPlanFromPrFn);
const mockCleanOrphanedPrStatus = vi.mocked(mockCleanOrphanedPrStatusFn);
const mockFetchOpenPullRequests = vi.mocked(mockFetchOpenPullRequestsFn);
const mockReadPlanFile = vi.mocked(mockReadPlanFileFn);
const mockResolvePlanFromDb = vi.mocked(mockResolvePlanFromDbFn);
const mockWritePlanFile = vi.mocked(mockWritePlanFileFn);
const mockSyncPlanToDb = vi.mocked(mockSyncPlanToDbFn);

let logs: string[] = [];
let dbHandle: AnyObject;
let currentPlan: AnyObject;
let currentPlanPath: string;
let currentWorkspaceInfo: AnyObject | null;
let currentRefreshedStatuses: Map<string, AnyObject>;
let currentSyncedStatuses: AnyObject[];
let currentParsedIdentifier: AnyObject | null;
let currentCachedDetail: AnyObject | null;
let currentAutoLinkedDetails: AnyObject[];
let currentPersistedPlan: AnyObject;

const handlePrCommand = { handlePrStatusCommand, handlePrLinkCommand, handlePrUnlinkCommand };

let currentWebhookServerUrl: string | null;
let prModule: typeof import('./pr.js');
let tempDir: string;
let originalCwd: string;

describe('tim/commands/pr', () => {
  beforeAll(async () => {
    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-pr-command-test-'));
    tempDir = await fs.realpath(tempDir);
    prModule = await import('./pr.js');
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
    clearGitHubTokenCache();
  });

  beforeEach(() => {
    clearGitHubTokenCache();
    vi.clearAllMocks();
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
    currentAutoLinkedDetails = [];
    currentWebhookServerUrl = null;
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
    mockEnsurePrStatusFresh.mockClear();
    mockSyncPlanPrLinks.mockClear();
    mockGetWebhookServerUrl.mockClear();
    mockIngestWebhookEvents.mockClear();
    mockCanonicalizePrUrl.mockClear();
    mockParsePrOrIssueNumber.mockClear();
    mockValidatePrIdentifier.mockClear();
    mockGetPrStatusByUrl.mockClear();
    mockGetPrStatusForPlan.mockClear();
    mockLinkPlanToPr.mockClear();
    mockUnlinkPlanFromPr.mockClear();
    mockCleanOrphanedPrStatus.mockClear();
    mockFetchOpenPullRequests.mockClear();
    mockReadPlanFile.mockClear();
    mockResolvePlanFromDb.mockClear();
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
    mockEnsurePrStatusFresh.mockImplementation(async (_db: unknown, prUrl: string) => {
      const detail = currentRefreshedStatuses.get(prUrl);
      if (!detail) {
        throw new Error(`Unexpected PR URL in test: ${prUrl}`);
      }
      return detail;
    });
    mockSyncPlanPrLinks.mockImplementation(async () => currentSyncedStatuses);
    mockGetWebhookServerUrl.mockImplementation(() => currentWebhookServerUrl);
    mockIngestWebhookEvents.mockImplementation(async () => ({
      eventsIngested: 0,
      prsUpdated: [],
      errors: [],
    }));
    mockCanonicalizePrUrl.mockImplementation((identifier: string) => {
      // Mimic real canonicalizePrUrl: reject non-PR GitHub URLs
      try {
        const url = new URL(identifier);
        const isGitHub = url.hostname === 'github.com' || url.hostname.endsWith('.github.com');
        if (isGitHub) {
          const segments = url.pathname.split('/').filter(Boolean);
          if (segments.length < 4 || (segments[2] !== 'pull' && segments[2] !== 'pulls')) {
            throw new Error(
              `Not a pull request URL: ${identifier}. Expected a GitHub PR URL (e.g. https://github.com/owner/repo/pull/123)`
            );
          }
        }
      } catch (e) {
        if (e instanceof TypeError) {
          // Not a URL, pass through
        } else {
          throw e;
        }
      }
      return identifier;
    });
    mockParsePrOrIssueNumber.mockImplementation(async () => currentParsedIdentifier);
    mockValidatePrIdentifier.mockImplementation(() => {});
    mockGetPrStatusByUrl.mockImplementation((_db: unknown, prUrl: string) => {
      // Check per-URL map first, then fall back to single cached detail
      const fromMap = currentRefreshedStatuses.get(prUrl);
      return fromMap ?? currentCachedDetail;
    });
    mockGetPrStatusForPlan.mockImplementation(() => currentAutoLinkedDetails);
    mockLinkPlanToPr.mockImplementation(() => {});
    mockUnlinkPlanFromPr.mockImplementation(() => {});
    mockCleanOrphanedPrStatus.mockImplementation(() => {});
    mockFetchOpenPullRequests.mockImplementation(async () => []);
    mockReadPlanFile.mockImplementation(async () => currentPersistedPlan);
    mockResolvePlanFromDb.mockImplementation(async () => ({
      plan: currentPersistedPlan,
      planPath: currentPlanPath,
    }));
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

    await handlePrCommand.handlePrStatusCommand(undefined, {}, createNestedCommand());

    expect(mockResolvePlan).toHaveBeenCalledWith('/tmp/248.plan.md', {
      gitRoot: '/tmp',
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
      await handlePrCommand.handlePrStatusCommand(undefined, {}, createNestedCommand());
    } finally {
      process.chdir(originalCwd);
    }

    expect(mockGetWorkspaceInfoByPath).toHaveBeenCalledWith(nestedDir);
    expect(mockGetWorkspaceInfoByPath).toHaveBeenCalledWith(path.join(workspaceDir, 'src'));
    expect(mockGetWorkspaceInfoByPath).toHaveBeenCalledWith(workspaceDir);
    expect(mockResolvePlan).toHaveBeenCalledWith('/tmp/248.plan.md', {
      gitRoot: '/tmp',
      configPath: '/tmp/tim.yml',
    });
  });

  test('status reports when a plan has no linked pull requests', async () => {
    currentPlan.pullRequest = [];

    await handlePrCommand.handlePrStatusCommand('248', {}, createNestedCommand());

    expect(mockSyncPlanPrLinks).not.toHaveBeenCalled();
    expect(logs).toContain('Plan 248 has no linked pull requests and no branch to look up.');
  });

  test('status uses webhook auto-linked PRs from the plan_pr junction when the plan file has none', async () => {
    currentWebhookServerUrl = 'https://webhooks.example.com';
    currentPlan.pullRequest = [];
    currentAutoLinkedDetails = [createPrDetail(605, 'Auto-linked PR', 'success')];
    currentRefreshedStatuses.set(
      'https://github.com/example/repo/pull/605',
      createPrDetail(605, 'Auto-linked PR', 'success')
    );

    await prModule.handlePrStatusCommand('248', {}, createNestedCommand());

    expect(mockGetPrStatusForPlan).toHaveBeenCalledWith(dbHandle, 'plan-248', []);
    expect(mockGetPrStatusByUrl).toHaveBeenCalledWith(
      dbHandle,
      'https://github.com/example/repo/pull/605'
    );
    expect(mockSyncPlanPrLinks).toHaveBeenCalledWith(dbHandle, 'plan-248', []);
    expect(mockEnsurePrStatusFresh).not.toHaveBeenCalled();
    expect(logs.some((line) => line.includes('example/repo#605: Auto-linked PR'))).toBe(true);
  });

  test('status refreshes explicit and auto-linked PRs together in webhook mode while syncing only explicit links', async () => {
    currentWebhookServerUrl = 'https://webhooks.example.com';
    currentPlan.pullRequest = ['https://github.com/example/repo/pull/611'];
    currentAutoLinkedDetails = [createPrDetail(612, 'Auto-linked PR', 'success')];
    currentRefreshedStatuses.set(
      'https://github.com/example/repo/pull/611',
      createPrDetail(611, 'Explicit PR', 'success')
    );
    currentRefreshedStatuses.set(
      'https://github.com/example/repo/pull/612',
      createPrDetail(612, 'Auto-linked PR', 'success')
    );

    await prModule.handlePrStatusCommand('248', {}, createNestedCommand());

    expect(mockGetPrStatusForPlan).toHaveBeenCalledWith(dbHandle, 'plan-248', []);
    expect(mockGetPrStatusByUrl).toHaveBeenCalledWith(
      dbHandle,
      'https://github.com/example/repo/pull/611'
    );
    expect(mockGetPrStatusByUrl).toHaveBeenCalledWith(
      dbHandle,
      'https://github.com/example/repo/pull/612'
    );
    expect(mockSyncPlanPrLinks).toHaveBeenCalledWith(dbHandle, 'plan-248', [
      'https://github.com/example/repo/pull/611',
    ]);
    expect(logs.some((line) => line.includes('example/repo#611: Explicit PR'))).toBe(true);
    expect(logs.some((line) => line.includes('example/repo#612: Auto-linked PR'))).toBe(true);
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

    await handlePrCommand.handlePrStatusCommand('248', {}, createNestedCommand());

    expect(mockRefreshPrStatus).toHaveBeenCalledTimes(3);
    expect(logs.some((line) => line.includes('example/repo#401: Passing PR'))).toBe(true);
    expect(logs.some((line) => line.includes('Merge readiness: ready'))).toBe(true);
    expect(logs.some((line) => line.includes('example/repo#402: Failing PR'))).toBe(true);
    expect(logs.some((line) => line.includes('Merge readiness: failing checks'))).toBe(true);
    expect(logs.some((line) => line.includes('example/repo#403: Pending PR'))).toBe(true);
    expect(logs.some((line) => line.includes('Merge readiness: checks pending'))).toBe(true);
  });

  test('status uses webhook ingestion and cached data when configured', async () => {
    currentWebhookServerUrl = 'https://webhooks.example.com';
    currentPlan.pullRequest = ['https://github.com/example/repo/pull/601'];
    currentRefreshedStatuses.set(
      'https://github.com/example/repo/pull/601',
      createPrDetail(601, 'Webhook PR', 'success')
    );

    await prModule.handlePrStatusCommand('248', {}, createNestedCommand());

    expect(mockIngestWebhookEvents).toHaveBeenCalledWith(dbHandle);
    expect(mockGetPrStatusByUrl).toHaveBeenCalledWith(
      dbHandle,
      'https://github.com/example/repo/pull/601'
    );
    expect(mockEnsurePrStatusFresh).not.toHaveBeenCalled();
    expect(mockRefreshPrStatus).not.toHaveBeenCalled();
  });

  test('status logs webhook ingestion warnings when the ingest result contains errors', async () => {
    currentWebhookServerUrl = 'https://webhooks.example.com';
    currentPlan.pullRequest = ['https://github.com/example/repo/pull/601'];
    currentRefreshedStatuses.set(
      'https://github.com/example/repo/pull/601',
      createPrDetail(601, 'Webhook PR', 'success')
    );
    mockIngestWebhookEvents.mockImplementation(async () => ({
      eventsIngested: 1,
      prsUpdated: [],
      errors: ['follow-up refresh failed'],
    }));

    await prModule.handlePrStatusCommand('248', {}, createNestedCommand());

    expect(
      logs.some((line) => line.includes('Webhook ingestion had issues: follow-up refresh failed'))
    ).toBe(true);
  });

  test('status keeps webhook mode API-free during junction sync even when GITHUB_TOKEN is set', async () => {
    currentWebhookServerUrl = 'https://webhooks.example.com';
    currentPlan.pullRequest = [
      'https://github.com/example/repo/pull/611',
      'https://github.com/example/repo/pull/612',
    ];
    currentRefreshedStatuses.set(
      'https://github.com/example/repo/pull/611',
      createPrDetail(611, 'Cached PR', 'success')
    );

    await prModule.handlePrStatusCommand('248', {}, createNestedCommand());

    expect(mockSyncPlanPrLinks).toHaveBeenCalledWith(dbHandle, 'plan-248', [
      'https://github.com/example/repo/pull/611',
    ]);
    expect(mockRefreshPrStatus).not.toHaveBeenCalled();
    expect(mockEnsurePrStatusFresh).not.toHaveBeenCalled();
  });

  test('status uses cached webhook data without requiring GITHUB_TOKEN', async () => {
    delete process.env.GITHUB_TOKEN;
    clearGitHubTokenCache();
    currentWebhookServerUrl = 'https://webhooks.example.com';
    currentPlan.pullRequest = ['https://github.com/example/repo/pull/603'];
    currentCachedDetail = createPrDetail(603, 'Cached Webhook PR', 'success');

    await prModule.handlePrStatusCommand('248', {}, createNestedCommand());

    expect(mockIngestWebhookEvents).toHaveBeenCalledWith(dbHandle);
    expect(mockGetPrStatusByUrl).toHaveBeenCalledWith(
      dbHandle,
      'https://github.com/example/repo/pull/603'
    );
    expect(mockEnsurePrStatusFresh).not.toHaveBeenCalled();
    expect(mockRefreshPrStatus).not.toHaveBeenCalled();
    expect(mockSyncPlanPrLinks).toHaveBeenCalledWith(dbHandle, 'plan-248', [
      'https://github.com/example/repo/pull/603',
    ]);
    expect(logs.some((line) => line.includes('example/repo#603: Cached Webhook PR'))).toBe(true);
  });

  test('status webhook mode prunes stale explicit junction rows when the plan has no explicit PRs', async () => {
    currentWebhookServerUrl = 'https://webhooks.example.com';
    currentPlan.pullRequest = [];
    currentAutoLinkedDetails = [createPrDetail(710, 'Auto-linked Only PR', 'success')];
    currentRefreshedStatuses.set(
      'https://github.com/example/repo/pull/710',
      createPrDetail(710, 'Auto-linked Only PR', 'success')
    );

    await prModule.handlePrStatusCommand('248', {}, createNestedCommand());

    expect(mockSyncPlanPrLinks).toHaveBeenCalledWith(dbHandle, 'plan-248', []);
    expect(mockGetPrStatusForPlan).toHaveBeenCalledWith(dbHandle, 'plan-248', []);
    expect(mockCleanOrphanedPrStatus).toHaveBeenCalledWith(dbHandle);
  });

  test('status reports missing cached webhook data when no token is available', async () => {
    delete process.env.GITHUB_TOKEN;
    clearGitHubTokenCache();
    currentWebhookServerUrl = 'https://webhooks.example.com';
    currentPlan.pullRequest = ['https://github.com/example/repo/pull/604'];
    currentCachedDetail = null;

    await expect(prModule.handlePrStatusCommand('248', {}, createNestedCommand())).rejects.toThrow(
      'Failed to fetch status for all linked pull requests'
    );

    expect(mockGetPrStatusByUrl).toHaveBeenCalledWith(
      dbHandle,
      'https://github.com/example/repo/pull/604'
    );
    expect(
      logs.some((line) =>
        line.includes(
          'Failed to fetch status for https://github.com/example/repo/pull/604: No cached data available'
        )
      )
    ).toBe(true);
  });

  test('status force-refresh bypasses webhook ingestion even when configured', async () => {
    currentWebhookServerUrl = 'https://webhooks.example.com';
    currentPlan.pullRequest = ['https://github.com/example/repo/pull/602'];
    currentRefreshedStatuses.set(
      'https://github.com/example/repo/pull/602',
      createPrDetail(602, 'Force Refresh PR', 'success')
    );

    await prModule.handlePrStatusCommand('248', { forceRefresh: true }, createNestedCommand());

    expect(mockIngestWebhookEvents).not.toHaveBeenCalled();
    expect(mockEnsurePrStatusFresh).not.toHaveBeenCalled();
    expect(mockRefreshPrStatus).toHaveBeenCalledWith(
      dbHandle,
      'https://github.com/example/repo/pull/602'
    );
  });

  test('status force-refresh uses auto-linked junction PRs when the plan has no explicit pull requests', async () => {
    currentWebhookServerUrl = 'https://webhooks.example.com';
    currentPlan.pullRequest = [];
    currentAutoLinkedDetails = [createPrDetail(605, 'Webhook Auto-linked PR', 'success')];
    currentRefreshedStatuses.set(
      'https://github.com/example/repo/pull/605',
      createPrDetail(605, 'Webhook Auto-linked PR', 'success')
    );

    await prModule.handlePrStatusCommand('248', { forceRefresh: true }, createNestedCommand());

    expect(mockIngestWebhookEvents).not.toHaveBeenCalled();
    expect(mockGetPrStatusForPlan).toHaveBeenCalledWith(dbHandle, 'plan-248', []);
    expect(mockRefreshPrStatus).toHaveBeenCalledWith(
      dbHandle,
      'https://github.com/example/repo/pull/605'
    );
    expect(logs.some((line) => line.includes('example/repo#605: Webhook Auto-linked PR'))).toBe(
      true
    );
  });

  test('status force-refresh uses the union of explicit and auto-linked PRs', async () => {
    currentWebhookServerUrl = 'https://webhooks.example.com';
    currentPlan.pullRequest = ['https://github.com/example/repo/pull/701'];
    currentAutoLinkedDetails = [createPrDetail(702, 'Webhook Auto-linked PR', 'success')];
    currentRefreshedStatuses.set(
      'https://github.com/example/repo/pull/701',
      createPrDetail(701, 'Explicit PR', 'success')
    );
    currentRefreshedStatuses.set(
      'https://github.com/example/repo/pull/702',
      createPrDetail(702, 'Webhook Auto-linked PR', 'success')
    );

    await prModule.handlePrStatusCommand('248', { forceRefresh: true }, createNestedCommand());

    expect(mockRefreshPrStatus).toHaveBeenCalledWith(
      dbHandle,
      'https://github.com/example/repo/pull/701'
    );
    expect(mockRefreshPrStatus).toHaveBeenCalledWith(
      dbHandle,
      'https://github.com/example/repo/pull/702'
    );
    expect(mockSyncPlanPrLinks).toHaveBeenCalledWith(dbHandle, 'plan-248', [
      'https://github.com/example/repo/pull/701',
    ]);
  });

  test('status shows partial results when some PR fetches fail', async () => {
    currentPlan.pullRequest = [
      'https://github.com/example/repo/pull/501',
      'https://github.com/example/repo/pull/502',
    ];
    const detail501 = createPrDetail(501, 'Good PR', 'success');
    currentRefreshedStatuses.set('https://github.com/example/repo/pull/501', detail501);
    // PR 502 is NOT in currentRefreshedStatuses, so refreshPrStatus will throw

    await handlePrCommand.handlePrStatusCommand('248', {}, createNestedCommand());

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

    await handlePrCommand.handlePrLinkCommand(
      '248',
      'https://github.com/example/repo/pull/201',
      {},
      createNestedCommand()
    );

    expect(mockResolvePlan).toHaveBeenCalledWith('248', {
      gitRoot: '/tmp',
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
    expect(mockResolvePlanFromDb).toHaveBeenCalled();
    expect(mockWritePlanFile).toHaveBeenCalledWith(
      '/tmp/248.plan.md',
      {
        ...currentPersistedPlan,
        pullRequest: ['https://github.com/example/repo/pull/201'],
      },
      { cwdForIdentity: '/tmp' }
    );
    // writePlanFile handles syncPlanToDb internally
    expect(logs.some((line) => line.includes('Linked'))).toBe(true);
  });

  test('link canonicalizes existing /pulls variants before deduplicating persisted plan URLs', async () => {
    currentParsedIdentifier = { owner: 'example', repo: 'repo', number: 201 };
    currentPersistedPlan = {
      ...currentPlan,
      pullRequest: ['https://github.com/example/repo/pulls/201?tab=checks'],
    };
    currentRefreshedStatuses.set(
      'https://github.com/example/repo/pull/201',
      createPrDetail(201, 'Linked PR', 'pending', 77)
    );
    mockCanonicalizePrUrl.mockImplementation((identifier: string) => {
      if (identifier.startsWith('https://github.com/example/repo/pulls/201')) {
        return 'https://github.com/example/repo/pull/201';
      }
      return identifier;
    });

    await handlePrCommand.handlePrLinkCommand(
      '248',
      'https://github.com/example/repo/pull/201',
      {},
      createNestedCommand()
    );

    expect(mockWritePlanFile).toHaveBeenCalledWith(
      '/tmp/248.plan.md',
      {
        ...currentPersistedPlan,
        pullRequest: ['https://github.com/example/repo/pull/201'],
      },
      { cwdForIdentity: '/tmp' }
    );
  });

  test('link re-reads fresh plan data before writing pull requests', async () => {
    currentParsedIdentifier = { owner: 'example', repo: 'repo', number: 201 };
    currentPlan = {
      ...currentPlan,
      title: 'Stale plan from command start',
      status: 'pending',
    };
    currentPersistedPlan = {
      ...currentPersistedPlan,
      title: 'Fresh plan from DB',
      status: 'in_progress',
      pullRequest: [],
    };
    currentRefreshedStatuses.set(
      'https://github.com/example/repo/pull/201',
      createPrDetail(201, 'Linked PR', 'pending', 77)
    );

    await handlePrCommand.handlePrLinkCommand(
      '248',
      'https://github.com/example/repo/pull/201',
      {},
      createNestedCommand()
    );

    expect(mockWritePlanFile).toHaveBeenCalledWith(
      '/tmp/248.plan.md',
      expect.objectContaining({
        title: 'Fresh plan from DB',
        status: 'in_progress',
        pullRequest: ['https://github.com/example/repo/pull/201'],
      }),
      { cwdForIdentity: '/tmp' }
    );
  });

  test('link preserves YAML-only fields by re-reading the file-backed plan when available', async () => {
    currentParsedIdentifier = { owner: 'example', repo: 'repo', number: 201 };
    currentPersistedPlan = {
      ...currentPersistedPlan,
      title: 'Fresh plan from DB',
      status: 'in_progress',
      pullRequest: [],
    };
    currentRefreshedStatuses.set(
      'https://github.com/example/repo/pull/201',
      createPrDetail(201, 'Linked PR', 'pending', 77)
    );

    await handlePrCommand.handlePrLinkCommand(
      '248',
      'https://github.com/example/repo/pull/201',
      {},
      createNestedCommand()
    );

    expect(mockResolvePlanFromDb).toHaveBeenCalled();
    expect(mockWritePlanFile).toHaveBeenCalledWith(
      '/tmp/248.plan.md',
      expect.objectContaining({
        title: 'Fresh plan from DB',
        status: 'in_progress',
        pullRequest: ['https://github.com/example/repo/pull/201'],
      }),
      { cwdForIdentity: '/tmp' }
    );
  });

  test('link rejects invalid GitHub pull request identifiers', async () => {
    currentParsedIdentifier = null;

    await expect(
      handlePrCommand.handlePrLinkCommand('248', 'not-a-pr', {}, createNestedCommand())
    ).rejects.toThrow(
      'No open PR found for branch "not-a-pr". Please specify a PR URL explicitly.'
    );

    expect(mockRefreshPrStatus).not.toHaveBeenCalled();
    expect(mockLinkPlanToPr).not.toHaveBeenCalled();
    expect(mockFetchOpenPullRequests).toHaveBeenCalled();
  });

  test('link rejects explicit GitHub issue URLs', async () => {
    currentParsedIdentifier = { owner: 'example', repo: 'repo', number: 201 };

    await expect(
      handlePrCommand.handlePrLinkCommand(
        '248',
        'https://github.com/example/repo/issues/201',
        {},
        createNestedCommand()
      )
    ).rejects.toThrow('Not a pull request URL: https://github.com/example/repo/issues/201');

    expect(mockRefreshPrStatus).not.toHaveBeenCalled();
    expect(mockLinkPlanToPr).not.toHaveBeenCalled();
  });

  test('unlink removes the junction, cleans orphaned PR cache rows, and persists the plan file', async () => {
    currentCachedDetail = createPrDetail(301, 'Cached PR', 'success', 88);
    currentPlan.pullRequest = ['https://github.com/example/repo/pull/301'];
    currentPersistedPlan = {
      ...currentPlan,
      pullRequest: ['https://github.com/example/repo/pull/301'],
    };

    await handlePrCommand.handlePrUnlinkCommand(
      '248',
      'https://github.com/example/repo/pull/301',
      {},
      createNestedCommand()
    );

    expect(mockResolvePlanFromDb).toHaveBeenCalled();
    expect(mockWritePlanFile).toHaveBeenCalledWith(
      '/tmp/248.plan.md',
      {
        ...currentPersistedPlan,
        pullRequest: [],
      },
      { cwdForIdentity: '/tmp' }
    );
    // DB cleanup best-effort
    expect(mockGetPrStatusByUrl).toHaveBeenCalledWith(
      dbHandle,
      'https://github.com/example/repo/pull/301'
    );
    expect(mockUnlinkPlanFromPr).toHaveBeenCalledWith(dbHandle, 'plan-248', 88);
    expect(mockCleanOrphanedPrStatus).toHaveBeenCalledWith(dbHandle);
    expect(logs.some((line) => line.includes('Unlinked'))).toBe(true);
  });

  test('unlink canonicalizes existing /pulls variants before removing persisted plan URLs', async () => {
    currentCachedDetail = createPrDetail(301, 'Cached PR', 'success', 88);
    currentPlan.pullRequest = ['https://github.com/example/repo/pulls/301?tab=checks'];
    currentPersistedPlan = {
      ...currentPlan,
      pullRequest: ['https://github.com/example/repo/pulls/301?tab=checks'],
    };
    mockCanonicalizePrUrl.mockImplementation((identifier: string) => {
      if (identifier.startsWith('https://github.com/example/repo/pulls/301')) {
        return 'https://github.com/example/repo/pull/301';
      }
      return identifier;
    });

    await handlePrCommand.handlePrUnlinkCommand(
      '248',
      'https://github.com/example/repo/pull/301',
      {},
      createNestedCommand()
    );

    expect(mockWritePlanFile).toHaveBeenCalledWith(
      '/tmp/248.plan.md',
      {
        ...currentPersistedPlan,
        pullRequest: [],
      },
      { cwdForIdentity: '/tmp' }
    );
    expect(logs.some((line) => line.includes('Unlinked'))).toBe(true);
  });

  test('unlink re-reads the fresh file-backed plan before writing pull requests', async () => {
    currentCachedDetail = createPrDetail(301, 'Cached PR', 'success', 88);
    currentPlan = {
      ...currentPlan,
      title: 'Stale plan from command start',
      status: 'pending',
      pullRequest: ['https://github.com/example/repo/pull/301'],
    };
    currentPersistedPlan = {
      ...currentPersistedPlan,
      title: 'Fresh plan from DB',
      status: 'in_progress',
      details: 'concurrent change preserved',
      pullRequest: ['https://github.com/example/repo/pull/301'],
    };

    await handlePrCommand.handlePrUnlinkCommand(
      '248',
      'https://github.com/example/repo/pull/301',
      {},
      createNestedCommand()
    );

    expect(mockResolvePlanFromDb).toHaveBeenCalled();
    expect(mockWritePlanFile).toHaveBeenCalledWith(
      '/tmp/248.plan.md',
      expect.objectContaining({
        title: 'Fresh plan from DB',
        status: 'in_progress',
        details: 'concurrent change preserved',
        pullRequest: [],
      }),
      { cwdForIdentity: '/tmp' }
    );
  });

  test('unlink falls back to DB when the file-backed plan no longer exists', async () => {
    currentCachedDetail = createPrDetail(301, 'Cached PR', 'success', 88);
    currentPersistedPlan = {
      ...currentPersistedPlan,
      title: 'Fresh plan from DB',
      pullRequest: ['https://github.com/example/repo/pull/301'],
    };
    await handlePrCommand.handlePrUnlinkCommand(
      '248',
      'https://github.com/example/repo/pull/301',
      {},
      createNestedCommand()
    );

    expect(mockResolvePlanFromDb).toHaveBeenCalled();
    expect(mockWritePlanFile).toHaveBeenCalledWith(
      '/tmp/248.plan.md',
      expect.objectContaining({
        title: 'Fresh plan from DB',
        pullRequest: [],
      }),
      { cwdForIdentity: '/tmp' }
    );
  });

  test('unlink reports no-op when URL not in plan file, but still cleans DB cache', async () => {
    currentCachedDetail = createPrDetail(302, 'Cached PR', 'success', 89);
    // Plan file has no PR URLs - the URL is only in the DB cache
    currentPersistedPlan = { ...currentPlan, pullRequest: [] };

    await handlePrCommand.handlePrUnlinkCommand(
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
      handlePrCommand.handlePrUnlinkCommand(
        '248',
        'https://github.com/example/repo/issues/302',
        {},
        createNestedCommand()
      )
    ).rejects.toThrow('Not a pull request URL: https://github.com/example/repo/issues/302');

    expect(mockGetPrStatusByUrl).not.toHaveBeenCalled();
    expect(mockUnlinkPlanFromPr).not.toHaveBeenCalled();
  });

  test('status requires GITHUB_TOKEN when plan has PRs and webhook mode is disabled', async () => {
    delete process.env.GITHUB_TOKEN;
    clearGitHubTokenCache();
    currentPlan.pullRequest = ['https://github.com/example/repo/pull/101'];

    await expect(
      handlePrCommand.handlePrStatusCommand('248', {}, createNestedCommand())
    ).rejects.toThrow('GITHUB_TOKEN environment variable is required for PR status commands');

    // Plan is resolved first, then token is checked
    expect(mockResolvePlan).toHaveBeenCalled();
    expect(mockRefreshPrStatus).not.toHaveBeenCalled();
  });

  test('status with no PRs succeeds without GITHUB_TOKEN', async () => {
    delete process.env.GITHUB_TOKEN;
    currentPlan.pullRequest = [];

    await handlePrCommand.handlePrStatusCommand('248', {}, createNestedCommand());

    expect(logs).toContain('Plan 248 has no linked pull requests and no branch to look up.');
  });

  test('link requires GITHUB_TOKEN', async () => {
    delete process.env.GITHUB_TOKEN;

    await expect(
      handlePrCommand.handlePrLinkCommand(
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
    currentPlan.pullRequest = ['https://github.com/example/repo/pull/999'];
    currentPersistedPlan = {
      ...currentPlan,
      pullRequest: ['https://github.com/example/repo/pull/999'],
    };

    await handlePrCommand.handlePrUnlinkCommand(
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

    await expect(
      handlePrCommand.handlePrStatusCommand('999', {}, createNestedCommand())
    ).rejects.toThrow('Plan not found: 999');

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
