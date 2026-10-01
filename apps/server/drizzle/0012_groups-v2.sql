-- #175 群組 v2（spec §10.2）：drizzle-kit 兩段產出後人工重排（plan Task 1 Step 3）。單一交易（drizzle migrator 的整批交易）；見 migrate.test.ts 的輔助 grep。
-- 步驟 1：group_roles（七旗標、六條 CHECK、三把唯一索引）
CREATE TABLE "group_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"builtin" text,
	"name" text,
	"can_read" boolean DEFAULT true NOT NULL,
	"can_create" boolean DEFAULT false NOT NULL,
	"can_edit" boolean DEFAULT false NOT NULL,
	"can_delete" boolean DEFAULT false NOT NULL,
	"can_manage_public_link" boolean DEFAULT false NOT NULL,
	"can_manage_members" boolean DEFAULT false NOT NULL,
	"can_manage_group" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_roles_builtin_chk" CHECK ("group_roles"."builtin" in ('admin','member')),
	CONSTRAINT "group_roles_name_chk" CHECK (("group_roles"."builtin" is null) = ("group_roles"."name" is not null)),
	CONSTRAINT "group_roles_name_len_chk" CHECK ("group_roles"."name" is null or length("group_roles"."name") between 1 and 40),
	CONSTRAINT "group_roles_admin_all_chk" CHECK ("group_roles"."builtin" is distinct from 'admin' or ("group_roles"."can_read" and "group_roles"."can_create" and "group_roles"."can_edit" and "group_roles"."can_delete" and "group_roles"."can_manage_public_link" and "group_roles"."can_manage_members" and "group_roles"."can_manage_group")),
	CONSTRAINT "group_roles_read_implied_chk" CHECK ("group_roles"."can_read" or not ("group_roles"."can_create" or "group_roles"."can_edit" or "group_roles"."can_delete" or "group_roles"."can_manage_public_link")),
	CONSTRAINT "group_roles_create_needs_edit_chk" CHECK ("group_roles"."can_edit" or not "group_roles"."can_create")
);
--> statement-breakpoint
ALTER TABLE "group_roles" ADD CONSTRAINT "group_roles_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "group_roles_group_id_id_idx" ON "group_roles" USING btree ("group_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_roles_builtin_idx" ON "group_roles" USING btree ("group_id","builtin") WHERE "group_roles"."builtin" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "group_roles_name_idx" ON "group_roles" USING btree ("group_id",lower("name")) WHERE "group_roles"."builtin" is null;--> statement-breakpoint
-- 步驟 2：每個群組兩個內建角色（name 恆 NULL）
INSERT INTO "group_roles" ("group_id", "builtin", "can_read", "can_create", "can_edit", "can_delete", "can_manage_public_link", "can_manage_members", "can_manage_group")
SELECT "id", 'admin', true, true, true, true, true, true, true FROM "groups";--> statement-breakpoint
INSERT INTO "group_roles" ("group_id", "builtin", "can_read", "can_create", "can_edit")
SELECT "id", 'member', true, true, true FROM "groups";--> statement-breakpoint
-- 步驟 3：group_members.role → role_id
ALTER TABLE "group_members" ADD COLUMN "role_id" uuid;--> statement-breakpoint
UPDATE "group_members" AS gm SET "role_id" = r."id" FROM "group_roles" AS r WHERE r."group_id" = gm."group_id" AND r."builtin" = gm."role";--> statement-breakpoint
ALTER TABLE "group_members" ALTER COLUMN "role_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_role_fk" FOREIGN KEY ("group_id","role_id") REFERENCES "public"."group_roles"("group_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_members_role_idx" ON "group_members" USING btree ("role_id");--> statement-breakpoint
ALTER TABLE "group_members" DROP CONSTRAINT "group_members_role_chk";--> statement-breakpoint
ALTER TABLE "group_members" DROP COLUMN "role";--> statement-breakpoint
-- 步驟 4：note_redirects＋既有群組筆記的現行 slug 轉址（Q6；用轉換前的 owner handle；不寫 prev_slug 路徑）
CREATE TABLE "note_redirects" (
	"old_path" text PRIMARY KEY NOT NULL,
	"note_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "note_redirects" ADD CONSTRAINT "note_redirects_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_redirects_note_idx" ON "note_redirects" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "note_redirects_expires_idx" ON "note_redirects" USING btree ("expires_at");--> statement-breakpoint
INSERT INTO "note_redirects" ("old_path", "note_id", "expires_at")
SELECT '/n/' || u."handle" || '/' || n."slug", n."id", now() + interval '1 month'
FROM "notes" AS n JOIN "users" AS u ON u."id" = n."owner_id"
WHERE n."group_id" IS NOT NULL;--> statement-breakpoint
-- 步驟 5：S5 殘留與群組筆記的公開別名
DELETE FROM "note_shares" AS s USING "notes" AS n WHERE n."id" = s."note_id" AND n."group_id" IS NOT NULL;--> statement-breakpoint
UPDATE "notes" SET "public_slug" = NULL WHERE "group_id" IS NOT NULL AND "public_slug" IS NOT NULL;--> statement-breakpoint
-- 步驟 6：擁有權轉移（必須在去重之前——gate r1 I1／F2）
ALTER TABLE "notes" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
UPDATE "notes" SET "owner_id" = NULL, "prev_slug" = NULL WHERE "group_id" IS NOT NULL;--> statement-breakpoint
-- 步驟 7：群組內 slug 去重（基底＝現行 slug；-2..-21；重截 ≤60；退 untitled-<uuid8>）
DO $mig$
DECLARE r record; cand text; suffix text; k int; found boolean;
BEGIN
  FOR r IN SELECT x."id", x."group_id", x."slug" FROM (
      SELECT "id", "group_id", "slug", row_number() OVER (PARTITION BY "group_id", "slug" ORDER BY "created_at", "id") AS rn
      FROM "notes" WHERE "group_id" IS NOT NULL) AS x
    WHERE x.rn > 1 ORDER BY x."group_id", x."slug", x.rn
  LOOP
    found := false;
    FOR k IN 2..21 LOOP
      suffix := '-' || k;
      cand := regexp_replace(left(r."slug", 60 - length(suffix)), '-+$', '') || suffix;
      IF NOT EXISTS (SELECT 1 FROM "notes" WHERE "group_id" = r."group_id" AND "slug" = cand) THEN
        found := true;
        EXIT;
      END IF;
    END LOOP;
    IF NOT found THEN
      cand := 'untitled-' || substr(gen_random_uuid()::text, 1, 8);
    END IF;
    UPDATE "notes" SET "slug" = cand WHERE "id" = r."id";
  END LOOP;
END $mig$;--> statement-breakpoint
-- 步驟 8：XOR／別名 CHECK、FK 改 RESTRICT、群組 slug 索引（兼任 #103 單欄 notes_group_idx 的用途，後者刪除）、廢 group_role
ALTER TABLE "notes" ADD CONSTRAINT "notes_owner_xor_group_chk" CHECK (("notes"."owner_id" is null) <> ("notes"."group_id" is null));--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_group_no_public_slug_chk" CHECK ("notes"."group_id" is null or "notes"."public_slug" is null);--> statement-breakpoint
ALTER TABLE "notes" DROP CONSTRAINT "notes_group_id_groups_id_fk";--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notes_group_slug_idx" ON "notes" USING btree ("group_id","slug");--> statement-breakpoint
DROP INDEX "notes_group_idx";--> statement-breakpoint
CREATE INDEX "notes_group_prev_slug_idx" ON "notes" USING btree ("group_id","prev_slug") WHERE "notes"."prev_slug" is not null;--> statement-breakpoint
ALTER TABLE "notes" DROP CONSTRAINT "notes_group_role_chk";--> statement-breakpoint
ALTER TABLE "notes" DROP COLUMN "group_role";
