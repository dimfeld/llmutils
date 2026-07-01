import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../headless.js', () => ({
  runWithHeadlessAdapterIfEnabled: vi.fn(async (options: any) => options.callback()),
  updateHeadlessSessionInfo: vi.fn(),
}));

vi.mock('../../logging/tunnel_client.js', () => ({
  isTunnelActive: vi.fn(() => false),
}));

vi.mock('../plan_repo_root.js', () => ({
  resolveRepoRoot: vi.fn(),
}));

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(),
  DEFAULT_EXECUTOR: 'claude-code',
}));

vi.mock('../workspace/workspace_setup.js', () => ({
  setupWorkspace: vi.fn(),
}));

vi.mock('../workspace/workspace_roundtrip.js', () => ({
  prepareWorkspaceRoundTrip: vi.fn(),
  runPreExecutionWorkspaceSync: vi.fn(async () => {}),
  runPostExecutionWorkspaceSync: vi.fn(async () => {}),
  materializePlansForExecution: vi.fn(async () => undefined),
}));

vi.mock('../workspace/workspace_info.js', () => ({
  getWorkspaceInfoByPath: vi.fn(() => null),
  patchWorkspaceInfo: vi.fn(),
  touchWorkspaceInfo: vi.fn(),
}));

vi.mock('../plan_file_watcher.js', () => ({
  watchPlanFile: vi.fn(() => ({ close: vi.fn(), closeAndFlush: vi.fn() })),
}));

import { handleChatCommand } from './chat.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { buildExecutorAndLog } from '../executors/index.js';
import { resolveRepoRoot } from '../plan_repo_root.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';
import { prepareWorkspaceRoundTrip } from '../workspace/workspace_roundtrip.js';
import { closeDatabaseForTesting } from '../db/database.js';
import { writePlanToDb } from '../plans.js';
import { addArtifactByPlanUuid } from '../artifacts/service.js';
import { buildReferenceArtifactMessage } from '../artifacts/reference.js';
import { REFERENCE_ARTIFACTS_DIR } from '../reference_artifacts.js';

describe('tim chat reference artifacts integration', () => {
  let tempDir: string;
  let repoRoot: string;
  let workspaceDir: string;
  let originalXdgConfigHome: string | undefined;
  const mockExecutorExecute = vi.fn(async () => {});

  beforeEach(async () => {
    tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'tim-chat-reference-artifacts-'))
    );
    repoRoot = path.join(tempDir, 'repo');
    workspaceDir = path.join(repoRoot, 'workspaces', 'task-1');
    await fs.mkdir(repoRoot, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    await Bun.$`git init`.cwd(repoRoot).quiet();

    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'config');
    closeDatabaseForTesting();

    vi.clearAllMocks();
    mockExecutorExecute.mockClear();

    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: undefined,
      terminalInput: false,
    } as any);
    vi.mocked(isTunnelActive).mockReturnValue(false);
    vi.mocked(resolveRepoRoot).mockResolvedValue(repoRoot);
    vi.mocked(buildExecutorAndLog).mockReturnValue({
      execute: mockExecutorExecute,
      filePathPrefix: '',
    } as any);
    vi.mocked(setupWorkspace).mockResolvedValue({
      baseDir: workspaceDir,
      planFile: '',
      workspaceTaskId: 'task-1',
      isNewWorkspace: false,
    } as any);
    vi.mocked(prepareWorkspaceRoundTrip).mockResolvedValue({
      executionWorkspacePath: workspaceDir,
    } as any);
  });

  afterEach(async () => {
    closeDatabaseForTesting();
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('materializes reference artifacts into the workspace and notes them in the chat prompt', async () => {
    const plan = await writePlanToDb(
      {
        id: 42,
        title: 'Chat reference artifact plan',
        goal: 'goal',
        details: 'details',
        status: 'pending',
        branch: 'chat-reference-artifacts',
        tasks: [],
      },
      { cwdForIdentity: repoRoot }
    );
    if (!plan.uuid) {
      throw new Error('Test plan was written without a uuid');
    }

    const sourcePath = path.join(tempDir, 'chat-spec.md');
    await fs.writeFile(sourcePath, 'chat reference artifact content');
    await addArtifactByPlanUuid({
      planUuid: plan.uuid,
      sourcePath,
      originalFilename: 'chat-spec.md',
      message: buildReferenceArtifactMessage('chat spec'),
    });

    await handleChatCommand(
      'Help with the chat session',
      { plan: 42, workspace: 'task-1', nonInteractive: true, terminalInput: false },
      {}
    );

    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    const executedPrompt = mockExecutorExecute.mock.calls[0][0] as string;

    const expectedRelativePath = path.join(REFERENCE_ARTIFACTS_DIR, '42', 'chat-spec.md');
    expect(executedPrompt).toContain('## Reference Artifacts');
    expect(executedPrompt).toContain(expectedRelativePath);
    expect(executedPrompt).toContain('present at these');
    expect(executedPrompt).toContain('Help with the chat session');

    // Reference artifacts materialize into the git root of the workspace, not the
    // workspace subdirectory itself (matching the execution-path materializer).
    const materializedContent = await fs.readFile(
      path.join(repoRoot, expectedRelativePath),
      'utf8'
    );
    expect(materializedContent).toBe('chat reference artifact content');
  });

  test('omits the reference-artifacts note when the plan has none', async () => {
    const plan = await writePlanToDb(
      {
        id: 43,
        title: 'Chat plan without reference artifacts',
        goal: 'goal',
        details: 'details',
        status: 'pending',
        branch: 'chat-no-reference-artifacts',
        tasks: [],
      },
      { cwdForIdentity: repoRoot }
    );
    expect(plan.uuid).toBeTruthy();

    await handleChatCommand(
      'Help with the chat session',
      { plan: 43, workspace: 'task-1', nonInteractive: true, terminalInput: false },
      {}
    );

    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    const executedPrompt = mockExecutorExecute.mock.calls[0][0] as string;

    expect(executedPrompt).not.toContain('## Reference Artifacts');
    expect(executedPrompt).toBe('Help with the chat session');

    await expect(fs.stat(path.join(repoRoot, REFERENCE_ARTIFACTS_DIR, '43'))).rejects.toMatchObject(
      { code: 'ENOENT' }
    );
  });

  test('does not materialize or note reference artifacts when no plan is attached', async () => {
    vi.mocked(prepareWorkspaceRoundTrip).mockResolvedValue({
      executionWorkspacePath: workspaceDir,
    } as any);

    await handleChatCommand(
      'Plain chat without a plan',
      { workspace: 'task-1', nonInteractive: true, terminalInput: false },
      {}
    );

    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    const executedPrompt = mockExecutorExecute.mock.calls[0][0] as string;
    expect(executedPrompt).toBe('Plain chat without a plan');

    await expect(fs.stat(path.join(repoRoot, REFERENCE_ARTIFACTS_DIR))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  test('inherits ancestor reference artifacts for a subplan attached to chat', async () => {
    const parentPlan = await writePlanToDb(
      {
        id: 44,
        title: 'Parent plan',
        goal: 'goal',
        details: 'details',
        status: 'pending',
        tasks: [],
      },
      { cwdForIdentity: repoRoot }
    );
    if (!parentPlan.uuid) {
      throw new Error('Parent plan was written without a uuid');
    }

    const childPlan = await writePlanToDb(
      {
        id: 45,
        title: 'Child plan',
        goal: 'goal',
        details: 'details',
        status: 'pending',
        parent: 44,
        branch: 'chat-child-reference-artifacts',
        tasks: [],
      },
      { cwdForIdentity: repoRoot }
    );
    if (!childPlan.uuid) {
      throw new Error('Child plan was written without a uuid');
    }

    const parentSourcePath = path.join(tempDir, 'parent-design.md');
    await fs.writeFile(parentSourcePath, 'parent design content');
    await addArtifactByPlanUuid({
      planUuid: parentPlan.uuid,
      sourcePath: parentSourcePath,
      originalFilename: 'parent-design.md',
      message: buildReferenceArtifactMessage('parent design'),
    });

    const childSourcePath = path.join(tempDir, 'child-notes.md');
    await fs.writeFile(childSourcePath, 'child notes content');
    await addArtifactByPlanUuid({
      planUuid: childPlan.uuid,
      sourcePath: childSourcePath,
      originalFilename: 'child-notes.md',
      message: buildReferenceArtifactMessage('child notes'),
    });

    await handleChatCommand(
      'Help with the child plan',
      { plan: 45, workspace: 'task-1', nonInteractive: true, terminalInput: false },
      {}
    );

    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    const executedPrompt = mockExecutorExecute.mock.calls[0][0] as string;

    const parentRelativePath = path.join(REFERENCE_ARTIFACTS_DIR, '45', 'parent-design.md');
    const childRelativePath = path.join(REFERENCE_ARTIFACTS_DIR, '45', 'child-notes.md');
    expect(executedPrompt).toContain(parentRelativePath);
    expect(executedPrompt).toContain(childRelativePath);

    await expect(fs.readFile(path.join(repoRoot, parentRelativePath), 'utf8')).resolves.toBe(
      'parent design content'
    );
    await expect(fs.readFile(path.join(repoRoot, childRelativePath), 'utf8')).resolves.toBe(
      'child notes content'
    );
  });
});
