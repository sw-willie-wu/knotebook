-- 全文搜尋（spec 2026-10-08-93 §3；檔名編號＝合併當下的下一號）：兩張表＋三條 CHECK＋一個索引。單一交易（drizzle migrator 整批），無非交易式 DDL（migrate.test.ts 有輔助 grep）。不回填：Y.Doc 是 bytea，SQL 解不開；回填在 app 啟動後背景跑（spec §6）。
CREATE TABLE "note_search_sections" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "note_search_sections_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"note_id" uuid NOT NULL,
	"source_kind" text DEFAULT 'note' NOT NULL,
	"source_id" uuid,
	"section_id" text NOT NULL,
	"ord" integer NOT NULL,
	"heading" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	CONSTRAINT "nss_source_kind_chk" CHECK ("note_search_sections"."source_kind" in ('note', 'attachment')),
	CONSTRAINT "nss_source_id_chk" CHECK (("note_search_sections"."source_kind" = 'note') = ("note_search_sections"."source_id" is null)),
	CONSTRAINT "nss_section_id_chk" CHECK ("note_search_sections"."section_id" ~ '^[A-Za-z0-9_-]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "note_search_state" (
	"note_id" uuid PRIMARY KEY NOT NULL,
	"extractor_version" smallint NOT NULL,
	"source_version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"indexed_units" integer NOT NULL,
	"capped" boolean NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "note_search_sections" ADD CONSTRAINT "note_search_sections_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_search_state" ADD CONSTRAINT "note_search_state_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nss_note_idx" ON "note_search_sections" USING btree ("note_id","source_kind","ord");