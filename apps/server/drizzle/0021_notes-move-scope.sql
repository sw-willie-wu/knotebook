ALTER TABLE "api_tokens" DROP CONSTRAINT "api_tokens_scope_chk";--> statement-breakpoint
ALTER TABLE "oauth_codes" DROP CONSTRAINT "oauth_codes_scope_chk";--> statement-breakpoint
ALTER TABLE "oauth_requests" DROP CONSTRAINT "oauth_requests_scope_chk";--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_scope_chk" CHECK ("api_tokens"."scope" in ('notes:read','notes:read notes:write','notes:read notes:write notes:move'));--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_scope_chk" CHECK ("oauth_codes"."scope" in ('notes:read','notes:read notes:write','notes:read notes:write notes:move'));--> statement-breakpoint
ALTER TABLE "oauth_requests" ADD CONSTRAINT "oauth_requests_scope_chk" CHECK ("oauth_requests"."scope" in ('notes:read','notes:read notes:write','notes:read notes:write notes:move'));