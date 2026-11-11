-- #334 最愛：只建 note_favorites（每人每篇至多一列：PK (user_id, note_id)；user_id、note_id 兩條 FK 都 ON DELETE CASCADE；note_id 索引支撐永久刪筆記時的 cascade；created_at 預設存整毫秒）；單一交易、無非交易式 DDL、不回填。回滾到前一版：舊碼不讀這張表，表留著無害；之後再升回來，表裡的紀錄照舊生效。
CREATE TABLE "note_favorites" (
	"user_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "note_favorites_user_id_note_id_pk" PRIMARY KEY("user_id","note_id")
);
--> statement-breakpoint
ALTER TABLE "note_favorites" ADD CONSTRAINT "note_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_favorites" ADD CONSTRAINT "note_favorites_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_favorites_note_idx" ON "note_favorites" USING btree ("note_id");