import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, Events } from 'discord.js';
import { config } from './config.js';
import { log, error, debugLog } from '../logging.js';
import { db, commandHistory, taskLogs } from './db/index.js';
import { startPlanGenerationTask, startImplementationTask } from './core/task_manager.js';
import { parseGitHubIssueUrl } from './utils/github_utils.js';
import { initializeThreadManager } from './core/thread_manager.js';
import { eq, asc } from 'drizzle-orm';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const RMPLAN_COMMAND = 'rm-plan';
const RMIMPLEMENT_COMMAND = 'rm-implement';
const RMLOGS_COMMAND = 'rm-logs';

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
