import { config as dotenvConfig } from 'dotenv';
import { error } from '../logging.js';

export interface BotConfig {
  GITHUB_TOKEN: string;
  DISCORD_TOKEN: string;
  DATABASE_PATH: string;
  WORKSPACE_BASE_DIR: string;
  LOG_RETENTION_DAYS: number;
  BOT_SERVER_PORT: number;
  LOG_LEVEL: string;
  GITHUB_WEBHOOK_SECRET?: string;
}

let _config: BotConfig | null = null;

export function loadConfig(): BotConfig {
  // Load environment variables from .env file
  dotenvConfig();

  const requiredVars = ['GITHUB_TOKEN', 'DISCORD_TOKEN', 'DATABASE_PATH', 'WORKSPACE_BASE_DIR'];
  const missing = requiredVars.filter((varName) => !process.env[varName]);

  if (missing.length > 0) {
    const errorMsg = `Missing required environment variables: ${missing.join(', ')}`;
    error(errorMsg);
    throw new Error(errorMsg);
  }

  _config = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN!,
    DISCORD_TOKEN: process.env.DISCORD_TOKEN!,
    DATABASE_PATH: process.env.DATABASE_PATH!,
    WORKSPACE_BASE_DIR: process.env.WORKSPACE_BASE_DIR!,
    LOG_RETENTION_DAYS: parseInt(process.env.LOG_RETENTION_DAYS || '30', 10),
    BOT_SERVER_PORT: parseInt(process.env.BOT_SERVER_PORT || '3000', 10),
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
  };

  return _config;
}

export const config: BotConfig = new Proxy({} as BotConfig, {
  get(target, prop) {
    if (!_config) {
      throw new Error('Config not loaded. Call loadConfig() first.');
    }
    return _config[prop as keyof BotConfig];
  },
});
