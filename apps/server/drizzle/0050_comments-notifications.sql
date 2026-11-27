-- Adds six tables for note comments and notifications and one nullable-default column on site_settings; no existing row is changed.
-- Rollback: version 0.18 never reads these tables or the column, so leaving them in place is harmless.
CREATE TABLE "comment_notified" (
	"comment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_label" text,
	CONSTRAINT "comment_notified_target_uq" UNIQUE NULLS NOT DISTINCT("comment_id","user_id","agent_label")
);
--> statement-breakpoint
CREATE TABLE "note_comment_mentions" (
	"comment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_label" text,
	"start" integer NOT NULL,
	"length" integer NOT NULL,
	CONSTRAINT "note_comment_mentions_comment_id_start_pk" PRIMARY KEY("comment_id","start"),
	CONSTRAINT "note_comment_mentions_span_chk" CHECK ("note_comment_mentions"."start" >= 0 and "note_comment_mentions"."length" >= 2)
);
--> statement-breakpoint
CREATE TABLE "note_comment_reads" (
	"user_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "note_comment_reads_user_id_note_id_pk" PRIMARY KEY("user_id","note_id")
);
--> statement-breakpoint
CREATE TABLE "note_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"token_id" uuid,
	"agent_label" text,
	"reply_to_id" uuid,
	"anchor_block_id" text,
	"anchor_quote" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"edited_at" timestamp with time zone,
	CONSTRAINT "note_comments_body_chk" CHECK (char_length("note_comments"."body") between 1 and 4000),
	CONSTRAINT "note_comments_quote_chk" CHECK ("note_comments"."anchor_quote" is null or char_length("note_comments"."anchor_quote") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "notification_seen" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_label" text,
	"kind" text NOT NULL,
	"note_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"actor_agent_label" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "notifications_kind_chk" CHECK ("notifications"."kind" in ('mention','reply'))
);
--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "notification_retention_days" integer DEFAULT 30;--> statement-breakpoint
ALTER TABLE "comment_notified" ADD CONSTRAINT "comment_notified_comment_id_note_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."note_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_notified" ADD CONSTRAINT "comment_notified_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_comment_mentions" ADD CONSTRAINT "note_comment_mentions_comment_id_note_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."note_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_comment_mentions" ADD CONSTRAINT "note_comment_mentions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_comment_reads" ADD CONSTRAINT "note_comment_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_comment_reads" ADD CONSTRAINT "note_comment_reads_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_comments" ADD CONSTRAINT "note_comments_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_comments" ADD CONSTRAINT "note_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_comments" ADD CONSTRAINT "note_comments_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_seen" ADD CONSTRAINT "notification_seen_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_comment_id_note_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."note_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_comment_reads_note_idx" ON "note_comment_reads" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "note_comments_note_created_idx" ON "note_comments" USING btree ("note_id","created_at","id");--> statement-breakpoint
CREATE INDEX "note_comments_token_idx" ON "note_comments" USING btree ("token_id");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "notifications_note_idx" ON "notifications" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "notifications_comment_idx" ON "notifications" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX "notifications_created_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "site_settings" ADD CONSTRAINT "site_settings_notification_retention_chk" CHECK ("site_settings"."notification_retention_days" is null or ("site_settings"."notification_retention_days" >= 1 and "site_settings"."notification_retention_days" <= 3650));