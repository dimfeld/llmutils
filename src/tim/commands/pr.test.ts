import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, afterAll, beforeEach, describe, expect, vi, test } from 'vitest';

import { clearGitHubTokenCache } from '../../common/github/token.js';
import {
  buildReviewThreadFixPrompt,
  buildPrReviewThreadFixPrompt,
  buildReviewThreadFixInstructions,
  handlePrCommentCommand,
  handlePrFixCommand,
  handlePrRefreshCommand,
  handlePrStatusCommand,
  handlePrLinkCommand,
  handlePrResolveCommand,
  handlePrUnlinkCommand,
  ensurePrFixHeadBranchPushableOnOrigin,
  fetchPrFixBaseBranch,
  resolvePrFixTargetIntent,
  resolvePrFixTarget,
  type PullRequestFixTarget,
} from './pr.js';
import { LATEST_GPT5_MODEL } from '../constants.js';

type AnyObject = Record<string, unknown>;

function makeProject(id: number, repositoryId = 'example/repo'): AnyObject {
  return {
    id,
    uuid: `project-${id}`,
    repository_id: repositoryId,
    remote_url: null,
    last_git_root: null,
    external_config_path: null,
    external_tasks_dir: null,
    remote_label: null,
    highest_plan_id: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

const executorMocks = vi.hoisted(() => ({
  buildExecutorAndLog: vi.fn(),
  defaultModelForExecutor: vi.fn(),
  execute: vi.fn(async (..._args: unknown[]) => {}),
}));

const lifecycleMocks = vi.hoisted(() => ({
  ctor: vi.fn(),
  startup: vi.fn(async () => {}),
  shutdown: vi.fn(async () => {}),
}));

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
  touchWorkspaceInfo: vi.fn((_workspacePath: string) => {}),
}));

vi.mock('../db/database.js', () => ({
  getDatabase: vi.fn(() => ({})),
}));

vi.mock('../../common/github/pr_status_service.js', () => ({
  refreshPrStatus: vi.fn(async (..._args: unknown[]) => ({})),
  ensurePrStatusFresh: vi.fn(async (..._args: unknown[]) => ({})),
  syncPlanPrLinks: vi.fn(async (..._args: unknown[]) => []),
}));

vi.mock('../../common/github/project_pr_service.js', () => ({
  refreshProjectPrs: vi.fn(async (..._args: unknown[]) => ({
    refreshed: [],
    authored: [],
    reviewing: [],
    newLinks: [],
  })),
}));

vi.mock('../../common/github/user.js', () => ({
  getGitHubUsername: vi.fn(async () => 'dimfeld'),
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
  parseOwnerRepoFromRepositoryId: vi.fn((repositoryId: string) => {
    const [owner, repo] = repositoryId.split('/');
    return owner && repo ? { owner, repo } : null;
  }),
  fetchOpenPullRequests: vi.fn(async (..._args: unknown[]) => []),
  postPullRequestComment: vi.fn(async (..._args: unknown[]) => ({
    id: 123,
    htmlUrl: 'https://github.com/example/repo/pull/701#issuecomment-123',
  })),
  resolveReviewThread: vi.fn(async (..._args: unknown[]) => true),
}));

vi.mock('../../common/github/identifiers.js', () => ({
  canonicalizePrUrl: vi.fn((identifier: string) => identifier),
  parsePrOrIssueNumber: vi.fn(async (..._args: unknown[]) => null),
  validatePrIdentifier: vi.fn((_identifier: string) => {}),
  deduplicatePrUrls: vi.fn((urls: string[]) => ({ valid: urls, invalid: [] })),
}));

vi.mock('../../common/git.js', () => ({
  fetchRemoteBranch: vi.fn(async () => true),
  getGitRepository: vi.fn(async () => 'example/repo'),
  getGitRoot: vi.fn(async () => process.cwd()),
  getUsingJj: vi.fn(async () => false),
  remoteBranchExists: vi.fn(async () => true),
  getWorkingCopyStatus: vi.fn(async () => ({
    clean: true,
    hasChanges: false,
    changedFiles: [],
  })),
}));

vi.mock('../assignments/workspace_identifier.js', () => ({
  getRepositoryIdentity: vi.fn(async () => ({
    repositoryId: 'github.com__example__repo',
    remoteUrl: 'https://github.com/example/repo.git',
    gitRoot: '/tmp/example-repo',
  })),
}));

vi.mock('./agent/agent.js', () => ({
  timAgent: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('../executors/index.js', () => ({
  buildExecutorAndLog: executorMocks.buildExecutorAndLog,
  DEFAULT_EXECUTOR: 'claude-code',
  defaultModelForExecutor: executorMocks.defaultModelForExecutor,
}));

vi.mock('../db/pr_status.js', () => ({
  getLinkedPlansByPrUrl: vi.fn(() => new Map()),
  getPrStatusByUrl: vi.fn((_db: unknown, _prUrl: string) => null),
  getPrStatusForPlan: vi.fn((_db: unknown, _planUuid: string, _prUrls?: string[]) => []),
  linkPlanToPr: vi.fn((_db: unknown, _planUuid: string, _prStatusId: number) => {}),
  unlinkPlanFromPr: vi.fn((_db: unknown, _planUuid: string, _prStatusId: number) => {}),
  cleanOrphanedPrStatus: vi.fn((_db: unknown) => {}),
}));

vi.mock('../db/project.js', () => ({
  getProject: vi.fn((_db: unknown, repositoryId: string) => ({
    id: 7,
    uuid: 'project-7',
    repository_id: repositoryId,
    remote_url: null,
    last_git_root: null,
    external_config_path: null,
    external_tasks_dir: null,
    remote_label: null,
    highest_plan_id: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  })),
  getProjectById: vi.fn((_db: unknown, projectId: number) => ({
    id: projectId,
    uuid: `project-${projectId}`,
    repository_id: 'example/repo',
    remote_url: null,
    last_git_root: null,
    external_config_path: null,
    external_tasks_dir: null,
    remote_label: null,
    highest_plan_id: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  })),
  listProjects: vi.fn(() => [
    {
      id: 7,
      uuid: 'project-7',
      repository_id: 'example/repo',
      remote_url: null,
      last_git_root: null,
      external_config_path: null,
      external_tasks_dir: null,
      remote_label: null,
      highest_plan_id: 0,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
  ]),
}));

vi.mock('../plans.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../plans.js')>();
  return {
    ...actual,
    readPlanFile: vi.fn(async (..._args: unknown[]) => ({})),
    resolvePlanByNumericId: vi.fn(async (..._args: unknown[]) => ({
      plan: {},
      planPath: '',
    })),
    resolvePlanByUuid: vi.fn(async (..._args: unknown[]) => ({
      plan: {},
      planPath: '',
    })),
    writePlanFile: vi.fn(async (..._args: unknown[]) => {}),
  };
});

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(async (..._args: unknown[]) => ({})),
}));

vi.mock('../../logging/tunnel_client.js', () => ({
  isTunnelActive: vi.fn(() => false),
}));

vi.mock('../headless.js', () => ({
  runWithHeadlessAdapterIfEnabled: vi.fn(async (options: { callback: () => Promise<unknown> }) =>
    options.callback()
  ),
  updateHeadlessSessionInfo: vi.fn(),
}));

vi.mock('../lifecycle.js', () => ({
  LifecycleManager: class {
    constructor(...args: unknown[]) {
      lifecycleMocks.ctor(...args);
    }

    startup = lifecycleMocks.startup;
    shutdown = lifecycleMocks.shutdown;
  },
}));

vi.mock('../workspace/workspace_setup.js', () => ({
  setupWorkspace: vi.fn(async (..._args: unknown[]) => ({
    baseDir: '/tmp/workspace',
    planFile: '/tmp/workspace/.tim/plans/248.plan.md',
    branchCreatedDuringSetup: false,
  })),
}));

vi.mock('../workspace/workspace_roundtrip.js', () => ({
  prepareWorkspaceRoundTrip: vi.fn(async () => null),
  runPreExecutionWorkspaceSync: vi.fn(async () => {}),
  materializePlansForExecution: vi.fn(async () => undefined),
  runPostExecutionWorkspaceSync: vi.fn(async () => {}),
}));

vi.mock('../db/plan_sync.js', () => ({
  syncPlanToDb: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('../utils/pr_context_gathering.js', () => ({
  gatherPrContext: vi.fn(async (..._args: unknown[]) => ({})),
}));

import { log as mockLogFn } from '../../logging.js';
import { resolvePlan as mockResolvePlanFn } from '../plan_display.js';
import {
  getWorkspaceInfoByPath as mockGetWorkspaceInfoByPathFn,
  touchWorkspaceInfo as mockTouchWorkspaceInfoFn,
} from '../workspace/workspace_info.js';
import { setupWorkspace as mockSetupWorkspaceFn } from '../workspace/workspace_setup.js';
import {
  materializePlansForExecution as mockMaterializePlansForExecutionFn,
  prepareWorkspaceRoundTrip as mockPrepareWorkspaceRoundTripFn,
  runPostExecutionWorkspaceSync as mockRunPostExecutionWorkspaceSyncFn,
  runPreExecutionWorkspaceSync as mockRunPreExecutionWorkspaceSyncFn,
} from '../workspace/workspace_roundtrip.js';
import { getDatabase as mockGetDatabaseFn } from '../db/database.js';
import {
  refreshPrStatus as mockRefreshPrStatusFn,
  ensurePrStatusFresh as mockEnsurePrStatusFreshFn,
  syncPlanPrLinks as mockSyncPlanPrLinksFn,
} from '../../common/github/pr_status_service.js';
import { refreshProjectPrs as mockRefreshProjectPrsFn } from '../../common/github/project_pr_service.js';
import { getGitHubUsername as mockGetGitHubUsernameFn } from '../../common/github/user.js';
import { getWebhookServerUrl as mockGetWebhookServerUrlFn } from '../../common/github/webhook_client.js';
import { ingestWebhookEvents as mockIngestWebhookEventsFn } from '../../common/github/webhook_ingest.js';
import {
  fetchOpenPullRequests as mockFetchOpenPullRequestsFn,
  postPullRequestComment as mockPostPullRequestCommentFn,
  resolveReviewThread as mockResolveReviewThreadFn,
} from '../../common/github/pull_requests.js';
import {
  canonicalizePrUrl as mockCanonicalizePrUrlFn,
  deduplicatePrUrls as mockDeduplicatePrUrlsFn,
  parsePrOrIssueNumber as mockParsePrOrIssueNumberFn,
  validatePrIdentifier as mockValidatePrIdentifierFn,
} from '../../common/github/identifiers.js';
import {
  fetchRemoteBranch as mockFetchRemoteBranchFn,
  getGitRepository as mockGetGitRepositoryFn,
  remoteBranchExists as mockRemoteBranchExistsFn,
} from '../../common/git.js';
import { getRepositoryIdentity as mockGetRepositoryIdentityFn } from '../assignments/workspace_identifier.js';
import {
  getLinkedPlansByPrUrl as mockGetLinkedPlansByPrUrlFn,
  getPrStatusByUrl as mockGetPrStatusByUrlFn,
  getPrStatusForPlan as mockGetPrStatusForPlanFn,
  linkPlanToPr as mockLinkPlanToPrFn,
  unlinkPlanFromPr as mockUnlinkPlanFromPrFn,
  cleanOrphanedPrStatus as mockCleanOrphanedPrStatusFn,
} from '../db/pr_status.js';
import {
  getProject as mockGetProjectFn,
  getProjectById as mockGetProjectByIdFn,
  listProjects as mockListProjectsFn,
} from '../db/project.js';
import {
  readPlanFile as mockReadPlanFileFn,
  resolvePlanByNumericId as mockResolvePlanFromDbFn,
  resolvePlanByUuid as mockResolvePlanByUuidFn,
  writePlanFile as mockWritePlanFileFn,
} from '../plans.js';
import { loadEffectiveConfig as mockLoadEffectiveConfigFn } from '../configLoader.js';
import { isTunnelActive as mockIsTunnelActiveFn } from '../../logging/tunnel_client.js';
import {
  runWithHeadlessAdapterIfEnabled as mockRunWithHeadlessAdapterIfEnabledFn,
  updateHeadlessSessionInfo as mockUpdateHeadlessSessionInfoFn,
} from '../headless.js';
import { syncPlanToDb as mockSyncPlanToDbFn } from '../db/plan_sync.js';
import { timAgent as mockTimAgentFn } from './agent/agent.js';
import { gatherPrContext as mockGatherPrContextFn } from '../utils/pr_context_gathering.js';
import {
  buildExecutorAndLog as mockBuildExecutorAndLogFn,
  defaultModelForExecutor as mockDefaultModelForExecutorFn,
} from '../executors/index.js';

const mockLog = vi.mocked(mockLogFn);
const mockResolvePlan = vi.mocked(mockResolvePlanFn);
const mockGetWorkspaceInfoByPath = vi.mocked(mockGetWorkspaceInfoByPathFn);
const mockGetDatabase = vi.mocked(mockGetDatabaseFn);
const mockRefreshPrStatus = vi.mocked(mockRefreshPrStatusFn);
const mockEnsurePrStatusFresh = vi.mocked(mockEnsurePrStatusFreshFn);
const mockSyncPlanPrLinks = vi.mocked(mockSyncPlanPrLinksFn);
const mockRefreshProjectPrs = vi.mocked(mockRefreshProjectPrsFn);
const mockGetGitHubUsername = vi.mocked(mockGetGitHubUsernameFn);
const mockGetWebhookServerUrl = vi.mocked(mockGetWebhookServerUrlFn);
const mockIngestWebhookEvents = vi.mocked(mockIngestWebhookEventsFn);
const mockCanonicalizePrUrl = vi.mocked(mockCanonicalizePrUrlFn);
const mockDeduplicatePrUrls = vi.mocked(mockDeduplicatePrUrlsFn);
const mockParsePrOrIssueNumber = vi.mocked(mockParsePrOrIssueNumberFn);
const mockValidatePrIdentifier = vi.mocked(mockValidatePrIdentifierFn);
const mockFetchRemoteBranch = vi.mocked(mockFetchRemoteBranchFn);
const mockGetGitRepository = vi.mocked(mockGetGitRepositoryFn);
const mockRemoteBranchExists = vi.mocked(mockRemoteBranchExistsFn);
const mockGetRepositoryIdentity = vi.mocked(mockGetRepositoryIdentityFn);
const mockGetLinkedPlansByPrUrl = vi.mocked(mockGetLinkedPlansByPrUrlFn);
const mockGetPrStatusByUrl = vi.mocked(mockGetPrStatusByUrlFn);
const mockGetPrStatusForPlan = vi.mocked(mockGetPrStatusForPlanFn);
const mockLinkPlanToPr = vi.mocked(mockLinkPlanToPrFn);
const mockUnlinkPlanFromPr = vi.mocked(mockUnlinkPlanFromPrFn);
const mockCleanOrphanedPrStatus = vi.mocked(mockCleanOrphanedPrStatusFn);
const mockGetProject = vi.mocked(mockGetProjectFn);
const mockGetProjectById = vi.mocked(mockGetProjectByIdFn);
const mockListProjects = vi.mocked(mockListProjectsFn);
const mockFetchOpenPullRequests = vi.mocked(mockFetchOpenPullRequestsFn);
const mockPostPullRequestComment = vi.mocked(mockPostPullRequestCommentFn);
const mockResolveReviewThread = vi.mocked(mockResolveReviewThreadFn);
const mockReadPlanFile = vi.mocked(mockReadPlanFileFn);
const mockResolvePlanFromDb = vi.mocked(mockResolvePlanFromDbFn);
const mockResolvePlanByUuid = vi.mocked(mockResolvePlanByUuidFn);
const mockWritePlanFile = vi.mocked(mockWritePlanFileFn);
const mockLoadEffectiveConfig = vi.mocked(mockLoadEffectiveConfigFn);
const mockIsTunnelActive = vi.mocked(mockIsTunnelActiveFn);
const mockRunWithHeadlessAdapterIfEnabled = vi.mocked(mockRunWithHeadlessAdapterIfEnabledFn);
const mockUpdateHeadlessSessionInfo = vi.mocked(mockUpdateHeadlessSessionInfoFn);
const mockSyncPlanToDb = vi.mocked(mockSyncPlanToDbFn);
const mockTimAgent = vi.mocked(mockTimAgentFn);
const mockBuildExecutorAndLog = vi.mocked(mockBuildExecutorAndLogFn);
const mockDefaultModelForExecutor = vi.mocked(mockDefaultModelForExecutorFn);
const mockGatherPrContext = vi.mocked(mockGatherPrContextFn);
const mockExecutorExecute = executorMocks.execute;
const mockTouchWorkspaceInfo = vi.mocked(mockTouchWorkspaceInfoFn);
const mockSetupWorkspace = vi.mocked(mockSetupWorkspaceFn);
const mockPrepareWorkspaceRoundTrip = vi.mocked(mockPrepareWorkspaceRoundTripFn);
const mockRunPreExecutionWorkspaceSync = vi.mocked(mockRunPreExecutionWorkspaceSyncFn);
const mockMaterializePlansForExecution = vi.mocked(mockMaterializePlansForExecutionFn);
const mockRunPostExecutionWorkspaceSync = vi.mocked(mockRunPostExecutionWorkspaceSyncFn);

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

const handlePrCommand = {
  handlePrStatusCommand,
  handlePrRefreshCommand,
  handlePrLinkCommand,
  handlePrCommentCommand,
  handlePrResolveCommand,
  handlePrUnlinkCommand,
};

let currentWebhookServerUrl: string | null;
let prModule: typeof import('./pr.js');
let tempDir: string;
let originalCwd: string;
let originalStdinIsTTY: boolean | undefined;

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
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalStdinIsTTY,
      configurable: true,
    });
  });

  beforeEach(() => {
    originalStdinIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
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
    currentPersistedPlan = currentPlan;
    process.env.GITHUB_TOKEN = 'test-token';

    mockLog.mockClear();
    mockResolvePlan.mockClear();
    mockGetWorkspaceInfoByPath.mockClear();
    mockGetDatabase.mockClear();
    mockRefreshPrStatus.mockClear();
    mockEnsurePrStatusFresh.mockClear();
    mockSyncPlanPrLinks.mockClear();
    mockRefreshProjectPrs.mockReset();
    mockGetGitHubUsername.mockReset();
    mockGetWebhookServerUrl.mockClear();
    mockIngestWebhookEvents.mockClear();
    mockCanonicalizePrUrl.mockClear();
    mockDeduplicatePrUrls.mockClear();
    mockParsePrOrIssueNumber.mockClear();
    mockValidatePrIdentifier.mockClear();
    mockFetchRemoteBranch.mockReset();
    mockFetchRemoteBranch.mockResolvedValue(true);
    mockGetGitRepository.mockReset();
    mockRemoteBranchExists.mockReset();
    mockRemoteBranchExists.mockResolvedValue(true);
    mockGetRepositoryIdentity.mockReset();
    mockGetLinkedPlansByPrUrl.mockReset();
    mockGetLinkedPlansByPrUrl.mockReturnValue(new Map());
    mockGetPrStatusByUrl.mockClear();
    mockGetPrStatusForPlan.mockClear();
    mockLinkPlanToPr.mockClear();
    mockUnlinkPlanFromPr.mockClear();
    mockCleanOrphanedPrStatus.mockClear();
    mockGetProject.mockReset();
    mockGetProjectById.mockReset();
    mockListProjects.mockReset();
    mockFetchOpenPullRequests.mockClear();
    mockPostPullRequestComment.mockClear();
    mockResolveReviewThread.mockClear();
    mockReadPlanFile.mockClear();
    mockResolvePlanFromDb.mockClear();
    mockResolvePlanByUuid.mockClear();
    mockWritePlanFile.mockClear();
    mockLoadEffectiveConfig.mockReset();
    mockLoadEffectiveConfig.mockResolvedValue({});
    mockIsTunnelActive.mockReset();
    mockIsTunnelActive.mockReturnValue(false);
    mockRunWithHeadlessAdapterIfEnabled.mockClear();
    mockRunWithHeadlessAdapterIfEnabled.mockImplementation(
      async (options: { callback: () => Promise<unknown> }) => options.callback()
    );
    mockUpdateHeadlessSessionInfo.mockReset();
    mockBuildExecutorAndLog.mockReset();
    mockBuildExecutorAndLog.mockReturnValue({ execute: mockExecutorExecute } as any);
    mockDefaultModelForExecutor.mockReset();
    mockDefaultModelForExecutor.mockImplementation((executorId: string) =>
      executorId === 'codex-cli' ? 'gpt-5.5' : 'opus'
    );
    mockExecutorExecute.mockClear();
    lifecycleMocks.ctor.mockClear();
    lifecycleMocks.startup.mockClear();
    lifecycleMocks.shutdown.mockClear();
    mockSyncPlanToDb.mockClear();
    mockTimAgent.mockClear();
    mockLog.mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
    mockResolvePlan.mockImplementation(async () => ({
      plan: currentPlan,
      planPath: currentPlanPath,
    }));
    mockGetWorkspaceInfoByPath.mockImplementation(() => currentWorkspaceInfo);
    mockTouchWorkspaceInfo.mockReset();
    mockTouchWorkspaceInfo.mockImplementation(() => {});
    mockSetupWorkspace.mockReset();
    mockSetupWorkspace.mockResolvedValue({
      baseDir: '/tmp/workspace',
      planFile: '/tmp/workspace/.tim/plans/248.plan.md',
      branchCreatedDuringSetup: false,
    } as any);
    mockPrepareWorkspaceRoundTrip.mockReset();
    mockPrepareWorkspaceRoundTrip.mockResolvedValue(null);
    mockRunPreExecutionWorkspaceSync.mockReset();
    mockRunPreExecutionWorkspaceSync.mockResolvedValue(undefined);
    mockMaterializePlansForExecution.mockReset();
    mockMaterializePlansForExecution.mockResolvedValue(undefined);
    mockRunPostExecutionWorkspaceSync.mockReset();
    mockRunPostExecutionWorkspaceSync.mockResolvedValue(undefined);
    mockGetDatabase.mockImplementation(() => dbHandle);
    mockRefreshPrStatus.mockImplementation(async (_db: unknown, prUrl: string) => {
      const detail = currentRefreshedStatuses.get(prUrl);
      if (detail) {
        return detail;
      }
      const autoLinkedDetail = currentAutoLinkedDetails.find(
        (candidate) => candidate.status?.pr_url === prUrl
      );
      if (autoLinkedDetail) {
        return autoLinkedDetail;
      }
      throw new Error(`Unexpected PR URL in test: ${prUrl}`);
    });
    mockEnsurePrStatusFresh.mockImplementation(async (_db: unknown, prUrl: string) => {
      const detail = currentRefreshedStatuses.get(prUrl);
      if (!detail) {
        throw new Error(`Unexpected PR URL in test: ${prUrl}`);
      }
      return detail;
    });
    mockSyncPlanPrLinks.mockImplementation(async () => currentSyncedStatuses);
    mockRefreshProjectPrs.mockResolvedValue({
      refreshed: [],
      authored: [],
      reviewing: [],
      newLinks: [],
    });
    mockGetGitHubUsername.mockResolvedValue('dimfeld');
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
    mockGetGitRepository.mockResolvedValue('example/repo');
    mockGetRepositoryIdentity.mockResolvedValue({
      repositoryId: 'github.com__example__repo',
      remoteUrl: 'https://github.com/example/repo.git',
      gitRoot: '/tmp/example-repo',
    });
    mockDeduplicatePrUrls.mockImplementation((urls: string[]) => ({ valid: urls, invalid: [] }));
    mockGetPrStatusByUrl.mockImplementation((_db: unknown, prUrl: string) => {
      // Check per-URL map first, then fall back to single cached detail
      const fromMap = currentRefreshedStatuses.get(prUrl);
      return fromMap ?? currentCachedDetail;
    });
    mockGetPrStatusForPlan.mockImplementation(() => currentAutoLinkedDetails);
    mockLinkPlanToPr.mockImplementation(() => {});
    mockUnlinkPlanFromPr.mockImplementation(() => {});
    mockCleanOrphanedPrStatus.mockImplementation(() => {});
    mockGetProject.mockImplementation(
      (_db: unknown, repositoryId: string) => makeProject(7, repositoryId) as any
    );
    mockGetProjectById.mockImplementation(
      (_db: unknown, projectId: number) => makeProject(projectId) as any
    );
    mockListProjects.mockReturnValue([makeProject(7), makeProject(8, 'example/other')] as any);
    mockFetchOpenPullRequests.mockImplementation(async () => []);
    mockPostPullRequestComment.mockImplementation(async () => ({
      id: 123,
      htmlUrl: 'https://github.com/example/repo/pull/701#issuecomment-123',
    }));
    mockResolveReviewThread.mockImplementation(async () => true);
    mockReadPlanFile.mockImplementation(async () => currentPersistedPlan);
    mockResolvePlanFromDb.mockImplementation(async () => ({
      plan: currentPersistedPlan,
      planPath: currentPlanPath,
    }));
    mockResolvePlanByUuid.mockImplementation(async () => ({
      plan: currentPersistedPlan,
      planPath: currentPlanPath,
    }));
    mockWritePlanFile.mockImplementation(async (_planPath: string, plan: unknown) => {
      currentPersistedPlan = plan as AnyObject;
    });
    mockSyncPlanToDb.mockImplementation(async () => {});
    mockTimAgent.mockImplementation(async () => {});
    mockGatherPrContext.mockReset();
    mockGatherPrContext.mockResolvedValue({
      prUrl: 'https://github.com/example/repo/pull/42',
      prNumber: 42,
      owner: 'example',
      repo: 'repo',
      baseBranch: 'main',
      headBranch: 'feature/my-pr',
      headSha: 'abc123def456',
      prStatus: {},
    } as any);
  });

  test('refresh defaults to the current repository project identity and fetches all open PR statuses', async () => {
    mockRefreshProjectPrs.mockResolvedValue({
      refreshed: [
        { status: { pr_number: 1 } },
        { status: { pr_number: 2 } },
        { status: { pr_number: 3 } },
      ] as any,
      authored: [{ status: { pr_number: 1 } }] as any,
      reviewing: [{ status: { pr_number: 2 } }] as any,
      newLinks: [{ prUrl: 'https://github.com/example/repo/pull/1', planId: 248 }],
    });

    await handlePrCommand.handlePrRefreshCommand(undefined, { opts: () => ({}) });

    expect(mockGetRepositoryIdentity).toHaveBeenCalledTimes(1);
    expect(mockGetGitRepository).not.toHaveBeenCalled();
    expect(mockGetProject).toHaveBeenCalledWith(dbHandle, 'github.com__example__repo');
    expect(mockRefreshProjectPrs).toHaveBeenCalledWith(dbHandle, 7, 'dimfeld');
    expect(logs).toContain(
      'Refreshed project 7 (github.com__example__repo): 3 open PRs, 1 new plan link.'
    );
    expect(logs.at(-1)).toContain('PR refresh complete: 1 project, 3 open PRs, 1 new plan link.');
  });

  test('refresh accepts an explicit project id', async () => {
    mockRefreshProjectPrs.mockResolvedValue({
      refreshed: [{ status: { pr_number: 9 } }] as any,
      authored: [],
      reviewing: [],
      newLinks: [],
    });

    await handlePrCommand.handlePrRefreshCommand('42', { opts: () => ({}) });

    expect(mockGetRepositoryIdentity).not.toHaveBeenCalled();
    expect(mockGetProjectById).toHaveBeenCalledWith(dbHandle, 42);
    expect(mockRefreshProjectPrs).toHaveBeenCalledWith(dbHandle, 42, 'dimfeld');
    expect(logs).toContain('Refreshed project 42 (example/repo): 1 open PR, 0 new plan links.');
  });

  test('refresh all processes every registered GitHub project', async () => {
    mockRefreshProjectPrs.mockResolvedValue({
      refreshed: [{ status: { pr_number: 9 } }] as any,
      authored: [],
      reviewing: [],
      newLinks: [],
    });

    await handlePrCommand.handlePrRefreshCommand('all', { opts: () => ({}) });

    expect(mockListProjects).toHaveBeenCalledWith(dbHandle);
    expect(mockRefreshProjectPrs).toHaveBeenCalledWith(dbHandle, 7, 'dimfeld');
    expect(mockRefreshProjectPrs).toHaveBeenCalledWith(dbHandle, 8, 'dimfeld');
    expect(logs.at(-1)).toContain('PR refresh complete: 2 projects, 2 open PRs, 0 new plan links.');
  });

  test('status resolves the current workspace plan and syncs each linked PR atomically', async () => {
    currentWorkspaceInfo = {
      planId: '248',
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

    expect(mockResolvePlanFromDb).toHaveBeenCalledWith(248, expect.any(String));
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
      planId: '248',
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
    expect(mockResolvePlanFromDb).toHaveBeenCalledWith(248, expect.any(String));
  });

  test('status reports when a plan has no linked pull requests', async () => {
    currentPlan.pullRequest = [];

    await handlePrCommand.handlePrStatusCommand(248, {}, createNestedCommand());

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

    await prModule.handlePrStatusCommand(248, {}, createNestedCommand());

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

    await prModule.handlePrStatusCommand(248, {}, createNestedCommand());

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

    await handlePrCommand.handlePrStatusCommand(248, {}, createNestedCommand());

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

    await prModule.handlePrStatusCommand(248, {}, createNestedCommand());

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

    await prModule.handlePrStatusCommand(248, {}, createNestedCommand());

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

    await prModule.handlePrStatusCommand(248, {}, createNestedCommand());

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

    await prModule.handlePrStatusCommand(248, {}, createNestedCommand());

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

    await prModule.handlePrStatusCommand(248, {}, createNestedCommand());

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

    await expect(prModule.handlePrStatusCommand(248, {}, createNestedCommand())).rejects.toThrow(
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

    await prModule.handlePrStatusCommand(248, { forceRefresh: true }, createNestedCommand());

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

    await prModule.handlePrStatusCommand(248, { forceRefresh: true }, createNestedCommand());

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

    await prModule.handlePrStatusCommand(248, { forceRefresh: true }, createNestedCommand());

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

    await handlePrCommand.handlePrStatusCommand(248, {}, createNestedCommand());

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
      248,
      'https://github.com/example/repo/pull/201',
      {},
      createNestedCommand()
    );

    expect(mockResolvePlanFromDb).toHaveBeenCalledWith(248, expect.any(String));
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
      248,
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
      248,
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
      248,
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
      handlePrCommand.handlePrLinkCommand(248, 'not-a-pr', {}, createNestedCommand())
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
        248,
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
      248,
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
      248,
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
      248,
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
      248,
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
      248,
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
        248,
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
      handlePrCommand.handlePrStatusCommand(248, {}, createNestedCommand())
    ).rejects.toThrow('GITHUB_TOKEN environment variable is required for PR status commands');

    // Plan is resolved first, then token is checked
    expect(mockResolvePlanFromDb).toHaveBeenCalled();
    expect(mockRefreshPrStatus).not.toHaveBeenCalled();
  });

  test('status with no PRs succeeds without GITHUB_TOKEN', async () => {
    delete process.env.GITHUB_TOKEN;
    currentPlan.pullRequest = [];

    await handlePrCommand.handlePrStatusCommand(248, {}, createNestedCommand());

    expect(logs).toContain('Plan 248 has no linked pull requests and no branch to look up.');
  });

  test('link requires GITHUB_TOKEN', async () => {
    delete process.env.GITHUB_TOKEN;

    await expect(
      handlePrCommand.handlePrLinkCommand(
        248,
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
      248,
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
    mockResolvePlanFromDb.mockImplementationOnce(async () => {
      throw new Error('Plan not found: 999');
    });

    await expect(
      handlePrCommand.handlePrStatusCommand(999, {}, createNestedCommand())
    ).rejects.toThrow('Plan not found: 999');

    expect(mockSyncPlanPrLinks).not.toHaveBeenCalled();
  });

  test('comment posts a standalone PR comment and logs success', async () => {
    currentParsedIdentifier = { owner: 'example', repo: 'repo', number: 701 };

    await handlePrCommand.handlePrCommentCommand(
      'https://github.com/example/repo/pull/701',
      'Fixed related feedback'
    );

    expect(mockPostPullRequestComment).toHaveBeenCalledWith(
      'example',
      'repo',
      701,
      'Fixed related feedback'
    );
    expect(
      logs.some((line) =>
        line.includes(
          'Commented on example/repo#701: https://github.com/example/repo/pull/701#issuecomment-123'
        )
      )
    ).toBe(true);
  });

  test('comment throws when the PR identifier cannot be parsed', async () => {
    currentParsedIdentifier = null;

    await expect(handlePrCommand.handlePrCommentCommand('not-a-pr', 'Comment')).rejects.toThrow(
      'Could not parse pull request identifier: not-a-pr'
    );

    expect(mockPostPullRequestComment).not.toHaveBeenCalled();
  });

  test('resolve resolves the GitHub review thread and logs success', async () => {
    await handlePrCommand.handlePrResolveCommand('thread-456');

    expect(mockResolveReviewThread).toHaveBeenCalledWith('thread-456');
    expect(logs.some((line) => line.includes('Resolved review thread thread-456'))).toBe(true);
  });

  test('resolve throws when resolving the GitHub review thread fails', async () => {
    mockResolveReviewThread.mockResolvedValueOnce(false);

    await expect(handlePrCommand.handlePrResolveCommand('thread-456')).rejects.toThrow(
      'Failed to resolve review thread thread-456'
    );
  });

  test('buildReviewThreadFixPrompt includes fetched review thread comments grouped by PRRT thread ID', () => {
    const prompt = buildReviewThreadFixPrompt(
      {
        id: 251,
        title: 'Review Comment Actions',
        goal: 'Automatically address unresolved review feedback',
        details: 'Keep PR review workflows inside tim.',
      } as any,
      [
        {
          prUrl: 'https://github.com/example/repo/pull/123',
          thread: createReviewThreadDetail({
            threadId: 'thread-123',
            path: 'src/auth.ts',
            line: 42,
            comments: [
              {
                author: 'alice',
                body: 'This logic needs a null check.',
                diff_hunk: '@@ -40,3 +40,4 @@',
              },
              {
                author: 'bob',
                body: 'Please add a test too.',
              },
            ],
          }),
        },
      ]
    );

    expect(prompt).toContain('## Plan Context');
    expect(prompt).toContain('**Plan ID:** 251');
    expect(prompt).toContain('**Title:** Review Comment Actions');
    expect(prompt).toContain('**Goal:** Automatically address unresolved review feedback');
    expect(prompt).toContain('- https://github.com/example/repo/pull/123');
    expect(prompt).toContain('## Unresolved Review Threads');
    expect(prompt).toContain('- PRRT thread ID: thread-123');
    expect(prompt).toContain('This logic needs a null check.');
    expect(prompt).toContain('Please add a test too.');
    expect(prompt).toContain('## Additional PR Feedback');
    expect(prompt).toContain('tim pr comment <PR URL or owner/repo#number> "explanation of fix"');
    expect(prompt).toContain('## User Feedback');
    expect(prompt).toContain('Show the whole contents of each issue/comment');
    expect(prompt).toContain(
      'Ask the user for feedback on which review comments to address and how.'
    );
    expect(prompt).toContain('otherwise wait for direction before implementing fixes');
    expect(prompt).toContain('## GraphQL Review Reply Workflow');
    expect(prompt).toContain('Group addressed threads by PR URL.');
    expect(prompt).toContain('addPullRequestReview(input:{pullRequestId:$pr})');
    expect(prompt).toContain(
      'addPullRequestReviewThreadReply(input:{pullRequestReviewId:$review,pullRequestReviewThreadId:$thread,body:$body})'
    );
    expect(prompt).toContain(
      'submitPullRequestReview(input:{pullRequestReviewId:$review,event:COMMENT})'
    );
    expect(prompt).toContain('Do not leave a pending review unsubmitted.');
    expect(prompt).toContain(
      'Every comment posted to the PR, including review-thread replies and standalone PR comments, must start with `AI Response: `'
    );
    expect(prompt).toContain('Do not mark review comments or threads resolved.');
    expect(prompt).not.toContain('tim pr reply');
    expect(prompt).not.toContain('tim pr resolve <Thread ID>');
    expect(prompt).not.toContain('gh pr view');
  });

  test('buildReviewThreadFixPrompt handles no PR URLs', () => {
    const prompt = buildReviewThreadFixPrompt(
      {
        id: 251,
        title: 'Review Comment Actions',
      } as any,
      []
    );

    expect(prompt).toContain('No unresolved review threads were provided.');
  });

  test('pr fix returns early when there are no unresolved review threads', async () => {
    currentAutoLinkedDetails = [
      {
        ...createPrDetail(701, 'Explicit PR', 'success'),
        reviewThreads: [
          createReviewThreadDetail({
            threadId: 'thread-resolved',
            path: 'src/auth.ts',
            line: 10,
            isResolved: 1,
          }),
        ],
      },
    ];

    await handlePrFixCommand(248, {}, createNestedCommand());

    expect(mockExecutorExecute).not.toHaveBeenCalled();
    expect(logs).toContain('Plan 248 has no unresolved PR review threads.');
  });

  test('pr fix fetches and forwards unresolved review thread details without prompting', async () => {
    currentAutoLinkedDetails = [
      {
        ...createPrDetail(701, 'Explicit PR', 'success'),
        reviewThreads: [
          createReviewThreadDetail({
            threadId: 'thread-1',
            path: 'src/auth.ts',
            line: 42,
            comments: [{ body: 'Add a null check.', diff_hunk: '@@ -40,2 +40,4 @@' }],
          }),
          createReviewThreadDetail({
            threadId: 'thread-2',
            path: 'src/user.ts',
            line: 88,
            comments: [{ body: 'Handle the empty state.' }],
          }),
        ],
      },
    ];

    await handlePrFixCommand(
      248,
      { executor: 'codex-cli', model: LATEST_GPT5_MODEL, terminalInput: true },
      createNestedCommand()
    );

    expect(mockBuildExecutorAndLog).toHaveBeenCalledWith(
      'codex-cli',
      expect.objectContaining({
        model: LATEST_GPT5_MODEL,
        terminalInput: true,
      }),
      expect.any(Object),
      undefined
    );
    expect(mockExecutorExecute).toHaveBeenCalledWith(
      expect.stringContaining('- PRRT thread ID: thread-1'),
      expect.objectContaining({ executionMode: 'planning', planId: '248' })
    );
    const context = String(mockExecutorExecute.mock.calls[0]?.[0] ?? '');
    expect(mockRefreshPrStatus).toHaveBeenCalledWith(
      dbHandle,
      'https://github.com/example/repo/pull/701'
    );
    expect(context).toContain('src/auth.ts:42');
    expect(context).toContain('src/user.ts:88');
    expect(context).toContain('Add a null check.');
    expect(context).toContain('Handle the empty state.');
    expect(context).not.toContain('tim pr resolve');
  });

  test('pr fix uses all unresolved threads without prompting in non-interactive mode', async () => {
    currentAutoLinkedDetails = [
      {
        ...createPrDetail(701, 'Explicit PR', 'success'),
        reviewThreads: [
          createReviewThreadDetail({
            threadId: 'thread-1',
            path: 'src/auth.ts',
            line: 42,
            comments: [{ body: 'Add a null check.' }],
          }),
        ],
      },
    ];

    await handlePrFixCommand(248, { nonInteractive: true }, createNestedCommand());

    expect(mockBuildExecutorAndLog).toHaveBeenCalledWith(
      'claude-code',
      expect.objectContaining({
        noninteractive: true,
        terminalInput: false,
      }),
      expect.any(Object),
      undefined
    );
    expect(mockExecutorExecute).toHaveBeenCalledWith(
      expect.stringContaining('- PRRT thread ID: thread-1'),
      expect.objectContaining({ executionMode: 'planning' })
    );
  });

  test('pr fix wraps execution in HeadlessAdapter with plan metadata', async () => {
    currentAutoLinkedDetails = [
      {
        ...createPrDetail(701, 'Explicit PR', 'success'),
        reviewThreads: [
          createReviewThreadDetail({
            threadId: 'thread-1',
            path: 'src/auth.ts',
            line: 42,
            comments: [{ body: 'Add a null check.' }],
          }),
        ],
      },
    ];

    await handlePrFixCommand(248, {}, createNestedCommand());

    expect(mockRunWithHeadlessAdapterIfEnabled).toHaveBeenCalledTimes(1);
    expect(mockRunWithHeadlessAdapterIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        command: 'pr-fix',
        interactive: true,
        plan: {
          id: 248,
          uuid: 'plan-248',
          title: 'PR status monitoring',
        },
      })
    );
    expect(typeof mockRunWithHeadlessAdapterIfEnabled.mock.calls[0]?.[0].callback).toBe('function');
  });

  test('pr fix keeps headless session interactive when terminal input is disabled', async () => {
    currentAutoLinkedDetails = [
      {
        ...createPrDetail(701, 'Explicit PR', 'success'),
        reviewThreads: [
          createReviewThreadDetail({
            threadId: 'thread-1',
            path: 'src/auth.ts',
            line: 42,
            comments: [{ body: 'Add a null check.' }],
          }),
        ],
      },
    ];

    await handlePrFixCommand(248, { terminalInput: false }, createNestedCommand());

    expect(mockRunWithHeadlessAdapterIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'pr-fix',
        interactive: true,
      })
    );
  });

  test('pr fix marks headless session non-interactive in non-interactive mode', async () => {
    currentAutoLinkedDetails = [
      {
        ...createPrDetail(701, 'Explicit PR', 'success'),
        reviewThreads: [
          createReviewThreadDetail({
            threadId: 'thread-1',
            path: 'src/auth.ts',
            line: 42,
            comments: [{ body: 'Add a null check.' }],
          }),
        ],
      },
    ];

    await handlePrFixCommand(248, { nonInteractive: true }, createNestedCommand());

    expect(mockRunWithHeadlessAdapterIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'pr-fix',
        interactive: false,
      })
    );
  });

  test('pr fix uses auto workspace round trip before executor execution', async () => {
    currentPlan.branch = 'feature/pr-status-monitoring';
    currentAutoLinkedDetails = [
      {
        ...createPrDetail(701, 'Explicit PR', 'success'),
        reviewThreads: [
          createReviewThreadDetail({
            threadId: 'thread-1',
            path: 'src/auth.ts',
            line: 42,
            comments: [{ body: 'Add a null check.' }],
          }),
        ],
      },
    ];
    const roundTripContext = {
      executionWorkspacePath: '/tmp/workspace',
      primaryWorkspacePath: tempDir,
      refName: 'feature/pr-status-monitoring',
      branchCreatedDuringSetup: false,
    };
    mockPrepareWorkspaceRoundTrip.mockResolvedValueOnce(roundTripContext as any);
    mockMaterializePlansForExecution.mockResolvedValueOnce('/tmp/workspace/.tim/plans/248.plan.md');

    await handlePrFixCommand(
      248,
      { autoWorkspace: true, workspaceSync: true },
      createNestedCommand()
    );

    expect(mockSetupWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        autoWorkspace: true,
        planId: 248,
        planUuid: 'plan-248',
        checkoutBranch: 'feature/pr-status-monitoring',
      }),
      expect.any(String),
      currentPlanPath,
      expect.any(Object),
      'tim pr fix'
    );
    expect(mockPrepareWorkspaceRoundTrip).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: '/tmp/workspace',
        workspaceSyncEnabled: true,
        branchCreatedDuringSetup: false,
      })
    );
    expect(mockRunPreExecutionWorkspaceSync).toHaveBeenCalledWith(roundTripContext);
    expect(mockMaterializePlansForExecution).toHaveBeenCalledWith('/tmp/workspace', 248);
    expect(mockBuildExecutorAndLog).toHaveBeenCalledWith(
      'claude-code',
      expect.objectContaining({
        baseDir: '/tmp/workspace',
      }),
      expect.any(Object),
      undefined
    );
    expect(mockExecutorExecute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        planFilePath: '/tmp/workspace/.tim/plans/248.plan.md',
      })
    );
    expect(mockRunPostExecutionWorkspaceSync).toHaveBeenCalledWith(
      roundTripContext,
      'PR review fixes'
    );
    expect(mockTouchWorkspaceInfo).toHaveBeenCalledWith('/tmp/workspace');
  });

  test('pr fix runs lifecycle hooks in pr-fix context for the selected workspace', async () => {
    currentPlan.branch = 'feature/pr-status-monitoring';
    currentWorkspaceInfo = {
      workspaceType: 'auto',
    };
    currentAutoLinkedDetails = [
      {
        ...createPrDetail(701, 'Explicit PR', 'success'),
        reviewThreads: [
          createReviewThreadDetail({
            threadId: 'thread-1',
            path: 'src/auth.ts',
            line: 42,
            comments: [{ body: 'Add a null check.' }],
          }),
        ],
      },
    ];
    mockLoadEffectiveConfig.mockResolvedValueOnce({
      lifecycle: {
        commands: [
          {
            title: 'PR fix setup',
            command: 'pnpm install',
            shutdown: 'pnpm stop',
            runIn: ['pr-fix'],
          },
        ],
      },
    } as any);

    await handlePrFixCommand(248, { autoWorkspace: true }, createNestedCommand());

    expect(lifecycleMocks.ctor).toHaveBeenCalledWith(
      [
        {
          title: 'PR fix setup',
          command: 'pnpm install',
          shutdown: 'pnpm stop',
          runIn: ['pr-fix'],
        },
      ],
      '/tmp/workspace',
      'auto',
      'pr-fix',
      undefined,
      {
        timEnvironment: expect.objectContaining({
          context: expect.objectContaining({
            planId: '248',
            planUuid: 'plan-248',
            planFilePath: '/tmp/workspace/.tim/plans/248.plan.md',
            branch: 'feature/pr-status-monitoring',
            workspacePath: '/tmp/workspace',
          }),
        }),
      }
    );
    expect(lifecycleMocks.startup).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    expect(lifecycleMocks.shutdown).toHaveBeenCalledTimes(1);
  });

  test('pr fix requires GITHUB_TOKEN', async () => {
    delete process.env.GITHUB_TOKEN;
    clearGitHubTokenCache();

    await expect(handlePrFixCommand(248, {}, createNestedCommand())).rejects.toThrow(
      'GITHUB_TOKEN environment variable is required'
    );

    expect(mockResolvePlan).not.toHaveBeenCalled();
    expect(mockExecutorExecute).not.toHaveBeenCalled();
  });

  test('pr fix filters out resolved threads and only passes unresolved ones', async () => {
    currentAutoLinkedDetails = [
      {
        ...createPrDetail(701, 'Explicit PR', 'success'),
        reviewThreads: [
          createReviewThreadDetail({
            threadId: 'thread-resolved',
            path: 'src/old.ts',
            line: 5,
            isResolved: 1,
            comments: [{ body: 'Already fixed.' }],
          }),
          createReviewThreadDetail({
            threadId: 'thread-unresolved',
            path: 'src/new.ts',
            line: 20,
            comments: [{ body: 'Needs fix.' }],
          }),
        ],
      },
    ];

    await handlePrFixCommand(248, {}, createNestedCommand());

    const context = String(mockExecutorExecute.mock.calls[0]?.[0] ?? '');
    expect(context).toContain('https://github.com/example/repo/pull/701');
    expect(context).toContain('src/new.ts:20');
    expect(context).toContain('thread-unresolved');
    expect(context).not.toContain('src/old.ts:5');
    expect(context).not.toContain('thread-resolved');
  });

  test('pr fix collects unresolved threads from multiple PRs', async () => {
    currentAutoLinkedDetails = [
      {
        ...createPrDetail(701, 'PR One', 'success'),
        reviewThreads: [
          createReviewThreadDetail({
            threadId: 'thread-pr1',
            path: 'src/auth.ts',
            line: 10,
            comments: [{ body: 'Fix auth.' }],
          }),
        ],
      },
      {
        ...createPrDetail(702, 'PR Two', 'success'),
        reviewThreads: [
          createReviewThreadDetail({
            threadId: 'thread-pr2',
            path: 'src/user.ts',
            line: 20,
            comments: [{ body: 'Fix user.' }],
          }),
        ],
      },
    ];

    await handlePrFixCommand(248, {}, createNestedCommand());

    const context = String(mockExecutorExecute.mock.calls[0]?.[0] ?? '');
    expect(context).toContain('https://github.com/example/repo/pull/701');
    expect(context).toContain('https://github.com/example/repo/pull/702');
    expect(context).toContain('src/auth.ts:10');
    expect(context).toContain('src/user.ts:20');
  });

  test('pr fix skips prompting when terminalInput is false', async () => {
    currentAutoLinkedDetails = [
      {
        ...createPrDetail(701, 'PR', 'success'),
        reviewThreads: [
          createReviewThreadDetail({
            threadId: 'thread-1',
            path: 'src/auth.ts',
            line: 42,
            comments: [{ body: 'Fix.' }],
          }),
        ],
      },
    ];

    await handlePrFixCommand(248, { terminalInput: false }, createNestedCommand());

    expect(mockExecutorExecute).toHaveBeenCalled();
  });

  test('pr fix canonicalizes explicit plan PR URLs before looking up cached status rows', async () => {
    currentPlan.pullRequest = ['https://github.com/example/repo/pulls/701?tab=checks'];
    mockDeduplicatePrUrls.mockReturnValueOnce({
      valid: ['https://github.com/example/repo/pull/701'],
      invalid: [],
    });
    currentAutoLinkedDetails = [
      {
        ...createPrDetail(701, 'Explicit PR', 'success'),
        reviewThreads: [
          createReviewThreadDetail({
            threadId: 'thread-canonical',
            path: 'src/auth.ts',
            line: 42,
            comments: [{ body: 'Fix this path.' }],
          }),
        ],
      },
    ];

    await handlePrFixCommand(248, {}, createNestedCommand());

    expect(mockDeduplicatePrUrls).toHaveBeenCalledWith([
      'https://github.com/example/repo/pulls/701?tab=checks',
    ]);
    expect(mockGetPrStatusForPlan).toHaveBeenCalledWith(
      dbHandle,
      'plan-248',
      ['https://github.com/example/repo/pull/701'],
      expect.objectContaining({ includeReviewThreads: true })
    );
    expect(mockExecutorExecute).toHaveBeenCalled();
  });

  test('pr fix preserves explicit orchestrator when no --executor value is provided', async () => {
    currentAutoLinkedDetails = [
      {
        ...createPrDetail(701, 'PR', 'success'),
        reviewThreads: [
          createReviewThreadDetail({
            threadId: 'thread-1',
            path: 'src/auth.ts',
            line: 42,
            comments: [{ body: 'Fix.' }],
          }),
        ],
      },
    ];

    await handlePrFixCommand(248, { orchestrator: 'claude-code' }, createNestedCommand());

    expect(mockBuildExecutorAndLog).toHaveBeenCalledWith(
      'claude-code',
      expect.objectContaining({
        model: 'opus',
      }),
      expect.any(Object),
      undefined
    );
  });

  test('pr fix uses configured executor, model, and effort when CLI options are omitted', async () => {
    currentAutoLinkedDetails = [
      {
        ...createPrDetail(701, 'PR', 'success'),
        reviewThreads: [
          createReviewThreadDetail({
            threadId: 'thread-1',
            path: 'src/auth.ts',
            line: 42,
            comments: [{ body: 'Fix.' }],
          }),
        ],
      },
    ];
    mockLoadEffectiveConfig.mockResolvedValueOnce({
      prFix: {
        executor: 'codex-cli',
        model: 'gpt-5-codex',
        effort: 'xhigh',
      },
    } as any);

    await handlePrFixCommand(248, {}, createNestedCommand());

    expect(mockBuildExecutorAndLog).toHaveBeenCalledWith(
      'codex-cli',
      expect.objectContaining({
        model: 'gpt-5-codex',
      }),
      expect.any(Object),
      expect.objectContaining({
        reasoning: expect.objectContaining({ default: 'xhigh' }),
      })
    );
  });

  test('pr fix CLI options override configured executor, model, and effort', async () => {
    currentAutoLinkedDetails = [
      {
        ...createPrDetail(701, 'PR', 'success'),
        reviewThreads: [
          createReviewThreadDetail({
            threadId: 'thread-1',
            path: 'src/auth.ts',
            line: 42,
            comments: [{ body: 'Fix.' }],
          }),
        ],
      },
    ];
    mockLoadEffectiveConfig.mockResolvedValueOnce({
      prFix: {
        executor: 'claude-code',
        model: 'opus',
        effort: 'high',
      },
    } as any);

    await handlePrFixCommand(
      248,
      {
        executor: 'codex-cli',
        model: 'gpt-5-codex',
        effort: 'xhigh',
      },
      createNestedCommand()
    );

    expect(mockBuildExecutorAndLog).toHaveBeenCalledWith(
      'codex-cli',
      expect.objectContaining({
        model: 'gpt-5-codex',
      }),
      expect.any(Object),
      expect.objectContaining({
        reasoning: expect.objectContaining({ default: 'xhigh' }),
      })
    );
  });

  test('buildReviewThreadFixPrompt follows address-review guidance without resolving threads', () => {
    const prompt = buildReviewThreadFixPrompt(
      {
        id: 248,
        title: 'PR status monitoring',
        goal: 'Address review comments',
        branch: '248-pr-status-monitoring',
      } as any,
      [
        {
          prUrl: 'https://github.com/example/repo/pull/701',
          thread: createReviewThreadDetail({
            threadId: 'thread-1',
            path: 'src/auth.ts',
            line: 42,
            comments: [{ body: 'Fix auth.', diff_hunk: '@@ -42,1 +42,1 @@' }],
          }),
        },
      ]
    );

    expect(prompt).toContain('**Branch:** 248-pr-status-monitoring');
    expect(prompt).toContain('Do not mark review comments or threads resolved.');
    expect(prompt).toContain('one pending GraphQL review per PR');
    expect(prompt).toContain('submitPullRequestReview');
    expect(prompt).not.toContain('tim pr reply');
    expect(prompt).not.toContain('tim pr resolve');
    expect(prompt).toContain('https://linear.review');
  });

  test('buildReviewThreadFixPrompt includes branch context without gh fetch instructions', () => {
    const prompt = buildReviewThreadFixPrompt(
      { id: 1, title: 'Test', branch: 'feature/x' } as any,
      [
        {
          prUrl: 'https://github.com/example/repo/pull/1',
          thread: createReviewThreadDetail({
            threadId: 'thread-1',
            path: 'src/file.ts',
            line: 1,
            comments: [{ body: 'Review comment.' }],
          }),
        },
      ]
    );

    expect(prompt).toContain('**Branch:** feature/x');
    expect(prompt).toContain('- PRRT thread ID: thread-1');
    expect(prompt).not.toContain('gh pr view');
  });

  test('buildReviewThreadFixPrompt omits goal line for plan without goal', () => {
    const prompt = buildReviewThreadFixPrompt({ id: 1, title: 'Test', goal: undefined } as any, []);

    expect(prompt).toContain('**Goal:** No goal provided');
  });

  test('buildReviewThreadFixPrompt omits details section for plan without details', () => {
    const prompt = buildReviewThreadFixPrompt(
      { id: 1, title: 'Test', details: undefined } as any,
      []
    );

    expect(prompt).not.toContain('**Details:**');
  });

  test('buildReviewThreadFixPrompt includes multiple threads from different PRs', () => {
    const prompt = buildReviewThreadFixPrompt({ id: 1, title: 'Multi-PR Test' } as any, [
      {
        prUrl: 'https://github.com/example/repo/pull/10',
        thread: createReviewThreadDetail({
          threadId: 'thread-a',
          path: 'src/a.ts',
          line: 1,
          comments: [{ body: 'Fix A.' }],
        }),
      },
      {
        prUrl: 'https://github.com/example/repo/pull/20',
        thread: createReviewThreadDetail({
          threadId: 'thread-b',
          path: 'src/b.ts',
          line: 2,
          comments: [{ body: 'Fix B.' }],
        }),
      },
    ]);

    expect(prompt).toContain('- https://github.com/example/repo/pull/10');
    expect(prompt).toContain('- https://github.com/example/repo/pull/20');
    expect(prompt).toContain('- PRRT thread ID: thread-a');
    expect(prompt).toContain('- PRRT thread ID: thread-b');
    expect(prompt).toContain('Fix A.');
    expect(prompt).toContain('Fix B.');
  });

  // ---------------------------------------------------------------------------
  // resolvePrFixTargetIntent (pure function — no mock interaction)
  // ---------------------------------------------------------------------------

  describe('resolvePrFixTargetIntent', () => {
    test('numeric positional string returns plan mode with parsed planId', () => {
      expect(resolvePrFixTargetIntent('123', {})).toEqual({ mode: 'plan', planId: 123 });
    });

    test('numeric positional number returns plan mode with planId', () => {
      expect(resolvePrFixTargetIntent(123, {})).toEqual({ mode: 'plan', planId: 123 });
    });

    test('--plan option returns plan mode', () => {
      expect(resolvePrFixTargetIntent(undefined, { plan: '456' })).toEqual({
        mode: 'plan',
        planId: 456,
      });
    });

    test('--pr option with number string returns PR mode', () => {
      expect(resolvePrFixTargetIntent(undefined, { pr: '789' })).toEqual({
        mode: 'pr',
        prUrlOrNumber: '789',
      });
    });

    test('--pr option with GitHub URL returns PR mode', () => {
      const url = 'https://github.com/owner/repo/pull/5';
      expect(resolvePrFixTargetIntent(undefined, { pr: url })).toEqual({
        mode: 'pr',
        prUrlOrNumber: url,
      });
    });

    test('GitHub URL positional returns PR mode', () => {
      const url = 'https://github.com/owner/repo/pull/5';
      expect(resolvePrFixTargetIntent(url, {})).toEqual({ mode: 'pr', prUrlOrNumber: url });
    });

    test('owner/repo#number positional returns PR mode', () => {
      expect(resolvePrFixTargetIntent('owner/repo#5', {})).toEqual({
        mode: 'pr',
        prUrlOrNumber: 'owner/repo#5',
      });
    });

    test('positional with slash returns PR mode', () => {
      expect(resolvePrFixTargetIntent('owner/repo', {})).toEqual({
        mode: 'pr',
        prUrlOrNumber: 'owner/repo',
      });
    });

    test('no positional and no options returns plan mode with undefined planId', () => {
      expect(resolvePrFixTargetIntent(undefined, {})).toEqual({ mode: 'plan' });
    });

    test('--current throws with message pointing to tim review --current', () => {
      expect(() => resolvePrFixTargetIntent(undefined, { current: true })).toThrow(
        'tim review --current'
      );
    });

    test('--branch throws with message pointing to tim review --branch', () => {
      expect(() => resolvePrFixTargetIntent(undefined, { branch: 'feature/x' })).toThrow(
        'tim review --branch'
      );
    });

    test('--current beats --pr (still throws)', () => {
      expect(() => resolvePrFixTargetIntent(undefined, { current: true, pr: '123' })).toThrow(
        'tim review --current'
      );
    });

    test('--pr beats numeric positional', () => {
      expect(
        resolvePrFixTargetIntent('123', { pr: 'https://github.com/owner/repo/pull/5' })
      ).toEqual({
        mode: 'pr',
        prUrlOrNumber: 'https://github.com/owner/repo/pull/5',
      });
    });

    test('--pr beats --plan', () => {
      expect(resolvePrFixTargetIntent(undefined, { pr: '5', plan: '123' })).toEqual({
        mode: 'pr',
        prUrlOrNumber: '5',
      });
    });

    test('bogus non-numeric non-url positional throws ambiguity error', () => {
      expect(() => resolvePrFixTargetIntent('notaplan', {})).toThrow('notaplan');
    });

    test('single-word non-numeric non-url like "abc" throws', () => {
      expect(() => resolvePrFixTargetIntent('abc', {})).toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // resolvePrFixTarget — PR mode
  // ---------------------------------------------------------------------------

  describe('resolvePrFixTarget (PR mode)', () => {
    function makePrStatusDetail(
      prNumber: number,
      title: string,
      author: string,
      threads: AnyObject[] = []
    ): AnyObject {
      return {
        ...createPrDetail(prNumber, title, 'success'),
        status: {
          ...createPrDetail(prNumber, title, 'success').status,
          title,
          author,
        },
        reviewThreads: threads,
      };
    }

    test('returns PullRequestFixTarget with PR metadata and no plan fields', async () => {
      currentCachedDetail = makePrStatusDetail(42, 'My PR', 'alice');
      mockGetRepositoryIdentity.mockResolvedValueOnce({
        repositoryId: 'example/repo',
        remoteUrl: 'https://github.com/example/repo.git',
        gitRoot: '/tmp/example-repo',
      });

      const target = await resolvePrFixTarget(
        { mode: 'pr', prUrlOrNumber: '42' },
        createNestedCommand()
      );

      expect(target.kind).toBe('pr');
      const prTarget = target as PullRequestFixTarget;
      expect(prTarget.canonicalPrUrl).toBe('https://github.com/example/repo/pull/42');
      expect(prTarget.prNumber).toBe(42);
      expect(prTarget.owner).toBe('example');
      expect(prTarget.repo).toBe('repo');
      expect(prTarget.baseBranch).toBe('main');
      expect(prTarget.headBranch).toBe('feature/my-pr');
      expect(prTarget.headSha).toBe('abc123def456');
      expect(prTarget.title).toBe('My PR');
      expect(prTarget.author).toBe('alice');
      expect('plan' in prTarget).toBe(false);
      expect('planPath' in prTarget).toBe(false);
      expect('planId' in prTarget).toBe(false);
    });

    test('rejects PR from a different repository', async () => {
      mockGatherPrContext.mockResolvedValueOnce({
        prUrl: 'https://github.com/other/project/pull/99',
        prNumber: 99,
        owner: 'other',
        repo: 'project',
        baseBranch: 'main',
        headBranch: 'feature/other',
        headSha: 'deadbeef',
        prStatus: {},
      } as any);
      mockGetRepositoryIdentity.mockResolvedValueOnce({
        repositoryId: 'example/repo',
        remoteUrl: 'https://github.com/example/repo.git',
        gitRoot: '/tmp/example-repo',
      });

      await expect(
        resolvePrFixTarget({ mode: 'pr', prUrlOrNumber: '99' }, createNestedCommand())
      ).rejects.toThrow(/other\/project.*example\/repo|example\/repo.*other\/project/i);
    });

    test('throws when PR status is not found in DB', async () => {
      currentCachedDetail = null;
      mockGetRepositoryIdentity.mockResolvedValueOnce({
        repositoryId: 'example/repo',
        remoteUrl: 'https://github.com/example/repo.git',
        gitRoot: '/tmp/example-repo',
      });

      await expect(
        resolvePrFixTarget({ mode: 'pr', prUrlOrNumber: '42' }, createNestedCommand())
      ).rejects.toThrow(/Failed to load PR review data/);
    });
  });

  describe('PR fix workspace helpers', () => {
    test('ensurePrFixHeadBranchPushableOnOrigin rejects fork-like PR branches missing on origin', async () => {
      await expect(
        ensurePrFixHeadBranchPushableOnOrigin(
          {
            canonicalPrUrl: 'https://github.com/example/repo/pull/42',
            repoRoot: '/tmp/repo',
            headBranch: 'contributor/fork-branch',
          },
          {
            remoteBranchExists: vi.fn(async () => false),
          }
        )
      ).rejects.toThrow(
        'tim pr fix cannot safely mutate fork PR https://github.com/example/repo/pull/42: head branch "contributor/fork-branch" is not present on origin, so changes cannot be pushed back. Fork PR fix support is not implemented yet.'
      );
    });

    test('ensurePrFixHeadBranchPushableOnOrigin passes when head branch is present on origin', async () => {
      const mockBranchExists = vi.fn(async () => true);

      await expect(
        ensurePrFixHeadBranchPushableOnOrigin(
          {
            canonicalPrUrl: 'https://github.com/example/repo/pull/99',
            repoRoot: '/tmp/repo',
            headBranch: 'feature/my-branch',
          },
          {
            remoteBranchExists: mockBranchExists,
          }
        )
      ).resolves.toBeUndefined();

      expect(mockBranchExists).toHaveBeenCalledWith('/tmp/repo', 'feature/my-branch');
    });

    test('fetchPrFixBaseBranch throws clearly when base fetch fails', async () => {
      await expect(
        fetchPrFixBaseBranch('/tmp/workspace', 'main', {
          fetchRemoteBranch: vi.fn(async () => false),
        })
      ).rejects.toThrow('Failed to fetch base branch "main" for PR fix.');
    });
  });

  // ---------------------------------------------------------------------------
  // handlePrFixCommand — PR mode (no-unresolved-threads and GITHUB_TOKEN)
  // ---------------------------------------------------------------------------

  describe('handlePrFixCommand — PR mode', () => {
    function setupPrModeTarget(threads: AnyObject[] = []) {
      mockGetRepositoryIdentity.mockResolvedValue({
        repositoryId: 'example/repo',
        remoteUrl: 'https://github.com/example/repo.git',
        gitRoot: '/tmp/example-repo',
      });
      currentCachedDetail = {
        ...createPrDetail(42, 'My PR', 'success'),
        status: {
          ...createPrDetail(42, 'My PR', 'success').status,
          title: 'My PR',
          author: 'alice',
        },
        reviewThreads: threads,
      };
    }

    test('logs clear message and does not launch executor when PR has no unresolved threads', async () => {
      setupPrModeTarget([
        createReviewThreadDetail({
          threadId: 'thread-resolved',
          path: 'src/auth.ts',
          line: 10,
          isResolved: 1,
        }),
      ]);

      await handlePrFixCommand(undefined, { pr: '42' }, createNestedCommand());

      expect(mockExecutorExecute).not.toHaveBeenCalled();
      expect(logs.some((l) => l.includes('no unresolved PR review threads'))).toBe(true);
    });

    test('throws when GITHUB_TOKEN is missing, before any PR resolution', async () => {
      delete process.env.GITHUB_TOKEN;
      setupPrModeTarget();

      await expect(
        handlePrFixCommand(undefined, { pr: '42' }, createNestedCommand())
      ).rejects.toThrow(/GITHUB_TOKEN/);

      expect(mockGatherPrContext).not.toHaveBeenCalled();
    });

    test('executes PR target in managed workspace on PR head branch without plan metadata', async () => {
      setupPrModeTarget([
        createReviewThreadDetail({
          threadId: 'thread-1',
          path: 'src/file.ts',
          line: 1,
          comments: [{ body: 'Fix this.' }],
        }),
      ]);
      const roundTripContext = {
        executionWorkspacePath: '/tmp/workspace',
        primaryWorkspacePath: tempDir,
        refName: 'feature/my-pr',
        branchCreatedDuringSetup: false,
      };
      mockPrepareWorkspaceRoundTrip.mockResolvedValueOnce(roundTripContext as any);
      mockGetLinkedPlansByPrUrl.mockReturnValueOnce(
        new Map([
          [
            'https://github.com/example/repo/pull/42',
            [
              {
                planId: 777,
                planUuid: 'plan-777',
                title: 'Linked display plan',
                branch: 'feature/linked',
              },
            ],
          ],
        ])
      );

      await handlePrFixCommand(undefined, { pr: '42' }, createNestedCommand());

      expect(mockRemoteBranchExists).toHaveBeenCalledWith(expect.any(String), 'feature/my-pr');
      expect(mockSetupWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          autoWorkspace: true,
          branchName: 'feature/my-pr',
          checkoutBranch: 'feature/my-pr',
          createBranch: false,
        }),
        expect.any(String),
        undefined,
        expect.any(Object),
        'tim pr fix'
      );
      const workspaceOptions = mockSetupWorkspace.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(workspaceOptions).not.toHaveProperty('planId');
      expect(workspaceOptions).not.toHaveProperty('planUuid');
      expect(mockFetchRemoteBranch).toHaveBeenCalledWith('/tmp/workspace', 'main');
      expect(mockUpdateHeadlessSessionInfo).toHaveBeenCalledWith({
        linkedPrUrl: 'https://github.com/example/repo/pull/42',
        linkedPrNumber: 42,
        linkedPrTitle: 'My PR',
        linkedPlanId: 777,
        linkedPlanUuid: 'plan-777',
        linkedPlanTitle: 'Linked display plan',
        workspacePath: '/tmp/workspace',
      });
      expect(mockMaterializePlansForExecution).not.toHaveBeenCalled();
      expect(mockRunPreExecutionWorkspaceSync).toHaveBeenCalledWith(roundTripContext);
      expect(mockRunPostExecutionWorkspaceSync).toHaveBeenCalledWith(
        roundTripContext,
        'PR review fixes'
      );
      expect(mockBuildExecutorAndLog).toHaveBeenCalledWith(
        'claude-code',
        expect.objectContaining({
          baseDir: '/tmp/workspace',
          timEnvironment: expect.not.objectContaining({
            plan: expect.anything(),
          }),
        }),
        expect.any(Object),
        undefined
      );
      expect(mockExecutorExecute).toHaveBeenCalledWith(
        expect.stringContaining('- PRRT thread ID: thread-1'),
        {
          planId: 'pr-42',
          planTitle: 'My PR',
          executionMode: 'planning',
        }
      );
      expect(mockExecutorExecute.mock.calls[0]?.[1]).not.toHaveProperty('planFilePath');
      expect(logs).not.toContain('Plan 248 has no unresolved PR review threads.');
    });

    test('defaults bare PR target to auto workspace and logs why', async () => {
      setupPrModeTarget([
        createReviewThreadDetail({
          threadId: 'thread-1',
          path: 'src/file.ts',
          line: 1,
          comments: [{ body: 'Fix this.' }],
        }),
      ]);

      await handlePrFixCommand(undefined, { pr: '42' }, createNestedCommand());

      expect(mockSetupWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          autoWorkspace: true,
          branchName: 'feature/my-pr',
          checkoutBranch: 'feature/my-pr',
        }),
        expect.any(String),
        undefined,
        expect.any(Object),
        'tim pr fix'
      );
      expect(logs).toContain(
        'Selecting a managed workspace for PR fix because mutating a PR branch must not use the current checkout.'
      );
    });

    test('rejects --current flag with guidance message', async () => {
      await expect(
        handlePrFixCommand(undefined, { current: true }, createNestedCommand())
      ).rejects.toThrow('tim review --current');
    });

    test('rejects --branch flag with guidance message', async () => {
      await expect(
        handlePrFixCommand(undefined, { branch: 'feature/x' }, createNestedCommand())
      ).rejects.toThrow('tim review --branch');
    });

    test('fork check throws before workspace is allocated when head branch is absent on origin', async () => {
      setupPrModeTarget([
        createReviewThreadDetail({
          threadId: 'thread-fork',
          path: 'src/file.ts',
          line: 1,
          comments: [{ body: 'Fix this.' }],
        }),
      ]);
      mockRemoteBranchExists.mockResolvedValue(false);

      await expect(
        handlePrFixCommand(undefined, { pr: '42' }, createNestedCommand())
      ).rejects.toThrow(
        'tim pr fix cannot safely mutate fork PR https://github.com/example/repo/pull/42: head branch "feature/my-pr" is not present on origin, so changes cannot be pushed back. Fork PR fix support is not implemented yet.'
      );

      expect(mockSetupWorkspace).not.toHaveBeenCalled();
    });

    test('current checkout is not switched: setupWorkspace is called with autoWorkspace true, not on repoRoot directly', async () => {
      setupPrModeTarget([
        createReviewThreadDetail({
          threadId: 'thread-1',
          path: 'src/file.ts',
          line: 1,
          comments: [{ body: 'Fix this.' }],
        }),
      ]);
      const repoRoot = '/tmp/example-repo';

      await handlePrFixCommand(undefined, { pr: '42' }, createNestedCommand());

      const setupCall = mockSetupWorkspace.mock.calls[0];
      expect(setupCall).toBeDefined();
      const workspaceOpts = setupCall?.[0] as Record<string, unknown>;
      // autoWorkspace: true means a managed workspace is selected, not the current checkout
      expect(workspaceOpts).toHaveProperty('autoWorkspace', true);
      // The workspace base dir passed to setupWorkspace is the repoRoot, not a forced current-checkout path
      // The important thing is that no workspace option forces use of the exact repoRoot as working directory
      expect(workspaceOpts).not.toHaveProperty('workspace', repoRoot);
    });

    test('--new-workspace alone still forces a managed workspace (autoWorkspace true)', async () => {
      setupPrModeTarget([
        createReviewThreadDetail({
          threadId: 'thread-1',
          path: 'src/file.ts',
          line: 1,
          comments: [{ body: 'Fix this.' }],
        }),
      ]);

      // Without an explicit --workspace name, PR mode must auto-select a managed
      // workspace even when only --new-workspace is passed; otherwise setupWorkspace's
      // `workspace || autoWorkspace` guard would be skipped and the current checkout
      // would be mutated.
      await handlePrFixCommand(undefined, { pr: '42', newWorkspace: true }, createNestedCommand());

      const workspaceOpts = mockSetupWorkspace.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(workspaceOpts).toHaveProperty('autoWorkspace', true);
      expect(workspaceOpts).toHaveProperty('newWorkspace', true);
    });
  });

  // ---------------------------------------------------------------------------
  // buildPrReviewThreadFixPrompt
  // ---------------------------------------------------------------------------

  describe('buildPrReviewThreadFixPrompt', () => {
    function makePrTarget(overrides: Partial<PullRequestFixTarget> = {}): PullRequestFixTarget {
      return {
        kind: 'pr',
        repoRoot: '/tmp/repo',
        canonicalPrUrl: 'https://github.com/example/repo/pull/42',
        prNumber: 42,
        owner: 'example',
        repo: 'repo',
        title: 'My Pull Request',
        author: 'alice',
        baseBranch: 'main',
        headBranch: 'feature/my-pr',
        headSha: 'abc123def456',
        prStatus: {} as any,
        ...overrides,
      };
    }

    test('includes Pull Request Context section with all fields', () => {
      const prompt = buildPrReviewThreadFixPrompt(makePrTarget(), []);

      expect(prompt).toContain('## Pull Request Context');
      expect(prompt).toContain('**PR URL:** https://github.com/example/repo/pull/42');
      expect(prompt).toContain('**PR Number:** 42');
      expect(prompt).toContain('**Repository:** example/repo');
      expect(prompt).toContain('**Title:** My Pull Request');
      expect(prompt).toContain('**Author:** alice');
      expect(prompt).toContain('**Base Branch:** main');
      expect(prompt).toContain('**Head Branch:** feature/my-pr');
      expect(prompt).toContain('**Head SHA:** abc123def456');
    });

    test('includes no-plan disclaimer', () => {
      const prompt = buildPrReviewThreadFixPrompt(makePrTarget(), []);

      expect(prompt).toContain(
        'No tim plan is associated with this run; do not update plan files, plan tasks, plan status, or plan assignments.'
      );
    });

    test('does NOT contain Plan Context section', () => {
      const prompt = buildPrReviewThreadFixPrompt(makePrTarget(), []);

      expect(prompt).not.toContain('## Plan Context');
      expect(prompt).not.toContain('**Plan ID:**');
    });

    test('omits Author line when author is undefined', () => {
      const prompt = buildPrReviewThreadFixPrompt(makePrTarget({ author: undefined }), []);

      expect(prompt).not.toContain('**Author:**');
    });

    test('uses "No title provided" when title is undefined', () => {
      const prompt = buildPrReviewThreadFixPrompt(makePrTarget({ title: undefined }), []);

      expect(prompt).toContain('**Title:** No title provided');
    });

    test('includes unresolved review thread IDs and comments', () => {
      const threads = [
        {
          prUrl: 'https://github.com/example/repo/pull/42',
          thread: createReviewThreadDetail({
            threadId: 'thread-x',
            path: 'src/auth.ts',
            line: 55,
            comments: [
              { author: 'reviewer', body: 'Needs null check.' },
              { author: 'bot', body: 'And a test.' },
            ],
          }),
        },
      ];

      const prompt = buildPrReviewThreadFixPrompt(makePrTarget(), threads);

      expect(prompt).toContain('## Unresolved Review Threads');
      expect(prompt).toContain('- PRRT thread ID: thread-x');
      expect(prompt).toContain('Needs null check.');
      expect(prompt).toContain('And a test.');
    });

    test('includes GraphQL review reply workflow instructions', () => {
      const prompt = buildPrReviewThreadFixPrompt(makePrTarget(), []);

      expect(prompt).toContain('## GraphQL Review Reply Workflow');
      expect(prompt).toContain('addPullRequestReview(input:{pullRequestId:$pr})');
      expect(prompt).toContain(
        'addPullRequestReviewThreadReply(input:{pullRequestReviewId:$review,pullRequestReviewThreadId:$thread,body:$body})'
      );
      expect(prompt).toContain(
        'submitPullRequestReview(input:{pullRequestReviewId:$review,event:COMMENT})'
      );
      expect(prompt).toContain('Do not leave a pending review unsubmitted.');
    });

    test('includes AI Response prefix requirement', () => {
      const prompt = buildPrReviewThreadFixPrompt(makePrTarget(), []);

      expect(prompt).toContain('must start with `AI Response: `');
    });

    test('includes no-resolve and no-request-review restrictions', () => {
      const prompt = buildPrReviewThreadFixPrompt(makePrTarget(), []);

      expect(prompt).toContain('Do not mark review comments or threads resolved.');
      expect(prompt).toContain('Do not update the status of the issue or PR.');
      expect(prompt).toContain('Do not request or re-request reviews.');
    });

    test('no threads renders empty-thread notice', () => {
      const prompt = buildPrReviewThreadFixPrompt(makePrTarget(), []);

      expect(prompt).toContain('No unresolved review threads were provided.');
    });
  });

  // ---------------------------------------------------------------------------
  // buildReviewThreadFixInstructions (shared helper)
  // ---------------------------------------------------------------------------

  describe('buildReviewThreadFixInstructions', () => {
    test('returns array of strings containing instruction sections', () => {
      const lines = buildReviewThreadFixInstructions([]);

      const joined = lines.join('\n');
      expect(joined).toContain('## Unresolved Review Threads');
      expect(joined).toContain('## GraphQL Review Reply Workflow');
      expect(joined).toContain('## Additional PR Feedback');
      expect(joined).toContain('## User Feedback');
      expect(joined).toContain('AI Response: ');
    });

    test('includes thread details when threads are provided', () => {
      const lines = buildReviewThreadFixInstructions([
        {
          prUrl: 'https://github.com/example/repo/pull/1',
          thread: createReviewThreadDetail({
            threadId: 'shared-thread',
            path: 'src/x.ts',
            line: 10,
            comments: [{ body: 'Shared comment.' }],
          }),
        },
      ]);

      const joined = lines.join('\n');
      expect(joined).toContain('- PRRT thread ID: shared-thread');
      expect(joined).toContain('Shared comment.');
    });
  });

  test('resolve updates local DB cache after successful GitHub mutation', async () => {
    const mockDb = { run: vi.fn() };
    mockGetDatabase.mockReturnValue(mockDb as any);

    await handlePrCommand.handlePrResolveCommand('thread-789');

    expect(mockResolveReviewThread).toHaveBeenCalledWith('thread-789');
    expect(mockDb.run).toHaveBeenCalledWith(
      'UPDATE pr_review_thread SET is_resolved = 1 WHERE thread_id = ?',
      ['thread-789']
    );
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

function createReviewThreadDetail(options: {
  threadId: string;
  path: string;
  line?: number | null;
  originalLine?: number | null;
  startLine?: number | null;
  originalStartLine?: number | null;
  isResolved?: number;
  comments?: Array<{
    author?: string | null;
    body?: string | null;
    diff_hunk?: string | null;
  }>;
}): AnyObject {
  return {
    thread: {
      id: 1,
      pr_status_id: 701,
      thread_id: options.threadId,
      path: options.path,
      line: options.line ?? null,
      original_line: options.originalLine ?? null,
      original_start_line: options.originalStartLine ?? null,
      start_line: options.startLine ?? null,
      diff_side: 'RIGHT',
      start_diff_side: null,
      is_resolved: options.isResolved ?? 0,
      is_outdated: 0,
      subject_type: 'LINE',
    },
    comments: (options.comments ?? []).map((comment, index) => ({
      id: index + 1,
      review_thread_id: 1,
      comment_id: `comment-${index + 1}`,
      database_id: 1000 + index,
      author: comment.author ?? 'reviewer',
      body: comment.body ?? null,
      diff_hunk: comment.diff_hunk ?? null,
      state: null,
      created_at: '2026-03-20T00:00:00.000Z',
    })),
  };
}
