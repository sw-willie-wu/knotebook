-- #404 使用者頭貼：建 user_avatars（候選頭貼：原圖檔名、顯示圖 bytea、裁切範圍、is_current 部分唯一索引等），並加 users.avatar_auto、user_identities.last_picture_url、user_identities.picture_dismissed_url 三欄。單一交易、無非交易式 DDL、不回填；avatar_auto 預設 true，所以已用 OIDC 登入的人下次登入會自動帶入頭貼。不動 users.avatar_url。回滾到前一版：舊碼不讀這張表和這三欄，留著無害；之後再升回來，表裡的資料重新生效。
CREATE TABLE "user_avatars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"identity_id" uuid,
	"oidc_picture_url" text,
	"original_file" uuid NOT NULL,
	"original_sha256" "bytea" NOT NULL,
	"original_mime" text NOT NULL,
	"original_size" bigint NOT NULL,
	"original_width" integer,
	"original_height" integer,
	"crop_x" integer,
	"crop_y" integer,
	"crop_size" integer,
	"display_data" "bytea",
	"display_mime" text,
	"display_size" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_avatars_source_chk" CHECK ("user_avatars"."source" in ('upload', 'oidc')),
	CONSTRAINT "user_avatars_oidc_url_chk" CHECK (("user_avatars"."source" = 'oidc') = ("user_avatars"."oidc_picture_url" is not null)),
	CONSTRAINT "user_avatars_oidc_url_len_chk" CHECK ("user_avatars"."oidc_picture_url" is null or char_length("user_avatars"."oidc_picture_url") <= 2048),
	CONSTRAINT "user_avatars_sha256_chk" CHECK (octet_length("user_avatars"."original_sha256") = 32),
	CONSTRAINT "user_avatars_original_mime_chk" CHECK ("user_avatars"."original_mime" in ('image/png', 'image/jpeg', 'image/webp')),
	CONSTRAINT "user_avatars_original_size_chk" CHECK ("user_avatars"."original_size" > 0 and "user_avatars"."original_size" <= 10485760),
	CONSTRAINT "user_avatars_crop_chk" CHECK (("user_avatars"."crop_x" is null and "user_avatars"."crop_y" is null and "user_avatars"."crop_size" is null) or ("user_avatars"."crop_x" is not null and "user_avatars"."crop_y" is not null and "user_avatars"."crop_size" is not null and "user_avatars"."crop_size" > 0)),
	CONSTRAINT "user_avatars_display_size_max_chk" CHECK ("user_avatars"."display_data" is null or octet_length("user_avatars"."display_data") <= 262144),
	CONSTRAINT "user_avatars_display_pair_chk" CHECK (("user_avatars"."display_data" is null) = ("user_avatars"."display_mime" is null)),
	CONSTRAINT "user_avatars_display_mime_chk" CHECK ("user_avatars"."display_mime" is null or "user_avatars"."display_mime" in ('image/png', 'image/jpeg', 'image/webp')),
	CONSTRAINT "user_avatars_upload_display_chk" CHECK ("user_avatars"."source" <> 'upload' or "user_avatars"."display_data" is not null),
	CONSTRAINT "user_avatars_display_size_chk" CHECK ("user_avatars"."display_size" = coalesce(octet_length("user_avatars"."display_data"), 0)),
	CONSTRAINT "user_avatars_version_chk" CHECK ("user_avatars"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "user_identities" ADD COLUMN "last_picture_url" text;--> statement-breakpoint
ALTER TABLE "user_identities" ADD COLUMN "picture_dismissed_url" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_auto" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_avatars" ADD CONSTRAINT "user_avatars_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_avatars" ADD CONSTRAINT "user_avatars_identity_id_user_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."user_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_avatars_user_idx" ON "user_avatars" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_avatars_original_file_idx" ON "user_avatars" USING btree ("original_file");--> statement-breakpoint
CREATE UNIQUE INDEX "user_avatars_identity_idx" ON "user_avatars" USING btree ("identity_id") WHERE "user_avatars"."identity_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_avatars_current_idx" ON "user_avatars" USING btree ("user_id") WHERE "user_avatars"."is_current";--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_last_picture_url_chk" CHECK ("user_identities"."last_picture_url" is null or char_length("user_identities"."last_picture_url") <= 2048);--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_picture_dismissed_url_chk" CHECK ("user_identities"."picture_dismissed_url" is null or char_length("user_identities"."picture_dismissed_url") <= 2048);