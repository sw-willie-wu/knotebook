ALTER TABLE "uploads" ALTER COLUMN "size" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN "file_name" text;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_file_name_len_chk" CHECK ("uploads"."file_name" is null or octet_length("uploads"."file_name") between 1 and 200);