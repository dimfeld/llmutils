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

// Since js-yaml isn't working in tests, we'll use yaml
import yaml from 'yaml';

// Test state
let tempDir: string;

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
    log: mock(() => {}),
    warn: mock(() => {}),
  }));

  // Mock utils
  await moduleMocker.mock('../rmfilter/utils.js', () => ({
    getGitRoot: mock(() => Promise.resolve('/fake/git/root')),
    quiet: false,
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

  test('findConfigPath returns null when default path does not exist', async () => {
    // Remove any existing config file
    try {
      await fs.unlink(path.join(configDir, 'rmplan.yml'));
    } catch (e) {
      // Ignore errors if file doesn't exist
    }

    const result = await findConfigPath();
    expect(result).toBeNull();
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
  });
});
