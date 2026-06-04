import chalk from 'chalk';
import { table } from 'table';
import {
  constructGitHubRepositoryId,
  parseOwnerRepoFromRepositoryId,
} from '../../common/github/pull_requests.js';
import { getGitRepository } from '../../common/git.js';
import {
  buildDailyDigestSlackPayload,
  postSlackTestMessage,
  resolveDigestReviewGrouping,
  type SlackPinSender,
  type SlackPostSender,
  type SlackUpdateSender,
} from '../../common/slack/slack_client.js';
import {
  parseSlackProjectSetting,
  SLACK_PROJECT_SETTING_KEY,
  type SlackProjectSetting,
} from '../../common/slack/slack_project_setting.js';
import { log } from '../../logging.js';
import {
  collectDailyDigestsForWorkspace,
  fetchWorkspaceLinearMilestones,
  getEligibleDailyDigestWorkspaces,
  getWorkspaceDigestDate,
  runAllDailyDigests,
  runDailyDigestForWorkspace,
  type CollectedProjectDigest,
} from '../../lib/server/daily_digest.js';
import type { LinearMilestoneDigestEntry } from '../../common/linear_milestone_digest.js';
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
import { getSlackDailyDigestMessage } from '../db/slack_daily_digest_message.js';
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
    dryRun?: boolean;
    pin?: boolean;
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

interface SlackDigestUpdateOptions {
  dryRun?: boolean;
  pin?: boolean;
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

function hasDryRunOption(
  options: { dryRun?: boolean },
  command: RootCommandLike | undefined
): boolean {
  if (options.dryRun === true) {
    return true;
  }

  let current = command;
  while (current) {
    if (current.opts?.().dryRun === true) {
      return true;
    }
    current = current.parent;
  }

  return false;
}

function hasPinOption(options: { pin?: boolean }, command: RootCommandLike | undefined): boolean {
  if (options.pin === true) {
    return true;
  }

  let current = command;
  while (current) {
    if (current.opts?.().pin === true) {
      return true;
    }
    current = current.parent;
  }

  return false;
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
  return (
    digest.approvedUnmerged.length === 0 &&
    digest.staleAwaitingReview.length === 0 &&
    digest.otherReadyForReview.length === 0
  );
}

function formatPrLine(entry: DigestEntry): string {
  return `  - #${entry.prNumber} ${entry.title} (author: ${entry.author})`;
}

function printLinearMilestonesDryRun(
  workspaceName: string,
  milestones: LinearMilestoneDigestEntry[]
): boolean {
  if (milestones.length === 0) {
    return false;
  }

  log(`  Linear milestones due or overdue (${workspaceName}):`);
  for (const milestone of milestones) {
    log(
      `  - ${milestone.milestoneName} (${milestone.projectName}; owner: ${milestone.milestoneOwner}; due: ${milestone.targetDate})`
    );
  }

  return true;
}

function printDigestDryRunProject(projectDigest: CollectedProjectDigest): void {
  log(
    `${chalk.bold(projectDigest.repoFullName)} (${projectDigest.workspaceName}/${projectDigest.channel})`
  );

  if (isDigestEmpty(projectDigest.digest)) {
    log('  Would skip: no approved or awaiting-review PRs.');
    return;
  }

  let printedSection = false;
  const printSectionBreak = (): void => {
    if (printedSection) {
      log('');
    }
    printedSection = true;
  };

  if (projectDigest.digest.approvedUnmerged.length > 0) {
    printSectionBreak();
    log('  Approved, not yet merged:');
    for (const entry of projectDigest.digest.approvedUnmerged) {
      log(formatPrLine(entry));
    }
  }

  if (projectDigest.digest.staleAwaitingReview.length > 0) {
    printSectionBreak();
    log('  Awaiting review:');
    for (const entry of projectDigest.digest.staleAwaitingReview) {
      const reviewers =
        entry.reviewers
          ?.map((reviewer) => `${reviewer.login} (${reviewer.waitedLabel})`)
          .join(', ') ?? 'none';
      log(`${formatPrLine(entry)}; waiting on: ${reviewers}`);
    }
  }

  if (projectDigest.digest.otherReadyForReview.length > 0) {
    printSectionBreak();
    log('  Other PRs ready for review for > 3 days:');
    for (const entry of projectDigest.digest.otherReadyForReview) {
      const readyLabel = entry.readyForReviewLabel ?? 'unknown duration';
      const previousReview = entry.previousReviewLabel
        ? `; previous review: ${entry.previousReviewLabel} ago`
        : '; previous review: none';
      log(`${formatPrLine(entry)}; ready for: ${readyLabel}${previousReview}`);
    }
  }
}

function printDigestSlackPayloadDryRun(
  projectDigest: CollectedProjectDigest,
  config: TimConfig,
  workspace: string
): void {
  const payload = buildDailyDigestSlackPayload(
    projectDigest.channel,
    projectDigest.repoFullName,
    projectDigest.digest,
    resolveDigestReviewGrouping(config, workspace)
  );
  log('Slack update payload:');
  log(`  channel: ${payload.channel}`);
  log(`  text: ${payload.text}`);
  log(`  blocks: ${JSON.stringify(payload.blocks, null, 2)}`);
}

function requireDigestEnabledSetting(
  setting: SlackProjectSetting | null,
  repositoryId: string
): { workspace: string; channel: string } {
  const workspace = setting?.workspace?.trim();
  const channel = setting?.channel?.trim();
  if (setting?.enabled !== true || setting.dailyDigest !== true || !workspace || !channel) {
    throw new Error(`Slack daily digest is not enabled for ${repositoryId}.`);
  }

  return { workspace, channel };
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

  if (hasDryRunOption(options, command)) {
    const nowMs = Date.now();
    const eligibleWorkspaces = getEligibleDailyDigestWorkspaces(db, config);
    if (eligibleWorkspaces.length === 0) {
      log('No Slack daily digest-enabled projects found.');
      return;
    }

    log(chalk.bold('Slack daily PR digest dry run'));
    let printedProjectCount = 0;
    for (const workspaceName of eligibleWorkspaces) {
      let linearMilestones: LinearMilestoneDigestEntry[] = [];
      try {
        linearMilestones = await fetchWorkspaceLinearMilestones(db, config, workspaceName, {
          nowMs,
        });
      } catch (error) {
        log(
          chalk.yellow(
            `Failed to fetch Linear milestones for workspace ${workspaceName}: ${String(error)}`
          )
        );
      }
      const projectDigests = collectDailyDigestsForWorkspace(db, config, workspaceName, {
        nowMs,
        includeEmpty: true,
        onProjectError: (repositoryId: string, error: unknown): void => {
          log(chalk.yellow(`Failed to compute daily digest for ${repositoryId}: ${String(error)}`));
        },
      });

      let printedSection = printLinearMilestonesDryRun(workspaceName, linearMilestones);
      for (const projectDigest of projectDigests) {
        if (printedSection) {
          log('');
        }
        printDigestDryRunProject(projectDigest);
        printedSection = true;
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

export async function handleSlackDigestUpdateCommand(
  options: SlackDigestUpdateOptions,
  command: RootCommandLike | undefined,
  updateSender?: SlackUpdateSender,
  pinSender?: SlackPinSender,
  unpinSender?: SlackPinSender
): Promise<void> {
  const config = await loadConfigForCommand(command);
  const db = getDatabase();
  const project = await resolveCurrentProject();
  const ownerRepo = parseOwnerRepoFromRepositoryId(project.repository_id);
  if (!ownerRepo) {
    throw new Error(`Project is not a GitHub repository: ${project.repository_id}`);
  }

  const setting = parseSlackProjectSetting(
    getProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY)
  );
  const { workspace, channel } = requireDigestEnabledSetting(setting, project.repository_id);
  validateWorkspaceExists(config, workspace);

  const repoFullName = `${ownerRepo.owner}/${ownerRepo.repo}`;
  const nowMs = Date.now();
  const digestDate = getWorkspaceDigestDate(config, workspace, nowMs);
  const existingMessage = getSlackDailyDigestMessage(
    db,
    workspace,
    channel,
    repoFullName,
    digestDate
  );

  const shouldPin = hasPinOption(options, command);
  if (hasDryRunOption(options, command)) {
    log(chalk.bold('Slack daily PR digest update dry run'));
    log(`Repository: ${repoFullName}`);
    log(`Lookup: workspace=${workspace}, channel=${channel}, digestDate=${digestDate}`);
    if (existingMessage) {
      log(
        `Stored message: channel=${existingMessage.slack_channel}, ts=${existingMessage.slack_ts}`
      );
      log('Would update the stored same-day digest message.');
      if (shouldPin) {
        log('Would pin the stored same-day digest message and unpin the previous digest message.');
      }
    } else {
      log(chalk.yellow('No stored same-day digest message found; nothing would be updated.'));
    }

    const projectDigest = collectDailyDigestsForWorkspace(db, config, workspace, {
      nowMs,
      includeEmpty: true,
    }).find((digest) => digest.repoFullName === repoFullName && digest.channel === channel);
    if (projectDigest) {
      printDigestDryRunProject(projectDigest);
      log('');
      printDigestSlackPayloadDryRun(projectDigest, config, workspace);
    } else {
      log('No digest-enabled project entry was found for this repository.');
    }
    return;
  }

  if (!existingMessage) {
    log(chalk.yellow('No stored same-day digest message found; nothing updated.'));
    return;
  }

  log(
    `Matched stored message: channel=${existingMessage.slack_channel}, ts=${existingMessage.slack_ts}`
  );
  await runDailyDigestForWorkspace(db, config, workspace, {
    updateSender,
    updateExistingOnly: true,
    repoFullNames: new Set([repoFullName]),
    pinUpdatedExisting: shouldPin,
    pinSender,
    unpinSender,
  });
  log(chalk.green(`Updated Slack daily PR digest for ${repoFullName}.`));
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
