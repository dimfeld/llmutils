import { test, describe, expect, afterEach, beforeEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  findConfigPath,
  loadConfig,
  findLocalConfigPath,
  loadEffectiveConfig,
} from './configLoader';

// Silence logs during tests
void mock.module('../logging.js', () => ({
  debugLog: () => {},
  log: () => {},
  error: () => {},
  warn: () => {},
}));
import { type RmplanConfig, type WorkspaceCreationConfig } from './configSchema.js';

// Since js-yaml isn't working in tests, we'll use yaml
import yaml from 'yaml';

beforeEach(() => {
  // Mock js-yaml to use yaml package
  mock.module('js-yaml', () => ({
    load: (content: string) => yaml.parse(content),
  }));

  // Mock logging
  mock.module('../logging.js', () => ({
    debugLog: mock.fn(),
    error: mock.fn(),
    log: mock.fn(),
  }));

  // Mock utils
  mock.module('../rmfilter/utils.js', () => ({
    getGitRoot: mock.fn(() => Promise.resolve('/fake/git/root')),
    quiet: false,
  }));

  // Setup mock for Bun.file
  const mockFileContents = new Map<string, string>();

  // Default mock file implementation
  const mockFile = {
    text: mock.fn().mockImplementation(async function () {
      const path = (this as any).__path;
      return mockFileContents.get(path) || '';
    }),
    exists: mock.fn().mockImplementation(async function () {
      const path = (this as any).__path;
      return mockFileContents.has(path);
    }),
  };

  // Override Bun.file
  const originalBunFile = Bun.file;
  Bun.file = function (path: string) {
    const mockResult = { ...mockFile, __path: path };
    return mockResult as any;
  } as any;

  // Add test helper to global context
  (global as any).addMockFile = (path: string, content: string) => {
    mockFileContents.set(path, content);
  };

  // Cleanup helper
  (global as any).cleanupMockFiles = () => {
    mockFileContents.clear();
    Bun.file = originalBunFile;
  };
});

// Import after mocks are set up
import { loadConfig } from './configLoader.js';

describe('configLoader', () => {
  let testDir: string;
  let configDir: string;

  beforeEach(async () => {
    // Create a unique temporary directory for each test
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-config-test-'));
    configDir = path.join(testDir, '.rmfilter', 'config');

    // Mock the getGitRoot function to return our test directory
    void mock.module('../rmfilter/utils.js', () => ({
      getGitRoot: async () => testDir,
      quiet: false,
    }));

    // Create test directories
    await fs.mkdir(configDir, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup test directory
    await fs.rm(testDir, { recursive: true, force: true });
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
    expect(config).toHaveProperty('defaultExecutor', 'copy-only'); // Our new default
  });

  describe('loadConfig with workspaceCreation', () => {
    test('should return default config when configPath is null', async () => {
      const config = await loadConfig(null);
      expect(config).toEqual({
        postApplyCommands: [],
        workspaceCreation: undefined,
      });
    });

    test('should load config with workspaceCreation undefined', async () => {
      const configYaml = `
postApplyCommands:
  - title: Test Command
    command: echo "test"
`
    );

    const config = await loadConfig(configPath);

    expect(config).toHaveProperty('defaultExecutor', 'direct-call');
    expect(config).toHaveProperty('postApplyCommands');
    expect(config.postApplyCommands).toHaveLength(1);
    expect(config.postApplyCommands?.[0].title).toBe('Test Command');
  });

  test('findLocalConfigPath returns local config path when it exists', async () => {
    const mainConfigPath = path.join(configDir, 'rmplan.yml');
    const localConfigPath = path.join(configDir, 'rmplan.local.yml');

    await fs.writeFile(mainConfigPath, 'defaultExecutor: direct-call');
    await fs.writeFile(localConfigPath, 'defaultExecutor: copy-only');

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
defaultExecutor: copy-only
`
    );

    const config = await loadEffectiveConfig();

    // Local config should override main config
    expect(config).toHaveProperty('defaultExecutor', 'copy-only');

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
defaultExecutor: direct-call
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
defaultExecutor: copy-only
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
    expect(config.defaultExecutor).toBe('copy-only');

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
});
    command: echo hello
`;
      (global as any).addMockFile('/test/config.yml', configYaml);

      const config = await loadConfig('/test/config.yml');
      expect(config.postApplyCommands).toHaveLength(1);
      expect(config.postApplyCommands![0].title).toBe('Test Command');
      expect(config.workspaceCreation).toBeUndefined();
    });

    test('should load config with workspaceCreation method script', async () => {
      const configYaml = `
workspaceCreation:
  method: script
  scriptPath: /path/to/script.sh
`;
      (global as any).addMockFile('/test/config.yml', configYaml);

      const config = await loadConfig('/test/config.yml');
      expect(config.workspaceCreation).toBeDefined();
      expect(config.workspaceCreation!.method).toBe('script');
      expect(config.workspaceCreation!.scriptPath).toBe('/path/to/script.sh');
    });

    test('should load config with workspaceCreation method llmutils', async () => {
      const configYaml = `
workspaceCreation:
  method: llmutils
  repositoryUrl: https://github.com/example/repo.git
  cloneLocation: ~/llmutils-workspaces
  postCloneCommands:
    - title: Install Dependencies
      command: npm install
`;
      (global as any).addMockFile('/test/config.yml', configYaml);

      const config = await loadConfig('/test/config.yml');
      expect(config.workspaceCreation).toBeDefined();
      expect(config.workspaceCreation!.method).toBe('llmutils');
      expect(config.workspaceCreation!.repositoryUrl).toBe('https://github.com/example/repo.git');
      expect(config.workspaceCreation!.cloneLocation).toBe('~/llmutils-workspaces');
      expect(config.workspaceCreation!.postCloneCommands).toHaveLength(1);
      expect(config.workspaceCreation!.postCloneCommands![0].title).toBe('Install Dependencies');
    });

    test('should fail validation when method is script but scriptPath is missing', async () => {
      const configYaml = `
workspaceCreation:
  method: script
`;
      (global as any).addMockFile('/test/config.yml', configYaml);

      await expect(loadConfig('/test/config.yml')).rejects.toThrow(
        /When method is 'script', scriptPath must be provided/
      );
    });

    test('should handle empty workspaceCreation object', async () => {
      const configYaml = `
workspaceCreation: {}
`;
      (global as any).addMockFile('/test/config.yml', configYaml);

      const config = await loadConfig('/test/config.yml');
      expect(config.workspaceCreation).toEqual({});
    });

    afterEach(() => {
      (global as any).cleanupMockFiles();
    });
  });
});
