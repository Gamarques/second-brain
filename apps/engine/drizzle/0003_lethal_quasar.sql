CREATE TABLE "environment_configuration_restart_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"configuration_revision" integer NOT NULL,
	"actor_alias_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_configuration_restart_requests_idempotency_key" UNIQUE("idempotency_key"),
	CONSTRAINT "environment_configuration_restart_requests_idempotency_key_check" CHECK (length(btrim("environment_configuration_restart_requests"."idempotency_key")) between 1 and 200),
	CONSTRAINT "environment_configuration_restart_requests_request_digest_check" CHECK ("environment_configuration_restart_requests"."request_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "environment_configuration_restart_requests_revision_check" CHECK ("environment_configuration_restart_requests"."configuration_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "environment_configuration" ADD COLUMN "restart_requested_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "environment_configuration_restart_requests" ADD CONSTRAINT "environment_configuration_restart_requests_actor_alias_id_admin_audit_actor_aliases_id_fk" FOREIGN KEY ("actor_alias_id") REFERENCES "public"."admin_audit_actor_aliases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "environment_configuration_restart_requests_created_id_idx" ON "environment_configuration_restart_requests" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "environment_configuration" ADD CONSTRAINT "environment_configuration_restart_revision_check" CHECK ("environment_configuration"."restart_requested_revision" >= 0 and "environment_configuration"."restart_requested_revision" <= "environment_configuration"."revision");--> statement-breakpoint
CREATE TRIGGER "environment_configuration_restart_requests_append_only_rows"
BEFORE UPDATE OR DELETE ON "environment_configuration_restart_requests"
FOR EACH ROW EXECUTE FUNCTION "reject_admin_history_mutation"();
--> statement-breakpoint
CREATE TRIGGER "environment_configuration_restart_requests_append_only_truncate"
BEFORE TRUNCATE ON "environment_configuration_restart_requests"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_admin_history_mutation"();
