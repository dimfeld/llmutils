import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'path';
import yaml from 'yaml';
import { handleInitCommand } from './init.js';
import { ModuleMocker } from '../../testing.js';

describe('rmplan init command', () => {
  let tempDir: string;
  let originalCwd: string;
  const moduleMocker = new ModuleMocker(import.meta);

  beforeEach(async () => {
    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-init-test-'));

    // Change to temp directory to simulate git root
    originalCwd = process.cwd();
    process.chdir(tempDir);

    // Mock git.js to return our temp directory as git root
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
    }));
  });

  afterEach(async () => {
    // Restore original directory
    process.chdir(originalCwd);

    // Clean up temporary directory
    await fs.rm(tempDir, { recursive: true, force: true });

    // Clear module mocks
    moduleMocker.clear();
  });

  test('creates configuration file in new repository with --yes flag', async () => {
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleInitCommand({ yes: true }, command);

    // Verify config file was created
    const configPath = path.join(tempDir, '.rmfilter', 'config', 'rmplan.yml');
    const configExists = await fs
      .access(configPath)
      .then(() => true)
      .catch(() => false);
    expect(configExists).toBe(true);

    // Verify config content
    const configContent = await fs.readFile(configPath, 'utf-8');
    const config = yaml.parse(configContent);
    expect(config).toHaveProperty('paths');
    expect(config.paths).toHaveProperty('tasks', 'tasks');
    expect(config).toHaveProperty('defaultExecutor');

    // Verify tasks directory was created
    const tasksDir = path.join(tempDir, 'tasks');
    const tasksDirExists = await fs
      .access(tasksDir)
      .then(() => true)
      .catch(() => false);
    expect(tasksDirExists).toBe(true);
  });

  test('creates minimal configuration with --minimal flag', async () => {
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleInitCommand({ minimal: true }, command);

    const configPath = path.join(tempDir, '.rmfilter', 'config', 'rmplan.yml');
    const configContent = await fs.readFile(configPath, 'utf-8');
    const config = yaml.parse(configContent);

    // Minimal config should have only essential fields
    expect(config).toHaveProperty('paths');
    expect(config.paths).toHaveProperty('tasks', 'tasks');
    expect(config).toHaveProperty('defaultExecutor');

    // Should not have optional fields like postApplyCommands
    expect(config).not.toHaveProperty('postApplyCommands');
  });

  test('refuses to overwrite existing configuration without --force', async () => {
    // Create existing config
    const configPath = path.join(tempDir, '.rmfilter', 'config', 'rmplan.yml');
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
    await moduleMocker.mock('@inquirer/prompts', () => ({
      confirm: mock(async () => false),
      input: mock(async () => 'tasks'),
      select: mock(async () => 'copy-only'),
    }));

    await handleInitCommand({}, command);

    // Verify config was not changed
    const configContent = await fs.readFile(configPath, 'utf-8');
    const config = yaml.parse(configContent);
    expect(config.paths.tasks).toBe('my-custom-tasks');
    expect(config.defaultExecutor).toBe('custom-executor');
  });

  test('overwrites existing configuration with --force', async () => {
    // Create existing config
    const configPath = path.join(tempDir, '.rmfilter', 'config', 'rmplan.yml');
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
    expect(config.paths.tasks).toBe('tasks');
    expect(config.defaultExecutor).not.toBe('custom-executor');
  });

  test('creates tasks directory at configured path', async () => {
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleInitCommand({ yes: true }, command);

    // Verify tasks directory was created
    const tasksDir = path.join(tempDir, 'tasks');
    const stats = await fs.stat(tasksDir);
    expect(stats.isDirectory()).toBe(true);
  });

  test('includes default postApplyCommands when using --yes', async () => {
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleInitCommand({ yes: true }, command);

    const configPath = path.join(tempDir, '.rmfilter', 'config', 'rmplan.yml');
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

    const configPath = path.join(tempDir, '.rmfilter', 'config', 'rmplan.yml');
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

    const configPath = path.join(tempDir, '.rmfilter', 'config', 'rmplan.yml');
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

  test('handles absolute paths for tasks directory', async () => {
    const absoluteTasksPath = path.join(tempDir, 'custom', 'tasks', 'location');

    // Mock inquirer to return absolute path
    await moduleMocker.mock('@inquirer/prompts', () => ({
      input: mock(async (options: any) => {
        if (options.message.includes('plan files')) {
          return absoluteTasksPath;
        }
        return 'npm run format';
      }),
      select: mock(async () => 'copy-only'),
      confirm: mock(async () => true),
    }));

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleInitCommand({}, command);

    // Verify absolute path directory was created
    const stats = await fs.stat(absoluteTasksPath);
    expect(stats.isDirectory()).toBe(true);
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
    expect(content).toContain('.rmfilter/reviews');
    expect(content).toContain('.rmfilter/config/rmplan.local.yml');
    expect(content).toContain('# rmplan generated files');
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
    expect(content).toContain('.rmfilter/reviews');
    expect(content).toContain('.rmfilter/config/rmplan.local.yml');
    expect(content).toContain('# rmplan generated files');
  });

  test('does not duplicate entries in .gitignore if they already exist', async () => {
    const gitignorePath = path.join(tempDir, '.gitignore');
    const existingContent =
      '# Existing content\n.rmfilter/reviews\n.rmfilter/config/rmplan.local.yml\n';
    await fs.writeFile(gitignorePath, existingContent, 'utf-8');

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleInitCommand({ yes: true }, command);

    // Verify .gitignore was not modified unnecessarily
    const content = await fs.readFile(gitignorePath, 'utf-8');
    const reviewsCount = (content.match(/\.rmfilter\/reviews/g) || []).length;
    const localYmlCount = (content.match(/\.rmfilter\/config\/rmplan\.local\.yml/g) || []).length;

    expect(reviewsCount).toBe(1);
    expect(localYmlCount).toBe(1);
  });

  test('adds only missing entries to existing .gitignore', async () => {
    const gitignorePath = path.join(tempDir, '.gitignore');
    const existingContent = '# Existing content\n.rmfilter/reviews\n';
    await fs.writeFile(gitignorePath, existingContent, 'utf-8');

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleInitCommand({ yes: true }, command);

    // Verify only the missing entry was added
    const content = await fs.readFile(gitignorePath, 'utf-8');
    expect(content).toContain('.rmfilter/reviews');
    expect(content).toContain('.rmfilter/config/rmplan.local.yml');

    // Verify only one instance of the existing entry
    const reviewsCount = (content.match(/\.rmfilter\/reviews/g) || []).length;
    expect(reviewsCount).toBe(1);
  });
});
