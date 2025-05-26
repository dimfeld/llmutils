CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`repository_url` text NOT NULL,
	`workspace_path` text NOT NULL,
	`branch` text NOT NULL,
	`original_plan_file` text,
	`created_at` integer DEFAULT (current_timestamp) NOT NULL,
	`last_accessed_at` integer,
	`locked_by_task_id` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`locked_by_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_workspace_path_unique` ON `workspaces` (`workspace_path`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `branch` text;