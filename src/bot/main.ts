#!/usr/bin/env bun
import { log, error } from '../logging.js';
import { config, loadConfig } from './config.js';
import { startServer } from './server.js';
import { startDiscordBot } from './discord_bot.js';

async function main() {
  try {
    log('Starting LLMUtils Bot Service...');

    // Load configuration
    loadConfig();

    // Start HTTP server for webhooks
    startServer(config.BOT_SERVER_PORT);

    // Start Discord bot
    await startDiscordBot();

    log('Bot service started successfully');
  } catch (err) {
    error('Failed to start bot service:', err);
    process.exit(1);
  }
}

// Run the main function
main().catch((err) => {
  error('Unhandled error in main:', err);
  process.exit(1);
});
