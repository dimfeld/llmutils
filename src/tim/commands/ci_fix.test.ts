import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { beforeAll, afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { CleanupRegistry } from '../../common/cleanup_registry.js';
import {
  buildCiFixExecutorOptions,
  buildCiFixPrompt,
  executeCiFixCommand,
  handleCiFixCommand,
} from './ci_fix.js';
import type { PullRequestFixTarget } from './pr.js';

type AnyObject = Record<string, unknown>;

const state = vi.hoisted(() => ({
  target: undefined as AnyObject | undefined,
  refreshedStatus: undefined as AnyObject | undefined,
  selectedChecks: undefined as AnyObject | undefined,
  config: {} as AnyObject,
  db: { name: 'db' } as AnyObject,
  workspaceDir: '',
  collectDestDir: '',
  collectOptions: undefined as AnyObject | undefined,
  collectDirExistsDuringCollect: false,
  staleFileExistsDuringCollect: false,
  cleanupSizeDuringCollect: 0,
  simulateCleanupDuringCollect: false,
  cleanupSizeAfterSimulatedCleanup: 0,
  collectDirExistsAfterSimulatedCleanup: true,
  postSyncLogDirectoryExists: true,
  postSyncCleanupSize: 0,
  executorExecute: vi.fn(async (..._args: unknown[]) => {}),
  lifecycleCtor: vi.fn(),
  lifecycleStartup: vi.fn(async () => {}),
  lifecycleShutdown: vi.fn(async () => {}),
}));

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../logging/tunnel_client.js', () => ({
  isTunnelActive: vi.fn(() => false),
}));

vi.mock('../../common/github/token.js', () => ({
  resolveGitHubToken: vi.fn(() => 'test-token'),
}));

vi.mock('../../common/github/octokit.js', () => ({
  getOctokit: vi.fn(() => ({})),
}));

vi.mock('../../common/github/pr_status_service.js', () => ({
  refreshPrCheckStatus: vi.fn(),
}));

vi.mock('../../common/github/required_check_rollup.js', () => ({
  getRequiredCheckNames: vi.fn(),
}));

vi.mock('../../common/github/select_failing_checks.js', () => ({
  selectFailingChecks: vi.fn(),
}));

vi.mock('../../common/github/workflow_logs.js', () => ({
  collectFailingCheckLogs: vi.fn(),
}));

vi.mock('../db/database.js', () => ({
  getDatabase: vi.fn(() => state.db),
}));

vi.mock('../db/pr_status.js', () => ({
  getLinkedPlansByPrUrl: vi.fn(() => new Map()),
}));

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(),
  DEFAULT_EXECUTOR: 'claude-code',
  defaultModelForExecutor: vi.fn(),
}));

vi.mock('../environment_options.js', () => ({
  buildTimWorkspaceCommandEnvironmentOptionsForPath: vi.fn(() => ({
    context: { workspacePath: state.workspaceDir },
  })),
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
      state.lifecycleCtor(...args);
    }

    startup = state.lifecycleStartup;
    shutdown = state.lifecycleShutdown;
  },
}));

vi.mock('../shutdown_state.js', () => ({
  isShuttingDown: vi.fn(() => false),
}));

vi.mock('../plan_materialize.js', () => ({
  TMP_DIR: path.join('.tim', 'tmp'),
}));

vi.mock('../workspace/workspace_info.js', () => ({
  getWorkspaceInfoByPath: vi.fn(() => ({ workspaceType: 'auto' })),
  touchWorkspaceInfo: vi.fn(),
}));

vi.mock('../workspace/workspace_setup.js', () => ({
  setupWorkspace: vi.fn(),
}));

vi.mock('../workspace/workspace_roundtrip.js', () => ({
  prepareWorkspaceRoundTrip: vi.fn(),
  runPreExecutionWorkspaceSync: vi.fn(),
  runPostExecutionWorkspaceSync: vi.fn(),
}));

vi.mock('./pr.js', () => ({
  ensurePrFixHeadBranchPushableOnOrigin: vi.fn(),
  fetchPrFixBaseBranch: vi.fn(),
  resolvePrFixTarget: vi.fn(),
  resolvePrFixTargetIntent: vi.fn(),
}));

import { log as mockLogFn } from '../../logging.js';
import { resolveGitHubToken as mockResolveGitHubTokenFn } from '../../common/github/token.js';
import { getOctokit as mockGetOctokitFn } from '../../common/github/octokit.js';
import { refreshPrCheckStatus as mockRefreshPrCheckStatusFn } from '../../common/github/pr_status_service.js';
import { getRequiredCheckNames as mockGetRequiredCheckNamesFn } from '../../common/github/required_check_rollup.js';
import { selectFailingChecks as mockSelectFailingChecksFn } from '../../common/github/select_failing_checks.js';
import { collectFailingCheckLogs as mockCollectFailingCheckLogsFn } from '../../common/github/workflow_logs.js';
import { loadEffectiveConfig as mockLoadEffectiveConfigFn } from '../configLoader.js';
import {
  buildExecutorAndLog as mockBuildExecutorAndLogFn,
  defaultModelForExecutor as mockDefaultModelForExecutorFn,
} from '../executors/index.js';
import {
  runWithHeadlessAdapterIfEnabled as mockRunWithHeadlessAdapterIfEnabledFn,
  updateHeadlessSessionInfo as mockUpdateHeadlessSessionInfoFn,
} from '../headless.js';
import { setupWorkspace as mockSetupWorkspaceFn } from '../workspace/workspace_setup.js';
import {
  prepareWorkspaceRoundTrip as mockPrepareWorkspaceRoundTripFn,
  runPostExecutionWorkspaceSync as mockRunPostExecutionWorkspaceSyncFn,
  runPreExecutionWorkspaceSync as mockRunPreExecutionWorkspaceSyncFn,
} from '../workspace/workspace_roundtrip.js';
import { touchWorkspaceInfo as mockTouchWorkspaceInfoFn } from '../workspace/workspace_info.js';
import {
  ensurePrFixHeadBranchPushableOnOrigin as mockEnsurePrFixHeadBranchPushableOnOriginFn,
  fetchPrFixBaseBranch as mockFetchPrFixBaseBranchFn,
  resolvePrFixTarget as mockResolvePrFixTargetFn,
  resolvePrFixTargetIntent as mockResolvePrFixTargetIntentFn,
} from './pr.js';

const mockLog = vi.mocked(mockLogFn);
const mockResolveGitHubToken = vi.mocked(mockResolveGitHubTokenFn);
const mockGetOctokit = vi.mocked(mockGetOctokitFn);
const mockRefreshPrCheckStatus = vi.mocked(mockRefreshPrCheckStatusFn);
const mockGetRequiredCheckNames = vi.mocked(mockGetRequiredCheckNamesFn);
const mockSelectFailingChecks = vi.mocked(mockSelectFailingChecksFn);
const mockCollectFailingCheckLogs = vi.mocked(mockCollectFailingCheckLogsFn);
const mockLoadEffectiveConfig = vi.mocked(mockLoadEffectiveConfigFn);
const mockBuildExecutorAndLog = vi.mocked(mockBuildExecutorAndLogFn);
const mockDefaultModelForExecutor = vi.mocked(mockDefaultModelForExecutorFn);
const mockRunWithHeadlessAdapterIfEnabled = vi.mocked(mockRunWithHeadlessAdapterIfEnabledFn);
const mockUpdateHeadlessSessionInfo = vi.mocked(mockUpdateHeadlessSessionInfoFn);
const mockSetupWorkspace = vi.mocked(mockSetupWorkspaceFn);
const mockPrepareWorkspaceRoundTrip = vi.mocked(mockPrepareWorkspaceRoundTripFn);
const mockRunPreExecutionWorkspaceSync = vi.mocked(mockRunPreExecutionWorkspaceSyncFn);
const mockRunPostExecutionWorkspaceSync = vi.mocked(mockRunPostExecutionWorkspaceSyncFn);
const mockTouchWorkspaceInfo = vi.mocked(mockTouchWorkspaceInfoFn);
const mockEnsurePrFixHeadBranchPushableOnOrigin = vi.mocked(
  mockEnsurePrFixHeadBranchPushableOnOriginFn
);
const mockFetchPrFixBaseBranch = vi.mocked(mockFetchPrFixBaseBranchFn);
const mockResolvePrFixTarget = vi.mocked(mockResolvePrFixTargetFn);
const mockResolvePrFixTargetIntent = vi.mocked(mockResolvePrFixTargetIntentFn);

let tempDir: string;

function makeStatus(): AnyObject {
  return {
    id: 42,
    pr_url: 'https://github.com/example/repo/pull/42',
    owner: 'example',
    repo: 'repo',
    pr_number: 42,
    author: 'alice',
    title: 'Fix CI',
    state: 'open',
    draft: 0,
    mergeable: 'MERGEABLE',
    head_sha: 'abc123def456789',
    base_branch: 'main',
    head_branch: 'feature/ci-fix',
    check_rollup_state: 'failure',
  };
}

function makeDetail(): AnyObject {
  return {
    status: makeStatus(),
    checks: [
      {
        id: 1,
        pr_status_id: 42,
        name: 'unit',
        source: 'check_run',
        status: 'completed',
        conclusion: 'failure',
        details_url: 'https://github.com/example/repo/actions/runs/7/job/8',
        started_at: null,
        completed_at: null,
      },
    ],
    reviews: [],
    reviewRequests: [],
    labels: [],
  };
}

function makeTarget(): PullRequestFixTarget {
  return {
    kind: 'pr',
    repoRoot: tempDir,
    canonicalPrUrl: 'https://github.com/example/repo/pull/42',
    prNumber: 42,
    owner: 'example',
    repo: 'repo',
    title: 'Fix CI',
    author: 'alice',
    baseBranch: 'main',
    headBranch: 'feature/ci-fix',
    headSha: 'abc123def456789',
    prStatus: makeDetail() as any,
  };
}

function makePlanTarget(prStatuses: AnyObject[]): AnyObject {
  return {
    kind: 'plan',
    planId: 401,
    plan: {
      id: 401,
      uuid: 'plan-401',
      title: 'CI fix plan',
    },
    planPath: null,
    repoRoot: tempDir,
    prStatuses,
  };
}

function makePlanPrStatus(prNumber: number): AnyObject {
  const detail = makeDetail();
  detail.status = {
    ...(detail.status as AnyObject),
    pr_number: prNumber,
    pr_url: `https://github.com/example/repo/pull/${prNumber}`,
    title: `Fix CI ${prNumber}`,
  };
  return detail;
}

function makeNestedCommand(): { parent: { parent: { opts: () => { config: string } } } } {
  return {
    parent: {
      parent: {
        opts: () => ({ config: '/tmp/tim.yml' }),
      },
    },
  };
}

function makeManifest(directory: string): AnyObject[] {
  return [
    {
      checkName: 'unit',
      source: 'check_run',
      conclusion: 'failure',
      detailsUrl: 'https://github.com/example/repo/actions/runs/7/job/8',
      logPath: path.join(directory, 'unit.log'),
      failedSteps: ['Run tests'],
      required: true,
    },
  ];
}

describe('tim/commands/ci_fix', () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-ci-fix-command-test-'));
    state.workspaceDir = path.join(tempDir, 'workspace');
    await fs.mkdir(state.workspaceDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    CleanupRegistry['instance'] = undefined;
    state.target = makeTarget() as unknown as AnyObject;
    state.refreshedStatus = makeDetail();
    state.selectedChecks = {
      checks: [
        {
          name: 'unit',
          source: 'check_run',
          status: 'completed',
          conclusion: 'failure',
          details_url: 'https://github.com/example/repo/actions/runs/7/job/8',
          required: true,
        },
      ],
      noRequiredConfig: false,
    };
    state.config = {};
    state.collectDestDir = '';
    state.collectOptions = undefined;
    state.collectDirExistsDuringCollect = false;
    state.staleFileExistsDuringCollect = false;
    state.cleanupSizeDuringCollect = 0;
    state.simulateCleanupDuringCollect = false;
    state.cleanupSizeAfterSimulatedCleanup = 0;
    state.collectDirExistsAfterSimulatedCleanup = true;
    state.postSyncLogDirectoryExists = true;
    state.postSyncCleanupSize = 0;
    state.executorExecute.mockReset();
    state.executorExecute.mockResolvedValue(undefined);
    state.lifecycleCtor.mockReset();
    state.lifecycleStartup.mockReset();
    state.lifecycleStartup.mockResolvedValue(undefined);
    state.lifecycleShutdown.mockReset();
    state.lifecycleShutdown.mockResolvedValue(undefined);

    mockResolveGitHubToken.mockReturnValue('test-token');
    mockResolvePrFixTargetIntent.mockReturnValue({ mode: 'pr', prUrlOrNumber: '42' });
    mockResolvePrFixTarget.mockResolvedValue(state.target as never);
    mockRefreshPrCheckStatus.mockResolvedValue(state.refreshedStatus as never);
    mockGetRequiredCheckNames.mockReturnValue(['unit']);
    mockSelectFailingChecks.mockReturnValue(state.selectedChecks as never);
    mockCollectFailingCheckLogs.mockImplementation(async (options: AnyObject) => {
      state.collectDestDir = String(options.destDir);
      state.collectOptions = options;
      state.collectDirExistsDuringCollect = await fs
        .stat(state.collectDestDir)
        .then(() => true)
        .catch(() => false);
      state.staleFileExistsDuringCollect = await fs
        .stat(path.join(state.collectDestDir, 'stale.log'))
        .then(() => true)
        .catch(() => false);
      state.cleanupSizeDuringCollect = CleanupRegistry.getInstance().size;
      if (state.simulateCleanupDuringCollect) {
        CleanupRegistry.getInstance().executeAll();
        state.cleanupSizeAfterSimulatedCleanup = CleanupRegistry.getInstance().size;
        state.collectDirExistsAfterSimulatedCleanup = await fs
          .stat(state.collectDestDir)
          .then(() => true)
          .catch(() => false);
      }
      return makeManifest(String(options.destDir)) as never;
    });
    mockLoadEffectiveConfig.mockResolvedValue(state.config as never);
    mockDefaultModelForExecutor.mockReturnValue('default-model');
    mockBuildExecutorAndLog.mockReturnValue({ execute: state.executorExecute } as never);
    mockSetupWorkspace.mockResolvedValue({
      baseDir: state.workspaceDir,
      planFile: '',
      branchCreatedDuringSetup: false,
    } as never);
    mockPrepareWorkspaceRoundTrip.mockResolvedValue(null);
    mockRunPreExecutionWorkspaceSync.mockResolvedValue(undefined);
    mockRunPostExecutionWorkspaceSync.mockResolvedValue(undefined);
    mockTouchWorkspaceInfo.mockImplementation(() => {});
    mockEnsurePrFixHeadBranchPushableOnOrigin.mockResolvedValue(undefined);
    mockFetchPrFixBaseBranch.mockResolvedValue(undefined);
    mockGetOctokit.mockReturnValue({} as never);
  });

  test('builds a prompt with required markers, absolute log paths, no-log fallback, and ask-before-fix guidance', () => {
    const logPath = path.join('selected-workspace', '.tim/tmp/ci-fix/unit.log');
    const absoluteLogPath = path.resolve(logPath);
    const prompt = buildCiFixPrompt(
      makeTarget(),
      [
        {
          checkName: 'unit',
          source: 'check_run',
          conclusion: 'failure',
          detailsUrl: 'https://github.com/example/repo/actions/runs/7/job/8',
          logPath,
          failedSteps: ['Run tests'],
          required: true,
        },
        {
          checkName: 'external-ci',
          source: 'status_context',
          conclusion: 'failure',
          detailsUrl: 'https://ci.example.test/build/9',
          logPath: null,
          failedSteps: [],
          required: false,
        },
      ],
      { noRequiredConfig: true }
    );

    expect(prompt).toContain('## Pull Request Context');
    expect(prompt).toContain('## Failing Checks');
    expect(prompt).toContain('**PR URL:** https://github.com/example/repo/pull/42');
    expect(prompt).toContain('**PR Number:** 42');
    expect(prompt).toContain('**Repository:** example/repo');
    expect(prompt).toContain('**Title:** Fix CI');
    expect(prompt).toContain('**Author:** alice');
    expect(prompt).toContain('**Base Branch:** main');
    expect(prompt).toContain('**Head Branch:** feature/ci-fix');
    expect(prompt).toContain('**Head SHA:** abc123def456789');
    expect(prompt).toContain('### 1. unit');
    expect(prompt).toContain('### 2. external-ci');
    expect(prompt).toContain('Scope: REQUIRED');
    expect(prompt).toContain('Scope: not-required');
    expect(prompt).toContain('- Conclusion: failure');
    expect(prompt).toContain('- Failed steps: Run tests');
    expect(prompt).toContain('- Failed steps: None reported');
    expect(prompt).toContain(`Log file: ${absoluteLogPath}`);
    expect(prompt).not.toContain(`Log file: ${logPath}`);
    expect(prompt).toContain('read this file; the tail usually has the error');
    expect(prompt).toContain('No logs available; investigate via https://ci.example.test/build/9');
    expect(prompt).toContain('no log excerpts are included in this prompt');
    expect(prompt).toContain(
      '1. Read every available log and diagnose the root cause of every failing check, whether the check is required or not.'
    );
    expect(prompt).toContain(
      '2. Present a numbered summary of every failure with its diagnosis and a proposed fix.'
    );
    expect(prompt).toContain('Ask the user what to do about each one, waiting for direction');
    expect(prompt).toContain('before making changes');
    expect(prompt).toContain(
      'Apply fixes for the REQUIRED failures only. Apply fixes for not-required failures only if the user asks.'
    );
    expect(prompt).toContain('Run the relevant local checks and tests to verify the fixes.');
    expect(prompt).toContain('Commit the code changes and push them to the pull request branch.');
    expect(prompt).toContain('environmental or flaky');
    expect(prompt).toContain('re-running the check');
    expect(prompt).toContain('jj bookmark set <current-bookmark> -r @-');
    expect(prompt).toContain(
      'Do not edit plan files or change plan tasks, plan status, or plan assignments during this CI-fix run.'
    );
    expect(prompt).not.toContain('No tim plan is associated with this run');
    expect(prompt).toContain('Do not edit plan files in PR mode.');
    expect(prompt).not.toContain('inline log');
  });

  test('states that every failing check is in scope without required-check configuration', () => {
    const prompt = buildCiFixPrompt(makeTarget(), [], { noRequiredConfig: true });

    expect(prompt).toContain(
      'No required-check configuration was found in branch protection or rulesets; all failing checks are in scope.'
    );
  });

  test('returns before workspace and executor allocation when no checks fail', async () => {
    mockSelectFailingChecks.mockReturnValue({ checks: [], noRequiredConfig: false } as never);

    await executeCiFixCommand({
      target: state.target as never,
      options: {},
      config: state.config as never,
      noninteractive: false,
      terminalInputEnabled: true,
    });

    expect(mockRefreshPrCheckStatus).toHaveBeenCalledWith(
      state.db,
      'https://github.com/example/repo/pull/42'
    );
    expect(mockGetRequiredCheckNames).toHaveBeenCalledWith(state.db, state.refreshedStatus.status);
    expect(mockSelectFailingChecks).toHaveBeenCalledWith(state.refreshedStatus.checks, ['unit']);
    expect(mockSetupWorkspace).not.toHaveBeenCalled();
    expect(mockEnsurePrFixHeadBranchPushableOnOrigin).not.toHaveBeenCalled();
    expect(mockBuildExecutorAndLog).not.toHaveBeenCalled();
    expect(mockCollectFailingCheckLogs).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith('No failing checks for PR #42');
    expect(CleanupRegistry.getInstance().size).toBe(0);
  });

  test('proceeds with a plan target that has exactly one linked pull request', async () => {
    state.target = makePlanTarget([makePlanPrStatus(42)]);

    await executeCiFixCommand({
      target: state.target as never,
      options: {},
      config: state.config as never,
      noninteractive: false,
      terminalInputEnabled: true,
    });

    expect(mockRefreshPrCheckStatus).toHaveBeenCalledWith(
      state.db,
      'https://github.com/example/repo/pull/42'
    );
    expect(mockSetupWorkspace).toHaveBeenCalled();
    expect(mockBuildExecutorAndLog).toHaveBeenCalled();
  });

  test('rejects a plan target with no linked pull requests', async () => {
    state.target = makePlanTarget([]);

    await expect(
      executeCiFixCommand({
        target: state.target as never,
        options: {},
        config: state.config as never,
        noninteractive: false,
        terminalInputEnabled: true,
      })
    ).rejects.toThrow('plan has no linked pull requests');

    expect(mockRefreshPrCheckStatus).not.toHaveBeenCalled();
    expect(mockSetupWorkspace).not.toHaveBeenCalled();
    expect(mockBuildExecutorAndLog).not.toHaveBeenCalled();
  });

  test('rejects a plan target with multiple linked pull requests', async () => {
    state.target = makePlanTarget([makePlanPrStatus(42), makePlanPrStatus(43)]);

    await expect(
      executeCiFixCommand({
        target: state.target as never,
        options: {},
        config: state.config as never,
        noninteractive: false,
        terminalInputEnabled: true,
      })
    ).rejects.toThrow('plan has multiple linked pull requests');

    expect(mockRefreshPrCheckStatus).not.toHaveBeenCalled();
    expect(mockSetupWorkspace).not.toHaveBeenCalled();
    expect(mockBuildExecutorAndLog).not.toHaveBeenCalled();
  });

  test.each(['base_branch', 'head_branch', 'head_sha'] as const)(
    'rejects a plan target with incomplete %s metadata',
    async (missingField) => {
      const prStatus = makePlanPrStatus(42);
      prStatus.status = {
        ...(prStatus.status as AnyObject),
        [missingField]: undefined,
      };
      state.target = makePlanTarget([prStatus]);

      await expect(
        executeCiFixCommand({
          target: state.target as never,
          options: {},
          config: state.config as never,
          noninteractive: false,
          terminalInputEnabled: true,
        })
      ).rejects.toThrow('incomplete pull request branch metadata');

      expect(mockRefreshPrCheckStatus).not.toHaveBeenCalled();
      expect(mockSetupWorkspace).not.toHaveBeenCalled();
    }
  );

  test('refreshes checks, creates logs in the selected workspace, and removes them on exit', async () => {
    const roundTripContext = {
      executionWorkspacePath: state.workspaceDir,
      primaryWorkspacePath: tempDir,
      refName: 'feature/ci-fix',
      branchCreatedDuringSetup: false,
    };
    mockPrepareWorkspaceRoundTrip.mockResolvedValue(roundTripContext as never);
    state.config = {
      ciFix: {
        executor: 'codex-cli',
        model: 'config-model',
        effort: 'low',
      },
      lifecycle: {
        commands: [{ title: 'CI setup', command: 'pnpm install', runIn: ['ci-fix'] }],
      },
    };
    mockLoadEffectiveConfig.mockResolvedValue(state.config as never);

    const staleDirectory = path.join(state.workspaceDir, '.tim/tmp/ci-fix/pr-42-oldsha');
    const unrelatedDirectory = path.join(state.workspaceDir, '.tim/tmp/ci-fix/pr-43-oldsha');
    await fs.mkdir(staleDirectory, { recursive: true });
    await fs.writeFile(path.join(staleDirectory, 'stale.log'), 'stale');
    await fs.mkdir(unrelatedDirectory, { recursive: true });
    await fs.writeFile(path.join(unrelatedDirectory, 'keep.log'), 'keep');

    await executeCiFixCommand({
      target: state.target as never,
      options: {},
      config: state.config as never,
      noninteractive: true,
      terminalInputEnabled: false,
    });

    expect(mockEnsurePrFixHeadBranchPushableOnOrigin).toHaveBeenCalledWith(
      expect.objectContaining({ headSha: 'abc123def456789' })
    );
    expect(mockSetupWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        autoWorkspace: true,
        branchName: 'feature/ci-fix',
        checkoutBranch: 'feature/ci-fix',
        createBranch: false,
      }),
      tempDir,
      undefined,
      state.config,
      'tim pr fix-ci'
    );
    expect(mockRunPreExecutionWorkspaceSync).toHaveBeenCalledWith(roundTripContext);
    expect(mockFetchPrFixBaseBranch).toHaveBeenCalledWith(state.workspaceDir, 'main');
    expect(state.collectDirExistsDuringCollect).toBe(true);
    expect(state.staleFileExistsDuringCollect).toBe(false);
    expect(state.collectDestDir).toBe(
      path.join(state.workspaceDir, '.tim/tmp/ci-fix/pr-42-abc123def456')
    );
    expect(path.isAbsolute(state.collectDestDir)).toBe(true);
    expect(state.cleanupSizeDuringCollect).toBe(1);
    expect(state.collectOptions).toEqual(
      expect.objectContaining({
        owner: 'example',
        repo: 'repo',
        headSha: 'abc123def456789',
        destDir: state.collectDestDir,
        failingChecks: [
          expect.objectContaining({
            name: 'unit',
            source: 'check_run',
            conclusion: 'failure',
            detailsUrl: 'https://github.com/example/repo/actions/runs/7/job/8',
            required: true,
          }),
        ],
      })
    );
    expect(mockGetOctokit).toHaveBeenCalledTimes(1);
    expect(mockBuildExecutorAndLog).toHaveBeenCalledWith(
      'codex-cli',
      expect.objectContaining({
        baseDir: state.workspaceDir,
        model: 'config-model',
        noninteractive: true,
        terminalInput: false,
      }),
      state.config,
      expect.objectContaining({ reasoning: { default: 'low' } })
    );
    expect(state.executorExecute).toHaveBeenCalledWith(
      expect.stringContaining(`Log file: ${path.join(state.collectDestDir, 'unit.log')}`),
      {
        planId: 'pr-42-ci',
        planTitle: 'Fix CI',
        executionMode: 'planning',
      }
    );
    expect(state.lifecycleCtor).toHaveBeenCalledWith(
      state.config.lifecycle.commands,
      state.workspaceDir,
      'auto',
      'ci-fix',
      undefined,
      expect.any(Object)
    );
    expect(state.lifecycleStartup).toHaveBeenCalledTimes(1);
    expect(state.lifecycleShutdown).toHaveBeenCalledTimes(1);
    expect(mockRunPostExecutionWorkspaceSync).toHaveBeenCalledWith(roundTripContext, 'CI fixes');
    expect(mockTouchWorkspaceInfo).toHaveBeenCalledWith(state.workspaceDir);
    expect(await fs.stat(staleDirectory).catch(() => null)).toBeNull();
    expect(
      await fs.stat(path.join(unrelatedDirectory, 'keep.log')).catch(() => null)
    ).not.toBeNull();
    expect(CleanupRegistry.getInstance().size).toBe(0);
  });

  test('passes every failing check to log collection and widens scope without required configuration', async () => {
    state.selectedChecks = {
      checks: [
        {
          name: 'unit',
          source: 'check_run',
          status: 'completed',
          conclusion: 'failure',
          details_url: 'https://github.com/example/repo/actions/runs/7/job/8',
          required: false,
        },
        {
          name: 'external-ci',
          source: 'status_context',
          status: 'completed',
          conclusion: 'error',
          details_url: 'https://ci.example.test/build/9',
          required: false,
        },
      ],
      noRequiredConfig: true,
    };
    mockSelectFailingChecks.mockReturnValue(state.selectedChecks as never);

    await executeCiFixCommand({
      target: state.target as never,
      options: {},
      config: state.config as never,
      noninteractive: false,
      terminalInputEnabled: true,
    });

    expect(state.collectOptions).toEqual(
      expect.objectContaining({
        failingChecks: [
          expect.objectContaining({
            name: 'unit',
            required: true,
          }),
          expect.objectContaining({
            name: 'external-ci',
            required: true,
          }),
        ],
      })
    );
    expect(state.executorExecute).toHaveBeenCalledWith(
      expect.stringContaining(
        'No required-check configuration was found in branch protection or rulesets; all failing checks are in scope.'
      ),
      expect.anything()
    );
  });

  test('removes CI fix logs and unregisters cleanup before post-execution sync', async () => {
    const roundTripContext = {
      executionWorkspacePath: state.workspaceDir,
      primaryWorkspacePath: tempDir,
      refName: 'feature/ci-fix',
      branchCreatedDuringSetup: false,
    };
    mockPrepareWorkspaceRoundTrip.mockResolvedValue(roundTripContext as never);
    mockRunPostExecutionWorkspaceSync.mockImplementationOnce(async () => {
      state.postSyncLogDirectoryExists = await fs
        .stat(state.collectDestDir)
        .then(() => true)
        .catch(() => false);
      state.postSyncCleanupSize = CleanupRegistry.getInstance().size;
    });

    await executeCiFixCommand({
      target: state.target as never,
      options: {},
      config: state.config as never,
      noninteractive: false,
      terminalInputEnabled: true,
    });

    expect(state.postSyncLogDirectoryExists).toBe(false);
    expect(state.postSyncCleanupSize).toBe(0);
    expect(mockRunPostExecutionWorkspaceSync).toHaveBeenCalledWith(roundTripContext, 'CI fixes');
  });

  test('CLI options override ciFix executor, model, and effort configuration', async () => {
    state.config = {
      ciFix: {
        executor: 'codex-cli',
        model: 'config-model',
        effort: 'low',
      },
    };
    mockLoadEffectiveConfig.mockResolvedValue(state.config as never);

    await executeCiFixCommand({
      target: state.target as never,
      options: {
        executor: 'claude-code',
        model: 'cli-model',
        effort: 'high',
      },
      config: state.config as never,
      noninteractive: false,
      terminalInputEnabled: true,
    });

    expect(mockBuildExecutorAndLog).toHaveBeenCalledWith(
      'claude-code',
      expect.objectContaining({ model: 'cli-model' }),
      state.config,
      { reasoningEffort: 'high' }
    );
  });

  test('uses ciFix configuration before global executor and model defaults', async () => {
    state.config = {
      defaultExecutor: 'claude-code',
      models: { execution: 'global-model' },
      ciFix: {
        executor: 'codex-cli',
        model: 'ci-fix-model',
        effort: 'low',
      },
    };

    await executeCiFixCommand({
      target: state.target as never,
      options: {},
      config: state.config as never,
      noninteractive: false,
      terminalInputEnabled: true,
    });

    expect(mockBuildExecutorAndLog).toHaveBeenCalledWith(
      'codex-cli',
      expect.objectContaining({ model: 'ci-fix-model' }),
      state.config,
      expect.objectContaining({ reasoning: { default: 'low' } })
    );
    expect(mockDefaultModelForExecutor).not.toHaveBeenCalled();
  });

  test('uses global defaults before executor-specific fallbacks', async () => {
    state.config = {
      defaultExecutor: 'codex-cli',
      models: { execution: 'global-model' },
    };

    await executeCiFixCommand({
      target: state.target as never,
      options: {},
      config: state.config as never,
      noninteractive: false,
      terminalInputEnabled: true,
    });

    expect(mockBuildExecutorAndLog).toHaveBeenCalledWith(
      'codex-cli',
      expect.objectContaining({ model: 'global-model' }),
      state.config,
      undefined
    );
    expect(mockDefaultModelForExecutor).not.toHaveBeenCalled();
  });

  test('falls back to the built-in executor and model defaults', async () => {
    await executeCiFixCommand({
      target: state.target as never,
      options: {},
      config: state.config as never,
      noninteractive: false,
      terminalInputEnabled: true,
    });

    expect(mockBuildExecutorAndLog).toHaveBeenCalledWith(
      'claude-code',
      expect.objectContaining({ model: 'default-model' }),
      state.config,
      undefined
    );
    expect(mockDefaultModelForExecutor).toHaveBeenCalledWith('claude-code', 'execution');
  });

  test('registers and unregisters log cleanup even when executor execution fails', async () => {
    state.executorExecute.mockRejectedValueOnce(new Error('executor failed'));

    await expect(
      executeCiFixCommand({
        target: state.target as never,
        options: {},
        config: state.config as never,
        noninteractive: false,
        terminalInputEnabled: true,
      })
    ).rejects.toThrow('executor failed');

    expect(state.cleanupSizeDuringCollect).toBe(1);
    expect(CleanupRegistry.getInstance().size).toBe(0);
    expect(
      await fs.stat(path.join(state.workspaceDir, '.tim/tmp/ci-fix')).catch(() => null)
    ).not.toBe(null);
    expect(await fs.stat(state.collectDestDir).catch(() => null)).toBeNull();
  });

  test('cleanup registry handler removes the log directory during an interrupted run', async () => {
    state.simulateCleanupDuringCollect = true;

    await executeCiFixCommand({
      target: state.target as never,
      options: {},
      config: state.config as never,
      noninteractive: false,
      terminalInputEnabled: true,
    });

    expect(state.collectDirExistsDuringCollect).toBe(true);
    expect(state.cleanupSizeDuringCollect).toBe(1);
    expect(state.cleanupSizeAfterSimulatedCleanup).toBe(0);
    expect(state.collectDirExistsAfterSimulatedCleanup).toBe(false);
    expect(CleanupRegistry.getInstance().size).toBe(0);
  });

  test('wraps execution with the ci-fix headless command and PR metadata', async () => {
    mockSelectFailingChecks.mockReturnValue({ checks: [], noRequiredConfig: false } as never);
    const command = makeNestedCommand();

    await handleCiFixCommand(undefined, { pr: '42' }, command);

    expect(mockResolvePrFixTargetIntent).toHaveBeenCalledWith(undefined, { pr: '42' });
    expect(mockResolvePrFixTarget).toHaveBeenCalledWith(
      { mode: 'pr', prUrlOrNumber: '42' },
      command
    );
    expect(mockLoadEffectiveConfig).toHaveBeenCalledWith('/tmp/tim.yml');
    expect(mockRunWithHeadlessAdapterIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'ci-fix',
        interactive: true,
        sessionInfo: {
          linkedPrUrl: 'https://github.com/example/repo/pull/42',
          linkedPrNumber: 42,
          linkedPrTitle: 'Fix CI',
        },
      })
    );
    expect(mockSetupWorkspace).not.toHaveBeenCalled();
  });

  test('includes plan and linked PR metadata in a plan-target headless session', async () => {
    state.target = makePlanTarget([makePlanPrStatus(42)]);
    mockResolvePrFixTargetIntent.mockReturnValueOnce({ mode: 'plan', planId: 401 });
    mockResolvePrFixTarget.mockResolvedValueOnce(state.target as never);
    mockSelectFailingChecks.mockReturnValueOnce({ checks: [], noRequiredConfig: false } as never);

    await handleCiFixCommand(401, {}, makeNestedCommand());

    expect(mockRunWithHeadlessAdapterIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'ci-fix',
        plan: {
          id: 401,
          uuid: 'plan-401',
          title: 'CI fix plan',
        },
        sessionInfo: {
          linkedPrUrl: 'https://github.com/example/repo/pull/42',
          linkedPrNumber: 42,
          linkedPrTitle: 'Fix CI 42',
        },
      })
    );
  });

  test('rejects a fork before workspace allocation', async () => {
    mockEnsurePrFixHeadBranchPushableOnOrigin.mockRejectedValueOnce(
      new Error('cannot safely mutate fork PR')
    );

    await expect(
      executeCiFixCommand({
        target: state.target as never,
        options: {},
        config: state.config as never,
        noninteractive: false,
        terminalInputEnabled: true,
      })
    ).rejects.toThrow('cannot safely mutate fork PR');

    expect(mockSetupWorkspace).not.toHaveBeenCalled();
    expect(mockCollectFailingCheckLogs).not.toHaveBeenCalled();
    expect(mockBuildExecutorAndLog).not.toHaveBeenCalled();
  });

  test('requires a GitHub token before resolving the target', async () => {
    mockResolveGitHubToken.mockReturnValueOnce(undefined);

    await expect(handleCiFixCommand(undefined, { pr: '42' }, makeNestedCommand())).rejects.toThrow(
      'GITHUB_TOKEN'
    );

    expect(mockResolvePrFixTarget).not.toHaveBeenCalled();
    expect(mockRunWithHeadlessAdapterIfEnabled).not.toHaveBeenCalled();
  });

  test('propagates cross-repository target refusal before starting headless execution', async () => {
    const prUrl = 'https://github.com/other/repo/pull/42';
    mockResolvePrFixTargetIntent.mockReturnValueOnce({ mode: 'pr', prUrlOrNumber: prUrl });
    mockResolvePrFixTarget.mockRejectedValueOnce(new Error('repository mismatch'));

    await expect(handleCiFixCommand(undefined, { pr: prUrl }, makeNestedCommand())).rejects.toThrow(
      'repository mismatch'
    );

    expect(mockResolvePrFixTarget).toHaveBeenCalledWith(
      { mode: 'pr', prUrlOrNumber: prUrl },
      expect.anything()
    );
    expect(mockRunWithHeadlessAdapterIfEnabled).not.toHaveBeenCalled();
    expect(mockSetupWorkspace).not.toHaveBeenCalled();
  });

  test('maps effort to executor-specific options', () => {
    expect(buildCiFixExecutorOptions('claude-code', 'max', {} as never)).toEqual({
      reasoningEffort: 'max',
    });
    expect(buildCiFixExecutorOptions('codex-cli', 'xhigh', {} as never)).toEqual({
      reasoning: { default: 'xhigh' },
    });
    expect(buildCiFixExecutorOptions('other', 'high', {} as never)).toBeUndefined();
  });
});
