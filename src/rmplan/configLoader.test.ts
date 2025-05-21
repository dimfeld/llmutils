import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import * as path from 'node:path';
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
