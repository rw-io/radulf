CREATE TABLE `pr_waits` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`run_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`owner` text NOT NULL,
	`repo` text NOT NULL,
	`branch` text NOT NULL,
	`base_branch` text NOT NULL,
	`pr_number` integer NOT NULL,
	`pr_url` text NOT NULL,
	`head_sha` text NOT NULL,
	`status` text NOT NULL,
	`pushed_at` text NOT NULL,
	`created_at` text NOT NULL,
	`ended_at` text,
	`detail` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pr_waits_status_idx` ON `pr_waits` (`status`);