import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as yaml from 'js-yaml';
import { clearConfigCache, loadConfig, loadEffectiveConfig } from '../configLoader.js';
import type { TimConfig } from '../configSchema.js';
import {
  ensureNodeId,
  getLocalNodeId,
  resolveNodeToken,
  resolveSyncConfig,
  validateSyncConfig,
} from './config.js';

describe('sync config helpers', () => {
  let tempDir: string;
  let originalXdgConfigHome: string | undefined;
  let originalLoadGlobalConfig: string | undefined;
  let originalEnvToken: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-sync-config-test-'));
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    originalLoadGlobalConfig = process.env.TIM_LOAD_GLOBAL_CONFIG;
    originalEnvToken = process.env.TIM_SYNC_TEST_TOKEN;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg');
    delete process.env.TIM_LOAD_GLOBAL_CONFIG;
    clearConfigCache();
  });

  afterEach(async () => {
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    if (originalLoadGlobalConfig === undefined) {
      delete process.env.TIM_LOAD_GLOBAL_CONFIG;
    } else {
      process.env.TIM_LOAD_GLOBAL_CONFIG = originalLoadGlobalConfig;
    }
    if (originalEnvToken === undefined) {
      delete process.env.TIM_SYNC_TEST_TOKEN;
    } else {
      process.env.TIM_SYNC_TEST_TOKEN = originalEnvToken;
    }
    clearConfigCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('resolves nodeToken directly', () => {
    expect(resolveNodeToken({ nodeToken: 'direct-token' })).toBe('direct-token');
  });

  test('resolves nodeToken from environment variable', () => {
    process.env.TIM_SYNC_TEST_TOKEN = 'env-token';
    expect(resolveNodeToken({ nodeTokenEnv: 'TIM_SYNC_TEST_TOKEN' })).toBe('env-token');
  });

  test('returns null for unset nodeTokenEnv', () => {
    delete process.env.TIM_SYNC_TEST_TOKEN;
    expect(resolveNodeToken({ nodeTokenEnv: 'TIM_SYNC_TEST_TOKEN' })).toBeNull();
  });

  test('disabled true prevents sync from being enabled', () => {
    const resolved = resolveSyncConfig({
      sync: {
        role: 'persistent',
        mainUrl: 'http://main.local',
        nodeToken: 'token',
        disabled: true,
      },
    } as TimConfig);

    expect(resolved.enabled).toBe(false);
    expect(resolved.disabled).toBe(true);
    expect(resolved.validationErrors).toEqual([]);
  });

  test('offline true is reported without making configured sync invalid', () => {
    const resolved = resolveSyncConfig({
      sync: {
        role: 'persistent',
        mainUrl: 'http://main.local',
        nodeToken: 'token',
        offline: true,
      },
    } as TimConfig);

    expect(resolved.enabled).toBe(true);
    expect(resolved.offline).toBe(true);
    expect(resolved.validationErrors).toEqual([]);
  });

  test('persistent node without mainUrl reports a validation error', () => {
    const resolved = resolveSyncConfig({
      sync: {
        role: 'persistent',
        nodeToken: 'token',
      },
    } as TimConfig);

    expect(resolved.enabled).toBe(false);
    expect(resolved.validationErrors).toContain(
      'sync.mainUrl is required for persistent sync nodes'
    );
  });

  test('ensureNodeId generates and persists a stable global nodeId', async () => {
    const config: TimConfig = {};
    const nodeId = await ensureNodeId(config);
    expect(nodeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(config.sync?.nodeId).toBe(nodeId);

    const globalConfigPath = path.join(process.env.XDG_CONFIG_HOME!, 'tim', 'config.yml');
    const loaded = await loadConfig(globalConfigPath);
    expect(loaded.sync?.nodeId).toBe(nodeId);

    const secondConfig = await loadConfig(globalConfigPath);
    await expect(getLocalNodeId(secondConfig)).resolves.toBe(nodeId);
  });

  test('getLocalNodeId returns same nodeId as ensureNodeId after it has been persisted', async () => {
    const config: TimConfig = { sync: { role: 'main' } };
    const nodeId = await ensureNodeId(config);
    // getLocalNodeId is a stable alias for ensureNodeId; calling it again should return same value
    const retrieved = await getLocalNodeId(config);
    expect(retrieved).toBe(nodeId);
  });

  test('ensureNodeId returns existing nodeId without writing if already in config', async () => {
    const config: TimConfig = { sync: { role: 'main', nodeId: 'preset-node-id' } };
    const nodeId = await ensureNodeId(config);
    expect(nodeId).toBe('preset-node-id');
    // Should not have written to disk since nodeId was already present
    const globalConfigPath = path.join(process.env.XDG_CONFIG_HOME!, 'tim', 'config.yml');
    const fileExists = await fs
      .access(globalConfigPath)
      .then(() => true)
      .catch(() => false);
    expect(fileExists).toBe(false);
  });

  test('validateSyncConfig returns empty array for missing sync section', () => {
    const errors = validateSyncConfig({} as TimConfig);
    expect(errors).toEqual([]);
  });

  test('validateSyncConfig returns error for persistent node without mainUrl', () => {
    const errors = validateSyncConfig({
      sync: { role: 'persistent', nodeToken: 'tok' },
    } as TimConfig);
    expect(errors).toContain('sync.mainUrl is required for persistent sync nodes');
  });

  test('validateSyncConfig returns error for persistent node without nodeToken or nodeTokenEnv', () => {
    const errors = validateSyncConfig({
      sync: { role: 'persistent', mainUrl: 'http://main.local' },
    } as TimConfig);
    expect(errors).toContain(
      'sync.nodeToken or a set sync.nodeTokenEnv is required for persistent sync nodes'
    );
  });

  test('validateSyncConfig returns error when role is missing', () => {
    const errors = validateSyncConfig({
      sync: { nodeId: 'abc' },
    } as TimConfig);
    expect(errors).toContain('sync.role is required to enable sync');
  });

  test('validateSyncConfig accepts valid main node config', () => {
    const errors = validateSyncConfig({
      sync: {
        role: 'main',
        nodeId: 'main-node',
        serverHost: '0.0.0.0',
        serverPort: 8124,
        requireSecureTransport: true,
        allowedNodes: [{ nodeId: 'node-a', tokenHash: 'a'.repeat(64) }],
      },
    } as TimConfig);
    expect(errors).toEqual([]);
  });

  test('validateSyncConfig rejects main-node server bind fields for non-main roles', () => {
    expect(
      validateSyncConfig({
        sync: {
          role: 'persistent',
          mainUrl: 'http://main.local',
          nodeToken: 'tok',
          serverPort: 8124,
        },
      } as TimConfig)
    ).toContain('serverPort: sync.serverPort is only valid when sync.role is "main"');

    expect(
      validateSyncConfig({
        sync: {
          role: 'ephemeral',
          serverHost: '0.0.0.0',
        },
      } as TimConfig)
    ).toContain('serverHost: sync.serverHost is only valid when sync.role is "main"');
  });

  test('validateSyncConfig rejects allowedNodes entry missing both token sources', () => {
    const errors = validateSyncConfig({
      sync: {
        role: 'main',
        allowedNodes: [{ nodeId: 'node-a' }],
      },
    } as TimConfig);
    expect(errors.some((e) => e.includes('allowedNodes.0'))).toBe(true);
  });

  test('resolveSyncConfig with no sync config returns disabled with no validation errors', () => {
    const resolved = resolveSyncConfig({} as TimConfig);
    expect(resolved.enabled).toBe(false);
    expect(resolved.validationErrors).toEqual([]);
    expect(resolved.nodeToken).toBeNull();
    expect(resolved.allowedNodes).toEqual([]);
  });

  test('resolveSyncConfig with main role and no allowedNodes returns enabled', () => {
    const resolved = resolveSyncConfig({
      sync: {
        role: 'main',
        nodeId: 'main-node',
        serverHost: '0.0.0.0',
        serverPort: 8124,
        requireSecureTransport: true,
      },
    } as TimConfig);
    expect(resolved.enabled).toBe(true);
    expect(resolved.role).toBe('main');
    expect(resolved.serverHost).toBe('0.0.0.0');
    expect(resolved.serverPort).toBe(8124);
    expect(resolved.requireSecureTransport).toBe(true);
    expect(resolved.sequenceRetentionDays).toBe(30);
    expect(resolved.validationErrors).toEqual([]);
  });

  test('resolveSyncConfig reads sync sequence retention days', () => {
    const resolved = resolveSyncConfig({
      sync: {
        role: 'main',
        nodeId: 'main-node',
        sequenceRetentionDays: 14,
      },
    } as TimConfig);

    expect(resolved.sequenceRetentionDays).toBe(14);
  });

  test('resolveNodeToken returns null when sync is undefined', () => {
    expect(resolveNodeToken(undefined)).toBeNull();
  });

  test('resolveNodeToken returns null when nodeTokenEnv env var is empty string', () => {
    process.env.TIM_SYNC_TEST_TOKEN = '';
    expect(resolveNodeToken({ nodeTokenEnv: 'TIM_SYNC_TEST_TOKEN' })).toBeNull();
  });

  test('loadEffectiveConfig sources sync only from the global config and ignores repo-local sync', async () => {
    process.env.TIM_SYNC_TEST_TOKEN = 'env-token';
    const globalConfigPath = path.join(process.env.XDG_CONFIG_HOME!, 'tim', 'config.yml');
    await fs.mkdir(path.dirname(globalConfigPath), { recursive: true });
    await fs.writeFile(
      globalConfigPath,
      yaml.dump({
        sync: {
          role: 'persistent',
          nodeId: 'global-node',
          mainUrl: 'http://global-main.local',
          nodeTokenEnv: 'TIM_SYNC_TEST_TOKEN',
        },
      }),
      'utf-8'
    );

    // Repo config attempts to override sync — must be ignored.
    const repoConfigPath = path.join(tempDir, 'repo-tim.yml');
    await fs.writeFile(
      repoConfigPath,
      yaml.dump({
        sync: {
          role: 'main',
          nodeId: 'attacker-node',
          mainUrl: 'http://attacker.local',
          nodeToken: 'planted-token',
          allowedNodes: [{ nodeId: 'a', tokenHash: 'b'.repeat(64) }],
        },
      }),
      'utf-8'
    );

    const config = await loadEffectiveConfig(repoConfigPath);
    expect(config.sync?.role).toBe('persistent');
    expect(config.sync?.nodeId).toBe('global-node');
    expect(config.sync?.mainUrl).toBe('http://global-main.local');
    expect(config.sync?.nodeTokenEnv).toBe('TIM_SYNC_TEST_TOKEN');
    expect(config.sync?.nodeToken).toBeUndefined();
    expect(config.sync?.allowedNodes).toBeUndefined();
    expect(config.sync?.disabled).toBe(false);
    expect(config.sync?.offline).toBe(false);
  });

  test('loadEffectiveConfig leaves sync undefined when global config has no sync section, even if repo provides one', async () => {
    const globalConfigPath = path.join(process.env.XDG_CONFIG_HOME!, 'tim', 'config.yml');
    await fs.mkdir(path.dirname(globalConfigPath), { recursive: true });
    await fs.writeFile(globalConfigPath, yaml.dump({ githubUsername: 'someone' }), 'utf-8');

    const repoConfigPath = path.join(tempDir, 'repo-tim.yml');
    await fs.writeFile(
      repoConfigPath,
      yaml.dump({
        sync: { role: 'main' },
      }),
      'utf-8'
    );

    const config = await loadEffectiveConfig(repoConfigPath);
    expect(config.sync).toBeUndefined();
    expect(config.githubUsername).toBe('someone');
  });

  test('loadEffectiveConfig accepts repo config with invalid sync block (sync stripped before validation)', async () => {
    const globalConfigPath = path.join(process.env.XDG_CONFIG_HOME!, 'tim', 'config.yml');
    await fs.mkdir(path.dirname(globalConfigPath), { recursive: true });
    await fs.writeFile(
      globalConfigPath,
      yaml.dump({ sync: { role: 'main', nodeId: 'global-node' } }),
      'utf-8'
    );

    // Repo config has an obviously invalid sync block plus a valid githubUsername.
    // The repo's bogus sync must not cause the load to throw, and the non-sync
    // setting should still be picked up.
    const repoConfigPath = path.join(tempDir, 'repo-tim.yml');
    await fs.writeFile(
      repoConfigPath,
      yaml.dump({
        githubUsername: 'octocat',
        sync: { role: 'persistent', nodeToken: 'a', nodeTokenEnv: 'B' }, // both -> invalid
      }),
      'utf-8'
    );

    const config = await loadEffectiveConfig(repoConfigPath);
    expect(config.githubUsername).toBe('octocat');
    expect(config.sync?.nodeId).toBe('global-node');
    expect(config.sync?.role).toBe('main');
  });

  test('loadEffectiveConfig with --config pointing at the global config retains sync', async () => {
    process.env.TIM_SYNC_TEST_TOKEN = 'env-token';
    const globalConfigPath = path.join(process.env.XDG_CONFIG_HOME!, 'tim', 'config.yml');
    await fs.mkdir(path.dirname(globalConfigPath), { recursive: true });
    await fs.writeFile(
      globalConfigPath,
      yaml.dump({
        sync: {
          role: 'persistent',
          nodeId: 'laptop',
          mainUrl: 'http://main.local',
          nodeTokenEnv: 'TIM_SYNC_TEST_TOKEN',
        },
      }),
      'utf-8'
    );

    const config = await loadEffectiveConfig(globalConfigPath);
    expect(config.sync?.role).toBe('persistent');
    expect(config.sync?.nodeId).toBe('laptop');
    expect(config.sync?.mainUrl).toBe('http://main.local');
    expect(config.sync?.nodeTokenEnv).toBe('TIM_SYNC_TEST_TOKEN');
  });

  test('validateSyncConfig returns no errors when sync.disabled is true', () => {
    const errors = validateSyncConfig({ sync: { disabled: true } } as TimConfig);
    expect(errors).toEqual([]);
  });

  test('resolveSyncConfig with disabled and no role returns enabled=false without validation errors', () => {
    const resolved = resolveSyncConfig({ sync: { disabled: true } } as TimConfig);
    expect(resolved.enabled).toBe(false);
    expect(resolved.disabled).toBe(true);
    expect(resolved.validationErrors).toEqual([]);
  });

  test('resolveSyncConfig does not enable ephemeral role for direct sync', () => {
    const resolved = resolveSyncConfig({
      sync: { role: 'ephemeral', nodeId: 'eph-1' },
    } as TimConfig);
    expect(resolved.enabled).toBe(false);
    expect(resolved.role).toBe('ephemeral');
  });
});
