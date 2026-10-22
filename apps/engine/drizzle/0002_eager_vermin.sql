CREATE TYPE "public"."admin_audit_category" AS ENUM('domain', 'administration', 'authentication', 'automation');--> statement-breakpoint
CREATE TYPE "public"."admin_audit_outcome" AS ENUM('succeeded', 'denied', 'failed');--> statement-breakpoint
CREATE TABLE "admin_audit_actor_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_audit_actor_aliases_account_key" UNIQUE("account_id")
);
--> statement-breakpoint
CREATE TABLE "admin_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" "admin_audit_category" NOT NULL,
	"action" text NOT NULL,
	"outcome" "admin_audit_outcome" NOT NULL,
	"target_type" text,
	"target_id" text,
	"actor_alias_id" uuid,
	"actor_role" "membership_role",
	"request_id" text NOT NULL,
	"error_code" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"changed_names" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_audit_events_action_check" CHECK (length(btrim("admin_audit_events"."action")) between 1 and 200),
	CONSTRAINT "admin_audit_events_target_check" CHECK (("admin_audit_events"."target_type" is null and "admin_audit_events"."target_id" is null)
        or (length(btrim("admin_audit_events"."target_type")) between 1 and 200
          and ("admin_audit_events"."target_id" is null or length(btrim("admin_audit_events"."target_id")) between 1 and 500))),
	CONSTRAINT "admin_audit_events_request_id_check" CHECK (length(btrim("admin_audit_events"."request_id")) between 1 and 500),
	CONSTRAINT "admin_audit_events_error_code_check" CHECK ("admin_audit_events"."error_code" is null or length(btrim("admin_audit_events"."error_code")) between 1 and 200),
	CONSTRAINT "admin_audit_events_metadata_check" CHECK (jsonb_typeof("admin_audit_events"."metadata") = 'object' and pg_column_size("admin_audit_events"."metadata") <= 16384),
	CONSTRAINT "admin_audit_events_changed_names_check" CHECK (cardinality("admin_audit_events"."changed_names") between 0 and 100),
	CONSTRAINT "admin_audit_events_configuration_metadata_check" CHECK (("admin_audit_events"."target_type" = 'environment_configuration'
          and "admin_audit_events"."changed_names" <> '{}'::text[]
          and "admin_audit_events"."metadata" = jsonb_build_object('changedNames', to_jsonb("admin_audit_events"."changed_names")))
        or ("admin_audit_events"."target_type" is distinct from 'environment_configuration'
          and "admin_audit_events"."changed_names" = '{}'::text[]))
);
--> statement-breakpoint
CREATE TABLE "environment_configuration" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"revision" integer NOT NULL,
	"entries" jsonb NOT NULL,
	"restart_required" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_configuration_singleton_check" CHECK ("environment_configuration"."id" = 1),
	CONSTRAINT "environment_configuration_revision_check" CHECK ("environment_configuration"."revision" > 0),
	CONSTRAINT "environment_configuration_entries_check" CHECK (jsonb_typeof("environment_configuration"."entries") = 'object')
);
--> statement-breakpoint
CREATE TABLE "environment_configuration_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"expected_revision" integer NOT NULL,
	"result_revision" integer NOT NULL,
	"changed_names" text[] NOT NULL,
	"restart_required" boolean NOT NULL,
	"actor_alias_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_configuration_changes_idempotency_key" UNIQUE("idempotency_key"),
	CONSTRAINT "environment_configuration_changes_idempotency_key_check" CHECK (length(btrim("environment_configuration_changes"."idempotency_key")) between 1 and 200),
	CONSTRAINT "environment_configuration_changes_request_digest_check" CHECK ("environment_configuration_changes"."request_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "environment_configuration_changes_revisions_check" CHECK ("environment_configuration_changes"."expected_revision" >= 0 and "environment_configuration_changes"."result_revision" = "environment_configuration_changes"."expected_revision" + 1),
	CONSTRAINT "environment_configuration_changes_names_check" CHECK (cardinality("environment_configuration_changes"."changed_names") between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "admin_audit_actor_aliases" ADD CONSTRAINT "admin_audit_actor_aliases_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_audit_events" ADD CONSTRAINT "admin_audit_events_actor_alias_id_admin_audit_actor_aliases_id_fk" FOREIGN KEY ("actor_alias_id") REFERENCES "public"."admin_audit_actor_aliases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_configuration_changes" ADD CONSTRAINT "environment_configuration_changes_actor_alias_id_admin_audit_actor_aliases_id_fk" FOREIGN KEY ("actor_alias_id") REFERENCES "public"."admin_audit_actor_aliases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_events_occurred_id_idx" ON "admin_audit_events" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "admin_audit_events_category_occurred_idx" ON "admin_audit_events" USING btree ("category","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "admin_audit_events_action_occurred_idx" ON "admin_audit_events" USING btree ("action","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "admin_audit_events_outcome_occurred_idx" ON "admin_audit_events" USING btree ("outcome","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "admin_audit_events_actor_occurred_idx" ON "admin_audit_events" USING btree ("actor_alias_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "admin_audit_events_target_occurred_idx" ON "admin_audit_events" USING btree ("target_type","target_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "environment_configuration_changes_created_id_idx" ON "environment_configuration_changes" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
CREATE FUNCTION "reject_admin_history_mutation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Administrative history is append-only.' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "admin_audit_events_append_only_rows"
BEFORE UPDATE OR DELETE ON "admin_audit_events"
FOR EACH ROW EXECUTE FUNCTION "reject_admin_history_mutation"();
--> statement-breakpoint
CREATE TRIGGER "admin_audit_events_append_only_truncate"
BEFORE TRUNCATE ON "admin_audit_events"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_admin_history_mutation"();
--> statement-breakpoint
CREATE TRIGGER "environment_configuration_changes_append_only_rows"
BEFORE UPDATE OR DELETE ON "environment_configuration_changes"
FOR EACH ROW EXECUTE FUNCTION "reject_admin_history_mutation"();
--> statement-breakpoint
CREATE TRIGGER "environment_configuration_changes_append_only_truncate"
BEFORE TRUNCATE ON "environment_configuration_changes"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_admin_history_mutation"();
