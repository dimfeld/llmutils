import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { clearAllTimCaches } from '../../testing.js';
import { closeDatabaseForTesting } from '../db/database.js';
import { getDefaultConfig } from '../configSchema.js';
import { writePlanToDb } from '../plans.js';
import { MAX_ARTIFACT_BYTES } from '../artifacts/constants.js';
import { listArtifactsForPlanUuid } from '../artifacts/service.js';
import type { Executor } from '../executors/types.js';
import { buildExecutorAndLog } from '../executors/index.js';
import { getChangedFilesOnBranch } from '../../common/git.js';
import { ProofNotConfiguredError, ProofRunError, runProofGeneration } from './runner.js';

// Controllable max size for the oversized-file test. Undefined → use real value.
// Must use vi.hoisted so this value is available inside the vi.mock factory (which is hoisted).
const maxBytesState = vi.hoisted(() => ({ override: undefined as number | undefined }));

vi.mock('../artifacts/constants.js', () => ({
  get MAX_ARTIFACT_BYTES() {
    return maxBytesState.override ?? 100 * 1024 * 1024;
  },
}));

vi.mock('../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(),
  DEFAULT_EXECUTOR: 'codex-cli',
  defaultModelForExecutor: vi.fn(() => 'test-model'),
}));

vi.mock('../../common/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/git.js')>();
  return {
    ...actual,
    getChangedFilesOnBranch: vi.fn(async () => []),
  };
});

const PLAN_UUID = '11111111-1111-1111-8111-111111111111';
const PLAN_GOAL = 'Add a widget to the dashboard';
const PLAN_DETAILS = `The widget should display real-time data.

## Manual Testing Runbooks

### Dashboard widget renders
1. Start the web app.
2. Open the dashboard.
3. Confirm the real-time widget is visible.`;
const PLAN_TASKS = [
  {
    uuid: 'aaaa0001-0000-1000-8000-000000000001',
    title: 'Create widget component',
    description: '',
    done: true,
  },
  {
    uuid: 'aaaa0002-0000-1000-8000-000000000002',
    title: 'Wire up data source',
    description: '',
    done: true,
  },
];
const CHANGED_FILES = ['src/components/Widget.svelte', 'src/routes/+page.svelte'];
const PROOF_INSTRUCTIONS =
  'Start dev server with `bun dev`. Use Playwright to capture screenshots.';

describe('runProofGeneration', () => {
  let tempDir: string;
  let proofArtifactsDir: string;
  let savedXdgDataHome: string | undefined;

  const makeLogger = () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  });

  const makeConfig = (instructionsOverride?: string | null) => ({
    ...getDefaultConfig(),
    proofGeneration: {
      instructions:
        instructionsOverride === null ? undefined : (instructionsOverride ?? PROOF_INSTRUCTIONS),
    },
  });

  const makeOptions = (configOverride?: ReturnType<typeof makeConfig>) => ({
    planUuid: PLAN_UUID,
    gitRoot: tempDir,
    workspacePath: tempDir,
    config: configOverride ?? makeConfig(),
    runId: 'run-00000000-0000-0000-0000-000000000001',
    logger: makeLogger(),
  });

  /**
   * Creates a mock executor whose `execute` writes fake files into `targetDir`
   * (defaults to `proofArtifactsDir`) and returns the captured prompt.
   */
  function makeFakeExecutor(options?: { getTargetDir?: () => string; extraFiles?: string[] }): {
    executor: Executor;
    getPrompt: () => string;
  } {
    const { getTargetDir = () => proofArtifactsDir, extraFiles = [] } = options ?? {};
    let capturedPrompt = '';
    const executor: Executor = {
      execute: vi.fn(async (prompt: string) => {
        capturedPrompt = prompt;
        const artDir = getTargetDir();
        await fs.writeFile(path.join(artDir, 'screenshot.png'), 'FAKEPNG');
        await fs.writeFile(path.join(artDir, 'report.md'), '# Proof Report\n\nAll done.');
        for (const file of extraFiles) {
          await fs.writeFile(path.join(artDir, file), 'extra content');
        }
        return undefined;
      }),
    };
    return { executor, getPrompt: () => capturedPrompt };
  }

  beforeEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    vi.resetAllMocks();
    maxBytesState.override = undefined;

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-proof-runner-test-'));
    proofArtifactsDir = path.join(tempDir, '.tim', 'proofs');

    // Redirect artifact storage to the temp dir
    savedXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = tempDir;

    // Set up a minimal git repo so resolveProjectContext / resolvePlanByUuid work
    await Bun.$`git init`.cwd(tempDir).quiet();
    await Bun.$`git remote add origin https://example.com/test/proof-test-repo.git`
      .cwd(tempDir)
      .quiet();

    // Seed a plan into the DB associated with this tempDir repo
    await writePlanToDb(
      {
        id: 1,
        uuid: PLAN_UUID,
        title: 'Proof test plan',
        goal: PLAN_GOAL,
        details: PLAN_DETAILS,
        status: 'needs_review',
        tasks: PLAN_TASKS,
        dependencies: [],
        issue: [],
        docs: [],
        tags: [],
        epic: false,
        temp: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { cwdForIdentity: tempDir, skipUpdatedAt: true }
    );

    // Default mock: changed files
    vi.mocked(getChangedFilesOnBranch).mockResolvedValue(CHANGED_FILES);
  });

  afterEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    maxBytesState.override = undefined;

    // Restore XDG_DATA_HOME
    if (savedXdgDataHome === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = savedXdgDataHome;
    }

    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  // ─── ProofNotConfiguredError ──────────────────────────────────────────────

  test('throws ProofNotConfiguredError when instructions is missing', async () => {
    const config = makeConfig(null);
    await expect(runProofGeneration(makeOptions(config))).rejects.toBeInstanceOf(
      ProofNotConfiguredError
    );
  });

  test('throws ProofNotConfiguredError when instructions is empty/whitespace', async () => {
    const config = makeConfig('   ');
    await expect(runProofGeneration(makeOptions(config))).rejects.toBeInstanceOf(
      ProofNotConfiguredError
    );
  });

  test('throws ProofNotConfiguredError when proofGeneration block is absent', async () => {
    const config = { ...getDefaultConfig() } as ReturnType<typeof makeConfig>;
    delete (config as any).proofGeneration;
    await expect(runProofGeneration(makeOptions(config))).rejects.toBeInstanceOf(
      ProofNotConfiguredError
    );
  });

  // ─── Prompt assembly ─────────────────────────────────────────────────────

  test('prompt contains plan goal, details, task titles, changed files, and instructions', async () => {
    const { executor, getPrompt } = makeFakeExecutor();
    vi.mocked(buildExecutorAndLog).mockReturnValue(executor);

    await runProofGeneration(makeOptions());

    const prompt = getPrompt();
    expect(prompt).toContain(PLAN_GOAL);
    expect(prompt).toContain(PLAN_DETAILS);
    for (const task of PLAN_TASKS) {
      expect(prompt).toContain(task.title);
    }
    for (const file of CHANGED_FILES) {
      expect(prompt).toContain(file);
    }
    expect(prompt).toContain(PROOF_INSTRUCTIONS);
  });

  test('prompt directs executor to create proof for manual testing runbooks', async () => {
    const { executor, getPrompt } = makeFakeExecutor();
    vi.mocked(buildExecutorAndLog).mockReturnValue(executor);

    await runProofGeneration(makeOptions());

    const prompt = getPrompt();
    expect(prompt).toContain('First look for "Manual Testing Runbooks" sections');
    expect(prompt).toContain('create proof for each runbook');
    expect(prompt).toContain('mapping each runbook to the proof you produced');
    expect(prompt).toContain('Dashboard widget renders');
  });

  test('prompt marks tasks with done/not-done state', async () => {
    const { executor, getPrompt } = makeFakeExecutor();
    vi.mocked(buildExecutorAndLog).mockReturnValue(executor);

    await runProofGeneration(makeOptions());

    const prompt = getPrompt();
    // Both tasks are done
    expect(prompt).toContain('[x] Create widget component');
    expect(prompt).toContain('[x] Wire up data source');
  });

  test('prompt notes when no changed files are available', async () => {
    vi.mocked(getChangedFilesOnBranch).mockResolvedValue([]);

    const { executor, getPrompt } = makeFakeExecutor();
    vi.mocked(buildExecutorAndLog).mockReturnValue(executor);

    await runProofGeneration(makeOptions());

    expect(getPrompt()).toContain('(none)');
  });

  test('prompt includes absolute artifacts directory path', async () => {
    const { executor, getPrompt } = makeFakeExecutor();
    vi.mocked(buildExecutorAndLog).mockReturnValue(executor);

    await runProofGeneration(makeOptions());

    const expectedDir = path.resolve(tempDir, '.tim/proofs');
    expect(getPrompt()).toContain(expectedDir);
  });

  // ─── Artifact attachment ──────────────────────────────────────────────────

  test('attaches artifacts with tim-proof:{runId} message', async () => {
    const { executor } = makeFakeExecutor();
    vi.mocked(buildExecutorAndLog).mockReturnValue(executor);

    const runId = 'run-test-attach-00000000-0001';
    const result = await runProofGeneration({ ...makeOptions(), runId });

    expect(result.runId).toBe(runId);
    expect(result.attachedArtifactUuids).toHaveLength(2);
    expect(result.skippedFiles).toHaveLength(0);

    const config = makeConfig();
    const attached = await listArtifactsForPlanUuid({ planUuid: PLAN_UUID, config });
    const notDeleted = attached.filter((a) => !a.deletedAt);
    expect(notDeleted).toHaveLength(2);
    for (const artifact of notDeleted) {
      expect(artifact.message).toBe(`tim-proof:${runId}`);
    }
  });

  // ─── Directory management ─────────────────────────────────────────────────

  test('clears artifacts directory before running executor', async () => {
    // Write a stale file that should be removed before the run
    await fs.mkdir(proofArtifactsDir, { recursive: true });
    const staleFilePath = path.join(proofArtifactsDir, 'stale_file_from_prior_run.png');
    await fs.writeFile(staleFilePath, 'stale content');

    let seenStaleFileAtExecuteTime = false;
    const executor: Executor = {
      execute: vi.fn(async () => {
        try {
          await fs.access(staleFilePath);
          seenStaleFileAtExecuteTime = true;
        } catch {
          // Expected: file was removed before executor runs
        }
        await fs.writeFile(path.join(proofArtifactsDir, 'screenshot.png'), 'FAKEPNG');
        await fs.writeFile(path.join(proofArtifactsDir, 'report.md'), '# Done');
        return undefined;
      }),
    };
    vi.mocked(buildExecutorAndLog).mockReturnValue(executor);

    await runProofGeneration(makeOptions());

    expect(seenStaleFileAtExecuteTime).toBe(false);
  });

  // ─── Rerun idempotency ────────────────────────────────────────────────────

  test('rerun: soft-deletes prior tim-proof artifacts before attaching new ones', async () => {
    // First run
    const run1Id = 'run-00000000-0000-0000-0001';
    const { executor: executor1 } = makeFakeExecutor();
    vi.mocked(buildExecutorAndLog).mockReturnValue(executor1);
    await runProofGeneration({ ...makeOptions(), runId: run1Id });

    // Second run
    const run2Id = 'run-00000000-0000-0000-0002';
    const { executor: executor2 } = makeFakeExecutor();
    vi.mocked(buildExecutorAndLog).mockReturnValue(executor2);
    await runProofGeneration({ ...makeOptions(), runId: run2Id });

    const config = makeConfig();
    const all = await listArtifactsForPlanUuid({
      planUuid: PLAN_UUID,
      config,
      includeDeleted: true,
    });

    // Run 1 artifacts should be soft-deleted
    const run1Artifacts = all.filter((a) => a.message === `tim-proof:${run1Id}`);
    expect(run1Artifacts.length).toBeGreaterThan(0);
    for (const artifact of run1Artifacts) {
      expect(artifact.deletedAt).not.toBeNull();
    }

    // Run 2 artifacts should be active
    const run2Artifacts = all.filter((a) => a.message === `tim-proof:${run2Id}`);
    expect(run2Artifacts.length).toBeGreaterThan(0);
    for (const artifact of run2Artifacts) {
      expect(artifact.deletedAt).toBeNull();
    }
  });

  test('rerun: stale files from prior run are not re-attached in new run', async () => {
    // First run writes an extra file
    const firstRunExtraFile = 'stale_from_run1.png';
    const { executor: executor1 } = makeFakeExecutor({ extraFiles: [firstRunExtraFile] });
    vi.mocked(buildExecutorAndLog).mockReturnValue(executor1);
    await runProofGeneration({ ...makeOptions(), runId: 'run1' });

    // Second run: executor sees an empty dir (stale file cleared) and writes only 2 files
    let filesSeenByExecutor2: string[] = [];
    const executor2: Executor = {
      execute: vi.fn(async () => {
        filesSeenByExecutor2 = await fs.readdir(proofArtifactsDir);
        await fs.writeFile(path.join(proofArtifactsDir, 'screenshot2.png'), 'FAKEPNG2');
        await fs.writeFile(path.join(proofArtifactsDir, 'report.md'), '# Run 2');
        return undefined;
      }),
    };
    vi.mocked(buildExecutorAndLog).mockReturnValue(executor2);
    const result2 = await runProofGeneration({ ...makeOptions(), runId: 'run2' });

    // The stale file from run 1 should NOT be present when executor2 starts
    expect(filesSeenByExecutor2).not.toContain(firstRunExtraFile);

    // Only the 2 fresh files should be attached
    expect(result2.attachedArtifactUuids).toHaveLength(2);
    expect(result2.skippedFiles).toHaveLength(0);
  });

  // ─── Oversized file handling ──────────────────────────────────────────────

  test('skips oversized files and records them in skippedFiles', async () => {
    // Use a tiny MAX_ARTIFACT_BYTES so we can test with real small files
    maxBytesState.override = 10;

    const executor: Executor = {
      execute: vi.fn(async () => {
        // small.png: 5 bytes — should be attached (5 <= 10)
        await fs.writeFile(path.join(proofArtifactsDir, 'small.png'), 'small');
        // huge.webm: 11 bytes — should be skipped (11 > 10)
        await fs.writeFile(path.join(proofArtifactsDir, 'huge.webm'), '12345678901');
        return undefined;
      }),
    };
    vi.mocked(buildExecutorAndLog).mockReturnValue(executor);

    const logger = makeLogger();
    const result = await runProofGeneration({ ...makeOptions(), logger });

    // small.png attached, huge.webm skipped
    expect(result.attachedArtifactUuids).toHaveLength(1);
    expect(result.skippedFiles).toHaveLength(1);
    expect(result.skippedFiles[0].path).toContain('huge.webm');
    expect(result.skippedFiles[0].size).toBe(11);

    // warn should mention the skipped file
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('huge.webm'));
  });

  // ─── Executor failure handling ────────────────────────────────────────────

  test('when executor throws mid-run, already-written files are still attached', async () => {
    const executor: Executor = {
      execute: vi.fn(async () => {
        await fs.writeFile(path.join(proofArtifactsDir, 'partial.png'), 'PARTIAL');
        throw new Error('executor crashed');
      }),
    };
    vi.mocked(buildExecutorAndLog).mockReturnValue(executor);

    const runId = 'run-failure-test';
    await expect(runProofGeneration({ ...makeOptions(), runId })).rejects.toBeInstanceOf(
      ProofRunError
    );

    // partial.png should have been attached despite the failure
    const config = makeConfig();
    const attached = await listArtifactsForPlanUuid({ planUuid: PLAN_UUID, config });
    const notDeleted = attached.filter((a) => !a.deletedAt);
    expect(notDeleted).toHaveLength(1);
    expect(notDeleted[0].message).toBe(`tim-proof:${runId}`);
  });

  test('ProofRunError wraps the original executor error', async () => {
    const originalError = new Error('some tool crashed');
    const executor: Executor = {
      execute: vi.fn(async () => {
        throw originalError;
      }),
    };
    vi.mocked(buildExecutorAndLog).mockReturnValue(executor);

    const caughtError = await runProofGeneration(makeOptions()).catch((e) => e);

    expect(caughtError).toBeInstanceOf(ProofRunError);
    expect(caughtError.cause).toBe(originalError);
    expect(caughtError.message).toContain('some tool crashed');
  });

  test('returns empty result with warning when executor produces no files', async () => {
    const executor: Executor = {
      execute: vi.fn(async () => undefined),
    };
    vi.mocked(buildExecutorAndLog).mockReturnValue(executor);

    const logger = makeLogger();
    const result = await runProofGeneration({ ...makeOptions(), logger });

    expect(result.attachedArtifactUuids).toHaveLength(0);
    expect(result.skippedFiles).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no artifacts'));
  });

  // ─── Executor configuration ───────────────────────────────────────────────

  test('passes executor name from config to buildExecutorAndLog', async () => {
    const config = {
      ...makeConfig(),
      proofGeneration: { ...makeConfig().proofGeneration, executor: 'claude-code' },
    };

    const { executor } = makeFakeExecutor();
    vi.mocked(buildExecutorAndLog).mockReturnValue(executor);

    await runProofGeneration({ ...makeOptions(), config });

    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledWith(
      'claude-code',
      expect.anything(),
      expect.anything()
    );
  });

  test('falls back to DEFAULT_EXECUTOR when no executor configured', async () => {
    const { executor } = makeFakeExecutor();
    vi.mocked(buildExecutorAndLog).mockReturnValue(executor);

    await runProofGeneration(makeOptions());

    // getDefaultConfig() has defaultExecutor: 'claude-code'; that takes precedence over DEFAULT_EXECUTOR
    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledWith(
      'claude-code',
      expect.anything(),
      expect.anything()
    );
  });

  test('CLI executor override takes precedence over config.proofGeneration.executor', async () => {
    const config = {
      ...makeConfig(),
      proofGeneration: { ...makeConfig().proofGeneration, executor: 'claude-code' },
    };
    const { executor } = makeFakeExecutor();
    vi.mocked(buildExecutorAndLog).mockReturnValue(executor);

    await runProofGeneration({ ...makeOptions(), config, executor: 'codex-cli' });

    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledWith(
      'codex-cli',
      expect.anything(),
      expect.anything()
    );
  });

  test('CLI model override is passed to executor options', async () => {
    const { executor } = makeFakeExecutor();
    vi.mocked(buildExecutorAndLog).mockReturnValue(executor);

    await runProofGeneration({ ...makeOptions(), model: 'override-model' });

    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ model: 'override-model' }),
      expect.anything()
    );
  });

  test('terminal input option is passed to executor options', async () => {
    const { executor } = makeFakeExecutor();
    vi.mocked(buildExecutorAndLog).mockReturnValue(executor);

    await runProofGeneration({ ...makeOptions(), terminalInput: false });

    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ terminalInput: false }),
      expect.anything()
    );
  });

  test('passes proof workspace and plan context through tim environment options', async () => {
    const config = {
      ...makeConfig(),
      environment: {
        TIM_PROOF_MARKER: 'proof_{{workspacePath}}_{{planId}}_{{planUuid}}',
      },
    };
    const { executor } = makeFakeExecutor();
    vi.mocked(buildExecutorAndLog).mockReturnValue(executor);

    await runProofGeneration({ ...makeOptions(config), config });

    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        baseDir: tempDir,
        timEnvironment: {
          environment: config.environment,
          context: expect.objectContaining({
            repoPath: tempDir,
            workspacePath: tempDir,
            planId: '1',
            planUuid: PLAN_UUID,
          }),
        },
      }),
      expect.anything()
    );
  });

  // ─── artifacts directory safety ──────────────────────────────────────────

  test('rejects .tim/proofs when it is a symlink pointing outside the workspace', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-proof-outside-'));
    const sentinelPath = path.join(outsideDir, 'sentinel.txt');
    await fs.writeFile(sentinelPath, 'do not delete');

    await fs.mkdir(path.join(tempDir, '.tim'), { recursive: true });
    const linkPath = path.join(tempDir, '.tim', 'proofs');
    await fs.symlink(outsideDir, linkPath, 'dir');

    try {
      await expect(runProofGeneration(makeOptions())).rejects.toThrow(/symlinked component/i);
      await fs.access(sentinelPath);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  test('rejects .tim/proofs when it is a symlink pointing inside the workspace', async () => {
    // Create an in-workspace sibling dir with a sentinel file
    const innerTargetDir = path.join(tempDir, 'src');
    await fs.mkdir(innerTargetDir, { recursive: true });
    const sentinelPath = path.join(innerTargetDir, 'sentinel.txt');
    await fs.writeFile(sentinelPath, 'do not delete');

    // Symlink .tim/proofs → ../src (in-workspace, but unsafe to clear)
    await fs.mkdir(path.join(tempDir, '.tim'), { recursive: true });
    const linkPath = path.join(tempDir, '.tim', 'proofs');
    await fs.symlink(innerTargetDir, linkPath, 'dir');

    await expect(runProofGeneration(makeOptions())).rejects.toThrow(/symlinked component/i);
    // Sentinel still present
    await fs.access(sentinelPath);
  });
});
