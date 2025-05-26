import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, Events } from 'discord.js';
import { config } from './config.js';
import { log, error, debugLog } from '../logging.js';
import { db, commandHistory, taskLogs, tasks } from './db/index.js';
import { startPlanGenerationTask, startImplementationTask } from './core/task_manager.js';
import { parseGitHubIssueUrl } from './utils/github_utils.js';
import { initializeThreadManager } from './core/thread_manager.js';
import { eq, asc, desc } from 'drizzle-orm';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isAdmin } from './discord_admin_utils.js';
import {
  mapUser,
  upsertPendingVerification,
  getPendingVerificationByCode,
  markAsVerified,
  getUserMappingByDiscordId,
  getUserMappingByGithubUsername,
} from './db/user_mappings_manager.js';
import { getAllActiveTasks } from './db/tasks_manager.js';
import { cleanupInactiveWorkspaces } from '../rmplan/workspace/workspace_manager.js';
import {
  generateVerificationCode,
  getVerificationCodeExpiration,
} from './utils/verification_code.js';

const RMPLAN_COMMAND = 'rm-plan';
const RMIMPLEMENT_COMMAND = 'rm-implement';
const RMLOGS_COMMAND = 'rm-logs';
const RMSTATUS_COMMAND = 'rm-status';
const RMLINKUSER_COMMAND = 'rm-link-user';
const RMSTATUSALL_COMMAND = 'rm-status-all';
const RMCLEANUP_COMMAND = 'rm-cleanup';
const RMREGISTER_COMMAND = 'rm-register';
const RMVERIFY_COMMAND = 'rm-verify';

const commands = [
  new SlashCommandBuilder()
    .setName(RMPLAN_COMMAND)
    .setDescription('Generates a plan for a GitHub issue.')
    .addStringOption((option) =>
      option.setName('issue-url').setDescription('The URL of the GitHub issue').setRequired(true)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName(RMIMPLEMENT_COMMAND)
    .setDescription('Implements an existing plan for a GitHub issue.')
    .addStringOption((option) =>
      option.setName('issue-url').setDescription('The URL of the GitHub issue').setRequired(true)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName(RMLOGS_COMMAND)
    .setDescription('Retrieves execution logs for a specific task.')
    .addStringOption((option) =>
      option
        .setName('task-id')
        .setDescription('The ID of the task to retrieve logs for.')
        .setRequired(true)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName(RMSTATUS_COMMAND)
    .setDescription('Checks the status of a task.')
    .addStringOption((option) =>
      option
        .setName('task-id')
        .setDescription('The ID of the task to check. Omitting it shows your most recent task.')
        .setRequired(false)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName(RMLINKUSER_COMMAND)
    .setDescription('(Admin) Links a GitHub username to a Discord user ID.')
    .addStringOption((option) =>
      option
        .setName('github-username')
        .setDescription('The GitHub username to link')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('discord-id')
        .setDescription('The Discord user ID to link to')
        .setRequired(true)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName(RMSTATUSALL_COMMAND)
    .setDescription('(Admin) Shows status of all active tasks.')
    .toJSON(),
  new SlashCommandBuilder()
    .setName(RMCLEANUP_COMMAND)
    .setDescription('(Admin) Cleans up inactive workspaces.')
    .toJSON(),
  new SlashCommandBuilder()
    .setName(RMREGISTER_COMMAND)
    .setDescription('Register your GitHub username with your Discord account.')
    .addStringOption((option) =>
      option.setName('github-username').setDescription('Your GitHub username').setRequired(true)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName(RMVERIFY_COMMAND)
    .setDescription('Verify your GitHub account ownership with a verification code.')
    .addStringOption((option) =>
      option
        .setName('code')
        .setDescription('The verification code from your GitHub issue comment')
        .setRequired(true)
    )
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

export async function startDiscordBot() {
  if (!config.DISCORD_TOKEN) {
    error('DISCORD_TOKEN is not set. Discord bot will not start.');
    return;
  }

  try {
    log('Registering Discord slash commands...');
    // Get the application ID (client ID) from the token
    const clientId = Buffer.from(config.DISCORD_TOKEN.split('.')[0], 'base64').toString();
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    log('Successfully registered Discord slash commands.');
  } catch (err) {
    error('Failed to register Discord slash commands:', err);
    // Continue starting the bot even if command registration fails,
    // as they might have been registered previously.
  }

  client.on(Events.ClientReady, () => {
    if (client.user) {
      log(`Discord bot logged in as ${client.user.tag}!`);
    } else {
      log('Discord bot is ready, but user information is not available.');
    }
    // Initialize the thread manager with the Discord client
    initializeThreadManager(client);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void (async () => {
      if (!interaction.isChatInputCommand()) return;

      const { commandName, options, user } = interaction;
      log(`Received Discord command: /${commandName} from ${user.tag} (${user.id})`);
      debugLog('Interaction options:', JSON.stringify(options.data));

      // Log command to command_history
      let originalCommandId: number | undefined;
      try {
        const insertedCmd = await db
          .insert(commandHistory)
          .values({
            commandName: commandName,
            platform: 'discord',
            userId: user.id,
            rawCommand: `/${commandName} ${options.data.map((opt) => `${opt.name}:${opt.value}`).join(' ')}`,
            status: 'pending',
          })
          .returning({ id: commandHistory.id });
        originalCommandId = insertedCmd[0]?.id;
      } catch (e) {
        error('Failed to log Discord command to command_history:', e);
      }

      if (commandName === RMPLAN_COMMAND) {
        const issueUrl = options.getString('issue-url', true);
        log(`'/rm-plan' command received for issue URL: ${issueUrl}`);

        // Reply immediately to acknowledge the interaction
        try {
          await interaction.reply({
            content: `Processing /rm-plan for ${issueUrl}... Task ID will be provided shortly.`,
            ephemeral: false,
          });
        } catch (replyError) {
          error('Failed to reply to Discord interaction:', replyError);
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'failed', errorMessage: 'Failed to reply to interaction' })
              .where(eq(commandHistory.id, originalCommandId));
          }
          return;
        }

        // Parse repoFullName from issueUrl
        const ghIdentifiers = parseGitHubIssueUrl(issueUrl);
        if (!ghIdentifiers) {
          await interaction.editReply({ content: `Invalid GitHub issue URL: ${issueUrl}` });
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'failed', errorMessage: 'Invalid issue URL' })
              .where(eq(commandHistory.id, originalCommandId));
          }
          return;
        }
        const repoFullName = `${ghIdentifiers.owner}/${ghIdentifiers.repo}`;

        // Determine repoPath (simplified for MVP)
        const repoPath = path.join(config.WORKSPACE_BASE_DIR, 'clones', repoFullName);
        // Check if repoPath exists and is a directory (basic check)
        try {
          const stats = await fs.stat(repoPath);
          if (!stats.isDirectory()) {
            throw new Error('Path is not a directory.');
          }
          // Further check: is it a git repo? (e.g., check for .git folder)
          await fs.stat(path.join(repoPath, '.git'));
        } catch (e) {
          error(
            `[Task ${originalCommandId}] Repository path ${repoPath} not found or not a valid git clone. Please configure repository clones. Error: ${(e as Error).message}`
          );
          await interaction.editReply({
            content: `Error: Repository for ${repoFullName} is not available to the bot. Please contact an admin.`,
          });
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'failed', errorMessage: `Repo clone not found at ${repoPath}` })
              .where(eq(commandHistory.id, originalCommandId));
          }
          return;
        }

        // Asynchronously start the plan generation
        startPlanGenerationTask({
          platform: 'discord',
          userId: user.id,
          issueUrl: issueUrl,
          repoFullName: repoFullName,
          repoPath: repoPath,
          discordInteraction: {
            id: interaction.id,
            channelId: interaction.channelId,
            token: interaction.token,
          },
          originalCommandId: originalCommandId,
        })
          .then((taskId) => {
            if (taskId) {
              log(`Successfully started plan generation task ${taskId} from Discord command.`);
              // interaction.editReply might fail if too much time passed, or use followup.
              // Thread manager will handle notifications.
            } else {
              log(`Plan generation task failed to start from Discord command.`);
              // interaction.editReply({ content: `Failed to start plan generation for ${issueUrl}. Admins notified.` });
            }
          })
          .catch((e) => {
            error('Unhandled error from startPlanGenerationTask (Discord):', e);
          });
      } else if (commandName === RMIMPLEMENT_COMMAND) {
        const issueUrl = options.getString('issue-url', true);
        log(`'/rm-implement' command received for issue URL: ${issueUrl}`);

        // Reply immediately to acknowledge the interaction
        try {
          await interaction.reply({
            content: `Processing /rm-implement for ${issueUrl}... Implementation will begin shortly.`,
            ephemeral: false,
          });
        } catch (replyError) {
          error('Failed to reply to Discord interaction:', replyError);
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'failed', errorMessage: 'Failed to reply to interaction' })
              .where(eq(commandHistory.id, originalCommandId));
          }
          return;
        }

        // Parse repoFullName from issueUrl
        const ghIdentifiers = parseGitHubIssueUrl(issueUrl);
        if (!ghIdentifiers) {
          await interaction.editReply({ content: `Invalid GitHub issue URL: ${issueUrl}` });
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'failed', errorMessage: 'Invalid issue URL' })
              .where(eq(commandHistory.id, originalCommandId));
          }
          return;
        }
        const repoFullName = `${ghIdentifiers.owner}/${ghIdentifiers.repo}`;

        // Determine repoPath (simplified for MVP)
        const repoPath = path.join(config.WORKSPACE_BASE_DIR, 'clones', repoFullName);
        // Check if repoPath exists and is a directory (basic check)
        try {
          const stats = await fs.stat(repoPath);
          if (!stats.isDirectory()) {
            throw new Error('Path is not a directory.');
          }
          // Further check: is it a git repo? (e.g., check for .git folder)
          await fs.stat(path.join(repoPath, '.git'));
        } catch (e) {
          error(
            `[Task ${originalCommandId}] Repository path ${repoPath} not found or not a valid git clone. Please configure repository clones. Error: ${(e as Error).message}`
          );
          await interaction.editReply({
            content: `Error: Repository for ${repoFullName} is not available to the bot. Please contact an admin.`,
          });
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'failed', errorMessage: `Repo clone not found at ${repoPath}` })
              .where(eq(commandHistory.id, originalCommandId));
          }
          return;
        }

        // Asynchronously start the implementation
        startImplementationTask({
          platform: 'discord',
          userId: user.id,
          issueUrl: issueUrl,
          repoFullName: repoFullName,
          repoPath: repoPath,
          discordInteraction: {
            id: interaction.id,
            channelId: interaction.channelId,
            token: interaction.token,
          },
          originalCommandId: originalCommandId,
        })
          .then((taskId) => {
            if (taskId) {
              log(`Successfully started implementation task ${taskId} from Discord command.`);
              // interaction.editReply might fail if too much time passed, or use followup.
              // Thread manager will handle notifications.
            } else {
              log(`Implementation task failed to start from Discord command.`);
              // interaction.editReply({ content: `Failed to start implementation for ${issueUrl}. Admins notified.` });
            }
          })
          .catch((e) => {
            error('Unhandled error from startImplementationTask (Discord):', e);
          });
      } else if (commandName === RMSTATUS_COMMAND) {
        const taskId = options.getString('task-id', false);
        log(
          `'/rm-status' command received from user ${user.id}${taskId ? ` for task ID: ${taskId}` : ' (no task ID provided)'}`
        );

        // Reply immediately to acknowledge the interaction
        try {
          await interaction.deferReply({ ephemeral: false });
        } catch (replyError) {
          error('Failed to defer reply to Discord interaction:', replyError);
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'failed', errorMessage: 'Failed to defer reply to interaction' })
              .where(eq(commandHistory.id, originalCommandId));
          }
          return;
        }

        try {
          let task;

          if (taskId) {
            // Query for specific task ID
            const [foundTask] = await db.select().from(tasks).where(eq(tasks.id, taskId));
            task = foundTask;
          } else {
            // Query for user's most recent task
            const [foundTask] = await db
              .select()
              .from(tasks)
              .where(eq(tasks.createdByUserId, user.id))
              .orderBy(desc(tasks.createdAt))
              .limit(1);
            task = foundTask;
          }

          if (!task) {
            const message = taskId
              ? `No task found with ID: ${taskId}`
              : `No tasks found for your user ID: ${user.id}`;
            await interaction.editReply({
              content: message,
            });
            if (originalCommandId) {
              await db
                .update(commandHistory)
                .set({ status: 'success' })
                .where(eq(commandHistory.id, originalCommandId));
            }
            return;
          }

          // Format task status message
          let statusMessage = `## Task Status\n\n`;
          statusMessage += `**Task ID:** ${task.id}\n`;
          statusMessage += `**Type:** ${task.taskType || 'Unknown'}\n`;
          statusMessage += `**Status:** ${task.status || 'Unknown'}\n`;
          if (task.issueUrl) {
            statusMessage += `**Issue URL:** ${task.issueUrl}\n`;
          }
          if (task.prNumber) {
            statusMessage += `**PR Number:** #${task.prNumber}\n`;
          }
          statusMessage += `**Created At:** ${task.createdAt ? new Date(task.createdAt).toLocaleString() : 'Unknown'}\n`;
          statusMessage += `**Updated At:** ${task.updatedAt ? new Date(task.updatedAt).toLocaleString() : 'Unknown'}\n`;

          if (task.errorMessage) {
            statusMessage += `\n**Error:** ${task.errorMessage}\n`;
          }

          await interaction.editReply({
            content: statusMessage,
          });

          // Update command_history to success
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'success' })
              .where(eq(commandHistory.id, originalCommandId));
          }
        } catch (err) {
          error(`Failed to retrieve status for task:`, err);
          await interaction.editReply({
            content: `Error retrieving task status: ${(err as Error).message}`,
          });
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'failed', errorMessage: (err as Error).message })
              .where(eq(commandHistory.id, originalCommandId));
          }
        }
      } else if (commandName === RMLOGS_COMMAND) {
        const taskId = options.getString('task-id', true);
        log(`'/rm-logs' command received for task ID: ${taskId}`);

        // Reply immediately to acknowledge the interaction
        try {
          await interaction.deferReply({ ephemeral: false });
        } catch (replyError) {
          error('Failed to defer reply to Discord interaction:', replyError);
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'failed', errorMessage: 'Failed to defer reply to interaction' })
              .where(eq(commandHistory.id, originalCommandId));
          }
          return;
        }

        try {
          // Query the task_logs table for all entries where taskId matches
          const logs = await db
            .select()
            .from(taskLogs)
            .where(eq(taskLogs.taskId, taskId))
            .orderBy(asc(taskLogs.timestamp));

          if (logs.length === 0) {
            await interaction.editReply({
              content: `No logs found for task ID: ${taskId}`,
            });
            if (originalCommandId) {
              await db
                .update(commandHistory)
                .set({ status: 'success' })
                .where(eq(commandHistory.id, originalCommandId));
            }
            return;
          }

          // Format the logs
          let formattedLogs = `Logs for Task ID: ${taskId}\n\n`;
          for (const logEntry of logs) {
            const timestamp = logEntry.timestamp
              ? new Date(logEntry.timestamp).toISOString()
              : 'Unknown';
            formattedLogs += `[${timestamp}] [${logEntry.logLevel}] ${logEntry.message}\n`;
          }

          // Check if logs exceed Discord's message limit (2000 chars)
          if (formattedLogs.length <= 1990) {
            // Send in a code block
            await interaction.editReply({
              content: `\`\`\`\n${formattedLogs}\n\`\`\``,
            });
          } else {
            // Send as a text file attachment
            const buffer = Buffer.from(formattedLogs, 'utf-8');
            await interaction.editReply({
              content: `Logs for task ${taskId} are too long to display. Attached as a file.`,
              files: [
                {
                  attachment: buffer,
                  name: `task_${taskId}_logs.txt`,
                  description: `Execution logs for task ${taskId}`,
                },
              ],
            });
          }

          // Update command_history to success
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'success' })
              .where(eq(commandHistory.id, originalCommandId));
          }
        } catch (err) {
          error(`Failed to retrieve logs for task ${taskId}:`, err);
          await interaction.editReply({
            content: `Error retrieving logs for task ${taskId}: ${(err as Error).message}`,
          });
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'failed', errorMessage: (err as Error).message })
              .where(eq(commandHistory.id, originalCommandId));
          }
        }
      } else if (commandName === RMLINKUSER_COMMAND) {
        const githubUsername = options.getString('github-username', true);
        const discordId = options.getString('discord-id', true);
        log(
          `'/rm-link-user' command received for GitHub user: ${githubUsername}, Discord ID: ${discordId}`
        );

        // Check if the user is an admin
        if (!isAdmin(user.id)) {
          try {
            await interaction.reply({
              content: 'Error: You do not have permission to use this command.',
              ephemeral: true,
            });
            if (originalCommandId) {
              await db
                .update(commandHistory)
                .set({ status: 'failed', errorMessage: 'Insufficient permissions' })
                .where(eq(commandHistory.id, originalCommandId));
            }
          } catch (replyError) {
            error('Failed to reply to Discord interaction:', replyError);
          }
          return;
        }

        // Reply immediately to acknowledge the interaction
        try {
          await interaction.deferReply({ ephemeral: false });
        } catch (replyError) {
          error('Failed to defer reply to Discord interaction:', replyError);
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'failed', errorMessage: 'Failed to defer reply to interaction' })
              .where(eq(commandHistory.id, originalCommandId));
          }
          return;
        }

        try {
          // Call the mapUser function to create the mapping
          await mapUser(githubUsername, discordId, 'admin', true);

          await interaction.editReply({
            content: `Successfully mapped GitHub user \`${githubUsername}\` to Discord user <@${discordId}>.`,
          });

          log(
            `Admin ${user.id} successfully mapped GitHub user ${githubUsername} to Discord user ${discordId}`
          );

          // Update command_history to success
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'success' })
              .where(eq(commandHistory.id, originalCommandId));
          }
        } catch (err) {
          error(`Failed to map user:`, err);
          await interaction.editReply({
            content: `Error mapping user: ${(err as Error).message}`,
          });
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'failed', errorMessage: (err as Error).message })
              .where(eq(commandHistory.id, originalCommandId));
          }
        }
      } else if (commandName === RMSTATUSALL_COMMAND) {
        log(`'/rm-status-all' command received from user ${user.id}`);

        // Check if the user is an admin
        if (!isAdmin(user.id)) {
          try {
            await interaction.reply({
              content: 'Error: You do not have permission to use this command.',
              ephemeral: true,
            });
            if (originalCommandId) {
              await db
                .update(commandHistory)
                .set({ status: 'failed', errorMessage: 'Insufficient permissions' })
                .where(eq(commandHistory.id, originalCommandId));
            }
          } catch (replyError) {
            error('Failed to reply to Discord interaction:', replyError);
          }
          return;
        }

        // Reply immediately to acknowledge the interaction
        try {
          await interaction.deferReply({ ephemeral: false });
        } catch (replyError) {
          error('Failed to defer reply to Discord interaction:', replyError);
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'failed', errorMessage: 'Failed to defer reply to interaction' })
              .where(eq(commandHistory.id, originalCommandId));
          }
          return;
        }

        try {
          // Get all active tasks
          const activeTasks = await getAllActiveTasks();

          if (activeTasks.length === 0) {
            await interaction.editReply({
              content: 'No active tasks found.',
            });
            if (originalCommandId) {
              await db
                .update(commandHistory)
                .set({ status: 'success' })
                .where(eq(commandHistory.id, originalCommandId));
            }
            return;
          }

          // Format the list of active tasks
          let statusMessage = `## Active Tasks (${activeTasks.length})\n\n`;

          for (const task of activeTasks) {
            statusMessage += `### Task ${task.id}\n`;
            statusMessage += `- **Repository:** ${task.repositoryFullName || 'Unknown'}\n`;
            if (task.issueNumber) {
              statusMessage += `- **Issue #:** ${task.issueNumber}\n`;
            }
            statusMessage += `- **Status:** ${task.status || 'Unknown'}\n`;
            statusMessage += `- **Type:** ${task.taskType || 'Unknown'}\n`;
            statusMessage += `- **Created by:** ${task.createdByUserId} (${task.createdByPlatform})\n`;
            statusMessage += `- **Created at:** ${task.createdAt ? new Date(task.createdAt).toLocaleString() : 'Unknown'}\n`;
            if (task.prNumber) {
              statusMessage += `- **PR #:** ${task.prNumber}\n`;
            }
            statusMessage += '\n';
          }

          // Check if message exceeds Discord's limit (2000 chars)
          if (statusMessage.length <= 1990) {
            await interaction.editReply({
              content: statusMessage,
            });
          } else {
            // Send as a text file attachment
            const buffer = Buffer.from(statusMessage, 'utf-8');
            await interaction.editReply({
              content: `Found ${activeTasks.length} active tasks. Details attached as a file due to length.`,
              files: [
                {
                  attachment: buffer,
                  name: `active_tasks_status.txt`,
                  description: `Status of all active tasks`,
                },
              ],
            });
          }

          log(`Admin ${user.id} retrieved status of ${activeTasks.length} active tasks`);

          // Update command_history to success
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'success' })
              .where(eq(commandHistory.id, originalCommandId));
          }
        } catch (err) {
          error(`Failed to retrieve active tasks:`, err);
          await interaction.editReply({
            content: `Error retrieving active tasks: ${(err as Error).message}`,
          });
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'failed', errorMessage: (err as Error).message })
              .where(eq(commandHistory.id, originalCommandId));
          }
        }
      } else if (commandName === RMCLEANUP_COMMAND) {
        log(`'/rm-cleanup' command received from user ${user.id}`);

        // Check if the user is an admin
        if (!isAdmin(user.id)) {
          try {
            await interaction.reply({
              content: 'Error: You do not have permission to use this command.',
              ephemeral: true,
            });
            if (originalCommandId) {
              await db
                .update(commandHistory)
                .set({ status: 'failed', errorMessage: 'Insufficient permissions' })
                .where(eq(commandHistory.id, originalCommandId));
            }
          } catch (replyError) {
            error('Failed to reply to Discord interaction:', replyError);
          }
          return;
        }

        // Reply immediately to acknowledge the interaction
        try {
          await interaction.deferReply({ ephemeral: false });
        } catch (replyError) {
          error('Failed to defer reply to Discord interaction:', replyError);
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'failed', errorMessage: 'Failed to defer reply to interaction' })
              .where(eq(commandHistory.id, originalCommandId));
          }
          return;
        }

        try {
          // Perform workspace cleanup
          await interaction.editReply({
            content: 'Starting workspace cleanup...',
          });

          const result = await cleanupInactiveWorkspaces(false);

          // Format the result message
          let resultMessage = `## Workspace Cleanup Complete\n\n`;
          resultMessage += `**Workspaces cleaned:** ${result.cleanedCount}\n`;

          if (result.errors.length > 0) {
            resultMessage += `\n**Errors encountered:** ${result.errors.length}\n`;
            for (const error of result.errors) {
              resultMessage += `- ${error.workspacePath}: ${error.error}\n`;
            }
          }

          await interaction.editReply({
            content: resultMessage,
          });

          log(
            `Admin ${user.id} performed workspace cleanup: ${result.cleanedCount} cleaned, ${result.errors.length} errors`
          );

          // Update command_history to success
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'success' })
              .where(eq(commandHistory.id, originalCommandId));
          }
        } catch (err) {
          error(`Failed to perform workspace cleanup:`, err);
          await interaction.editReply({
            content: `Error performing workspace cleanup: ${(err as Error).message}`,
          });
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'failed', errorMessage: (err as Error).message })
              .where(eq(commandHistory.id, originalCommandId));
          }
        }
      } else if (commandName === RMREGISTER_COMMAND) {
        const githubUsername = options.getString('github-username', true);
        log(
          `'/rm-register' command received from user ${user.id} for GitHub username: ${githubUsername}`
        );

        // Reply immediately with ephemeral message
        try {
          await interaction.deferReply({ ephemeral: true });
        } catch (replyError) {
          error('Failed to defer reply to Discord interaction:', replyError);
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'failed', errorMessage: 'Failed to defer reply to interaction' })
              .where(eq(commandHistory.id, originalCommandId));
          }
          return;
        }

        try {
          // Check if this Discord user already has a verified mapping
          const existingDiscordMapping = await getUserMappingByDiscordId(user.id);
          if (existingDiscordMapping && existingDiscordMapping.verified) {
            await interaction.editReply({
              content: `You are already registered as GitHub user \`${existingDiscordMapping.githubUsername}\`. If you need to change this, please contact an admin.`,
            });
            if (originalCommandId) {
              await db
                .update(commandHistory)
                .set({ status: 'success' })
                .where(eq(commandHistory.id, originalCommandId));
            }
            return;
          }

          // Check if this GitHub username is already verified for someone else
          const existingGithubMapping = await getUserMappingByGithubUsername(githubUsername);
          if (
            existingGithubMapping &&
            existingGithubMapping.verified &&
            existingGithubMapping.discordUserId !== user.id
          ) {
            await interaction.editReply({
              content: `The GitHub username \`${githubUsername}\` is already registered to another Discord user. If this is your account, please contact an admin.`,
            });
            if (originalCommandId) {
              await db
                .update(commandHistory)
                .set({ status: 'failed', errorMessage: 'GitHub username already registered' })
                .where(eq(commandHistory.id, originalCommandId));
            }
            return;
          }

          // Generate verification code
          const verificationCode = generateVerificationCode();
          const expiresAt = getVerificationCodeExpiration();

          // Store pending verification
          await upsertPendingVerification(user.id, githubUsername, verificationCode, expiresAt);

          // Provide instructions
          const repoUrl = 'https://github.com/dimfeld/llmutils'; // TODO: Make this configurable
          await interaction.editReply({
            content: `## GitHub Account Verification

To verify you own the GitHub account \`${githubUsername}\`, please:

1. Go to any issue in the repository: ${repoUrl}
2. Add a comment with exactly this text:
   \`\`\`
   @bot verify ${verificationCode}
   \`\`\`
3. After posting the comment, use \`/rm-verify ${verificationCode}\` here to complete registration

**Note:** The verification code expires in 10 minutes.`,
          });

          log(
            `User ${user.id} initiated registration for GitHub username ${githubUsername} with code ${verificationCode}`
          );

          // Update command_history to success
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'success' })
              .where(eq(commandHistory.id, originalCommandId));
          }
        } catch (err) {
          error(`Failed to process registration:`, err);
          await interaction.editReply({
            content: `Error processing registration: ${(err as Error).message}`,
          });
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'failed', errorMessage: (err as Error).message })
              .where(eq(commandHistory.id, originalCommandId));
          }
        }
      } else if (commandName === RMVERIFY_COMMAND) {
        const code = options.getString('code', true).toUpperCase();
        log(`'/rm-verify' command received from user ${user.id} with code: ${code}`);

        // Reply immediately with ephemeral message
        try {
          await interaction.deferReply({ ephemeral: true });
        } catch (replyError) {
          error('Failed to defer reply to Discord interaction:', replyError);
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'failed', errorMessage: 'Failed to defer reply to interaction' })
              .where(eq(commandHistory.id, originalCommandId));
          }
          return;
        }

        try {
          // Look up the pending verification by code
          const pendingVerification = await getPendingVerificationByCode(code);

          if (!pendingVerification) {
            await interaction.editReply({
              content: `Invalid or expired verification code. Please start the registration process again with \`/rm-register\`.`,
            });
            if (originalCommandId) {
              await db
                .update(commandHistory)
                .set({ status: 'failed', errorMessage: 'Invalid verification code' })
                .where(eq(commandHistory.id, originalCommandId));
            }
            return;
          }

          // Check if the code belongs to this Discord user
          if (pendingVerification.discordUserId !== user.id) {
            await interaction.editReply({
              content: `This verification code was not generated for your Discord account. Please use your own verification code.`,
            });
            if (originalCommandId) {
              await db
                .update(commandHistory)
                .set({ status: 'failed', errorMessage: 'Verification code mismatch' })
                .where(eq(commandHistory.id, originalCommandId));
            }
            return;
          }

          // Mark as verified
          await markAsVerified(pendingVerification.githubUsername, user.id);

          await interaction.editReply({
            content: `✅ Successfully verified! Your Discord account is now linked to GitHub user \`${pendingVerification.githubUsername}\`.`,
          });

          log(
            `User ${user.id} successfully verified as GitHub user ${pendingVerification.githubUsername}`
          );

          // Update command_history to success
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'success' })
              .where(eq(commandHistory.id, originalCommandId));
          }
        } catch (err) {
          error(`Failed to verify registration:`, err);
          await interaction.editReply({
            content: `Error verifying registration: ${(err as Error).message}`,
          });
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'failed', errorMessage: (err as Error).message })
              .where(eq(commandHistory.id, originalCommandId));
          }
        }
      } else {
        try {
          await interaction.reply({ content: `Unknown command: ${commandName}`, ephemeral: true });
          if (originalCommandId) {
            await db
              .update(commandHistory)
              .set({ status: 'failed', errorMessage: 'Unknown command' })
              .where(eq(commandHistory.id, originalCommandId));
          }
        } catch (replyError) {
          error('Failed to reply to Discord interaction (unknown command):', replyError);
        }
      }
    })();
  });

  try {
    await client.login(config.DISCORD_TOKEN);
  } catch (err) {
    error('Discord bot failed to login:', err);
  }
}
