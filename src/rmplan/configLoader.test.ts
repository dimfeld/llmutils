import { test, describe, expect, afterEach, beforeEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { findConfigPath, loadConfig, findLocalConfigPath, loadEffectiveConfig } from './configLoader';

// Silence logs during tests
void mock.module('../logging.js', () => ({
  debugLog: () => {},
  log: () => {},
  error: () => {},
  warn: () => {},
}));

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
    expect(config).toHaveProperty('defaultExecutor', 'CopyOnlyExecutor'); // Our new default
  });

  test('loadConfig loads valid config file', async () => {
    const configPath = path.join(testDir, 'valid-config.yml');
    await fs.writeFile(configPath, `
defaultExecutor: OneCallExecutor
postApplyCommands:
  - title: Test Command
    command: echo "test"
`);
    
    const config = await loadConfig(configPath);
    
    expect(config).toHaveProperty('defaultExecutor', 'OneCallExecutor');
    expect(config).toHaveProperty('postApplyCommands');
    expect(config.postApplyCommands).toHaveLength(1);
    expect(config.postApplyCommands[0].title).toBe('Test Command');
  });

  test('findLocalConfigPath returns local config path when it exists', async () => {
    const mainConfigPath = path.join(configDir, 'rmplan.yml');
    const localConfigPath = path.join(configDir, 'rmplan.local.yml');
    
    await fs.writeFile(mainConfigPath, 'defaultExecutor: OneCallExecutor');
    await fs.writeFile(localConfigPath, 'defaultExecutor: CopyOnlyExecutor');
    
    const result = await findLocalConfigPath(mainConfigPath);
    expect(result).toBe(localConfigPath);
  });

  test('findLocalConfigPath returns null when local config does not exist', async () => {
    const mainConfigPath = path.join(configDir, 'rmplan.yml');
    const localConfigPath = path.join(configDir, 'rmplan.local.yml');
    
    await fs.writeFile(mainConfigPath, 'defaultExecutor: OneCallExecutor');
    
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
    
    await fs.writeFile(mainConfigPath, `
defaultExecutor: OneCallExecutor
postApplyCommands:
  - title: Main Command
    command: echo "main"
`);
    
    await fs.writeFile(localConfigPath, `
defaultExecutor: CopyOnlyExecutor
`);
    
    const config = await loadEffectiveConfig();
    
    // Local config should override main config
    expect(config).toHaveProperty('defaultExecutor', 'CopyOnlyExecutor');
    
    // Properties not in local config should remain from main config
    expect(config).toHaveProperty('postApplyCommands');
    expect(config.postApplyCommands).toHaveLength(1);
    expect(config.postApplyCommands[0].title).toBe('Main Command');
  });

  test('loadEffectiveConfig uses main config when local config has validation errors', async () => {
    const mainConfigPath = path.join(configDir, 'rmplan.yml');
    const localConfigPath = path.join(configDir, 'rmplan.local.yml');
    
    await fs.writeFile(mainConfigPath, `
defaultExecutor: OneCallExecutor
postApplyCommands:
  - title: Main Command
    command: echo "main"
`);
    
    // Invalid configuration (not invalid YAML) in local config
    await fs.writeFile(localConfigPath, `
defaultExecutor: OneCallExecutor
postApplyCommands:
  - title: Missing command field
`);
    
    const config = await loadEffectiveConfig();
    
    // Should fall back to main config
    expect(config).toHaveProperty('defaultExecutor', 'OneCallExecutor');
    expect(config).toHaveProperty('postApplyCommands');
    expect(config.postApplyCommands).toHaveLength(1);
  });
});