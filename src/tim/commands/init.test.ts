import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'path';
import yaml from 'yaml';
import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { getWorkspaceByPath, recordWorkspace } from '../db/workspace.js';
import { getOrCreateProject } from '../db/project.js';

vi.mock('../../common/git.js', () => ({
  getGitRoot: vi.fn(),
  getCurrentBranchName: vi.fn(async () => null),
}));

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
  input: vi.fn(),
  select: vi.fn(),
}));

import { handleInitCommand } from './init.js';
import { getGitRoot } from '../../common/git.js';
import { confirm, input, select } from '@inquirer/prompts';

describe('tim init command', () => {
  let tempDir: string;
  let originalCwd: string;
  let originalConfigHome: string | undefined;

  beforeEach(async () => {
    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-init-test-'));

    // Change to temp directory to simulate git root
    originalCwd = process.cwd();
    originalConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'user-config');
    closeDatabaseForTesting();
    process.chdir(tempDir);

    // Mock git.js to return our temp directory as git root
    vi.mocked(getGitRoot).mockResolvedValue(tempDir);
  });

  afterEach(async () => {
    // Restore original directory
    process.chdir(originalCwd);
    closeDatabaseForTesting();
    if (originalConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalConfigHome;
    }

    // Clean up temporary directory
    await fs.rm(tempDir, { recursive: true, force: true });

    // Clear module mocks
    vi.clearAllMocks();
  });

  test('creates configuration file in new repository with --yes flag', async () => {
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleInitCommand({ yes: true }, command);

    // Verify config file was created
    const configPath = path.join(tempDir, '.tim', 'config', 'tim.yml');
    const configExists = await fs
      .access(configPath)
      .then(() => true)
      .catch(() => false);
    expect(configExists).toBe(true);

    // Verify config content
    const configContent = await fs.readFile(configPath, 'utf-8');
    const config = yaml.parse(configContent);
    expect(config).toHaveProperty('defaultExecutor');
    expect(getWorkspaceByPath(getDatabase(), tempDir)?.workspace_type).toBe(1);
  });

  test('creates minimal configuration with --minimal flag', async () => {
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleInitCommand({ minimal: true }, command);

    const configPath = path.join(tempDir, '.tim', 'config', 'tim.yml');
    const configContent = await fs.readFile(configPath, 'utf-8');
    const config = yaml.parse(configContent);

    // Minimal config should have only essential fields
    expect(config).toHaveProperty('defaultExecutor');

    // Should not have optional fields like postApplyCommands
    expect(config).not.toHaveProperty('postApplyCommands');
  });

  test('refuses to overwrite existing configuration without --force', async () => {
    // Create existing config
    const configPath = path.join(tempDir, '.tim', 'config', 'tim.yml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const existingConfig = {
      paths: { tasks: 'my-custom-tasks' },
      defaultExecutor: 'custom-executor',
    };
    await fs.writeFile(configPath, yaml.stringify(existingConfig));

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Mock inquirer to return false (don't overwrite)
    vi.mocked(confirm).mockResolvedValue(false);
    vi.mocked(input).mockResolvedValue('tasks');
    vi.mocked(select).mockResolvedValue('copy-only');

    await handleInitCommand({}, command);

    // Verify config was not changed
    const configContent = await fs.readFile(configPath, 'utf-8');
    const config = yaml.parse(configContent);
    expect(config.paths?.tasks).toBe('my-custom-tasks');
    expect(config.defaultExecutor).toBe('custom-executor');
  });

  test('overwrites existing configuration with --force', async () => {
    // Create existing config
    const configPath = path.join(tempDir, '.tim', 'config', 'tim.yml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const existingConfig = {
      paths: { tasks: 'my-custom-tasks' },
      defaultExecutor: 'custom-executor',
    };
    await fs.writeFile(configPath, yaml.stringify(existingConfig));

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleInitCommand({ force: true, yes: true }, command);

    // Verify config was overwritten
    const configContent = await fs.readFile(configPath, 'utf-8');
    const config = yaml.parse(configContent);
    expect(config.paths?.tasks).toBeUndefined();
    expect(config.defaultExecutor).not.toBe('custom-executor');
  });

  test('includes default postApplyCommands when using --yes', async () => {
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleInitCommand({ yes: true }, command);

    const configPath = path.join(tempDir, '.tim', 'config', 'tim.yml');
    const configContent = await fs.readFile(configPath, 'utf-8');
    const config = yaml.parse(configContent);

    expect(config).toHaveProperty('postApplyCommands');
    expect(Array.isArray(config.postApplyCommands)).toBe(true);
    expect(config.postApplyCommands.length).toBeGreaterThan(0);
    expect(config.postApplyCommands[0]).toHaveProperty('title');
    expect(config.postApplyCommands[0]).toHaveProperty('command');
  });

  test('includes prCreation settings in default config', async () => {
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleInitCommand({ yes: true }, command);

    const configPath = path.join(tempDir, '.tim', 'config', 'tim.yml');
    const configContent = await fs.readFile(configPath, 'utf-8');
    const config = yaml.parse(configContent);

    expect(config).toHaveProperty('prCreation');
    expect(config.prCreation).toHaveProperty('draft');
  });

  test('includes updateDocs and executors settings in default config', async () => {
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleInitCommand({ yes: true }, command);

    const configPath = path.join(tempDir, '.tim', 'config', 'tim.yml');
    const configContent = await fs.readFile(configPath, 'utf-8');
    const config = yaml.parse(configContent);

    // Check updateDocs settings
    expect(config).toHaveProperty('updateDocs');
    expect(config.updateDocs).toHaveProperty('mode', 'after-iteration');

    // Check executors.claude-code.permissionsMcp settings
    expect(config).toHaveProperty('executors');
    expect(config.executors).toHaveProperty('claude-code');
    expect(config.executors['claude-code']).toHaveProperty('permissionsMcp');
    expect(config.executors['claude-code'].permissionsMcp).toHaveProperty('enabled', true);
    expect(config.executors['claude-code'].permissionsMcp).toHaveProperty(
      'autoApproveCreatedFileDeletion',
      true
    );
  });

  test('interactive init no longer prompts for a plan files directory', async () => {
    const inputSpy = vi.mocked(input).mockResolvedValue('npm run format');
    vi.mocked(select)
      .mockResolvedValueOnce('claude-code')
      .mockResolvedValueOnce('production')
      .mockResolvedValueOnce('pr-based')
      .mockResolvedValueOnce('never');
    vi.mocked(confirm).mockResolvedValue(true);

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleInitCommand({}, command);

    expect(inputSpy).toHaveBeenCalledTimes(2);
    expect(inputSpy.mock.calls.map(([options]) => options.message)).not.toContain(
      'Where should plan files be stored?'
    );
  });

  test('writes selected workflow settings and the detected install command', async () => {
    await fs.writeFile(path.join(tempDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0');
    vi.mocked(select)
      .mockResolvedValueOnce('codex-cli')
      .mockResolvedValueOnce('hobby')
      .mockResolvedValueOnce('squash-rebase')
      .mockResolvedValueOnce('never');
    vi.mocked(confirm).mockResolvedValue(false);
    vi.mocked(input).mockResolvedValue('pnpm install --frozen-lockfile');

    await handleInitCommand({}, {});

    const config = yaml.parse(
      await fs.readFile(path.join(tempDir, '.tim/config/tim.yml'), 'utf-8')
    );
    expect(config.quality).toBe('hobby');
    expect(config.developmentWorkflow).toBe('squash-rebase');
    expect(config.lifecycle.commands).toEqual([
      { title: 'Install dependencies', command: 'pnpm install --frozen-lockfile' },
    ]);
    expect(vi.mocked(input).mock.calls[0]?.[0].default).toBe('pnpm install');
  });

  test('does not add an install command when the answer is blank', async () => {
    vi.mocked(select)
      .mockResolvedValueOnce('claude-code')
      .mockResolvedValueOnce('production')
      .mockResolvedValueOnce('pr-based')
      .mockResolvedValueOnce('never');
    vi.mocked(confirm).mockResolvedValue(false);
    vi.mocked(input).mockResolvedValue('  ');

    await handleInitCommand({}, {});

    const config = yaml.parse(
      await fs.readFile(path.join(tempDir, '.tim/config/tim.yml'), 'utf-8')
    );
    expect(config.lifecycle).toBeUndefined();
  });

  test('prefers the declared package manager over a lockfile', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ packageManager: 'yarn@4.1.0' })
    );
    await fs.writeFile(path.join(tempDir, 'package-lock.json'), '{}');
    vi.mocked(select)
      .mockResolvedValueOnce('claude-code')
      .mockResolvedValueOnce('production')
      .mockResolvedValueOnce('pr-based')
      .mockResolvedValueOnce('never');
    vi.mocked(confirm).mockResolvedValue(false);
    vi.mocked(input).mockResolvedValue('yarn install');

    await handleInitCommand({}, {});

    expect(vi.mocked(input).mock.calls[0]?.[0].default).toBe('yarn install');
  });

  test('keeps an existing workspace id when marking it primary', async () => {
    const db = getDatabase();
    const project = getOrCreateProject(db, 'existing');
    recordWorkspace(db, {
      projectId: project.id,
      taskId: 'existing-workspace',
      workspacePath: tempDir,
      workspaceType: 'standard',
    });

    await handleInitCommand({ yes: true }, {});
    const workspace = getWorkspaceByPath(db, tempDir);
    expect(workspace?.task_id).toBe('existing-workspace');
    expect(workspace?.workspace_type).toBe(1);

    await handleInitCommand({ yes: true }, {});
    expect(getWorkspaceByPath(db, tempDir)?.task_id).toBe('existing-workspace');
  });

  test('creates .gitignore with required entries when file does not exist', async () => {
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleInitCommand({ yes: true }, command);

    // Verify .gitignore was created
    const gitignorePath = path.join(tempDir, '.gitignore');
    const gitignoreExists = await fs
      .access(gitignorePath)
      .then(() => true)
      .catch(() => false);
    expect(gitignoreExists).toBe(true);

    // Verify content includes required entries
    const content = await fs.readFile(gitignorePath, 'utf-8');
    expect(content).toContain('.tim/reviews');
    expect(content).toContain('.tim/config/tim.local.yml');
    expect(content).toContain('.tim/workspaces');
    expect(content).toContain('# tim generated files');
  });

  test('updates existing .gitignore with missing entries', async () => {
    const gitignorePath = path.join(tempDir, '.gitignore');
    const existingContent = '# Existing content\nnode_modules\n.env\n';
    await fs.writeFile(gitignorePath, existingContent, 'utf-8');

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleInitCommand({ yes: true }, command);

    // Verify .gitignore was updated
    const content = await fs.readFile(gitignorePath, 'utf-8');
    expect(content).toContain('# Existing content');
    expect(content).toContain('node_modules');
    expect(content).toContain('.tim/reviews');
    expect(content).toContain('.tim/config/tim.local.yml');
    expect(content).toContain('.tim/workspaces');
    expect(content).toContain('# tim generated files');
  });

  test('does not duplicate entries in .gitignore if they already exist', async () => {
    const gitignorePath = path.join(tempDir, '.gitignore');
    const existingContent =
      '# Existing content\n.tim/reviews\n.tim/config/tim.local.yml\n.tim/workspaces\n';
    await fs.writeFile(gitignorePath, existingContent, 'utf-8');

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleInitCommand({ yes: true }, command);

    // Verify .gitignore was not modified unnecessarily
    const content = await fs.readFile(gitignorePath, 'utf-8');
    const reviewsCount = (content.match(/\.tim\/reviews/g) || []).length;
    const localYmlCount = (content.match(/\.tim\/config\/tim\.local\.yml/g) || []).length;
    const workspacesCount = (content.match(/\.tim\/workspaces/g) || []).length;

    expect(reviewsCount).toBe(1);
    expect(localYmlCount).toBe(1);
    expect(workspacesCount).toBe(1);
  });

  test('adds only missing entries to existing .gitignore', async () => {
    const gitignorePath = path.join(tempDir, '.gitignore');
    const existingContent = '# Existing content\n.tim/reviews\n';
    await fs.writeFile(gitignorePath, existingContent, 'utf-8');

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleInitCommand({ yes: true }, command);

    // Verify only the missing entry was added
    const content = await fs.readFile(gitignorePath, 'utf-8');
    expect(content).toContain('.tim/reviews');
    expect(content).toContain('.tim/config/tim.local.yml');
    expect(content).toContain('.tim/workspaces');

    // Verify only one instance of the existing entry
    const reviewsCount = (content.match(/\.tim\/reviews/g) || []).length;
    expect(reviewsCount).toBe(1);
  });
});
