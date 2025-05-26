import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, Events } from 'discord.js';
import { config } from './config.js';
import { log, error, debugLog } from '../logging.js';
import { db, commandHistory } from './db/index.js';

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
      try {
        await db.insert(commandHistory).values({
          commandName: commandName,
          platform: 'discord',
          userId: user.id, // Discord user ID
          rawCommand: `/${commandName} ${options.data.map((opt) => `${opt.name}:${opt.value}`).join(' ')}`,
          status: 'pending', // Will be updated after processing
        });
      } catch (e) {
        error('Failed to log Discord command to command_history:', e);
      }

      if (commandName === RMPLAN_COMMAND) {
        const issueUrl = options.getString('issue-url', true);
        log(`'/rm-plan' command received for issue URL: ${issueUrl}`);

        // Placeholder: Acknowledge interaction
        try {
          await interaction.reply({
            content: `Processing /rm-plan for ${issueUrl}... Task ID will be provided shortly.`,
            ephemeral: false,
          });
          // TODO: Implement actual plan generation trigger in a later step.
          // Update command_history for now
          // await db.update(commandHistory).set({ status: 'success' }).where(...);
        } catch (replyError) {
          error('Failed to reply to Discord interaction:', replyError);
        }
      } else {
        try {
          await interaction.reply({ content: `Unknown command: ${commandName}`, ephemeral: true });
          // await db.update(commandHistory).set({ status: 'failed', errorMessage: 'Unknown command' }).where(...);
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
