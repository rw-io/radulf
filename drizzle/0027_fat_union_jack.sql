CREATE TABLE `forge_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`base_url` text NOT NULL,
	`token` text NOT NULL,
	`account` text,
	`check_error` text,
	`checked_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forge_connections_base_url_unique` ON `forge_connections` (`base_url`);