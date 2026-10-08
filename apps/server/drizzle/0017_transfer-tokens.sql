-- #200 transfer token（spec 2026-10-08-200-mcp-image-transfer §3）：新表 transfer_tokens，兩條 cascade FK、三條 CHECK、三個索引。單一交易（drizzle migrator 整批），無非交易式 DDL（migrate.test.ts 有輔助 grep）。
CREATE TABLE "transfer_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"parent_token_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "transfer_tokens_purpose_chk" CHECK ("transfer_tokens"."purpose" in ('upload','download')),
	CONSTRAINT "transfer_tokens_consumed_chk" CHECK ("transfer_tokens"."purpose" = 'upload' or "transfer_tokens"."consumed_at" is null),
	CONSTRAINT "transfer_tokens_expiry_chk" CHECK ("transfer_tokens"."expires_at" > "transfer_tokens"."created_at")
);
--> statement-breakpoint
ALTER TABLE "transfer_tokens" ADD CONSTRAINT "transfer_tokens_parent_token_id_api_tokens_id_fk" FOREIGN KEY ("parent_token_id") REFERENCES "public"."api_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_tokens" ADD CONSTRAINT "transfer_tokens_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transfer_tokens_parent_idx" ON "transfer_tokens" USING btree ("parent_token_id");--> statement-breakpoint
CREATE INDEX "transfer_tokens_note_idx" ON "transfer_tokens" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "transfer_tokens_expires_idx" ON "transfer_tokens" USING btree ("expires_at");