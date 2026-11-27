-- Adds the upload_finished kind: comment_id becomes nullable, upload_id and block_id are added, and per-kind CHECKs describe each kind's columns; every existing row already satisfies them.
-- Rollback: earlier versions can't list upload_finished rows; run `delete from notifications where kind = 'upload_finished'` before rolling back.
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_chk";--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "comment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "upload_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "block_id" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_upload_uq" ON "notifications" USING btree ("upload_id") WHERE "notifications"."upload_id" is not null;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_comment_kind_chk" CHECK ("notifications"."kind" not in ('mention','reply') or ("notifications"."comment_id" is not null and "notifications"."upload_id" is null and "notifications"."block_id" is null));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_upload_kind_chk" CHECK ("notifications"."kind" <> 'upload_finished' or ("notifications"."upload_id" is not null and "notifications"."block_id" is not null and "notifications"."comment_id" is null and "notifications"."actor_id" = "notifications"."user_id" and "notifications"."agent_label" is null and "notifications"."actor_agent_label" is null));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_block_id_chk" CHECK ("notifications"."block_id" is null or "notifications"."block_id" ~ '^[A-Za-z0-9_-]{1,64}$');--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_chk" CHECK ("notifications"."kind" in ('mention','reply','upload_finished'));