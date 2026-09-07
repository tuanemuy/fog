CREATE TABLE `_occ_guard` (
	`n` integer NOT NULL,
	CONSTRAINT "occ_guard_positive" CHECK("_occ_guard"."n" > 0)
);
--> statement-breakpoint
CREATE TABLE `outbox_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`payload` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`processed_at` integer,
	`created_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`next_attempt_at` integer,
	`failed_at` integer,
	`claimed_at` integer,
	`claimed_by` text
);
--> statement-breakpoint
CREATE INDEX `idx_outbox_pending` ON `outbox_events` (`next_attempt_at`,`created_at`,`id`) WHERE processed_at IS NULL AND failed_at IS NULL;--> statement-breakpoint
CREATE TABLE `processed_events` (
	`id` text PRIMARY KEY NOT NULL,
	`processed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`auth_method` text NOT NULL,
	`password_hash` text,
	`sso_provider` text,
	`sso_provider_subject` text,
	`trash_retention_days` integer NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "users_auth_method_sum" CHECK((auth_method = 'password' AND password_hash IS NOT NULL AND sso_provider IS NULL AND sso_provider_subject IS NULL) OR (auth_method = 'sso' AND password_hash IS NULL AND sso_provider IS NOT NULL AND sso_provider_subject IS NOT NULL)),
	CONSTRAINT "users_auth_method_valid" CHECK(auth_method IN ('password','sso')),
	CONSTRAINT "users_sso_provider_valid" CHECK(sso_provider IS NULL OR sso_provider IN ('google','apple')),
	CONSTRAINT "users_sso_subject_nonempty" CHECK(sso_provider_subject IS NULL OR length(sso_provider_subject) > 0),
	CONSTRAINT "users_trash_retention_positive" CHECK(trash_retention_days >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_uq` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_sso_identity_uq` ON `users` (`sso_provider`,`sso_provider_subject`) WHERE sso_provider IS NOT NULL;