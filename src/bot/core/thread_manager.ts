import { randomUUID } from 'node:crypto';
import { db, threads as threadsTable, tasks as tasksTable, userMappings } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { config as botConfig } from '../config.js';
import { Client as DiscordClient, TextChannel, ThreadAutoArchiveDuration } from 'discord.js';
import { Octokit } from 'octokit';
import { log, error, warn, debugLog } from '../../logging.js';

let octokit: Octokit;
let discordClient: DiscordClient | null = null;

export function initializeThreadManager(client?: DiscordClient) {
  if (client) {
    discordClient = client;
  }
  if (!octokit) {
    octokit = new Octokit({ auth: botConfig.GITHUB_TOKEN });
  }
}

interface PlatformContext {
  platform: 'github' | 'discord';
  userId: string;
  // GitHub specific
  repoFullName?: string;
  issueNumber?: number;
  githubCommentId?: number;
  // Discord specific
  discordInteraction?: { id: string; channelId: string; token: string };
  channelId?: string;
}

export async function updateGitHubComment(taskId: string, newBody: string): Promise<void> {
  try {
    // Find the GitHub thread for this task
    const threads = await db.select().from(threadsTable).where(eq(threadsTable.taskId, taskId));

    const githubThread = threads.find((t) => t.platform === 'github');
    if (!githubThread || !githubThread.externalId) {
      debugLog(`[${taskId}] No GitHub thread found for task`);
      return;
    }

    // Get task details for repo info
    const tasks = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    const task = tasks[0];
    if (!task || !task.repositoryFullName) {
      error(`[${taskId}] Task not found or missing repository info`);
      return;
    }

    const [owner, repo] = task.repositoryFullName.split('/');
    const commentId = parseInt(githubThread.externalId, 10);

    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: commentId,
      body: newBody,
    });

    log(`[${taskId}] Updated GitHub comment ${commentId}`);
  } catch (e) {
    error(`[${taskId}] Failed to update GitHub comment:`, e);
  }
}

export async function notifyTaskProgress(
  taskId: string,
  progressMessage: string,
  taskStatus?: string
): Promise<void> {
  log(`[${taskId}] Notifying task progress: ${progressMessage}`);

  // Fetch all associated threads for the given taskId
  const threads = await db.select().from(threadsTable).where(eq(threadsTable.taskId, taskId));

  if (!threads || threads.length === 0) {
    debugLog(`[${taskId}] No threads found for task`);
    return;
  }

  // Process Discord threads
  const discordThreads = threads.filter((t) => t.platform === 'discord');
  for (const thread of discordThreads) {
    if (discordClient && thread.externalId) {
      try {
        const channel = (await discordClient.channels.fetch(thread.externalId)) as TextChannel;
        if (channel && channel.isTextBased()) {
          await channel.send(`**Progress Update** - ${progressMessage}`);
          debugLog(`[${taskId}] Posted progress to Discord thread ${thread.externalId}`);
        }
      } catch (e) {
        error(`[${taskId}] Failed to post progress to Discord thread ${thread.externalId}:`, e);
      }
    }
  }

  // Process GitHub threads
  const githubThreads = threads.filter((t) => t.platform === 'github');
  for (const thread of githubThreads) {
    if (!thread.externalId) continue;

    try {
      // Get task details for repo info
      const tasks = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
      const task = tasks[0];
      if (!task || !task.repositoryFullName) {
        error(`[${taskId}] Task not found or missing repository info`);
        continue;
      }

      const [owner, repo] = task.repositoryFullName.split('/');
      const commentId = parseInt(thread.externalId, 10);

      if (taskStatus) {
        // Try to update the initial bot comment with progress
        try {
          // Get the current comment to append progress
          const { data: currentComment } = await octokit.rest.issues.getComment({
            owner,
            repo,
            comment_id: commentId,
          });

          // Check if this is the initial bot comment (usually contains "Task <id>:")
          if (currentComment.body && currentComment.body.includes(`Task ${taskId}:`)) {
            // Append progress update to existing comment
            let updatedBody = currentComment.body;

            // Add a progress section if it doesn't exist
            if (!updatedBody.includes('### Progress')) {
              updatedBody += '\n\n### Progress\n';
            }

            // Add the new progress message
            updatedBody += `\n- ${new Date().toISOString()}: ${progressMessage}`;

            // Update overall status if provided
            if (taskStatus) {
              // Update the status line if it exists, or add it
              const statusRegex = /Current Status: .*/;
              if (statusRegex.test(updatedBody)) {
                updatedBody = updatedBody.replace(statusRegex, `Current Status: ${taskStatus}`);
              } else {
                updatedBody += `\n\n**Current Status:** ${taskStatus}`;
              }
            }

            await octokit.rest.issues.updateComment({
              owner,
              repo,
              comment_id: commentId,
              body: updatedBody,
            });

            debugLog(`[${taskId}] Updated GitHub comment ${commentId} with progress`);
          } else {
            // Not the initial comment, post a new comment
            await octokit.rest.issues.createComment({
              owner,
              repo,
              issue_number: task.issueNumber!,
              body: `**Progress Update** - ${progressMessage}${taskStatus ? `\n**Status:** ${taskStatus}` : ''}`,
            });
            debugLog(`[${taskId}] Posted new progress comment to GitHub issue`);
          }
        } catch (updateError) {
          // If update fails, fall back to creating a new comment
          error(`[${taskId}] Failed to update comment, creating new one:`, updateError);
          await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: task.issueNumber!,
            body: `**Progress Update** - ${progressMessage}${taskStatus ? `\n**Status:** ${taskStatus}` : ''}`,
          });
        }
      } else {
        // No status provided, just post a new comment
        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: task.issueNumber!,
          body: `**Progress Update** - ${progressMessage}`,
        });
        debugLog(`[${taskId}] Posted progress comment to GitHub issue`);
      }
    } catch (e) {
      error(`[${taskId}] Failed to handle GitHub progress notification:`, e);
    }
  }
}

export async function notifyTaskCreation(
  taskId: string,
  message: string,
  initiatingContext: PlatformContext,
  targetRepoFullName?: string,
  targetIssueNumber?: number
) {
  log(`[${taskId}] Notifying task creation: ${message}`);

  const tasks = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
  const task = tasks[0];
  if (!task) {
    error(`[${taskId}] Task not found for notification.`);
    return;
  }

  // Get mapped GitHub username if initiated from Discord
  let githubUsernameInitiator: string | null = null;
  if (initiatingContext.platform === 'discord' && initiatingContext.userId) {
    const mappings = await db
      .select()
      .from(userMappings)
      .where(eq(userMappings.discordUserId, initiatingContext.userId));
    const mapping = mappings[0];
    if (mapping && mapping.verified) {
      githubUsernameInitiator = mapping.githubUsername;
    }
  }

  // Get mapped Discord user ID if initiated from GitHub
  let discordUserIdInitiator: string | null = null;
  if (initiatingContext.platform === 'github' && initiatingContext.userId) {
    const mappings = await db
      .select()
      .from(userMappings)
      .where(eq(userMappings.githubUsername, initiatingContext.userId));
    const mapping = mappings[0];
    if (mapping && mapping.verified) {
      discordUserIdInitiator = mapping.discordUserId;
    }
  }

  // Notify GitHub if initiated from Discord OR if it's a GitHub task needing an update
  if (initiatingContext.platform === 'discord' || (targetRepoFullName && targetIssueNumber)) {
    const repoToUse = targetRepoFullName || task.repositoryFullName;
    const issueToUse = targetIssueNumber || task.issueNumber;

    if (repoToUse && issueToUse && octokit) {
      try {
        const [owner, repo] = repoToUse.split('/');
        let body = `Task ${taskId}: ${message}`;
        if (initiatingContext.platform === 'discord') {
          body += `\nInitiated by Discord user ${initiatingContext.userId}`;
          if (githubUsernameInitiator) {
            body += ` (GitHub: @${githubUsernameInitiator})`;
          }
        }
        // TODO: Add link to Discord thread once created
        const comment = await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: issueToUse,
          body: body,
        });
        log(`[${taskId}] Posted to GitHub issue ${repoToUse}#${issueToUse}`);
        await db.insert(threadsTable).values({
          id: randomUUID(),
          taskId: taskId,
          platform: 'github',
          externalId: comment.data.id.toString(),
          threadUrl: comment.data.html_url,
        });
      } catch (e) {
        error(`[${taskId}] Failed to post to GitHub:`, e);
      }
    }
  }

  // Notify Discord if initiated from GitHub OR if it's a Discord task needing an update
  if (initiatingContext.platform === 'github' || initiatingContext.channelId) {
    if (discordClient) {
      const channelIdToUse = initiatingContext.channelId || botConfig.DISCORD_DEFAULT_CHANNEL_ID;
      if (!channelIdToUse) {
        warn(`[${taskId}] No Discord channel ID available for notification.`);
        return;
      }
      try {
        const channel = (await discordClient.channels.fetch(channelIdToUse)) as TextChannel;
        if (channel && channel.isTextBased()) {
          let discordMessageContent = `Task ${taskId}: ${message}`;
          if (initiatingContext.platform === 'github') {
            discordMessageContent += `\nInitiated by GitHub user @${initiatingContext.userId}`;
            if (discordUserIdInitiator) {
              discordMessageContent += ` (<@${discordUserIdInitiator}>)`;
            }
          }
          // TODO: Add link to GitHub comment/issue

          const sentMessage = await channel.send(discordMessageContent);
          // Optionally create a thread from this message
          const thread = await sentMessage.startThread({
            name: `Task ${taskId} - Issue ${task.issueUrl?.split('/').pop() || 'N/A'}`,
            autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
          });
          log(
            `[${taskId}] Posted to Discord channel ${channelIdToUse} and created thread ${thread.id}`
          );

          await db.insert(threadsTable).values({
            id: randomUUID(),
            taskId: taskId,
            platform: 'discord',
            externalId: thread.id,
            threadUrl: thread.url,
          });
        } else {
          warn(`[${taskId}] Discord channel ${channelIdToUse} not found or not text-based.`);
        }
      } catch (e) {
        error(`[${taskId}] Failed to post to Discord:`, e);
      }
    }
  }
}
