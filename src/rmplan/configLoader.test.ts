import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import * as path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { type RmplanConfig, type WorkspaceCreationConfig } from './configSchema.js';

// Since js-yaml isn't working in tests, we'll use yaml
import yaml from 'yaml';

// Test state
let tempDir: string;

// Helper function to create a temporary directory structure for testing
async function createTempTestDir() {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'configLoader-test-'));
  return tempDir;
}

// Helper function to create test files
async function createTestFile(filePath: string, content: string) {
  await writeFile(filePath, content, 'utf-8');
}

beforeEach(async () => {
  // Mock js-yaml to use yaml package
  await mock.module('js-yaml', () => ({
    load: (content: string) => yaml.parse(content),
  }));

  // Mock logging
  await mock.module('../logging.js', () => ({
    debugLog: mock(() => {}),
    error: mock(() => {}),
    log: mock(() => {}),
  }));

  // Mock utils
  await mock.module('../rmfilter/utils.js', () => ({
    getGitRoot: mock(() => Promise.resolve('/fake/git/root')),
    quiet: false,
  }));

  // Create temporary directory for test files
  tempDir = await createTempTestDir();
});

afterEach(async () => {
  // Clean up temporary directory
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// Import after mocks are set up
import { loadConfig } from './configLoader.js';

describe('configLoader', () => {
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
    command: echo hello
`;
      const configPath = path.join(tempDir, 'config.yml');
      await createTestFile(configPath, configYaml);

      const config = await loadConfig(configPath);
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
      const configPath = path.join(tempDir, 'config.yml');
      await createTestFile(configPath, configYaml);

      const config = await loadConfig(configPath);
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
      const configPath = path.join(tempDir, 'config.yml');
      await createTestFile(configPath, configYaml);

      const config = await loadConfig(configPath);
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
      const configPath = path.join(tempDir, 'config.yml');
      await createTestFile(configPath, configYaml);

      expect(loadConfig(configPath)).rejects.toThrow(
        /When method is 'script', scriptPath must be provided/
      );
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
});