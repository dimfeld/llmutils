import { sqliteTable, text, integer, primaryKey, unique } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Tasks table
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  issueUrl: text('issue_url'),
  issueNumber: integer('issue_number'),
  repositoryFullName: text('repository_full_name'),
  taskType: text('task_type'),
  status: text('status'),
  workspacePath: text('workspace_path'),
  planFilePath: text('plan_file_path'),
  prNumber: integer('pr_number'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(current_timestamp)`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .default(sql`(current_timestamp)`)
    .$onUpdate(() => sql`(current_timestamp)`),
  createdByPlatform: text('created_by_platform'),
  createdByUserId: text('created_by_user_id'),
  errorMessage: text('error_message'),
});

// Threads table
export const threads = sqliteTable('threads', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  platform: text('platform').notNull(),
  externalId: text('external_id').notNull(),
  threadUrl: text('thread_url'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(current_timestamp)`),
});

// User mappings table
export const userMappings = sqliteTable('user_mappings', {
  githubUsername: text('github_username').primaryKey(),
  discordUserId: text('discord_user_id').unique(),
  verified: integer('verified').default(0),
  verificationCode: text('verification_code'),
  verificationCodeExpiresAt: integer('verification_code_expires_at', { mode: 'timestamp' }),
  mappedAt: integer('mapped_at', { mode: 'timestamp' }).default(sql`(current_timestamp)`),
  mappedBy: text('mapped_by'),
});

// Task logs table
export const taskLogs = sqliteTable('task_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  timestamp: integer('timestamp', { mode: 'timestamp' }).default(sql`(current_timestamp)`),
  logLevel: text('log_level').notNull(),
  message: text('message').notNull(),
  fullContent: text('full_content'),
});

// Command history table
export const commandHistory = sqliteTable('command_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: text('task_id'),
  commandName: text('command_name').notNull(),
  platform: text('platform').notNull(),
  userId: text('user_id').notNull(),
  timestamp: integer('timestamp', { mode: 'timestamp' }).default(sql`(current_timestamp)`),
  status: text('status').notNull(),
  rawCommand: text('raw_command').notNull(),
  errorMessage: text('error_message'),
});

// Task artifacts table
export const taskArtifacts = sqliteTable('task_artifacts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  artifactType: text('artifact_type').notNull(),
  filePath: text('file_path').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(current_timestamp)`),
  metadata: text('metadata'),
});
