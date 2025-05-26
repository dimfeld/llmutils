#!/usr/bin/env bun
import { log, error, runWithLogger } from '../logging.js';
import { getLoggerAdapter } from '../logging/adapter.js';
import { ConsoleAdapter } from '../logging/console.js';
import { config, loadConfig } from './config.js';
import { startServer } from './server.js';
import { startDiscordBot } from './discord_bot.js';
import { initializeThreadManager } from './core/thread_manager.js';
import { scheduleCleanupService } from './cleanup_service.js';

async function main() {
  // Load configuration first to get LOG_LEVEL
  loadConfig();

  // Create a console adapter for the bot service
  const consoleAdapter = new ConsoleAdapter();

  // Run the entire bot service within the logger context
  await runWithLogger(consoleAdapter, async () => {
    try {
      log('Starting LLMUtils Bot Service...');
      log(`Log level: ${config.LOG_LEVEL}`);

      // Initialize thread manager (initializes Octokit)
      initializeThreadManager();
      log('Thread manager initialized');

      // Start HTTP server for webhooks
      startServer();

      // Start Discord bot
      await startDiscordBot();

      // Schedule automatic cleanup service (runs every 24 hours by default)
      const stopCleanup = scheduleCleanupService();
      log('Cleanup service scheduled');

      // Handle graceful shutdown
      process.on('SIGINT', () => {
        log('Received SIGINT, shutting down gracefully...');
        stopCleanup();
        process.exit(0);
      });

      process.on('SIGTERM', () => {
        log('Received SIGTERM, shutting down gracefully...');
        stopCleanup();
        process.exit(0);
      });

      log('Bot service started successfully');
    } catch (err) {
      error('Failed to start bot service:', err);
      process.exit(1);
    }
  });
}

// Run the main function
main().catch((err) => {
  error('Unhandled error in main:', err);
  process.exit(1);
});
