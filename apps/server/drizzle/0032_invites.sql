-- #285 邀請註冊：kind_chk 擴充 'invite'（先 DROP 再 ADD）、加 label／used_by_id 兩欄與一條 FK（ON DELETE SET NULL）、四條邀請 CHECK；單一交易、無非交易式 DDL。
ALTER TABLE "one_time_links" DROP CONSTRAINT "one_time_links_kind_chk";--> statement-breakpoint
ALTER TABLE "one_time_links" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "one_time_links" ADD COLUMN "used_by_id" uuid;--> statement-breakpoint
ALTER TABLE "one_time_links" ADD CONSTRAINT "one_time_links_used_by_id_users_id_fk" FOREIGN KEY ("used_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_time_links" ADD CONSTRAINT "one_time_links_invite_target_chk" CHECK ("one_time_links"."kind" <> 'invite' or "one_time_links"."target_user_id" is null);--> statement-breakpoint
ALTER TABLE "one_time_links" ADD CONSTRAINT "one_time_links_invite_fields_chk" CHECK ("one_time_links"."kind" = 'invite' or ("one_time_links"."label" is null and "one_time_links"."used_by_id" is null));--> statement-breakpoint
ALTER TABLE "one_time_links" ADD CONSTRAINT "one_time_links_label_chk" CHECK ("one_time_links"."label" is null or char_length("one_time_links"."label") between 1 and 100);--> statement-breakpoint
ALTER TABLE "one_time_links" ADD CONSTRAINT "one_time_links_used_by_chk" CHECK ("one_time_links"."used_by_id" is null or "one_time_links"."used_at" is not null);--> statement-breakpoint
ALTER TABLE "one_time_links" ADD CONSTRAINT "one_time_links_kind_chk" CHECK ("one_time_links"."kind" in ('password_reset', 'invite'));