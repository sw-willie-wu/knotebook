CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"scope" text NOT NULL,
	"access_token_hash" text NOT NULL,
	"refresh_token_hash" text,
	"client_id" text,
	"access_expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_access_token_hash_unique" UNIQUE("access_token_hash"),
	CONSTRAINT "api_tokens_refresh_token_hash_unique" UNIQUE("refresh_token_hash"),
	CONSTRAINT "api_tokens_kind_chk" CHECK ("api_tokens"."kind" in ('pat','oauth')),
	CONSTRAINT "api_tokens_scope_chk" CHECK ("api_tokens"."scope" in ('notes:read','notes:read notes:write')),
	CONSTRAINT "api_tokens_name_chk" CHECK (length("api_tokens"."name") between 1 and 64),
	CONSTRAINT "api_tokens_client_chk" CHECK (("api_tokens"."kind" = 'pat') = ("api_tokens"."client_id" is null)),
	CONSTRAINT "api_tokens_refresh_chk" CHECK (("api_tokens"."kind" = 'pat') = ("api_tokens"."refresh_token_hash" is null)),
	CONSTRAINT "api_tokens_oauth_expiry_chk" CHECK ("api_tokens"."kind" = 'pat' or "api_tokens"."access_expires_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"client_name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_clients_name_chk" CHECK (length("oauth_clients"."client_name") between 1 and 64),
	CONSTRAINT "oauth_clients_redirect_uris_chk" CHECK (jsonb_typeof("oauth_clients"."redirect_uris") = 'array' and jsonb_array_length("oauth_clients"."redirect_uris") between 1 and 8)
);
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "oauth_codes_scope_chk" CHECK ("oauth_codes"."scope" in ('notes:read','notes:read notes:write'))
);
--> statement-breakpoint
CREATE TABLE "oauth_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"scope" text NOT NULL,
	"state" text,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "oauth_requests_scope_chk" CHECK ("oauth_requests"."scope" in ('notes:read','notes:read notes:write')),
	CONSTRAINT "oauth_requests_state_chk" CHECK ("oauth_requests"."state" is null or length("oauth_requests"."state") <= 2048)
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_requests" ADD CONSTRAINT "oauth_requests_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_tokens_user_idx" ON "api_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "api_tokens_client_idx" ON "api_tokens" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_oauth_user_client_uidx" ON "api_tokens" USING btree ("user_id","client_id") WHERE "api_tokens"."kind" = 'oauth';--> statement-breakpoint
CREATE INDEX "oauth_codes_client_idx" ON "oauth_codes" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_codes_user_idx" ON "oauth_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_requests_client_idx" ON "oauth_requests" USING btree ("client_id");