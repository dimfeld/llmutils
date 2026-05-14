import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { clearAllTimCaches } from '../../testing.js';
import { closeDatabaseForTesting } from '../db/database.js';
import { writePlanToDb } from '../plans.js';
import { runProofGeneration, ProofNotConfiguredError } from '../proof/runner.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';
import { handleProofCommand } from './proof.js';

vi.mock('../proof/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../proof/runner.js')>();
  return {
    ...actual,
    runProofGeneration: vi.fn(async () => ({
      runId: 'run-test',
      attachedArtifactUuids: ['art-1'],
      skippedFiles: [],
    })),
  };
});

vi.mock('../workspace/workspace_setup.js', () => ({
  setupWorkspace: vi.fn(async () => ({
    baseDir: '/tmp/fake-workspace',
    branchCreatedDuringSetup: false,
  })),
}));

const PLAN_UUID = '22222222-2222-2222-8222-222222222222';

describe('handleProofCommand', () => {
  let tempDir: string;
  let savedXdgDataHome: string | undefined;
  let originalCwd: string;

  function makeRootCommand(): { parent: { opts: () => { config?: string } } } {
    return {
      parent: {
        opts: () => ({ config: undefined }),
      },
    };
  }

  beforeEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    vi.clearAllMocks();

    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-proof-cli-test-'));

    savedXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = tempDir;

    await Bun.$`git init`.cwd(tempDir).quiet();
    await Bun.$`git remote add origin https://example.com/test/proof-cli-test.git`
      .cwd(tempDir)
      .quiet();

    process.chdir(tempDir);

    await writePlanToDb(
      {
        id: 1,
        uuid: PLAN_UUID,
        title: 'Proof CLI test plan',
        goal: 'Test the proof CLI',
        details: 'Stubbed runner asserts wiring',
        status: 'needs_review',
        tasks: [],
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

    // Also write a .tim/config/tim.yml so loadEffectiveConfig can return something usable.
    await fs.mkdir(path.join(tempDir, '.tim', 'config'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, '.tim', 'config', 'tim.yml'),
      'defaultExecutor: codex-cli\nissueTracker: github\n'
    );
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    clearAllTimCaches();
    closeDatabaseForTesting();
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

  test('requires a plan ID', async () => {
    await expect(handleProofCommand(undefined, {}, makeRootCommand())).rejects.toThrow(
      'A numeric plan ID is required'
    );
  });

  test('throws when plan is not found', async () => {
    await expect(handleProofCommand(9999, {}, makeRootCommand())).rejects.toThrow(/Plan not found/);
  });

  test('invokes setupWorkspace when --auto-workspace is passed', async () => {
    await handleProofCommand(1, { autoWorkspace: true, terminalInput: false }, makeRootCommand());
    expect(setupWorkspace).toHaveBeenCalledTimes(1);
    expect(runProofGeneration).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(runProofGeneration).mock.calls[0][0];
    expect(callArgs.workspacePath).toBe('/tmp/fake-workspace');
    expect(callArgs.gitRoot).toBe('/tmp/fake-workspace');
  });

  test('does not invoke setupWorkspace without --auto-workspace and no configured workspace', async () => {
    await handleProofCommand(1, { terminalInput: false }, makeRootCommand());
    expect(setupWorkspace).not.toHaveBeenCalled();
    expect(runProofGeneration).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(runProofGeneration).mock.calls[0][0];
    const realTempDir = await fs.realpath(tempDir);
    expect(callArgs.gitRoot).toBe(realTempDir);
  });

  test('passes CLI executor and model overrides through to the runner', async () => {
    await handleProofCommand(
      1,
      { executor: 'claude-code', model: 'claude-opus', terminalInput: false },
      makeRootCommand()
    );
    expect(runProofGeneration).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(runProofGeneration).mock.calls[0][0];
    expect(callArgs.executor).toBe('claude-code');
    expect(callArgs.model).toBe('claude-opus');
  });

  test('ProofNotConfiguredError is rewritten to a friendly message mentioning config', async () => {
    vi.mocked(runProofGeneration).mockRejectedValueOnce(new ProofNotConfiguredError());
    await expect(
      handleProofCommand(1, { terminalInput: false }, makeRootCommand())
    ).rejects.toThrow(/proofGeneration/);
  });

  test('non-ProofNotConfiguredError runner failures are surfaced unchanged', async () => {
    vi.mocked(runProofGeneration).mockRejectedValueOnce(new Error('executor exploded'));
    await expect(
      handleProofCommand(1, { terminalInput: false }, makeRootCommand())
    ).rejects.toThrow(/executor exploded/);
  });
});
