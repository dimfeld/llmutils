import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, Events } from 'discord.js';
import { config } from './config.js';
import { log, error, debugLog } from '../logging.js';
import { db, commandHistory } from './db/index.js';
import { startPlanGenerationTask } from './core/task_manager.js';
import { parsePrOrIssueNumber } from '../common/github/identifiers.js';
import { eq } from 'drizzle-orm';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const RMPLAN_COMMAND = 'rm-plan';
// Add other command names here as they are defined
// const RMIMPLEMENT_COMMAND = 'rm-implement';

const commands = [
  new SlashCommandBuilder()
    .setName(RMPLAN_COMMAND)
    .setDescription('Generates a plan for a GitHub issue.')
    .addStringOption((option) =>
      option.setName('issue-url').setDescription('The URL of the GitHub issue').setRequired(true)
    )
    .toJSON(),
  // Define other commands here later
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
            userId: user.id, // Discord user ID
            rawCommand: `/${commandName} ${options.data.map((opt) => `${opt.name}:${opt.value}`).join(' ')}`,
            status: 'pending', // Will be updated after processing
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
        const ghIdentifiers = await parsePrOrIssueNumber(issueUrl);
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
          }, // Pass necessary details
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
