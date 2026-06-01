import { afterEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { executePostApplyCommand } from './actions.js';
import { buildTimEnvironmentTemplateContext } from './environment.js';

describe('executePostApplyCommand', () => {
  let tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  async function makeTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-post-apply-test-'));
    tempDirs.push(dir);
    return dir;
  }

  test('injects rendered project env and reserved built-ins while preserving legacy env', async () => {
    const repoRoot = await makeTempDir();
    const outputPath = path.join(repoRoot, 'env-output.txt');
    const planFilePath = path.join(repoRoot, '.tim', 'plans', '123.plan.md');

    const success = await executePostApplyCommand(
      {
        title: 'capture env',
        command:
          'printf "%s|%s|%s|%s|%s" "$TIM_CUSTOM_MARKER" "$TIM_PLAN_ID" "$TIM_WORKSPACE_ID" "$LLMUTILS_TASK_ID" "$LLMUTILS_PLAN_FILE_PATH" > env-output.txt',
        env: {
          LLMUTILS_TASK_ID: 'workspace-123',
          LLMUTILS_PLAN_FILE_PATH: planFilePath,
        },
      },
      repoRoot,
      false,
      {
        timEnvironment: {
          environment: {
            TIM_CUSTOM_MARKER: 'marker_{{workspaceId}}_{{planId}}',
          },
          context: buildTimEnvironmentTemplateContext({
            repoPath: repoRoot,
            workspace: {
              workspaceId: 'workspace-123',
              workspaceName: 'Workspace 123',
              workspacePath: repoRoot,
            },
            plan: {
              planId: 123,
              planUuid: 'plan-uuid',
              planFilePath,
              branch: 'feature/plan-123',
            },
          }),
        },
      }
    );

    expect(success).toBe(true);
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe(
      `marker_workspace-123_123|123|workspace-123|workspace-123|${planFilePath}`
    );
  });

  test('lets explicit command env override project env', async () => {
    const repoRoot = await makeTempDir();
    const outputPath = path.join(repoRoot, 'override-output.txt');

    const success = await executePostApplyCommand(
      {
        title: 'capture override',
        command: 'printf "%s" "$TIM_CUSTOM_MARKER" > override-output.txt',
        env: {
          TIM_CUSTOM_MARKER: 'command_override',
        },
      },
      repoRoot,
      false,
      {
        timEnvironment: {
          environment: {
            TIM_CUSTOM_MARKER: 'project_{{workspaceId}}',
          },
          context: buildTimEnvironmentTemplateContext({
            repoPath: repoRoot,
            workspace: {
              workspaceId: 'workspace-override',
              workspacePath: repoRoot,
            },
          }),
        },
      }
    );

    expect(success).toBe(true);
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('command_override');
  });

  test('does not mutate global process.env when injecting project env', async () => {
    const repoRoot = await makeTempDir();
    const outputPath = path.join(repoRoot, 'global-env-output.txt');
    const originalMarker = process.env.TIM_MUTATION_MARKER;

    try {
      delete process.env.TIM_MUTATION_MARKER;

      const success = await executePostApplyCommand(
        {
          title: 'capture non-mutating env',
          command: 'printf "%s" "$TIM_MUTATION_MARKER" > global-env-output.txt',
        },
        repoRoot,
        false,
        {
          timEnvironment: {
            environment: {
              TIM_MUTATION_MARKER: 'marker_{{workspaceId}}',
            },
            context: buildTimEnvironmentTemplateContext({
              repoPath: repoRoot,
              workspace: {
                workspaceId: 'workspace-global',
                workspacePath: repoRoot,
              },
            }),
          },
        }
      );

      expect(success).toBe(true);
      await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('marker_workspace-global');
      expect(process.env.TIM_MUTATION_MARKER).toBeUndefined();
    } finally {
      if (originalMarker === undefined) {
        delete process.env.TIM_MUTATION_MARKER;
      } else {
        process.env.TIM_MUTATION_MARKER = originalMarker;
      }
    }
  });
});
