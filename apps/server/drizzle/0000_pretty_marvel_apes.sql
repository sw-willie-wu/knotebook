CREATE TABLE "ai_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"system_prompt" text NOT NULL,
	"user_template" text NOT NULL,
	"model_id" uuid,
	"apply_mode" text DEFAULT 'preview' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "ai_actions_apply_mode_chk" CHECK ("ai_actions"."apply_mode" in ('direct','preview'))
);
--> statement-breakpoint
CREATE TABLE "ai_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"model_id" text NOT NULL,
	"display_name" text NOT NULL,
	"purpose" text DEFAULT 'chat' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_models_purpose_chk" CHECK ("ai_models"."purpose" in ('chat','embedding'))
);
--> statement-breakpoint
CREATE TABLE "ai_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_encrypted" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_providers_type_chk" CHECK ("ai_providers"."type" in ('openai_compatible','anthropic'))
);
--> statement-breakpoint
CREATE TABLE "instance_setup" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_setup_singleton_chk" CHECK ("instance_setup"."singleton")
);
--> statement-breakpoint
CREATE TABLE "note_links" (
	"source_note_id" uuid NOT NULL,
	"target_note_id" uuid NOT NULL,
	CONSTRAINT "note_links_source_note_id_target_note_id_pk" PRIMARY KEY("source_note_id","target_note_id")
);
--> statement-breakpoint
CREATE TABLE "note_shares" (
	"note_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_shares_note_id_user_id_pk" PRIMARY KEY("note_id","user_id"),
	CONSTRAINT "note_shares_role_chk" CHECK ("note_shares"."role" in ('viewer','editor'))
);
--> statement-breakpoint
CREATE TABLE "note_state_backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"ydoc" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "note_states" (
	"note_id" uuid PRIMARY KEY NOT NULL,
	"ydoc" "bytea" NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text DEFAULT 'Untitled' NOT NULL,
	"links_clock" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"uploader_id" uuid,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"oidc_issuer" text,
	"oidc_sub" text,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"is_admin" boolean DEFAULT false NOT NULL,
	"disabled_at" timestamp with time zone,
	"token_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_model_id_ai_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_links" ADD CONSTRAINT "note_links_source_note_id_notes_id_fk" FOREIGN KEY ("source_note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_links" ADD CONSTRAINT "note_links_target_note_id_notes_id_fk" FOREIGN KEY ("target_note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_shares" ADD CONSTRAINT "note_shares_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_shares" ADD CONSTRAINT "note_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_state_backups" ADD CONSTRAINT "note_state_backups_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_states" ADD CONSTRAINT "note_states_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_models_provider_model_idx" ON "ai_models" USING btree ("provider_id","model_id");--> statement-breakpoint
CREATE INDEX "note_links_target_idx" ON "note_links" USING btree ("target_note_id");--> statement-breakpoint
CREATE INDEX "nsb_note_created_idx" ON "note_state_backups" USING btree ("note_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_oidc_idx" ON "users" USING btree ("oidc_issuer","oidc_sub");