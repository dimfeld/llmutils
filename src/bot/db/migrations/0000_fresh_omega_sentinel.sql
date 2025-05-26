CREATE TABLE `command_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text,
	`command_name` text NOT NULL,
	`platform` text NOT NULL,
	`user_id` text NOT NULL,
	`timestamp` integer DEFAULT (current_timestamp),
	`status` text NOT NULL,
	`raw_command` text NOT NULL,
	`error_message` text
);
--> statement-breakpoint
CREATE TABLE `task_artifacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`artifact_type` text NOT NULL,
	`file_path` text NOT NULL,
	`created_at` integer DEFAULT (current_timestamp),
	`metadata` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `task_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`timestamp` integer DEFAULT (current_timestamp),
	`log_level` text NOT NULL,
	`message` text NOT NULL,
	`full_content` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_url` text,
	`issue_number` integer,
	`repository_full_name` text,
	`task_type` text,
	`status` text,
	`workspace_path` text,
	`plan_file_path` text,
	`pr_number` integer,
	`created_at` integer DEFAULT (current_timestamp),
	`updated_at` integer DEFAULT (current_timestamp),
	`created_by_platform` text,
	`created_by_user_id` text,
	`error_message` text
);
--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`platform` text NOT NULL,
	`external_id` text NOT NULL,
	`thread_url` text,
	`created_at` integer DEFAULT (current_timestamp),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `user_mappings` (
	`github_username` text PRIMARY KEY NOT NULL,
	`discord_user_id` text,
	`verified` integer DEFAULT 0,
	`verification_code` text,
	`verification_code_expires_at` integer,
	`mapped_at` integer DEFAULT (current_timestamp),
	`mapped_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_mappings_discord_user_id_unique` ON `user_mappings` (`discord_user_id`);