import chalk from 'chalk';
import { table } from 'table';
import { constructGitHubRepositoryId } from '../../common/github/pull_requests.js';
import { getGitRepository } from '../../common/git.js';
import { postSlackTestMessage, type SlackPostSender } from '../../common/slack/slack_client.js';
import {
  parseSlackProjectSetting,
  SLACK_PROJECT_SETTING_KEY,
  type SlackProjectSetting,
} from '../../common/slack/slack_project_setting.js';
import { log } from '../../logging.js';
import {
  collectDailyDigestsForWorkspace,
  getEligibleDailyDigestWorkspaces,
  runAllDailyDigests,
  type CollectedProjectDigest,
} from '../../lib/server/daily_digest.js';
import type { DigestEntry, PrDigest } from '../../lib/server/pr_digest.js';
import type { TimConfig } from '../configSchema.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getDatabase } from '../db/database.js';
import { getProject, type Project } from '../db/project.js';
import { getProjectSetting } from '../db/project_settings.js';
import {
  countClosedPrReviewRequestsPendingNotification,
  markClosedPrReviewRequestsNotified,
} from '../db/pr_review_request_notifications.js';
import {
  deleteUserMapping,
  listUserMappings,
  upsertUserMapping,
  type SlackUserMapRow,
} from '../db/slack_user_map.js';
import { writeProjectSettingSet } from '../sync/write_router.js';

interface RootCommandLike {
  parent?: RootCommandLike;
  opts?: () => {
    config?: string;
  };
}

interface SlackEnableOptions {
  workspace?: string;
  channel?: string;
}

interface SlackTestOptions extends SlackEnableOptions {
  message?: string;
}

interface SlackMarkClosedNotifiedOptions {
  dryRun?: boolean;
}

interface SlackDigestRunOptions {
  dryRun?: boolean;
}

interface SlackWorkspaceOption {
  workspace?: string;
}

interface SlackMapOptions extends SlackWorkspaceOption {
  display?: string;
}

function getRootOptions(command: RootCommandLike | undefined): { config?: string } {
  let current = command;
  while (current?.parent) {
    current = current.parent;
  }

  return current?.opts?.() ?? {};
}

async function loadConfigForCommand(command: RootCommandLike | undefined): Promise<TimConfig> {
  const rootOptions = getRootOptions(command);
  return await loadEffectiveConfig(rootOptions.config, { cwd: process.cwd() });
}

function getWorkspaceNames(config: TimConfig): string[] {
  return Object.keys(config.slack?.workspaces ?? {}).sort();
}

function formatWorkspaceNames(config: TimConfig): string {
  const workspaceNames = getWorkspaceNames(config);
  return workspaceNames.length > 0 ? workspaceNames.join(', ') : 'none configured';
}

function validateWorkspaceExists(config: TimConfig, workspace: string): void {
  if (config.slack?.workspaces?.[workspace] !== undefined) {
    return;
  }

  throw new Error(
    `Slack workspace "${workspace}" is not configured. Configured Slack workspaces: ${formatWorkspaceNames(config)}.`
  );
}

function requireWorkspaceOption(options: SlackWorkspaceOption): string {
  const workspace = options.workspace?.trim();
  if (!workspace) {
    throw new Error('Missing required option: --workspace <name>');
  }

  return workspace;
}

function requireEnableOptions(options: SlackEnableOptions): { workspace: string; channel: string } {
  const workspace = options.workspace?.trim();
  if (!workspace) {
    throw new Error('Missing required option: --workspace <name>');
  }

  const channel = options.channel?.trim();
  if (!channel) {
    throw new Error('Missing required option: --channel <#channel>');
  }

  return { workspace, channel };
}

function requireTestOptions(options: SlackTestOptions): {
  workspace: string;
  channel: string;
  message: string;
} {
  const { workspace, channel } = requireEnableOptions(options);
  const message =
    options.message?.trim() || `tim Slack test message from ${process.env.USER ?? 'unknown user'}`;

  return { workspace, channel, message };
}

async function resolveCurrentProject(): Promise<Project> {
  const repository = await getGitRepository(process.cwd());
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) {
    throw new Error(
      `Could not resolve the current GitHub repository from origin remote: "${repository}".`
    );
  }

  const db = getDatabase();
  const repositoryId = constructGitHubRepositoryId(owner, repo);
  const project = getProject(db, repositoryId);
  if (!project) {
    throw new Error(`Project not found for current repository: ${owner}/${repo}`);
  }

  return project;
}

function formatProjectSetting(setting: SlackProjectSetting | null): string {
  if (!setting) {
    return 'not configured';
  }

  const enabled = setting.enabled === true ? 'enabled' : 'disabled';
  const digest = setting.dailyDigest === true ? 'enabled' : 'disabled';
  const workspace = setting.workspace ?? '(no workspace)';
  const channel = setting.channel ?? '(no channel)';
  return `${enabled}, workspace=${workspace}, channel=${channel}, dailyDigest=${digest}`;
}

function printMappings(mappings: SlackUserMapRow[]): void {
  if (mappings.length === 0) {
    log('No Slack user mappings found.');
    return;
  }

  log(
    table([
      ['Workspace', 'GitHub Login', 'Slack User ID', 'Display'],
      ...mappings.map((mapping) => [
        mapping.workspace,
        mapping.github_login,
        mapping.slack_user_id,
        mapping.slack_display ?? '',
      ]),
    ]).trimEnd()
  );
}

function isDigestEmpty(digest: PrDigest): boolean {
  return digest.approvedUnmerged.length === 0 && digest.staleAwaitingReview.length === 0;
}

function formatPrLine(entry: DigestEntry): string {
  return `  - #${entry.prNumber} ${entry.title} (author: ${entry.author})`;
}

function printDigestDryRunProject(projectDigest: CollectedProjectDigest): void {
  log(
    `${chalk.bold(projectDigest.repoFullName)} (${projectDigest.workspaceName}/${projectDigest.channel})`
  );

  if (isDigestEmpty(projectDigest.digest)) {
    log('  Would skip: no approved or stale review-request PRs.');
    return;
  }

  if (projectDigest.digest.approvedUnmerged.length > 0) {
    log('  Approved, not yet merged:');
    for (const entry of projectDigest.digest.approvedUnmerged) {
      log(formatPrLine(entry));
    }
  }

  if (projectDigest.digest.staleAwaitingReview.length > 0) {
    log('  Awaiting review for > 1 day:');
    for (const entry of projectDigest.digest.staleAwaitingReview) {
      const reviewers =
        entry.reviewers
          ?.map((reviewer) => `${reviewer.login} (${reviewer.waitedLabel})`)
          .join(', ') ?? 'none';
      log(`${formatPrLine(entry)}; waiting on: ${reviewers}`);
    }
  }
}

export async function handleSlackEnableCommand(
  options: SlackEnableOptions,
  command: RootCommandLike | undefined
): Promise<void> {
  const { workspace, channel } = requireEnableOptions(options);
  const config = await loadConfigForCommand(command);
  validateWorkspaceExists(config, workspace);

  const db = getDatabase();
  const project = await resolveCurrentProject();
  const existing = parseSlackProjectSetting(
    getProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY)
  );
  const setting: SlackProjectSetting = {
    enabled: true,
    workspace,
    channel,
    ...(typeof existing?.dailyDigest === 'boolean' ? { dailyDigest: existing.dailyDigest } : {}),
  };
  await writeProjectSettingSet(
    db,
    config,
    project.id,
    SLACK_PROJECT_SETTING_KEY,
    setting,
    'latest'
  );

  log(chalk.green(`Enabled Slack notifications for ${project.repository_id}.`));
  log(`Workspace: ${workspace}`);
  log(`Channel: ${channel}`);
}

export async function handleSlackDisableCommand(
  _options: Record<string, never>,
  command: RootCommandLike | undefined
): Promise<void> {
  const config = await loadConfigForCommand(command);
  const db = getDatabase();
  const project = await resolveCurrentProject();
  const existing = parseSlackProjectSetting(
    getProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY)
  );

  // Preserve prior workspace/channel so `tim slack list` still shows the last configured target.
  const nextSetting: SlackProjectSetting = {
    ...existing,
    enabled: false,
    dailyDigest: false,
  };
  await writeProjectSettingSet(
    db,
    config,
    project.id,
    SLACK_PROJECT_SETTING_KEY,
    nextSetting,
    'latest'
  );

  log(chalk.green(`Disabled Slack notifications for ${project.repository_id}.`));
}

export async function handleSlackDigestEnableCommand(
  _options: Record<string, never>,
  command: RootCommandLike | undefined
): Promise<void> {
  const config = await loadConfigForCommand(command);
  const db = getDatabase();
  const project = await resolveCurrentProject();
  const existing = parseSlackProjectSetting(
    getProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY)
  );

  if (existing?.enabled !== true || !existing.workspace || !existing.channel) {
    throw new Error(
      'Slack daily digest requires Slack notifications to be enabled first with a workspace and channel.'
    );
  }

  validateWorkspaceExists(config, existing.workspace);

  const nextSetting: SlackProjectSetting = {
    ...existing,
    dailyDigest: true,
  };
  await writeProjectSettingSet(
    db,
    config,
    project.id,
    SLACK_PROJECT_SETTING_KEY,
    nextSetting,
    'latest'
  );

  log(chalk.green(`Enabled Slack daily digest for ${project.repository_id}.`));
  log(`Workspace: ${existing.workspace}`);
  log(`Channel: ${existing.channel}`);
}

export async function handleSlackDigestDisableCommand(
  _options: Record<string, never>,
  command: RootCommandLike | undefined
): Promise<void> {
  const config = await loadConfigForCommand(command);
  const db = getDatabase();
  const project = await resolveCurrentProject();
  const existing = parseSlackProjectSetting(
    getProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY)
  );
  const nextSetting: SlackProjectSetting = {
    ...existing,
    dailyDigest: false,
  };

  await writeProjectSettingSet(
    db,
    config,
    project.id,
    SLACK_PROJECT_SETTING_KEY,
    nextSetting,
    'latest'
  );

  log(chalk.green(`Disabled Slack daily digest for ${project.repository_id}.`));
}

export async function handleSlackDigestRunCommand(
  options: SlackDigestRunOptions,
  command: RootCommandLike | undefined,
  sender?: SlackPostSender
): Promise<void> {
  const config = await loadConfigForCommand(command);
  const db = getDatabase();

  if (options.dryRun === true) {
    const nowMs = Date.now();
    const eligibleWorkspaces = getEligibleDailyDigestWorkspaces(db, config);
    if (eligibleWorkspaces.length === 0) {
      log('No Slack daily digest-enabled projects found.');
      return;
    }

    log(chalk.bold('Slack daily PR digest dry run'));
    let printedProjectCount = 0;
    for (const workspaceName of eligibleWorkspaces) {
      const projectDigests = collectDailyDigestsForWorkspace(db, config, workspaceName, {
        nowMs,
        includeEmpty: true,
        onProjectError: (repositoryId: string, error: unknown): void => {
          log(chalk.yellow(`Failed to compute daily digest for ${repositoryId}: ${String(error)}`));
        },
      });

      for (const projectDigest of projectDigests) {
        printDigestDryRunProject(projectDigest);
        printedProjectCount += 1;
      }
    }

    if (printedProjectCount === 0) {
      log('No Slack daily digest-enabled projects with a parseable GitHub repository were found.');
    }
    return;
  }

  await runAllDailyDigests(db, config, { sender });
  log(chalk.green('Ran Slack daily PR digest.'));
}

export async function handleSlackTestCommand(
  options: SlackTestOptions,
  command: RootCommandLike | undefined,
  sender?: SlackPostSender
): Promise<void> {
  const { workspace, channel, message } = requireTestOptions(options);
  const config = await loadConfigForCommand(command);
  validateWorkspaceExists(config, workspace);

  const result = await postSlackTestMessage({
    config,
    workspace,
    channel,
    message,
    sender,
  });

  if (!result.ok) {
    throw new Error(`Slack test message failed: ${result.error ?? 'unknown error'}`);
  }

  log(chalk.green(`Sent Slack test message to ${channel} in workspace "${workspace}".`));
}

export async function handleSlackMarkClosedNotifiedCommand(
  options: SlackMarkClosedNotifiedOptions
): Promise<void> {
  const db = getDatabase();
  const pendingCount = countClosedPrReviewRequestsPendingNotification(db);

  if (options.dryRun === true) {
    log(
      `Would mark ${pendingCount} pending Slack review-request notification${pendingCount === 1 ? '' : 's'} for closed or merged PRs as already notified.`
    );
    return;
  }

  const markedCount = markClosedPrReviewRequestsNotified(db);
  log(
    chalk.green(
      `Marked ${markedCount} pending Slack review-request notification${markedCount === 1 ? '' : 's'} for closed or merged PRs as already notified.`
    )
  );
}

export async function handleSlackMapCommand(
  githubLogin: string,
  slackUserId: string,
  options: SlackMapOptions,
  command: RootCommandLike | undefined
): Promise<void> {
  const workspace = requireWorkspaceOption(options);
  const config = await loadConfigForCommand(command);
  validateWorkspaceExists(config, workspace);

  upsertUserMapping(getDatabase(), {
    workspace,
    githubLogin,
    slackUserId,
    slackDisplay: options.display,
  });

  log(chalk.green(`Mapped ${githubLogin} to ${slackUserId} in Slack workspace "${workspace}".`));
}

export async function handleSlackUnmapCommand(
  githubLogin: string,
  options: SlackWorkspaceOption,
  command: RootCommandLike | undefined
): Promise<void> {
  const workspace = requireWorkspaceOption(options);
  const config = await loadConfigForCommand(command);
  validateWorkspaceExists(config, workspace);

  const removed = deleteUserMapping(getDatabase(), workspace, githubLogin);
  if (removed) {
    log(chalk.green(`Removed Slack mapping for ${githubLogin} in workspace "${workspace}".`));
    return;
  }

  log(chalk.yellow(`No Slack mapping found for ${githubLogin} in workspace "${workspace}".`));
}

export async function handleSlackListCommand(
  options: SlackWorkspaceOption,
  command: RootCommandLike | undefined
): Promise<void> {
  const db = getDatabase();
  const project = await resolveCurrentProject();
  const setting = parseSlackProjectSetting(
    getProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY)
  );
  const workspace = options.workspace?.trim() || undefined;
  if (workspace !== undefined) {
    const config = await loadConfigForCommand(command);
    validateWorkspaceExists(config, workspace);
  }

  log(`Project: ${project.repository_id}`);
  log(`Slack setting: ${formatProjectSetting(setting)}`);
  log('');

  const mappings = listUserMappings(db, workspace);
  printMappings(mappings);
}
