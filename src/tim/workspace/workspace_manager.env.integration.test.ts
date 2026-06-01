import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeDatabaseForTesting } from '../db/database.js';
import type { PlanSchema } from '../planSchema.js';
import type { TimConfig } from '../configSchema.js';
import { createWorkspace, runWorkspaceUpdateCommands } from './workspace_manager.js';
import { WorkspaceLock } from './workspace_lock.js';

describe('workspace command project environment integration', () => {
  let tempDir: string;
  let originalXdgConfigHome: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-workspace-env-integration-'));
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'config');
    closeDatabaseForTesting();

    vi.spyOn(WorkspaceLock, 'acquireLock').mockResolvedValue({
      type: 'persistent',
      command: 'tim agent --workspace test',
      startedAt: new Date().toISOString(),
      hostname: 'test-host',
      version: 2,
    });
    vi.spyOn(WorkspaceLock, 'setupCleanupHandlers').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeDatabaseForTesting();
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function runCommand(command: string[], cwd: string): Promise<void> {
    const proc = Bun.spawn(command, {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode, `${command.join(' ')} failed\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
  }

  async function createSourceRepository(): Promise<{ repoRoot: string; planPath: string }> {
    const repoRoot = path.join(tempDir, 'source-repo');
    await fs.mkdir(repoRoot, { recursive: true });
    await runCommand(['git', 'init', '-b', 'main'], repoRoot);
    await runCommand(['git', 'config', 'user.email', 'test@test.com'], repoRoot);
    await runCommand(['git', 'config', 'user.name', 'Test User'], repoRoot);
    await runCommand(['git', 'remote', 'add', 'origin', repoRoot], repoRoot);

    const planPath = path.join(repoRoot, '.tim', 'plans', '77.plan.md');
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(
      planPath,
      'id: 77\nuuid: plan-uuid-77\ntitle: Workspace Env Plan\ntasks: []\n'
    );
    await fs.writeFile(path.join(repoRoot, 'README.md'), '# test repo\n');
    await runCommand(['git', 'add', '.'], repoRoot);
    await runCommand(['git', 'commit', '-m', 'initial'], repoRoot);

    return { repoRoot, planPath };
  }

  test('post-clone commands receive rendered project env for the target workspace context', async () => {
    const { repoRoot, planPath } = await createSourceRepository();
    const cloneLocation = path.join(tempDir, 'workspaces');
    const taskId = 'post-clone-task';
    const expectedWorkspacePath = path.join(cloneLocation, `source-repo-${taskId}`);
    const expectedWorkspacePlanPath = path.join(
      expectedWorkspacePath,
      '.tim',
      'plans',
      '77.plan.md'
    );
    const planData = {
      id: 77,
      uuid: 'plan-uuid-77',
      title: 'Workspace Env Plan',
      tasks: [],
    } as PlanSchema;

    const config: TimConfig = {
      environment: {
        TIM_WORKSPACE_MARKER: '{{workspaceId}}|{{workspacePath}}|{{branch}}|{{planId}}',
        TIM_OVERRIDE_ME: 'project_{{workspaceId}}',
      },
      workspaceCreation: {
        cloneMethod: 'cp',
        repositoryUrl: repoRoot,
        sourceDirectory: repoRoot,
        cloneLocation,
        postCloneCommands: [
          {
            title: 'Capture post-clone env',
            command:
              'mkdir -p .tim/tmp && printf "%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s" "$TIM_WORKSPACE_MARKER" "$TIM_PLAN_FILE_PATH" "$TIM_PLAN_UUID" "$TIM_BRANCH" "$LLMUTILS_TASK_ID" "$LLMUTILS_PLAN_FILE_PATH" "$TIM_OVERRIDE_ME" > .tim/tmp/post-clone-env.txt',
            env: {
              TIM_OVERRIDE_ME: 'command_override',
            },
          },
        ],
      },
    };

    const result = await createWorkspace(repoRoot, taskId, planPath, config, {
      branchName: 'feature/post-clone-env',
      createBranch: true,
      planData,
    });

    expect(result?.path).toBe(expectedWorkspacePath);
    await expect(
      fs.readFile(path.join(expectedWorkspacePath, '.tim', 'tmp', 'post-clone-env.txt'), 'utf8')
    ).resolves.toBe(
      [
        `${taskId}|${expectedWorkspacePath}|feature/post-clone-env|77`,
        expectedWorkspacePlanPath,
        'plan-uuid-77',
        'feature/post-clone-env',
        taskId,
        expectedWorkspacePlanPath,
        'command_override',
      ].join('\n')
    );
  });

  test('workspace update commands receive target workspace context and legacy env values', async () => {
    const repoRoot = path.join(tempDir, 'main-repo');
    const workspacePath = path.join(tempDir, 'workspace-target');
    await fs.mkdir(workspacePath, { recursive: true });
    const planFilePath = path.join(workspacePath, '.tim', 'plans', '88.plan.md');
    await fs.mkdir(path.dirname(planFilePath), { recursive: true });
    await fs.writeFile(planFilePath, 'id: 88\nuuid: plan-uuid-88\ntitle: Update Plan\ntasks: []\n');

    const config: TimConfig = {
      environment: {
        TIM_WORKSPACE_MARKER:
          '{{workspaceId}}|{{workspaceName}}|{{workspacePath}}|{{branch}}|{{planId}}',
        TIM_OVERRIDE_ME: 'project_{{workspaceId}}',
      },
      workspaceCreation: {
        workspaceUpdateCommands: [
          {
            title: 'Capture workspace update env',
            command:
              'mkdir -p .tim/tmp && printf "%s\\n%s\\n%s\\n%s\\n%s" "$TIM_WORKSPACE_MARKER" "$TIM_PLAN_FILE_PATH" "$TIM_PLAN_UUID" "$LLMUTILS_PLAN_FILE_PATH" "$TIM_OVERRIDE_ME" > .tim/tmp/update-env.txt',
            env: {
              TIM_OVERRIDE_ME: 'command_override',
            },
          },
        ],
      },
    };

    const success = await runWorkspaceUpdateCommands(
      workspacePath,
      config,
      'update-task',
      planFilePath,
      {
        repoPath: repoRoot,
        workspaceName: 'Update Workspace',
        branch: 'feature/update-env',
        planData: {
          id: 88,
          uuid: 'plan-uuid-88',
          title: 'Update Plan',
          tasks: [],
        } as PlanSchema,
      }
    );

    expect(success).toBe(true);
    await expect(
      fs.readFile(path.join(workspacePath, '.tim', 'tmp', 'update-env.txt'), 'utf8')
    ).resolves.toBe(
      [
        `update-task|Update Workspace|${workspacePath}|feature/update-env|88`,
        planFilePath,
        'plan-uuid-88',
        planFilePath,
        'command_override',
      ].join('\n')
    );
  });
});
