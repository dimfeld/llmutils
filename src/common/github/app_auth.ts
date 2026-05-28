import * as fs from 'node:fs';
import type { Database } from 'bun:sqlite';
import { App } from 'octokit';

import { debugLog, warn } from '../../logging.js';
import { getDatabase } from '../../tim/db/database.js';
import { getProjectById } from '../../tim/db/project.js';
import { SQL_NOW_ISO_UTC } from '../../tim/db/sql_utils.js';
import { parseOwnerRepoFromRepositoryId } from './pull_requests.js';

/**
 * GitHub App authentication.
 *
 * GitHub Apps do not have long-lived refresh tokens. Installation access tokens
 * expire after about one hour and are re-minted from app credentials plus an
 * installation id. App tokens are stored per installation and are never exported
 * as GITHUB_TOKEN; personal-token flows must use common/github/token.ts.
 */

const TOKEN_RENEW_BUFFER_MS = 10 * 60 * 1000;

export interface StoredAppConfig {
  appId: string;
  installationId?: number;
  privateKeyPath?: string;
}

export interface AppOnlyCredentials {
  appId: string;
  privateKey: string;
}

export interface GitHubAppCredentials extends AppOnlyCredentials {
  installationId: number;
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

export interface CachedInstallationToken extends InstallationToken {
  appId: string;
  installationId: number;
}

export interface GetInstallationTokenDeps {
  mint: (credentials: GitHubAppCredentials) => Promise<InstallationToken>;
}

export interface AppInstallation {
  id: number;
  account: string | null;
}

interface GitHubAppConfigRow {
  app_id: string;
  private_key_path: string | null;
}

interface GitHubAppInstallationRow {
  app_id: string;
  installation_id: number;
  account_login: string | null;
  token: string | null;
  token_expires_at: string | null;
}

function normalizePrivateKey(pem: string): string {
  return pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
}

function remainingMs(expiresAt: string): number {
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) ? expiry - Date.now() : Number.NEGATIVE_INFINITY;
}

function appDb(): Database {
  return getDatabase();
}

export function loadStoredAppConfig(db: Database = appDb()): StoredAppConfig | null {
  const row = db
    .prepare('SELECT app_id, private_key_path FROM github_app_config WHERE id = 1')
    .get() as GitHubAppConfigRow | null;
  if (!row?.app_id) {
    return null;
  }

  const onlyInstallation = db
    .prepare(
      `
      SELECT installation_id
      FROM github_app_installation
      WHERE app_id = ?
      ORDER BY installation_id
      LIMIT 2
    `
    )
    .all(row.app_id) as Array<{ installation_id: number }>;

  return {
    appId: row.app_id,
    installationId: onlyInstallation.length === 1 ? onlyInstallation[0].installation_id : undefined,
    privateKeyPath: row.private_key_path ?? undefined,
  };
}

export function saveStoredAppConfig(config: StoredAppConfig, db: Database = appDb()): void {
  db.prepare(
    `
    INSERT INTO github_app_config (id, app_id, private_key_path, created_at, updated_at)
    VALUES (1, ?, ?, ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC})
    ON CONFLICT(id) DO UPDATE SET
      app_id = excluded.app_id,
      private_key_path = excluded.private_key_path,
      updated_at = ${SQL_NOW_ISO_UTC}
  `
  ).run(config.appId, config.privateKeyPath ?? null);

  if (config.installationId) {
    upsertAppInstallation(
      {
        appId: config.appId,
        installationId: config.installationId,
        account: null,
      },
      db
    );
  }
}

export function upsertAppInstallation(
  installation: { appId: string; installationId: number; account: string | null },
  db: Database = appDb()
): void {
  db.prepare(
    `
    INSERT INTO github_app_installation (
      app_id,
      installation_id,
      account_login,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC})
    ON CONFLICT(app_id, installation_id) DO UPDATE SET
      account_login = COALESCE(excluded.account_login, account_login),
      updated_at = ${SQL_NOW_ISO_UTC}
  `
  ).run(installation.appId, installation.installationId, installation.account);
}

export function saveAppInstallations(
  appId: string,
  installations: AppInstallation[],
  db: Database = appDb()
): void {
  const write = db.transaction((rows: AppInstallation[]) => {
    for (const installation of rows) {
      upsertAppInstallation(
        { appId, installationId: installation.id, account: installation.account },
        db
      );
    }
  });
  write.immediate(installations);
}

function readPrivateKey(inline: string | undefined, keyPath: string | undefined): string | null {
  const trimmedInline = inline?.trim();
  if (trimmedInline) {
    return normalizePrivateKey(trimmedInline);
  }
  const trimmedPath = keyPath?.trim();
  if (trimmedPath) {
    try {
      return fs.readFileSync(trimmedPath, 'utf8');
    } catch (err) {
      warn(
        `Failed to read GitHub App private key at ${trimmedPath}: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }
  return null;
}

export function resolveAppOnlyCredentials(db: Database = appDb()): AppOnlyCredentials | null {
  const stored = loadStoredAppConfig(db);
  const appId = process.env.TIM_GITHUB_APP_ID?.trim() || stored?.appId;
  if (!appId) {
    return null;
  }
  const privateKey = readPrivateKey(
    process.env.TIM_GITHUB_APP_PRIVATE_KEY,
    process.env.TIM_GITHUB_APP_PRIVATE_KEY_PATH ?? stored?.privateKeyPath
  );
  if (!privateKey) {
    return null;
  }
  return { appId, privateKey };
}

export function resolveGitHubAppCredentials(
  installationId?: number,
  db: Database = appDb()
): GitHubAppCredentials | null {
  const appOnly = resolveAppOnlyCredentials(db);
  if (!appOnly) {
    return null;
  }

  const envInstallation = process.env.TIM_GITHUB_APP_INSTALLATION_ID?.trim();
  const resolvedInstallationId = envInstallation
    ? Number(envInstallation)
    : (installationId ?? loadStoredAppConfig(db)?.installationId);
  if (
    resolvedInstallationId == null ||
    !Number.isInteger(resolvedInstallationId) ||
    resolvedInstallationId <= 0
  ) {
    return null;
  }

  return { ...appOnly, installationId: resolvedInstallationId };
}

export function isGitHubAppConfigured(): boolean {
  return resolveAppOnlyCredentials() != null;
}

export function findInstallationForOwner(owner: string, db: Database = appDb()): number | null {
  const appOnly = resolveAppOnlyCredentials(db);
  if (!appOnly) {
    return null;
  }
  const row = db
    .prepare(
      `
      SELECT installation_id
      FROM github_app_installation
      WHERE app_id = ? AND account_login = ? COLLATE NOCASE
    `
    )
    .get(appOnly.appId, owner) as { installation_id: number } | null;
  return row?.installation_id ?? null;
}

export function mapProjectToInstallation(
  projectId: number,
  installationId: number,
  db: Database = appDb()
): void {
  const appOnly = resolveAppOnlyCredentials(db);
  if (!appOnly) {
    throw new Error('GitHub App is not configured.');
  }
  db.prepare(
    `
    INSERT INTO github_app_project_installation (
      project_id,
      app_id,
      installation_id,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC})
    ON CONFLICT(project_id) DO UPDATE SET
      app_id = excluded.app_id,
      installation_id = excluded.installation_id,
      updated_at = ${SQL_NOW_ISO_UTC}
  `
  ).run(projectId, appOnly.appId, installationId);
}

export function findInstallationForProject(
  projectId: number,
  db: Database = appDb()
): number | null {
  const appOnly = resolveAppOnlyCredentials(db);
  if (!appOnly) {
    return null;
  }

  const mapped = db
    .prepare(
      `
      SELECT installation_id
      FROM github_app_project_installation
      WHERE project_id = ? AND app_id = ?
    `
    )
    .get(projectId, appOnly.appId) as { installation_id: number } | null;
  if (mapped) {
    return mapped.installation_id;
  }

  const project = getProjectById(db, projectId);
  const parsed = project ? parseOwnerRepoFromRepositoryId(project.repository_id) : null;
  if (!parsed) {
    return null;
  }
  const installationId = findInstallationForOwner(parsed.owner, db);
  if (installationId) {
    mapProjectToInstallation(projectId, installationId, db);
  }
  return installationId;
}

async function findOrDiscoverInstallationForOwner(
  owner: string,
  db: Database = appDb()
): Promise<number | null> {
  const storedInstallationId = findInstallationForOwner(owner, db);
  if (storedInstallationId) {
    return storedInstallationId;
  }

  const appOnly = resolveAppOnlyCredentials(db);
  if (!appOnly) {
    return null;
  }

  const installations = await listAppInstallations(appOnly);
  saveAppInstallations(appOnly.appId, installations, db);
  return findInstallationForOwner(owner, db);
}

export async function mintInstallationToken(
  credentials: GitHubAppCredentials
): Promise<InstallationToken> {
  const app = new App({ appId: credentials.appId, privateKey: credentials.privateKey });
  const auth = (await app.octokit.auth({
    type: 'installation',
    installationId: credentials.installationId,
  })) as { token?: unknown; expiresAt?: unknown };

  if (typeof auth.token !== 'string' || typeof auth.expiresAt !== 'string') {
    throw new Error('GitHub App authentication did not return an installation token.');
  }
  return { token: auth.token, expiresAt: auth.expiresAt };
}

export function readCachedInstallationToken(
  installationId?: number,
  db: Database = appDb()
): CachedInstallationToken | null {
  const appOnly = resolveAppOnlyCredentials(db);
  if (!appOnly) {
    return null;
  }

  const row = db
    .prepare(
      `
      SELECT app_id, installation_id, token, token_expires_at
      FROM github_app_installation
      WHERE app_id = ?
        AND (? IS NULL OR installation_id = ?)
        AND token IS NOT NULL
        AND token_expires_at IS NOT NULL
      ORDER BY installation_id
      LIMIT 2
    `
    )
    .all(
      appOnly.appId,
      installationId ?? null,
      installationId ?? null
    ) as GitHubAppInstallationRow[];

  if (row.length !== 1 || !row[0].token || !row[0].token_expires_at) {
    return null;
  }

  return {
    token: row[0].token,
    expiresAt: row[0].token_expires_at,
    appId: row[0].app_id,
    installationId: row[0].installation_id,
  };
}

function writeCachedInstallationToken(
  token: CachedInstallationToken,
  db: Database = appDb()
): void {
  db.prepare(
    `
    INSERT INTO github_app_installation (
      app_id,
      installation_id,
      token,
      token_expires_at,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC})
    ON CONFLICT(app_id, installation_id) DO UPDATE SET
      token = excluded.token,
      token_expires_at = excluded.token_expires_at,
      updated_at = ${SQL_NOW_ISO_UTC}
  `
  ).run(token.appId, token.installationId, token.token, token.expiresAt);
}

export function clearCachedInstallationToken(
  installationId?: number,
  db: Database = appDb()
): void {
  const appOnly = resolveAppOnlyCredentials(db);
  if (!appOnly) {
    return;
  }
  if (installationId) {
    db.prepare(
      `
      UPDATE github_app_installation
      SET token = NULL, token_expires_at = NULL, updated_at = ${SQL_NOW_ISO_UTC}
      WHERE app_id = ? AND installation_id = ?
    `
    ).run(appOnly.appId, installationId);
    return;
  }
  db.prepare(
    `
    UPDATE github_app_installation
    SET token = NULL, token_expires_at = NULL, updated_at = ${SQL_NOW_ISO_UTC}
    WHERE app_id = ?
  `
  ).run(appOnly.appId);
}

const defaultDeps: GetInstallationTokenDeps = { mint: mintInstallationToken };

export async function getInstallationToken(
  options: {
    forceRefresh?: boolean;
    installationId?: number;
    owner?: string;
    projectId?: number;
  } = {},
  deps: GetInstallationTokenDeps = defaultDeps
): Promise<InstallationToken> {
  const db = appDb();
  let installationId = options.installationId;
  if (!installationId && options.owner) {
    installationId = (await findOrDiscoverInstallationForOwner(options.owner, db)) ?? undefined;
  }
  if (!installationId && options.projectId) {
    installationId = findInstallationForProject(options.projectId, db) ?? undefined;
  }

  const credentials = resolveGitHubAppCredentials(installationId, db);
  if (!credentials) {
    throw new Error(
      'GitHub App is not configured for this installation. Run `tim github-app set` or set TIM_GITHUB_APP_* environment variables.'
    );
  }

  if (!options.forceRefresh) {
    const cached = readCachedInstallationToken(credentials.installationId, db);
    if (
      cached &&
      cached.appId === credentials.appId &&
      cached.installationId === credentials.installationId &&
      remainingMs(cached.expiresAt) > TOKEN_RENEW_BUFFER_MS
    ) {
      return { token: cached.token, expiresAt: cached.expiresAt };
    }
  }

  const minted = await deps.mint(credentials);
  writeCachedInstallationToken(
    {
      ...minted,
      appId: credentials.appId,
      installationId: credentials.installationId,
    },
    db
  );
  debugLog(
    `Minted GitHub App installation token for installation ${credentials.installationId}; expires at ${minted.expiresAt}`
  );
  return minted;
}

export async function getGitHubAppInstallationTokenForOwner(
  owner: string,
  deps: GetInstallationTokenDeps = defaultDeps
): Promise<string | null> {
  try {
    const { token } = await getInstallationToken({ owner }, deps);
    return token;
  } catch (err) {
    warn(
      `Failed to obtain GitHub App installation token for ${owner}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

export async function ensureGitHubAppToken(
  deps: GetInstallationTokenDeps = defaultDeps
): Promise<string | null> {
  try {
    const { token } = await getInstallationToken({}, deps);
    return token;
  } catch (err) {
    warn(
      `Failed to obtain GitHub App installation token: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

export async function listAppInstallations(
  credentials: AppOnlyCredentials
): Promise<AppInstallation[]> {
  const app = new App({ appId: credentials.appId, privateKey: credentials.privateKey });
  const response = await app.octokit.request('GET /app/installations', { per_page: 100 });
  return response.data.map((installation) => {
    const account = installation.account;
    const login =
      account && typeof account === 'object' && 'login' in account
        ? ((account as { login?: unknown }).login ?? null)
        : null;
    return { id: installation.id, account: typeof login === 'string' ? login : null };
  });
}

export async function getAppMetadata(
  credentials: AppOnlyCredentials
): Promise<{ slug: string | null; name: string | null }> {
  const app = new App({ appId: credentials.appId, privateKey: credentials.privateKey });
  const response = await app.octokit.request('GET /app');
  const data = response.data;
  return { slug: data?.slug ?? null, name: data?.name ?? null };
}
