import { $ } from 'bun';
import { test, describe, expect, afterEach, beforeEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  findConfigPath,
  loadConfig,
  findLocalConfigPath,
  loadEffectiveConfig,
  clearConfigCache,
} from './configLoader.ts';
import { ModuleMocker } from '../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

// Silence logs during tests will be done in beforeEach
import { type TimConfig, type WorkspaceCreationConfig } from './configSchema.js';
import { DEFAULT_EXECUTOR } from './constants.js';
import {
  deriveRepositoryName,
  fallbackRepositoryNameFromGitRoot,
  parseGitRemoteUrl,
} from '../common/git_url_parser.js';

// Since js-yaml isn't working in tests, we'll use yaml
import yaml from 'yaml';

// Test state
let tempDir: string;
let fakeHomeDir: string;
let originalXdgConfigHome: string | undefined;
let logSpy: ReturnType<typeof mock>;

// Helper function to create a temporary directory structure for testing
async function createTempTestDir() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'configLoader-test-'));
  return tempDir;
}

// Helper function to create test files
async function createTestFile(filePath: string, content: string) {
  await fs.writeFile(filePath, content, 'utf-8');
}

beforeEach(async () => {
  // Mock js-yaml to use yaml package
  await moduleMocker.mock('js-yaml', () => ({
    load: (content: string) => yaml.parse(content),
  }));

  // Mock logging
  await moduleMocker.mock('../logging.js', () => ({
    debugLog: mock(() => {}),
    error: mock(() => {}),
    log: (logSpy = mock(() => {})),
    warn: mock(() => {}),
  }));

  // Create temporary directory for test files
  tempDir = await createTempTestDir();
});

afterEach(async () => {
  // Clean up mocks
  moduleMocker.clear();

  // Clean up temporary directory
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

describe('configLoader', () => {
  let testDir: string;
  let configDir: string;

  beforeEach(async () => {
    // Clear the config cache before each test
    clearConfigCache();

    // Create a unique temporary directory for each test
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-config-test-'));
    configDir = path.join(testDir, '.rmfilter', 'config');

    fakeHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-home-'));
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(fakeHomeDir, '.config');

    const realOs = await import('node:os');
    await moduleMocker.mock('node:os', () => ({
      ...realOs,
      homedir: () => fakeHomeDir,
    }));

    // Mock the getGitRoot function to return our test directory
    await moduleMocker.mock('../common/git.js', () => ({
      getGitRoot: async () => testDir,
    }));

    // Create test directories
    await fs.mkdir(configDir, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup test directory
    await fs.rm(testDir, { recursive: true, force: true });
    if (fakeHomeDir) {
      await fs.rm(fakeHomeDir, { recursive: true, force: true });
    }
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    // Clear mocks after each test
    moduleMocker.clear();
    // Clear the config cache again
    clearConfigCache();
  });

  test('findConfigPath returns default path when it exists', async () => {
    const defaultConfigPath = path.join(configDir, 'tim.yml');
    await fs.writeFile(defaultConfigPath, 'postApplyCommands: []');

    const result = await findConfigPath();
    expect(result).toBe(defaultConfigPath);
  });

  test('loadEffectiveConfig returns default config using external storage when repository lacks config', async () => {
    await fs.rm(path.join(configDir, 'tim.yml'), { force: true });

    const repositoryName = fallbackRepositoryNameFromGitRoot(testDir);
    const expectedRepositoryDir = path.join(
      fakeHomeDir,
      '.config',
      'tim',
      'repositories',
      repositoryName
    );

    const config = await loadEffectiveConfig();

    expect(config.isUsingExternalStorage).toBe(true);
    expect(config.externalRepositoryConfigDir).toBe(expectedRepositoryDir);
    const loggedMessage = logSpy.mock.calls.at(-1)?.[0];
    expect(typeof loggedMessage).toBe('string');
    const messageText = loggedMessage as string;
    expect(messageText).toBe(`Using external tim storage at ${expectedRepositoryDir}`);
  });

  test('loadEffectiveConfig captures repository metadata from remote when using external storage', async () => {
    await fs.rm(path.join(configDir, 'tim.yml'), { force: true });

    await $`git init`.cwd(testDir).quiet();
    const remote = 'example.com:Owner Space/Client Repo.git';
    await $`git remote add origin ${remote}`.cwd(testDir).quiet();

    const config = await loadEffectiveConfig();

    const parsedRemote = parseGitRemoteUrl(remote);
    const fallbackName = fallbackRepositoryNameFromGitRoot(testDir);
    const expectedName = deriveRepositoryName(parsedRemote, {
      fallbackName,
      uniqueSalt: testDir,
    });

    const expectedRepositoryDir = path.join(
      fakeHomeDir,
      '.config',
      'tim',
      'repositories',
      expectedName
    );

    expect(config.repositoryRemoteUrl).toBe(remote);
    expect(config.repositoryConfigName).toBe(expectedName);
    expect(config.externalRepositoryConfigDir).toBe(expectedRepositoryDir);
    expect(config.resolvedConfigPath).toBe(
      path.join(expectedRepositoryDir, '.rmfilter', 'config', 'tim.yml')
    );

    const loggedMessage = logSpy.mock.calls.at(-1)?.[0];
    expect(typeof loggedMessage).toBe('string');
    const messageText = loggedMessage as string;
    expect(messageText).toBe(`Using external tim storage at ${expectedRepositoryDir}`);
  });

  test('loadEffectiveConfig redacts credentials and tokens from remote logging output', async () => {
    await fs.rm(path.join(configDir, 'tim.yml'), { force: true });

    await $`git init`.cwd(testDir).quiet();
    const remote = 'https://user:super-secret-token@github.com/Owner/Repo.git?token=abc#frag';
    await $`git remote add origin ${remote}`.cwd(testDir).quiet();

    await loadEffectiveConfig();

    const loggedMessage = logSpy.mock.calls.at(-1)?.[0];
    expect(typeof loggedMessage).toBe('string');
    const messageText = loggedMessage as string;

    // The simplified message doesn't include remote URL, so no credentials to leak
    expect(messageText).not.toMatch(/super-secret-token/);
    expect(messageText).not.toMatch(/token=abc/);
    expect(messageText).not.toMatch(/x-oauth-basic/);
  });

  test('loadEffectiveConfig applies tags allowlist overrides from local config', async () => {
    const mainConfigPath = path.join(configDir, 'tim.yml');
    const tasksPath = path.join(testDir, 'tasks');
    await fs.mkdir(tasksPath, { recursive: true });
    const mainConfig = yaml.stringify({
      paths: { tasks: tasksPath },
      tags: { allowed: ['frontend', 'backend'] },
    });
    await fs.writeFile(mainConfigPath, mainConfig, 'utf-8');

    const localConfigPath = path.join(configDir, 'tim.local.yml');
    const localConfig = yaml.stringify({
      tags: { allowed: ['urgent'] },
    });
    await fs.writeFile(localConfigPath, localConfig, 'utf-8');

    const config = await loadEffectiveConfig();
    expect(config.tags?.allowed).toEqual(['urgent']);
  });

  test('findConfigPath falls back to external repository config path when default config does not exist', async () => {
    await fs.rm(path.join(configDir, 'tim.yml'), { force: true });

    const repositoryName = fallbackRepositoryNameFromGitRoot(testDir);
    const expectedConfigPath = path.join(
      fakeHomeDir,
      '.config',
      'tim',
      'repositories',
      repositoryName,
      '.rmfilter',
      'config',
      'tim.yml'
    );
    const expectedTasksDir = path.join(
      fakeHomeDir,
      '.config',
      'tim',
      'repositories',
      repositoryName,
      'tasks'
    );

    const result = await findConfigPath();

    expect(result).toBe(expectedConfigPath);
    const configDirStats = await fs.stat(path.dirname(expectedConfigPath));
    expect(configDirStats.isDirectory()).toBe(true);
    const tasksDirStats = await fs.stat(expectedTasksDir);
    expect(tasksDirStats.isDirectory()).toBe(true);
  });

  test('findConfigPath returns override path when provided', async () => {
    const overridePath = path.join(testDir, 'override-config.yml');
    await fs.writeFile(overridePath, 'postApplyCommands: []');

    const result = await findConfigPath(overridePath);
    expect(result).toBe(path.resolve(overridePath));
  });

  test('loadConfig returns default config when configPath is null', async () => {
    const config = await loadConfig(null);

    expect(config).toHaveProperty('postApplyCommands');
    expect(config.postApplyCommands).toEqual([]);
    expect(config).toHaveProperty('defaultExecutor', DEFAULT_EXECUTOR); // Our new default
  });

  describe('loadConfig with workspaceCreation', () => {
    test('should return default config when configPath is null', async () => {
      const config = await loadConfig(null);
      expect(config).toEqual({
        issueTracker: 'github',
        defaultExecutor: DEFAULT_EXECUTOR,
        assignments: { staleTimeout: 7 },
        postApplyCommands: [],
        prCreation: { draft: true },
        workspaceCreation: undefined,
      });
    });

    test('should load config with workspaceCreation undefined', async () => {
      const configYaml = `
postApplyCommands:
  - title: Test Command
    command: echo "test"
`;
      const configPath = path.join(tempDir, 'config.yml');
      await createTestFile(configPath, configYaml);

      const config = await loadConfig(configPath);

      expect(config).toHaveProperty('postApplyCommands');
      expect(config.postApplyCommands).toHaveLength(1);
      expect(config.postApplyCommands?.[0].title).toBe('Test Command');
    });

    test('findLocalConfigPath returns local config path when it exists', async () => {
      const mainConfigPath = path.join(configDir, 'tim.yml');
      const localConfigPath = path.join(configDir, 'tim.local.yml');

      await fs.writeFile(mainConfigPath, 'defaultExecutor: direct-call');
      await fs.writeFile(localConfigPath, `defaultExecutor: ${DEFAULT_EXECUTOR}`);

      const result = await findLocalConfigPath(mainConfigPath);
      expect(result).toBe(localConfigPath);
    });

    test('findLocalConfigPath returns null when local config does not exist', async () => {
      const mainConfigPath = path.join(configDir, 'tim.yml');
      const localConfigPath = path.join(configDir, 'tim.local.yml');

      await fs.writeFile(mainConfigPath, 'defaultExecutor: direct-call');

      // Remove any existing local config
      try {
        await fs.unlink(localConfigPath);
      } catch (e) {
        // Ignore errors if file doesn't exist
      }

      const result = await findLocalConfigPath(mainConfigPath);
      expect(result).toBeNull();
    });

    test('loadEffectiveConfig loads and merges local config', async () => {
      const mainConfigPath = path.join(configDir, 'tim.yml');
      const localConfigPath = path.join(configDir, 'tim.local.yml');

      await fs.writeFile(
        mainConfigPath,
        `
defaultExecutor: direct-call
postApplyCommands:
  - title: Main Command
    command: echo "main"
`
      );

      await fs.writeFile(
        localConfigPath,
        `
defaultExecutor: ${DEFAULT_EXECUTOR}
`
      );

      const config = await loadEffectiveConfig();

      // Local config should override main config
      expect(config).toHaveProperty('defaultExecutor', DEFAULT_EXECUTOR);
      expect(config.isUsingExternalStorage).toBe(false);

      // Properties not in local config should remain from main config
      expect(config).toHaveProperty('postApplyCommands');
      expect(config.postApplyCommands).toHaveLength(1);
      expect(config.postApplyCommands?.[0].title).toBe('Main Command');
    });

    test('loadEffectiveConfig merges global config before repository config', async () => {
      // Re-enable global config loading for this test
      const originalEnv = process.env.TIM_LOAD_GLOBAL_CONFIG;
      delete process.env.TIM_LOAD_GLOBAL_CONFIG;

      try {
        const globalConfigPath = path.join(fakeHomeDir, '.config', 'tim', 'config.yml');
        await fs.mkdir(path.dirname(globalConfigPath), { recursive: true });
        await fs.writeFile(
          globalConfigPath,
          yaml.stringify({
            defaultExecutor: 'copy-only',
            models: { execution: 'global-exec' },
            postApplyCommands: [
              {
                title: 'Global Command',
                command: 'echo "global"',
              },
            ],
          }),
          'utf-8'
        );

        const mainConfigPath = path.join(configDir, 'tim.yml');
        await fs.writeFile(
          mainConfigPath,
          yaml.stringify({
            defaultExecutor: 'direct-call',
            models: { convert_yaml: 'repo-convert' },
            postApplyCommands: [
              {
                title: 'Repo Command',
                command: 'echo "repo"',
              },
            ],
          }),
          'utf-8'
        );

        const config = await loadEffectiveConfig();

        expect(config.defaultExecutor).toBe('direct-call');
        expect(config.models?.execution).toBe('global-exec');
        expect(config.models?.convert_yaml).toBe('repo-convert');
        expect(config.postApplyCommands?.map((command) => command.title)).toEqual([
          'Global Command',
          'Repo Command',
        ]);
      } finally {
        if (originalEnv !== undefined) {
          process.env.TIM_LOAD_GLOBAL_CONFIG = originalEnv;
        }
      }
    });

    test('loadEffectiveConfig skips global merge when override path matches global config', async () => {
      // Re-enable global config loading for this test
      const originalEnv = process.env.TIM_LOAD_GLOBAL_CONFIG;
      delete process.env.TIM_LOAD_GLOBAL_CONFIG;

      try {
        const globalConfigPath = path.join(fakeHomeDir, '.config', 'tim', 'config.yml');
        await fs.mkdir(path.dirname(globalConfigPath), { recursive: true });
        await fs.writeFile(
          globalConfigPath,
          yaml.stringify({
            postApplyCommands: [
              {
                title: 'Global Command',
                command: 'echo "global"',
              },
            ],
            autoexamples: ['global-example'],
          }),
          'utf-8'
        );

        const config = await loadEffectiveConfig(globalConfigPath);

        expect(config.postApplyCommands).toHaveLength(1);
        expect(config.postApplyCommands?.[0].title).toBe('Global Command');
        expect(config.autoexamples).toEqual(['global-example']);
      } finally {
        if (originalEnv !== undefined) {
          process.env.TIM_LOAD_GLOBAL_CONFIG = originalEnv;
        }
      }
    });

    test('loadEffectiveConfig allows repository notification disable without command', async () => {
      // Re-enable global config loading for this test
      const originalEnv = process.env.TIM_LOAD_GLOBAL_CONFIG;
      delete process.env.TIM_LOAD_GLOBAL_CONFIG;

      try {
        const globalConfigPath = path.join(fakeHomeDir, '.config', 'tim', 'config.yml');
        await fs.mkdir(path.dirname(globalConfigPath), { recursive: true });
        await fs.writeFile(
          globalConfigPath,
          yaml.stringify({
            notifications: {
              command: 'notify',
            },
          }),
          'utf-8'
        );

        const mainConfigPath = path.join(configDir, 'tim.yml');
        await fs.writeFile(
          mainConfigPath,
          yaml.stringify({
            notifications: {
              enabled: false,
            },
          }),
          'utf-8'
        );

        const config = await loadEffectiveConfig();

        expect(config.notifications?.enabled).toBe(false);
        expect(config.notifications?.command).toBe('notify');
      } finally {
        if (originalEnv !== undefined) {
          process.env.TIM_LOAD_GLOBAL_CONFIG = originalEnv;
        }
      }
    });

    test('loadEffectiveConfig throws when notifications lack a command and are enabled', async () => {
      const mainConfigPath = path.join(configDir, 'tim.yml');
      await fs.writeFile(
        mainConfigPath,
        yaml.stringify({
          notifications: {
            env: { NOTIFY_TOKEN: 'token' },
          },
        }),
        'utf-8'
      );

      await expect(loadEffectiveConfig()).rejects.toThrow(
        'Notification command is required unless notifications are disabled.'
      );
    });

    test('loadEffectiveConfig applies local overrides over global and repository configs', async () => {
      // Re-enable global config loading for this test
      const originalEnv = process.env.TIM_LOAD_GLOBAL_CONFIG;
      delete process.env.TIM_LOAD_GLOBAL_CONFIG;

      try {
        const globalConfigPath = path.join(fakeHomeDir, '.config', 'tim', 'config.yml');
        await fs.mkdir(path.dirname(globalConfigPath), { recursive: true });
        await fs.writeFile(
          globalConfigPath,
          yaml.stringify({
            defaultExecutor: 'copy-only',
            models: { execution: 'global-exec' },
          }),
          'utf-8'
        );

        const mainConfigPath = path.join(configDir, 'tim.yml');
        await fs.writeFile(
          mainConfigPath,
          yaml.stringify({
            defaultExecutor: 'direct-call',
            models: { convert_yaml: 'repo-convert' },
          }),
          'utf-8'
        );

        const localConfigPath = path.join(configDir, 'tim.local.yml');
        await fs.writeFile(
          localConfigPath,
          yaml.stringify({
            defaultExecutor: 'copy-paste',
            models: { execution: 'local-exec' },
          }),
          'utf-8'
        );

        const config = await loadEffectiveConfig();

        expect(config.defaultExecutor).toBe('copy-paste');
        expect(config.models?.execution).toBe('local-exec');
        expect(config.models?.convert_yaml).toBe('repo-convert');
      } finally {
        if (originalEnv !== undefined) {
          process.env.TIM_LOAD_GLOBAL_CONFIG = originalEnv;
        }
      }
    });

    test('loadEffectiveConfig uses main config when local config has validation errors', async () => {
      const mainConfigPath = path.join(configDir, 'tim.yml');
      const localConfigPath = path.join(configDir, 'tim.local.yml');

      await fs.writeFile(
        mainConfigPath,
        `
defaultExecutor: direct-call
postApplyCommands:
  - title: Main Command
    command: echo "main"
`
      );

      // Invalid configuration (not invalid YAML) in local config
      await fs.writeFile(
        localConfigPath,
        `
defaultExecutor: copy-only
postApplyCommands:
  - title: Missing command field
`
      );

      const config = await loadEffectiveConfig();

      // Should fall back to main config
      expect(config).toHaveProperty('defaultExecutor', 'direct-call');
      expect(config).toHaveProperty('postApplyCommands');
      expect(config.postApplyCommands).toHaveLength(1);
    });

    test('loadEffectiveConfig deeply merges nested objects and arrays', async () => {
      const mainConfigPath = path.join(configDir, 'tim.yml');
      const localConfigPath = path.join(configDir, 'tim.local.yml');

      await fs.writeFile(
        mainConfigPath,
        `
defaultExecutor: direct-call
postApplyCommands:
  - title: Main Command
    command: echo "main"
paths:
  tasks: "./main-tasks"
models:
  execution: "claude-3-sonnet"
autoexamples:
  - "main-example"
`
      );

      await fs.writeFile(
        localConfigPath,
        `
defaultExecutor: ${DEFAULT_EXECUTOR}
postApplyCommands:
  - title: Local Command
    command: echo "local"
paths:
  tasks: "./local-tasks"
models:
  convert_yaml: "claude-3-haiku"
autoexamples:
  - "local-example"
`
      );

      const config = await loadEffectiveConfig();

      // Local should override main for simple properties
      expect(config.defaultExecutor).toBe(DEFAULT_EXECUTOR);

      // Arrays should be concatenated
      expect(config.postApplyCommands).toHaveLength(2);
      expect(config.postApplyCommands?.[0].title).toBe('Main Command');
      expect(config.postApplyCommands?.[1].title).toBe('Local Command');

      expect(config.autoexamples).toHaveLength(2);
      expect(config.autoexamples).toContain('main-example');
      expect(config.autoexamples).toContain('local-example');

      // Objects should be deeply merged
      expect(config.paths?.tasks).toBe('./local-tasks'); // local overrides main

      expect(config.models?.execution).toBe('claude-3-sonnet'); // from main
      expect(config.models?.convert_yaml).toBe('claude-3-haiku'); // from local
    });

    test('loadEffectiveConfig merges executors field correctly', async () => {
      const mainConfigPath = path.join(configDir, 'tim.yml');
      const localConfigPath = path.join(configDir, 'tim.local.yml');

      await fs.writeFile(
        mainConfigPath,
        `
defaultExecutor: direct-call
executors:
  "claude-code":
    allowedTools: ["tool1", "tool2"]
    includeDefaultTools: false
    permissionsMcp:
      enabled: true
  "copy-only": {}
`
      );

      await fs.writeFile(
        localConfigPath,
        `
executors:
  "claude-code":
    includeDefaultTools: true
    mcpConfigFile: "/path/to/config"
  "direct-call":
    executionModel: "gpt-4"
`
      );

      const config = await loadEffectiveConfig();

      // Check that executors are properly merged
      expect(config.executors).toBeDefined();

      // claude-code should have merged options from both configs
      expect(config.executors?.['claude-code']).toEqual({
        allowedTools: ['tool1', 'tool2'], // from main
        includeDefaultTools: true, // from local (overrides main)
        permissionsMcp: {
          autoApproveCreatedFileDeletion: false,
          enabled: true,
        }, // from main
        mcpConfigFile: '/path/to/config', // from local
      });

      // copy-only should only have options from main
      expect(config.executors?.['copy-only']).toEqual({});

      // direct-call should only have options from local
      expect(config.executors?.['direct-call']).toEqual({
        executionModel: 'gpt-4',
      });
    });
  });

  describe('config with workspaceCreation configurations', () => {
    test('should load config with workspaceCreation', async () => {
      const configYaml = `
workspaceCreation:
  repositoryUrl: https://github.com/example/repo.git
  cloneLocation: ~/llmutils-workspaces
  postCloneCommands:
    - title: Install Dependencies
      command: npm install
`;
      const configPath = path.join(tempDir, 'config.yml');
      await createTestFile(configPath, configYaml);

      const config = await loadConfig(configPath);
      expect(config.workspaceCreation).toBeDefined();
      expect(config.workspaceCreation!.repositoryUrl).toBe('https://github.com/example/repo.git');
      expect(config.workspaceCreation!.cloneLocation).toBe('~/llmutils-workspaces');
      expect(config.workspaceCreation!.postCloneCommands).toHaveLength(1);
      expect(config.workspaceCreation!.postCloneCommands![0].title).toBe('Install Dependencies');
    });

    test('should handle empty workspaceCreation object', async () => {
      const configYaml = `
workspaceCreation: {}
`;
      const configPath = path.join(tempDir, 'config.yml');
      await createTestFile(configPath, configYaml);

      const config = await loadConfig(configPath);
      expect(config.workspaceCreation).toEqual({});
    });
  });

  describe('config with planning.direct_mode configuration', () => {
    test('loadEffectiveConfig should parse and validate planning.direct_mode: true', async () => {
      const mainConfigPath = path.join(configDir, 'tim.yml');

      await fs.writeFile(
        mainConfigPath,
        `
defaultExecutor: direct-call
planning:
  direct_mode: true
paths:
  tasks: "./tasks"
`
      );

      const config = await loadEffectiveConfig();

      // Check that planning.direct_mode is properly parsed
      expect(config.planning).toBeDefined();
      expect(config.planning?.direct_mode).toBe(true);
    });

    test('loadEffectiveConfig should parse and validate planning.direct_mode: false', async () => {
      const mainConfigPath = path.join(configDir, 'tim.yml');

      await fs.writeFile(
        mainConfigPath,
        `
defaultExecutor: direct-call
planning:
  direct_mode: false
paths:
  tasks: "./tasks"
`
      );

      const config = await loadEffectiveConfig();

      // Check that planning.direct_mode is properly parsed
      expect(config.planning).toBeDefined();
      expect(config.planning?.direct_mode).toBe(false);
    });

    test('loadEffectiveConfig should handle missing planning section', async () => {
      const mainConfigPath = path.join(configDir, 'tim.yml');

      await fs.writeFile(
        mainConfigPath,
        `
defaultExecutor: direct-call
paths:
  tasks: "./tasks"
`
      );

      const config = await loadEffectiveConfig();

      // Check that planning is undefined when not specified
      expect(config.planning).toBeUndefined();
    });

    test('loadEffectiveConfig merges planning section from local config', async () => {
      const mainConfigPath = path.join(configDir, 'tim.yml');
      const localConfigPath = path.join(configDir, 'tim.local.yml');

      await fs.writeFile(
        mainConfigPath,
        `
defaultExecutor: direct-call
planning:
  direct_mode: false
paths:
  tasks: "./tasks"
`
      );

      await fs.writeFile(
        localConfigPath,
        `
planning:
  direct_mode: true
`
      );

      const config = await loadEffectiveConfig();

      // Local config should override main config for planning.direct_mode
      expect(config.planning).toBeDefined();
      expect(config.planning?.direct_mode).toBe(true);
    });

    test('loadEffectiveConfig merges issueTracker from local config', async () => {
      const mainConfigPath = path.join(configDir, 'tim.yml');
      const localConfigPath = path.join(configDir, 'tim.local.yml');

      await fs.writeFile(
        mainConfigPath,
        `
defaultExecutor: direct-call
issueTracker: github
paths:
  tasks: "./tasks"
`
      );

      await fs.writeFile(
        localConfigPath,
        `
issueTracker: linear
`
      );

      const config = await loadEffectiveConfig();

      // Local config should override main config for issueTracker
      expect(config.issueTracker).toBe('linear');
    });

    test('loadEffectiveConfig applies default issueTracker when not specified in configs', async () => {
      const mainConfigPath = path.join(configDir, 'tim.yml');

      await fs.writeFile(
        mainConfigPath,
        `
defaultExecutor: direct-call
paths:
  tasks: "./tasks"
`
      );

      const config = await loadEffectiveConfig();

      expect(config.issueTracker).toBe('github');
    });

    test('loadEffectiveConfig keeps defaults when repository config is partial', async () => {
      const mainConfigPath = path.join(configDir, 'tim.yml');

      await fs.writeFile(
        mainConfigPath,
        `
paths:
  tasks: "./tasks"
`
      );

      const config = await loadEffectiveConfig();

      expect(config.issueTracker).toBe('github');
      expect(config.defaultExecutor).toBe(DEFAULT_EXECUTOR);
      expect(config.prCreation?.draft).toBe(true);
      expect(config.assignments?.staleTimeout).toBe(7);
    });

    test('loadEffectiveConfig keeps defaults with global config and local overrides', async () => {
      // Re-enable global config loading for this test
      const originalEnv = process.env.TIM_LOAD_GLOBAL_CONFIG;
      delete process.env.TIM_LOAD_GLOBAL_CONFIG;

      try {
        const globalConfigPath = path.join(fakeHomeDir, '.config', 'tim', 'config.yml');
        await fs.mkdir(path.dirname(globalConfigPath), { recursive: true });
        await fs.writeFile(
          globalConfigPath,
          yaml.stringify({
            issueTracker: 'linear',
          }),
          'utf-8'
        );

        const mainConfigPath = path.join(configDir, 'tim.yml');
        await fs.writeFile(
          mainConfigPath,
          `
paths:
  tasks: "./tasks"
`
        );

        const localConfigPath = path.join(configDir, 'tim.local.yml');
        await fs.writeFile(
          localConfigPath,
          yaml.stringify({
            prCreation: { draft: false },
          }),
          'utf-8'
        );

        const config = await loadEffectiveConfig();

        expect(config.issueTracker).toBe('linear');
        expect(config.defaultExecutor).toBe(DEFAULT_EXECUTOR);
        expect(config.prCreation?.draft).toBe(false);
        expect(config.assignments?.staleTimeout).toBe(7);
      } finally {
        if (originalEnv !== undefined) {
          process.env.TIM_LOAD_GLOBAL_CONFIG = originalEnv;
        }
      }
    });
  });
});
