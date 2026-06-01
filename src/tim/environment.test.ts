import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DATABASE_FILENAME, openDatabase } from './db/database.js';
import { getOrCreateProject } from './db/project.js';
import { recordWorkspace } from './db/workspace.js';
import {
  RESERVED_TIM_ENVIRONMENT_VARIABLES,
  TIM_ENVIRONMENT_CONTEXT_DEFINITIONS,
  TIM_ENVIRONMENT_PLACEHOLDERS,
  buildTimEnvironmentTemplateContext,
  buildTimEnvironmentTemplateContextForCwd,
  buildTimEnvironmentWorkspaceContextFromRow,
  findRegisteredWorkspaceForCwd,
  normalizeTimEnvironmentConfigEntry,
  renderBuiltInTimEnvironment,
  renderTimEnvironmentTemplate,
  renderTimEnvironmentTemplates,
  type TimEnvironmentTemplateContext,
} from './environment.js';
import type { Database } from 'bun:sqlite';

describe('tim environment templates', () => {
  const fullContext: TimEnvironmentTemplateContext = {
    workspaceId: 'workspace-123',
    workspaceName: 'Workspace 123',
    workspacePath: '/repo/workspaces/workspace-123',
    repoPath: '/repo/main',
    planId: '373',
    planUuid: 'plan-uuid',
    planFilePath: '/repo/workspaces/workspace-123/.tim/plans/373.plan.md',
    branch: 'tim/373-project-env',
  };

  test('renders plain strings and simple placeholders', () => {
    expect(renderTimEnvironmentTemplate('db_{{workspaceId}}_{{ planId }}', fullContext)).toBe(
      'db_workspace-123_373'
    );
  });

  test('renders repeated placeholders and multiple configured variables', () => {
    expect(
      renderTimEnvironmentTemplates(
        {
          TIM_DATABASE_NAME: 'db_{{ workspaceId }}_{{ workspaceId }}',
          TIM_BRANCH_LABEL: '{{ branch }}',
        },
        fullContext
      )
    ).toEqual({
      TIM_DATABASE_NAME: 'db_workspace-123_workspace-123',
      TIM_BRANCH_LABEL: 'tim/373-project-env',
    });
  });

  test('throws for unknown placeholders', () => {
    expect(() =>
      renderTimEnvironmentTemplate('{{ doesNotExist }}', fullContext, 'TIM_DATABASE_NAME')
    ).toThrow(/doesNotExist/);
  });

  test('throws for unavailable direct placeholders', () => {
    expect(() =>
      renderTimEnvironmentTemplate('{{ workspaceId }}', { planId: '373' }, 'TIM_DATABASE_NAME')
    ).toThrow(/unavailable placeholder "workspaceId"/);
  });

  test('fallback chains use the first available non-empty placeholder', () => {
    expect(
      renderTimEnvironmentTemplate(
        'db_{{ workspaceId ?? planId ?? "main" }}',
        { workspaceId: '', planId: '373' },
        'TIM_DATABASE_NAME'
      )
    ).toBe('db_373');
  });

  test('fallback chains can resolve to quoted literals', () => {
    expect(
      renderTimEnvironmentTemplate(
        'db_{{ workspaceId ?? planId ?? "main" }}',
        {},
        'TIM_DATABASE_NAME'
      )
    ).toBe('db_main');
  });

  test('fallback chains support escaped quoted literal values', () => {
    expect(
      renderTimEnvironmentTemplate(
        String.raw`{{ workspaceId ?? "main\nbranch" }}`,
        {},
        'TIM_DATABASE_NAME'
      )
    ).toBe('main\nbranch');

    expect(
      renderTimEnvironmentTemplate(
        String.raw`{{ workspaceId ?? 'owner\'s-main' }}`,
        {},
        'TIM_DATABASE_NAME'
      )
    ).toBe("owner's-main");
  });

  test('fallback chains throw when no operand resolves', () => {
    expect(() =>
      renderTimEnvironmentTemplate('db_{{ workspaceId ?? planId }}', {}, 'TIM_DATABASE_NAME')
    ).toThrow(/did not resolve/);
  });

  test('fallback chains still reject unknown placeholders', () => {
    expect(() =>
      renderTimEnvironmentTemplate(
        'db_{{ doesNotExist ?? "main" }}',
        fullContext,
        'TIM_DATABASE_NAME'
      )
    ).toThrow(/doesNotExist/);
  });

  test('throws for empty template expressions and fallback operands', () => {
    expect(() =>
      renderTimEnvironmentTemplate('db_{{ }}', fullContext, 'TIM_DATABASE_NAME')
    ).toThrow(/Empty TIM environment template expression/);

    expect(() =>
      renderTimEnvironmentTemplate(
        'db_{{ workspaceId ?? }}',
        { workspaceId: '' },
        'TIM_DATABASE_NAME'
      )
    ).toThrow(/Empty operand/);
  });

  test('throws for invalid operands and unterminated literals', () => {
    expect(() =>
      renderTimEnvironmentTemplate('db_{{ workspace-id }}', fullContext, 'TIM_DATABASE_NAME')
    ).toThrow(/Invalid TIM environment template operand "workspace-id"/);

    expect(() =>
      renderTimEnvironmentTemplate('db_{{ workspaceId ?? "main }}', {}, 'TIM_DATABASE_NAME')
    ).toThrow(/Unterminated quoted literal/);

    expect(() =>
      renderTimEnvironmentTemplate(
        String.raw`db_{{ workspaceId ?? "\q" }}`,
        {},
        'TIM_DATABASE_NAME'
      )
    ).toThrow(/Invalid quoted literal.*TIM_DATABASE_NAME/);
  });

  test('supports ?? inside quoted literal fallbacks', () => {
    expect(
      renderTimEnvironmentTemplate('{{ workspaceId ?? "main??fallback" }}', {}, 'TIM_DATABASE_NAME')
    ).toBe('main??fallback');
  });

  test('normalizes string shorthand and object entries', () => {
    expect(normalizeTimEnvironmentConfigEntry('value')).toEqual({
      value: 'value',
      precedence: 'normal',
    });
    expect(
      normalizeTimEnvironmentConfigEntry({
        value: 'value',
        precedence: 'override-dotenv',
      })
    ).toEqual({
      value: 'value',
      precedence: 'override-dotenv',
    });
  });

  test('renders built-ins from the same placeholder mapping and omits unavailable values', () => {
    expect(
      renderBuiltInTimEnvironment({
        ...fullContext,
        workspaceName: '',
        repoPath: null,
        branch: undefined,
      })
    ).toEqual({
      TIM_WORKSPACE_ID: 'workspace-123',
      TIM_WORKSPACE_PATH: '/repo/workspaces/workspace-123',
      TIM_PLAN_ID: '373',
      TIM_PLAN_UUID: 'plan-uuid',
      TIM_PLAN_FILE_PATH: '/repo/workspaces/workspace-123/.tim/plans/373.plan.md',
    });
  });

  test('keeps placeholder and built-in definitions in one-to-one parity', () => {
    expect(TIM_ENVIRONMENT_PLACEHOLDERS).toEqual(Object.keys(TIM_ENVIRONMENT_CONTEXT_DEFINITIONS));
    expect(RESERVED_TIM_ENVIRONMENT_VARIABLES).toEqual(
      Object.values(TIM_ENVIRONMENT_CONTEXT_DEFINITIONS)
    );
  });
});

describe('tim environment context helpers', () => {
  test('constructs context from explicit repo, workspace, and plan fields', () => {
    expect(
      buildTimEnvironmentTemplateContext({
        repoPath: '/repo/main',
        workspace: {
          workspaceId: 'task-373',
          workspaceName: 'Project Env',
          workspacePath: '/repo/workspaces/task-373',
        },
        plan: {
          planId: 373,
          planUuid: 'plan-uuid',
          planFilePath: '/repo/workspaces/task-373/.tim/plans/373.plan.md',
          branch: 'tim/373-project-env',
        },
      })
    ).toEqual({
      workspaceId: 'task-373',
      workspaceName: 'Project Env',
      workspacePath: '/repo/workspaces/task-373',
      repoPath: '/repo/main',
      planId: '373',
      planUuid: 'plan-uuid',
      planFilePath: '/repo/workspaces/task-373/.tim/plans/373.plan.md',
      branch: 'tim/373-project-env',
    });
  });

  test('leaves unavailable values unavailable and falls workspaceName back to workspaceId', () => {
    expect(
      buildTimEnvironmentTemplateContext({
        repoPath: '/repo/main',
        workspace: {
          workspaceId: 'task-373',
          workspacePath: '/repo/workspaces/task-373',
        },
        plan: {},
      })
    ).toEqual({
      workspaceId: 'task-373',
      workspaceName: 'task-373',
      workspacePath: '/repo/workspaces/task-373',
      repoPath: '/repo/main',
      planId: undefined,
      planUuid: undefined,
      planFilePath: undefined,
      branch: undefined,
    });
  });

  test('treats empty workspace names as unavailable for workspaceId fallback', () => {
    expect(
      buildTimEnvironmentTemplateContext({
        workspace: {
          workspaceId: 'task-373',
          workspaceName: '',
          workspacePath: '/repo/workspaces/task-373',
        },
      }).workspaceName
    ).toBe('task-373');
  });
});

describe('registered workspace environment context detection', () => {
  let tempDir: string;
  let db: Database;
  let projectId: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-env-context-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
    projectId = getOrCreateProject(db, 'github.com/test/repo').id;
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('detects registered workspace roots and child directories', async () => {
    const workspacePath = path.join(tempDir, 'workspace');
    const childPath = path.join(workspacePath, 'src', 'feature');
    await fs.mkdir(childPath, { recursive: true });

    const row = recordWorkspace(db, {
      projectId,
      taskId: 'task-373',
      workspacePath,
      name: 'Project Env Workspace',
    });

    expect(findRegisteredWorkspaceForCwd(db, workspacePath)?.id).toBe(row.id);
    expect(findRegisteredWorkspaceForCwd(db, childPath)?.id).toBe(row.id);
    expect(buildTimEnvironmentWorkspaceContextFromRow(row)).toEqual({
      workspaceId: 'task-373',
      workspaceName: 'Project Env Workspace',
      workspacePath,
    });
  });

  test('falls row workspaceName back to workspaceId when row name is empty', async () => {
    const workspacePath = path.join(tempDir, 'workspace');
    await fs.mkdir(workspacePath, { recursive: true });

    const row = recordWorkspace(db, {
      projectId,
      taskId: 'task-373',
      workspacePath,
      name: '',
    });

    expect(buildTimEnvironmentWorkspaceContextFromRow(row)).toEqual({
      workspaceId: 'task-373',
      workspaceName: 'task-373',
      workspacePath,
    });
  });

  test('detects registered workspaces through symlinked child directories', async () => {
    const workspacePath = path.join(tempDir, 'workspace');
    const childPath = path.join(workspacePath, 'src', 'feature');
    const symlinkPath = path.join(tempDir, 'workspace-link');
    const symlinkChildPath = path.join(symlinkPath, 'src', 'feature');
    await fs.mkdir(childPath, { recursive: true });
    await fs.symlink(workspacePath, symlinkPath, 'dir');

    const row = recordWorkspace(db, {
      projectId,
      taskId: 'task-373',
      workspacePath,
      name: 'Symlinked Workspace',
    });

    expect(findRegisteredWorkspaceForCwd(db, symlinkChildPath)?.id).toBe(row.id);
  });

  test('chooses the nearest containing registered workspace root', async () => {
    const parentWorkspacePath = path.join(tempDir, 'workspace');
    const nestedWorkspacePath = path.join(parentWorkspacePath, 'nested');
    const childPath = path.join(nestedWorkspacePath, 'src');
    await fs.mkdir(childPath, { recursive: true });

    recordWorkspace(db, {
      projectId,
      taskId: 'parent',
      workspacePath: parentWorkspacePath,
    });
    const nested = recordWorkspace(db, {
      projectId,
      taskId: 'nested',
      workspacePath: nestedWorkspacePath,
    });

    expect(findRegisteredWorkspaceForCwd(db, childPath)?.id).toBe(nested.id);
  });

  test('detects from cwd only when workspace input is undefined', async () => {
    const workspacePath = path.join(tempDir, 'workspace');
    const childPath = path.join(workspacePath, 'src');
    await fs.mkdir(childPath, { recursive: true });

    recordWorkspace(db, {
      projectId,
      taskId: 'task-373',
      workspacePath,
      name: 'Detected Workspace',
    });

    expect(
      buildTimEnvironmentTemplateContextForCwd(db, {
        cwd: childPath,
        repoPath: tempDir,
        plan: { planId: 373 },
      })
    ).toMatchObject({
      workspaceId: 'task-373',
      workspaceName: 'Detected Workspace',
      workspacePath,
      repoPath: tempDir,
      planId: '373',
    });

    expect(
      buildTimEnvironmentTemplateContextForCwd(db, {
        cwd: childPath,
        repoPath: tempDir,
        workspace: null,
        plan: { planId: 373 },
      })
    ).toEqual({
      workspaceId: undefined,
      workspaceName: undefined,
      workspacePath: undefined,
      repoPath: tempDir,
      planId: '373',
      planUuid: undefined,
      planFilePath: undefined,
      branch: undefined,
    });
  });

  test('does not match sibling paths or synthesize workspace identifiers', async () => {
    const workspacePath = path.join(tempDir, 'workspace');
    const siblingPath = path.join(tempDir, 'workspace-sibling');
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(siblingPath, { recursive: true });

    recordWorkspace(db, {
      projectId,
      taskId: 'task-373',
      workspacePath,
    });

    expect(findRegisteredWorkspaceForCwd(db, siblingPath)).toBeNull();
    expect(
      buildTimEnvironmentTemplateContextForCwd(db, {
        cwd: siblingPath,
        repoPath: siblingPath,
        plan: { planId: 373 },
      })
    ).toEqual({
      workspaceId: undefined,
      workspaceName: undefined,
      workspacePath: undefined,
      repoPath: siblingPath,
      planId: '373',
      planUuid: undefined,
      planFilePath: undefined,
      branch: undefined,
    });
  });
});
