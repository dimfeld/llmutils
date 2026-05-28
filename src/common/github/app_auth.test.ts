import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  findInstallationForOwner,
  getInstallationToken,
  loadStoredAppConfig,
  mapProjectToInstallation,
  readCachedInstallationToken,
  resolveAppOnlyCredentials,
  resolveGitHubAppCredentials,
  saveStoredAppConfig,
  upsertAppInstallation,
  type GitHubAppCredentials,
  type InstallationToken,
} from './app_auth.js';
import { closeDatabaseForTesting, getDatabase } from '../../tim/db/database.js';
import { getOrCreateProject } from '../../tim/db/project.js';

const APP_ENV_KEYS = [
  'TIM_GITHUB_APP_ID',
  'TIM_GITHUB_APP_INSTALLATION_ID',
  'TIM_GITHUB_APP_PRIVATE_KEY',
  'TIM_GITHUB_APP_PRIVATE_KEY_PATH',
];

describe('common/github/app_auth', () => {
  let tempDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-app-auth-test-'));
    savedEnv.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
    savedEnv.XDG_CACHE_HOME = process.env.XDG_CACHE_HOME;
    savedEnv.TIM_DATABASE_FILENAME = process.env.TIM_DATABASE_FILENAME;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'config');
    process.env.XDG_CACHE_HOME = path.join(tempDir, 'cache');
    process.env.TIM_DATABASE_FILENAME = 'tim-test.db';
    for (const key of APP_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    closeDatabaseForTesting();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('saveStoredAppConfig writes to sqlite and loadStoredAppConfig round-trips', () => {
    saveStoredAppConfig({ appId: '123', installationId: 456, privateKeyPath: '/keys/app.pem' });

    expect(loadStoredAppConfig()).toEqual({
      appId: '123',
      installationId: 456,
      privateKeyPath: '/keys/app.pem',
    });
  });

  test('resolveAppOnlyCredentials reads an inline private key from the environment', () => {
    process.env.TIM_GITHUB_APP_ID = '999';
    process.env.TIM_GITHUB_APP_PRIVATE_KEY = '-----BEGIN KEY-----\\nabc\\n-----END KEY-----';

    const creds = resolveAppOnlyCredentials();
    expect(creds?.appId).toBe('999');
    // Escaped newlines should be normalized to real newlines.
    expect(creds?.privateKey).toBe('-----BEGIN KEY-----\nabc\n-----END KEY-----');
  });

  test('resolveGitHubAppCredentials requires an installation id', () => {
    const keyPath = path.join(tempDir, 'app.pem');
    fs.writeFileSync(keyPath, 'PRIVATE-KEY');
    saveStoredAppConfig({ appId: '123', privateKeyPath: keyPath });

    expect(resolveAppOnlyCredentials()).not.toBeNull();
    expect(resolveGitHubAppCredentials()).toBeNull();

    process.env.TIM_GITHUB_APP_INSTALLATION_ID = '77';
    expect(resolveGitHubAppCredentials()).toEqual({
      appId: '123',
      privateKey: 'PRIVATE-KEY',
      installationId: 77,
    });
  });

  test('environment values override the stored config file', () => {
    const keyPath = path.join(tempDir, 'app.pem');
    fs.writeFileSync(keyPath, 'FILE-KEY');
    saveStoredAppConfig({ appId: 'file-app', installationId: 11, privateKeyPath: keyPath });

    process.env.TIM_GITHUB_APP_ID = 'env-app';
    process.env.TIM_GITHUB_APP_INSTALLATION_ID = '22';

    const creds = resolveGitHubAppCredentials();
    expect(creds?.appId).toBe('env-app');
    expect(creds?.installationId).toBe(22);
    // Private key still resolves from the stored path since no inline/path env override.
    expect(creds?.privateKey).toBe('FILE-KEY');
  });

  test('getInstallationToken mints, caches, and reuses the cached token', () => {
    return (async () => {
      const keyPath = path.join(tempDir, 'app.pem');
      fs.writeFileSync(keyPath, 'PRIVATE-KEY');
      saveStoredAppConfig({ appId: '123', installationId: 77, privateKeyPath: keyPath });

      let mintCount = 0;
      const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const mint = async (credentials: GitHubAppCredentials): Promise<InstallationToken> => {
        mintCount += 1;
        expect(credentials.installationId).toBe(77);
        return { token: `minted-${mintCount}`, expiresAt: futureExpiry };
      };

      const first = await getInstallationToken({}, { mint });
      expect(first.token).toBe('minted-1');
      expect(mintCount).toBe(1);

      expect(readCachedInstallationToken(77)?.token).toBe('minted-1');

      // Fresh cache (1h out) is reused without minting again.
      const second = await getInstallationToken({}, { mint });
      expect(second.token).toBe('minted-1');
      expect(mintCount).toBe(1);

      // forceRefresh re-mints.
      const third = await getInstallationToken({ forceRefresh: true }, { mint });
      expect(third.token).toBe('minted-2');
      expect(mintCount).toBe(2);
    })();
  });

  test('getInstallationToken re-mints when the cached token is near expiry', async () => {
    const keyPath = path.join(tempDir, 'app.pem');
    fs.writeFileSync(keyPath, 'PRIVATE-KEY');
    saveStoredAppConfig({ appId: '123', installationId: 77, privateKeyPath: keyPath });

    const db = getDatabase();
    db.prepare(
      `
      UPDATE github_app_installation
      SET token = ?, token_expires_at = ?
      WHERE app_id = ? AND installation_id = ?
    `
    ).run('stale', new Date(Date.now() + 2 * 60 * 1000).toISOString(), '123', 77);

    let minted = false;
    const result = await getInstallationToken(
      {},
      {
        mint: async () => {
          minted = true;
          return {
            token: 'fresh',
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          };
        },
      }
    );

    expect(minted).toBe(true);
    expect(result.token).toBe('fresh');
  });

  test('getInstallationToken throws when no credentials are configured', async () => {
    await expect(
      getInstallationToken({}, { mint: async () => ({ token: 'x', expiresAt: 'y' }) })
    ).rejects.toThrow(/not configured/i);
  });

  test('installation lookup maps owners and projects to installation ids', () => {
    const keyPath = path.join(tempDir, 'app.pem');
    fs.writeFileSync(keyPath, 'PRIVATE-KEY');
    saveStoredAppConfig({ appId: '123', privateKeyPath: keyPath });
    upsertAppInstallation({ appId: '123', installationId: 77, account: 'ExampleOrg' });

    expect(findInstallationForOwner('exampleorg')).toBe(77);

    const db = getDatabase();
    const project = getOrCreateProject(db, 'github.com__ExampleOrg__repo');
    mapProjectToInstallation(project.id, 77, db);
    expect(readCachedInstallationToken(77)).toBeNull();
  });
});
