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
import { type RmplanConfig, type WorkspaceCreationConfig } from './configSchema.js';
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
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-config-test-'));
    configDir = path.join(testDir, '.rmfilter', 'config');

    fakeHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-home-'));

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
    // Clear mocks after each test
    moduleMocker.clear();
    // Clear the config cache again
    clearConfigCache();
  });

  test('findConfigPath returns default path when it exists', async () => {
    const defaultConfigPath = path.join(configDir, 'rmplan.yml');
    await fs.writeFile(defaultConfigPath, 'postApplyCommands: []');

    const result = await findConfigPath();
    expect(result).toBe(defaultConfigPath);
  });

  test('loadEffectiveConfig returns default config using external storage when repository lacks config', async () => {
    await fs.rm(path.join(configDir, 'rmplan.yml'), { force: true });

    const repositoryName = fallbackRepositoryNameFromGitRoot(testDir);
    const expectedRepositoryDir = path.join(
      fakeHomeDir,
      '.config',
      'rmfilter',
      'repositories',
      repositoryName
    );

    const config = await loadEffectiveConfig();

    expect(config.isUsingExternalStorage).toBe(true);
    expect(config.externalRepositoryConfigDir).toBe(expectedRepositoryDir);
    const loggedMessage = logSpy.mock.calls.at(-1)?.[0];
    expect(typeof loggedMessage).toBe('string');
    const messageText = loggedMessage as string;
    expect(messageText).toContain(`Base directory: ${expectedRepositoryDir}`);
    expect(messageText).toContain(
      `Configuration file: ${path.join(expectedRepositoryDir, '.rmfilter', 'config', 'rmplan.yml')}`
    );
    expect(messageText).toContain(`Plan directory: ${path.join(expectedRepositoryDir, 'tasks')}`);
    expect(messageText).toContain('Remote origin: none detected');
    expect(messageText).toContain(
      `Add ${path.join(testDir, '.rmfilter', 'config', 'rmplan.yml')} to store rmplan data inside the repository.`
    );
  });

  test('loadEffectiveConfig captures repository metadata from remote when using external storage', async () => {
    await fs.rm(path.join(configDir, 'rmplan.yml'), { force: true });

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
      'rmfilter',
      'repositories',
      expectedName
    );

    expect(config.repositoryRemoteUrl).toBe(remote);
    expect(config.repositoryConfigName).toBe(expectedName);
    expect(config.externalRepositoryConfigDir).toBe(expectedRepositoryDir);
    expect(config.resolvedConfigPath).toBe(
      path.join(expectedRepositoryDir, '.rmfilter', 'config', 'rmplan.yml')
    );

    const loggedMessage = logSpy.mock.calls.at(-1)?.[0];
    expect(typeof loggedMessage).toBe('string');
    const messageText = loggedMessage as string;
    const expectedRemoteDetails =
      parsedRemote?.fullName && parsedRemote.host
        ? `${parsedRemote.host}/${parsedRemote.fullName}`
        : remote;
    expect(messageText).toContain(`Remote origin: ${expectedRemoteDetails}`);
    expect(messageText).toContain(`Base directory: ${expectedRepositoryDir}`);
    expect(messageText).toContain('Using external rmplan storage for');
  });

  test('findConfigPath falls back to external repository config path when default config does not exist', async () => {
    await fs.rm(path.join(configDir, 'rmplan.yml'), { force: true });

    const repositoryName = fallbackRepositoryNameFromGitRoot(testDir);
    const expectedConfigPath = path.join(
      fakeHomeDir,
      '.config',
      'rmfilter',
      'repositories',
      repositoryName,
      '.rmfilter',
      'config',
      'rmplan.yml'
    );
    const expectedTasksDir = path.join(
      fakeHomeDir,
      '.config',
      'rmfilter',
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
      const mainConfigPath = path.join(configDir, 'rmplan.yml');
      const localConfigPath = path.join(configDir, 'rmplan.local.yml');

      await fs.writeFile(mainConfigPath, 'defaultExecutor: direct-call');
      await fs.writeFile(localConfigPath, `defaultExecutor: ${DEFAULT_EXECUTOR}`);

      const result = await findLocalConfigPath(mainConfigPath);
      expect(result).toBe(localConfigPath);
    });

    test('findLocalConfigPath returns null when local config does not exist', async () => {
      const mainConfigPath = path.join(configDir, 'rmplan.yml');
      const localConfigPath = path.join(configDir, 'rmplan.local.yml');

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
      const mainConfigPath = path.join(configDir, 'rmplan.yml');
      const localConfigPath = path.join(configDir, 'rmplan.local.yml');

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

    test('loadEffectiveConfig uses main config when local config has validation errors', async () => {
      const mainConfigPath = path.join(configDir, 'rmplan.yml');
      const localConfigPath = path.join(configDir, 'rmplan.local.yml');

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
      const mainConfigPath = path.join(configDir, 'rmplan.yml');
      const localConfigPath = path.join(configDir, 'rmplan.local.yml');

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
      const mainConfigPath = path.join(configDir, 'rmplan.yml');
      const localConfigPath = path.join(configDir, 'rmplan.local.yml');

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
        permissionsMcp: { enabled: true }, // from main
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
      const mainConfigPath = path.join(configDir, 'rmplan.yml');

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
      const mainConfigPath = path.join(configDir, 'rmplan.yml');

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
      const mainConfigPath = path.join(configDir, 'rmplan.yml');

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
      const mainConfigPath = path.join(configDir, 'rmplan.yml');
      const localConfigPath = path.join(configDir, 'rmplan.local.yml');

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
      const mainConfigPath = path.join(configDir, 'rmplan.yml');
      const localConfigPath = path.join(configDir, 'rmplan.local.yml');

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
      const mainConfigPath = path.join(configDir, 'rmplan.yml');

      await fs.writeFile(
        mainConfigPath,
        `
defaultExecutor: direct-call
paths:
  tasks: "./tasks"
`
      );

      const config = await loadEffectiveConfig();

      // Undefined so that local and global configs can properly override
      expect(config.issueTracker).toBeUndefined();
    });
  });
});
