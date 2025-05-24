#!/usr/bin/env bun
import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { GitHubAppServer } from './server';
import type { GitHubAppConfig } from './types';
import { error, log } from '../logging';

// Load environment variables
loadEnv();

const program = new Command();

program
  .name('rmapp')
  .description('GitHub App server for llmutils - responds to mentions in issues and PRs')
  .version('1.0.0');

program
  .command('start')
  .description('Start the GitHub App server')
  .option('-c, --config <path>', 'Path to configuration file')
  .option('-p, --port <port>', 'Port to listen on', '3000')
  .option('--app-id <id>', 'GitHub App ID (or set GITHUB_APP_ID env var)')
  .option('--webhook-secret <secret>', 'Webhook secret (or set GITHUB_WEBHOOK_SECRET env var)')
  .option(
    '--private-key-path <path>',
    'Path to private key file (or set GITHUB_PRIVATE_KEY_PATH env var)'
  )
  .option('--bot-name <name>', 'Bot name to respond to (or set GITHUB_BOT_NAME env var)')
  .action(async (options) => {
    try {
      const config = await loadConfiguration(options);

      const server = new GitHubAppServer(config);
      server.start();

      // Handle graceful shutdown
      process.on('SIGTERM', async () => {
        log('Received SIGTERM, shutting down...');
        await server.stop();
        process.exit(0);
      });

      process.on('SIGINT', async () => {
        log('Received SIGINT, shutting down...');
        await server.stop();
        process.exit(0);
      });
    } catch (e) {
      error('Failed to start server:', e);
      process.exit(1);
    }
  });

program
  .command('test-parse')
  .description('Test command parsing')
  .argument('<comment>', 'Comment text to parse')
  .option('--bot-name <name>', 'Bot name', 'bot')
  .action((comment, options) => {
    const { MentionParser } = require('./mention_parser');
    const parser = new MentionParser(options.botName);
    const result = parser.parse(comment);

    if (result) {
      console.log('Parsed command:', JSON.stringify(result, null, 2));
    } else {
      console.log('No valid command found');
    }
  });

async function loadConfiguration(options: any): Promise<GitHubAppConfig> {
  let config: Partial<GitHubAppConfig> = {};

  // Try to load from config file if specified
  if (options.config) {
    try {
      const configPath = path.resolve(options.config);
      const configContent = await fs.readFile(configPath, 'utf-8');
      config = JSON.parse(configContent);
    } catch (e) {
      error('Failed to load config file:', e);
    }
  }

  // Override with CLI options and environment variables
  const appId = options.appId || process.env.GITHUB_APP_ID || config.appId;
  const webhookSecret =
    options.webhookSecret || process.env.GITHUB_WEBHOOK_SECRET || config.webhookSecret;
  const botName = options.botName || process.env.GITHUB_BOT_NAME || config.botName;
  const port = parseInt(options.port) || config.port;

  // Handle private key - can be path or content
  let privateKey = config.privateKey;
  const privateKeyPath = options.privateKeyPath || process.env.GITHUB_PRIVATE_KEY_PATH;

  if (privateKeyPath) {
    try {
      privateKey = await fs.readFile(path.resolve(privateKeyPath), 'utf-8');
    } catch (e) {
      throw new Error(`Failed to read private key from ${privateKeyPath}: ${e}`);
    }
  } else if (process.env.GITHUB_PRIVATE_KEY) {
    privateKey = process.env.GITHUB_PRIVATE_KEY;
  }

  // Validate required fields
  if (!appId) {
    throw new Error('GitHub App ID is required (--app-id or GITHUB_APP_ID)');
  }
  if (!privateKey) {
    throw new Error(
      'GitHub App private key is required (--private-key-path or GITHUB_PRIVATE_KEY_PATH)'
    );
  }
  if (!webhookSecret) {
    throw new Error('Webhook secret is required (--webhook-secret or GITHUB_WEBHOOK_SECRET)');
  }
  if (!botName) {
    throw new Error('Bot name is required (--bot-name or GITHUB_BOT_NAME)');
  }

  return {
    appId,
    privateKey,
    webhookSecret,
    botName,
    port,
  };
}

program.parse();
