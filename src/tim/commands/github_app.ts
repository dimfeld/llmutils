import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  clearCachedInstallationToken,
  findInstallationForOwner,
  getAppMetadata,
  getInstallationToken,
  listAppInstallations,
  loadStoredAppConfig,
  mapProjectToInstallation,
  readCachedInstallationToken,
  resolveAppOnlyCredentials,
  resolveGitHubAppCredentials,
  saveStoredAppConfig,
  saveAppInstallations,
  type AppInstallation,
} from '../../common/github/app_auth.js';
import { parseOwnerRepoFromRepositoryId } from '../../common/github/pull_requests.js';
import { log, warn } from '../../logging.js';
import { getDatabase, getDefaultDatabasePath } from '../db/database.js';
import { getOrCreateProject, listProjects, updateProject, type Project } from '../db/project.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';

export interface GitHubAppSetOptions {
  appId?: string;
  installationId?: string;
  privateKey?: string;
}

export interface GitHubAppTokenOptions {
  refresh?: boolean;
  installationId?: string;
  owner?: string;
}

export interface GitHubAppRefreshOptions {
  watch?: boolean;
  interval?: string;
  installationId?: string;
  owner?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeAccount(installation: AppInstallation): string {
  return installation.account
    ? `${installation.account} (id ${installation.id})`
    : `id ${installation.id}`;
}

function parseInstallationIdOption(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const installationId = Number(value);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw new Error(`Invalid --installation-id: ${value}`);
  }
  return installationId;
}

function findInstallationById(
  installations: AppInstallation[],
  installationId: number
): AppInstallation | null {
  return installations.find((installation) => installation.id === installationId) ?? null;
}

function updateProjectRepositoryMetadata(
  project: Project,
  remoteUrl: string | null,
  gitRoot: string
): void {
  if (project.remote_url === remoteUrl && project.last_git_root === gitRoot) {
    return;
  }
  updateProject(getDatabase(), project.id, {
    remoteUrl,
    lastGitRoot: gitRoot,
  });
}

async function resolveCurrentRepositoryInstallation(installations: AppInstallation[]): Promise<{
  owner: string;
  repo: string;
  projectId: number;
  installation: AppInstallation | null;
} | null> {
  let repoIdentity: Awaited<ReturnType<typeof getRepositoryIdentity>>;
  try {
    repoIdentity = await getRepositoryIdentity({ cwd: process.cwd() });
  } catch (err) {
    warn(
      `Could not inspect the current repository: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }

  const parsed = parseOwnerRepoFromRepositoryId(repoIdentity.repositoryId);
  if (!parsed) {
    return null;
  }

  const db = getDatabase();
  const project = getOrCreateProject(db, repoIdentity.repositoryId, {
    remoteUrl: repoIdentity.remoteUrl,
    lastGitRoot: repoIdentity.gitRoot,
  });
  updateProjectRepositoryMetadata(project, repoIdentity.remoteUrl, repoIdentity.gitRoot);

  let installationId = findInstallationForOwner(parsed.owner, db);
  if (!installationId) {
    installationId =
      installations.find(
        (installation) => installation.account?.toLowerCase() === parsed.owner.toLowerCase()
      )?.id ?? null;
  }
  if (!installationId) {
    return {
      ...parsed,
      projectId: project.id,
      installation: null,
    };
  }

  mapProjectToInstallation(project.id, installationId, db);
  return {
    ...parsed,
    projectId: project.id,
    installation: findInstallationById(installations, installationId) ?? {
      id: installationId,
      account: parsed.owner,
    },
  };
}

async function resolveCurrentRepositoryOwner(): Promise<string | undefined> {
  const current = await resolveCurrentRepositoryInstallation([]);
  return current?.owner;
}

export async function handleGitHubAppSetCommand(options: GitHubAppSetOptions): Promise<void> {
  const stored = loadStoredAppConfig();
  const appId = options.appId?.trim() || stored?.appId;
  if (!appId) {
    throw new Error('Provide the GitHub App ID with --app-id <id>.');
  }

  let privateKeyPath = options.privateKey?.trim() || stored?.privateKeyPath;
  if (!privateKeyPath) {
    throw new Error('Provide the path to the App private key (.pem) with --private-key <path>.');
  }
  privateKeyPath = path.resolve(privateKeyPath);
  if (!fs.existsSync(privateKeyPath)) {
    throw new Error(`Private key file not found: ${privateKeyPath}`);
  }
  // Validate the key is readable now so failures surface here, not at mint time.
  fs.readFileSync(privateKeyPath, 'utf8');

  const appOnly = { appId, privateKey: fs.readFileSync(privateKeyPath, 'utf8') };

  // Resolve the installation id, auto-discovering when there is exactly one install.
  let installationId: number | undefined;
  if (options.installationId?.trim()) {
    installationId = Number(options.installationId.trim());
    if (!Number.isInteger(installationId) || installationId <= 0) {
      throw new Error(`Invalid --installation-id: ${options.installationId}`);
    }
  } else if (stored?.installationId) {
    installationId = stored.installationId;
  } else {
    const installations = await listAppInstallations(appOnly);
    if (installations.length === 0) {
      throw new Error(
        'The App has no installations. Install it on the target account/org, then re-run.'
      );
    }
    saveAppInstallations(appId, installations);
    if (installations.length > 1) {
      const list = installations.map((i) => `  - ${describeAccount(i)}`).join('\n');
      saveStoredAppConfig({ appId, privateKeyPath });
      log(`Saved GitHub App configuration to ${getDefaultDatabasePath()}`);
      log(`Discovered ${installations.length} installations:\n${list}`);
      log('Re-run with --installation-id <id> to mint and verify a specific installation token.');
      return;
    }
    installationId = installations[0].id;
    log(`Using the only installation: ${describeAccount(installations[0])}`);
  }

  saveStoredAppConfig({ appId, installationId, privateKeyPath });
  const matchingInstallation = (await listAppInstallations(appOnly)).find(
    (installation) => installation.id === installationId
  );
  if (matchingInstallation) {
    saveAppInstallations(appId, [matchingInstallation]);
  }

  // Confirm the credentials actually mint a token before declaring success.
  clearCachedInstallationToken(installationId);
  const { expiresAt } = await getInstallationToken({ forceRefresh: true, installationId });
  const metadata = await getAppMetadata(appOnly).catch(() => ({ slug: null, name: null }));

  log(`Saved GitHub App configuration to ${getDefaultDatabasePath()}`);
  if (metadata.slug || metadata.name) {
    log(`App: ${metadata.name ?? metadata.slug} (${metadata.slug ?? 'unknown slug'})`);
  }
  log(`Installation: ${installationId}`);
  log(`Minted a test installation token (expires ${expiresAt}).`);
  log('tim will now act as this App for GitHub API calls. Comments will appear as the App.');
}

export async function handleGitHubAppTokenCommand(options: GitHubAppTokenOptions): Promise<void> {
  const installationId = parseInstallationIdOption(options.installationId);
  const owner =
    options.owner ?? (installationId ? undefined : await resolveCurrentRepositoryOwner());
  const { token } = await getInstallationToken({
    forceRefresh: options.refresh === true,
    installationId,
    owner,
  });
  // Print only the token to stdout. Do not export it as GITHUB_TOKEN; app tokens
  // are scoped to app-authenticated commands.
  process.stdout.write(`${token}\n`);
}

export async function handleGitHubAppStatusCommand(): Promise<void> {
  const stored = loadStoredAppConfig();
  const appOnly = resolveAppOnlyCredentials();

  if (!appOnly) {
    log('GitHub App is not configured.');
    log('Run `tim github-app set --app-id <id> --private-key <path-to-pem>` to configure it.');
    return;
  }

  log(`App ID: ${appOnly.appId}`);
  log(
    `Config source: ${process.env.TIM_GITHUB_APP_ID ? 'environment' : 'database'} (${getDefaultDatabasePath()}${stored ? '' : ', not present'})`
  );

  const metadata = await getAppMetadata(appOnly).catch((err) => {
    warn(`Could not load App metadata: ${err instanceof Error ? err.message : String(err)}`);
    return { slug: null, name: null };
  });
  if (metadata.slug || metadata.name) {
    log(`App: ${metadata.name ?? metadata.slug} (${metadata.slug ?? 'unknown slug'})`);
  }

  const installations = await listAppInstallations(appOnly).catch((err) => {
    warn(`Could not list App installations: ${err instanceof Error ? err.message : String(err)}`);
    return [] as AppInstallation[];
  });
  if (installations.length > 0) {
    saveAppInstallations(appOnly.appId, installations);
  }

  const currentRepositoryInstallation = await resolveCurrentRepositoryInstallation(installations);
  if (currentRepositoryInstallation) {
    log(
      `Current repository: ${currentRepositoryInstallation.owner}/${currentRepositoryInstallation.repo}`
    );
    if (currentRepositoryInstallation.installation) {
      log(
        `Current repository installation: ${describeAccount(currentRepositoryInstallation.installation)}`
      );
    } else {
      warn(
        `No App installation matches the current repository owner ${currentRepositoryInstallation.owner}.`
      );
    }
  }

  const credentials =
    currentRepositoryInstallation?.installation?.id != null
      ? resolveGitHubAppCredentials(currentRepositoryInstallation.installation.id)
      : resolveGitHubAppCredentials();

  if (!credentials) {
    if (installations.length > 0) {
      log('Available installations:');
      for (const installation of installations) {
        log(`  - ${describeAccount(installation)}`);
      }
    }
    warn(
      'No installation id resolved. Run from a GitHub repository owned by an installed account, or use `tim github-app set --installation-id <id>`.'
    );
    return;
  }

  log(`Installation: ${credentials.installationId}`);
  const cached = readCachedInstallationToken(credentials.installationId);
  if (cached) {
    const remainingMinutes = Math.round((Date.parse(cached.expiresAt) - Date.now()) / 60000);
    log(`Cached token: expires ${cached.expiresAt} (${remainingMinutes} min remaining).`);
  } else {
    log('Cached token: none. A fresh token will be minted on next use.');
  }
}

export async function handleGitHubAppRefreshCommand(
  options: GitHubAppRefreshOptions
): Promise<void> {
  const intervalMinutes = options.interval ? Number(options.interval) : undefined;
  if (options.interval && (!Number.isFinite(intervalMinutes) || (intervalMinutes ?? 0) <= 0)) {
    throw new Error(`Invalid --interval (minutes): ${options.interval}`);
  }
  const installationId = parseInstallationIdOption(options.installationId);
  const owner =
    options.owner ?? (installationId ? undefined : await resolveCurrentRepositoryOwner());

  const refreshOnce = async (): Promise<string> => {
    const { expiresAt } = await getInstallationToken({
      forceRefresh: true,
      installationId,
      owner,
    });
    log(`Refreshed GitHub App token; expires ${expiresAt}.`);
    return expiresAt;
  };

  if (!options.watch) {
    await refreshOnce();
    return;
  }

  log('Watching: refreshing the GitHub App token before each expiry. Press Ctrl-C to stop.');
  for (;;) {
    const expiresAt = await refreshOnce();
    const defaultSleep = Math.max(60_000, Date.parse(expiresAt) - Date.now() - 10 * 60_000);
    const sleepMs = intervalMinutes ? intervalMinutes * 60_000 : defaultSleep;
    await delay(sleepMs);
  }
}

export async function handleGitHubAppInstallationsCommand(): Promise<void> {
  const appOnly = resolveAppOnlyCredentials();
  if (!appOnly) {
    throw new Error(
      'GitHub App is not configured. Run `tim github-app set --app-id <id> --private-key <path>` first.'
    );
  }
  const installations = await listAppInstallations(appOnly);
  saveAppInstallations(appOnly.appId, installations);
  if (installations.length === 0) {
    log('The App has no installations.');
    return;
  }
  log('Installations:');
  for (const installation of installations) {
    log(`  - ${describeAccount(installation)}`);
  }
  const db = getDatabase();
  for (const project of listProjects(db)) {
    const parsed = parseOwnerRepoFromRepositoryId(project.repository_id);
    if (!parsed) {
      continue;
    }
    const installationId = findInstallationForOwner(parsed.owner, db);
    if (installationId) {
      mapProjectToInstallation(project.id, installationId, db);
    }
  }
}

export function handleGitHubAppLogoutCommand(): void {
  clearCachedInstallationToken();
  const db = getDatabase();
  db.prepare('DELETE FROM github_app_project_installation').run();
  db.prepare('DELETE FROM github_app_installation').run();
  db.prepare('DELETE FROM github_app_config').run();
  log('Removed stored GitHub App configuration, installation mappings, and cached tokens.');
}
