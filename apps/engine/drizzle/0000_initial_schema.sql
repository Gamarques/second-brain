DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass
          AND d.objid = c.oid
          AND d.deptype = 'e'
      )
    UNION ALL
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typtype IN ('d', 'e')
      AND t.typelem = 0
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_type'::regclass
          AND d.objid = t.oid
          AND d.deptype = 'e'
      )
  ) THEN
    RAISE EXCEPTION 'Clean v1 migrations require an empty public schema.';
  END IF;
END
$$;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
CREATE TYPE "public"."automation_job_kind" AS ENUM('daily_dreaming', 'reminder_delivery');--> statement-breakpoint
CREATE TYPE "public"."automation_job_status" AS ENUM('pending', 'running', 'retry_wait', 'completed', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."notification_channel_kind" AS ENUM('inbox', 'email', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."reminder_delivery_status" AS ENUM('pending', 'running', 'delivered', 'retry_wait', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."account_status" AS ENUM('active', 'disabled', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."activity_time_basis" AS ENUM('instant', 'explicit_interval');--> statement-breakpoint
CREATE TYPE "public"."actor_kind" AS ENUM('account', 'oauth_client', 'import', 'dreaming', 'system');--> statement-breakpoint
CREATE TYPE "public"."dreaming_mode" AS ENUM('preview', 'apply');--> statement-breakpoint
CREATE TYPE "public"."embedding_entity_type" AS ENUM('memory', 'decision', 'knowledge_chunk', 'insight');--> statement-breakpoint
CREATE TYPE "public"."embedding_metric" AS ENUM('cosine');--> statement-breakpoint
CREATE TYPE "public"."embedding_space_status" AS ENUM('preparing', 'active', 'retired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."goal_status" AS ENUM('active', 'paused', 'achieved', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."link_basis" AS ENUM('explicit', 'reviewed_inference', 'model_inference');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('viewer', 'editor', 'admin', 'owner');--> statement-breakpoint
CREATE TYPE "public"."mutation_source" AS ENUM('direct', 'mcp_http', 'automation', 'import');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('active', 'paused', 'completed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."task_relation_kind" AS ENUM('blocks', 'depends_on', 'duplicate_of');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('todo', 'in_progress', 'done', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."version_operation" AS ENUM('created', 'updated', 'started', 'completed', 'reopened', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."version_origin" AS ENUM('native', 'import');--> statement-breakpoint
CREATE TYPE "public"."dreaming_change_operation" AS ENUM('create', 'update');--> statement-breakpoint
CREATE TYPE "public"."dreaming_change_status" AS ENUM('proposed', 'eligible', 'applied', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."dreaming_evidence_role" AS ENUM('primary', 'comparison', 'memory_target');--> statement-breakpoint
CREATE TYPE "public"."dreaming_evidence_type" AS ENUM('memory', 'decision', 'task', 'reminder', 'goal', 'priority_plan', 'activity', 'activity_summary');--> statement-breakpoint
CREATE TYPE "public"."dreaming_run_status" AS ENUM('pending', 'collecting', 'analyzing', 'verifying', 'applying', 'completed', 'completed_with_skips', 'retryable_failed', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."ingest_proposal_kind" AS ENUM('memory', 'decision', 'task', 'reminder', 'person');--> statement-breakpoint
CREATE TYPE "public"."ingest_receipt_status" AS ENUM('committed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."ingest_review_decision" AS ENUM('accept', 'reject');--> statement-breakpoint
CREATE TYPE "public"."ingest_run_status" AS ENUM('proposing', 'awaiting_review', 'reviewed', 'committing', 'completed', 'completed_with_skips', 'failed');--> statement-breakpoint
CREATE TYPE "public"."activity_event_action" AS ENUM('created', 'updated', 'started', 'completed', 'reopened', 'canceled', 'deleted', 'superseded', 'revoked', 'linked', 'retracted');--> statement-breakpoint
CREATE TYPE "public"."activity_event_entity_type" AS ENUM('task_list', 'task', 'task_relation', 'reminder', 'memory', 'decision', 'project', 'person', 'goal', 'priority_plan', 'knowledge_document', 'knowledge_base', 'activity', 'automation_settings');--> statement-breakpoint
CREATE TYPE "public"."activity_kind" AS ENUM('work_session', 'progress_note', 'meeting', 'communication');--> statement-breakpoint
CREATE TABLE "automation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "automation_job_kind" NOT NULL,
	"canonical_key" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" "automation_job_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"fencing_token" uuid,
	"cancel_requested_at" timestamp with time zone,
	"sanitized_error" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_jobs_id_kind_key" UNIQUE("id","kind"),
	CONSTRAINT "automation_jobs_canonical_key" UNIQUE("kind","canonical_key"),
	CONSTRAINT "automation_jobs_attempt_check" CHECK ("automation_jobs"."attempt_count" >= 0),
	CONSTRAINT "automation_jobs_lease_check" CHECK (("automation_jobs"."status" = 'running' and "automation_jobs"."lease_owner" is not null and "automation_jobs"."lease_expires_at" is not null and "automation_jobs"."fencing_token" is not null)
        or ("automation_jobs"."status" <> 'running' and "automation_jobs"."lease_owner" is null and "automation_jobs"."lease_expires_at" is null and "automation_jobs"."fencing_token" is null)),
	CONSTRAINT "automation_jobs_retry_check" CHECK (("automation_jobs"."status" = 'retry_wait' and "automation_jobs"."next_attempt_at" is not null) or ("automation_jobs"."status" <> 'retry_wait'))
);
--> statement-breakpoint
CREATE TABLE "automation_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"time_zone" text NOT NULL,
	"dreaming_enabled" boolean DEFAULT false NOT NULL,
	"dream_local_time" time DEFAULT '03:00' NOT NULL,
	"next_dream_at" timestamp with time zone,
	"dreaming_mode" "dreaming_mode" DEFAULT 'preview' NOT NULL,
	"daily_input_token_limit" integer DEFAULT 20000 NOT NULL,
	"daily_output_token_limit" integer DEFAULT 2000 NOT NULL,
	"reminder_delivery_enabled" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_settings_singleton_check" CHECK ("automation_settings"."id" = 1),
	CONSTRAINT "automation_settings_revision_check" CHECK ("automation_settings"."revision" > 0),
	CONSTRAINT "automation_settings_token_limits_check" CHECK ("automation_settings"."daily_input_token_limit" > 0 and "automation_settings"."daily_output_token_limit" > 0)
);
--> statement-breakpoint
CREATE TABLE "automation_worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "notification_channel_kind" NOT NULL,
	"name" text NOT NULL,
	"encrypted_config" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_channels_name_check" CHECK (length(btrim("notification_channels"."name")) between 1 and 200),
	CONSTRAINT "notification_channels_config_check" CHECK (("notification_channels"."kind" = 'inbox' and "notification_channels"."encrypted_config" is null) or ("notification_channels"."kind" <> 'inbox' and nullif("notification_channels"."encrypted_config", '') is not null))
);
--> statement-breakpoint
CREATE TABLE "reminder_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reminder_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"automation_job_id" uuid NOT NULL,
	"automation_job_kind" "automation_job_kind" DEFAULT 'reminder_delivery' NOT NULL,
	"message_snapshot" text NOT NULL,
	"remind_at_snapshot" timestamp with time zone NOT NULL,
	"status" "reminder_delivery_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider_message_id" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminder_deliveries_idempotency_key" UNIQUE("idempotency_key"),
	CONSTRAINT "reminder_deliveries_job_key" UNIQUE("automation_job_id"),
	CONSTRAINT "reminder_deliveries_reminder_channel_key" UNIQUE("reminder_id","channel_id"),
	CONSTRAINT "reminder_deliveries_job_kind_check" CHECK ("reminder_deliveries"."automation_job_kind" = 'reminder_delivery'),
	CONSTRAINT "reminder_deliveries_delivered_check" CHECK (("reminder_deliveries"."status" = 'delivered' and "reminder_deliveries"."delivered_at" is not null) or ("reminder_deliveries"."status" <> 'delivered' and "reminder_deliveries"."delivered_at" is null))
);
--> statement-breakpoint
CREATE TABLE "decision_people" (
	"decision_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_people_pkey" PRIMARY KEY("decision_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lineage_id" uuid NOT NULL,
	"version_number" integer DEFAULT 1 NOT NULL,
	"supersedes_id" uuid,
	"statement" text NOT NULL,
	"rationale" text NOT NULL,
	"rejected_alternatives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"project_id" uuid,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"content_hash" text NOT NULL,
	"source_excerpt" text,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_account_id" uuid,
	"actor_client_id" text,
	"actor_source" "mutation_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decisions_id_lineage_key" UNIQUE("id","lineage_id"),
	CONSTRAINT "decisions_lineage_version_key" UNIQUE("lineage_id","version_number"),
	CONSTRAINT "decisions_supersedes_key" UNIQUE("supersedes_id"),
	CONSTRAINT "decisions_statement_length_check" CHECK (length(btrim("decisions"."statement")) between 1 and 2000),
	CONSTRAINT "decisions_rationale_length_check" CHECK (length(btrim("decisions"."rationale")) between 1 and 10000),
	CONSTRAINT "decisions_rejected_alternatives_check" CHECK (jsonb_typeof("decisions"."rejected_alternatives") = 'array'),
	CONSTRAINT "decisions_version_number_check" CHECK ("decisions"."version_number" > 0),
	CONSTRAINT "decisions_lineage_check" CHECK (("decisions"."version_number" = 1 and "decisions"."supersedes_id" is null and "decisions"."lineage_id" = "decisions"."id") or ("decisions"."version_number" > 1 and "decisions"."supersedes_id" is not null)),
	CONSTRAINT "decisions_content_hash_check" CHECK ("decisions"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "decisions_actor_check" CHECK ((
      ("decisions"."actor_kind" = 'account' and (("decisions"."actor_account_id" is not null and "decisions"."actor_client_id" is null) or ("decisions"."actor_account_id" is null and "decisions"."actor_client_id" is null)))
      or ("decisions"."actor_kind" = 'oauth_client' and (("decisions"."actor_account_id" is not null and nullif(btrim("decisions"."actor_client_id"), '') is not null) or ("decisions"."actor_account_id" is null and "decisions"."actor_client_id" is null)))
      or ("decisions"."actor_kind" = 'import' and (("decisions"."actor_account_id" is not null and "decisions"."actor_client_id" is null) or ("decisions"."actor_account_id" is null and "decisions"."actor_client_id" is null)))
      or ("decisions"."actor_kind" in ('dreaming', 'system') and "decisions"."actor_account_id" is null and "decisions"."actor_client_id" is null)
    ))
);
--> statement-breakpoint
CREATE TABLE "knowledge_bases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_account_id" uuid,
	"actor_client_id" text,
	"actor_source" "mutation_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_bases_name_length_check" CHECK (length(btrim("knowledge_bases"."name")) between 1 and 200),
	CONSTRAINT "knowledge_bases_actor_check" CHECK ((
      ("knowledge_bases"."actor_kind" = 'account' and (("knowledge_bases"."actor_account_id" is not null and "knowledge_bases"."actor_client_id" is null) or ("knowledge_bases"."actor_account_id" is null and "knowledge_bases"."actor_client_id" is null)))
      or ("knowledge_bases"."actor_kind" = 'oauth_client' and (("knowledge_bases"."actor_account_id" is not null and nullif(btrim("knowledge_bases"."actor_client_id"), '') is not null) or ("knowledge_bases"."actor_account_id" is null and "knowledge_bases"."actor_client_id" is null)))
      or ("knowledge_bases"."actor_kind" = 'import' and (("knowledge_bases"."actor_account_id" is not null and "knowledge_bases"."actor_client_id" is null) or ("knowledge_bases"."actor_account_id" is null and "knowledge_bases"."actor_client_id" is null)))
      or ("knowledge_bases"."actor_kind" in ('dreaming', 'system') and "knowledge_bases"."actor_account_id" is null and "knowledge_bases"."actor_client_id" is null)
    ))
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_chunks_revision_position_key" UNIQUE("revision_id","position"),
	CONSTRAINT "knowledge_chunks_position_check" CHECK ("knowledge_chunks"."position" >= 0),
	CONSTRAINT "knowledge_chunks_content_length_check" CHECK (length("knowledge_chunks"."content") > 0),
	CONSTRAINT "knowledge_chunks_content_hash_check" CHECK ("knowledge_chunks"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "knowledge_document_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"content_hash" text NOT NULL,
	"chunk_count" integer NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_account_id" uuid,
	"actor_client_id" text,
	"actor_source" "mutation_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_document_revisions_number_key" UNIQUE("document_id","revision_number"),
	CONSTRAINT "knowledge_document_revisions_number_check" CHECK ("knowledge_document_revisions"."revision_number" > 0),
	CONSTRAINT "knowledge_document_revisions_chunks_check" CHECK ("knowledge_document_revisions"."chunk_count" >= 0),
	CONSTRAINT "knowledge_document_revisions_content_hash_check" CHECK ("knowledge_document_revisions"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "knowledge_document_revisions_actor_check" CHECK ((
      ("knowledge_document_revisions"."actor_kind" = 'account' and (("knowledge_document_revisions"."actor_account_id" is not null and "knowledge_document_revisions"."actor_client_id" is null) or ("knowledge_document_revisions"."actor_account_id" is null and "knowledge_document_revisions"."actor_client_id" is null)))
      or ("knowledge_document_revisions"."actor_kind" = 'oauth_client' and (("knowledge_document_revisions"."actor_account_id" is not null and nullif(btrim("knowledge_document_revisions"."actor_client_id"), '') is not null) or ("knowledge_document_revisions"."actor_account_id" is null and "knowledge_document_revisions"."actor_client_id" is null)))
      or ("knowledge_document_revisions"."actor_kind" = 'import' and (("knowledge_document_revisions"."actor_account_id" is not null and "knowledge_document_revisions"."actor_client_id" is null) or ("knowledge_document_revisions"."actor_account_id" is null and "knowledge_document_revisions"."actor_client_id" is null)))
      or ("knowledge_document_revisions"."actor_kind" in ('dreaming', 'system') and "knowledge_document_revisions"."actor_account_id" is null and "knowledge_document_revisions"."actor_client_id" is null)
    ))
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"knowledge_base_id" uuid NOT NULL,
	"title" text NOT NULL,
	"source_uri" text,
	"current_revision_number" integer DEFAULT 1 NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_account_id" uuid,
	"actor_client_id" text,
	"actor_source" "mutation_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_documents_title_length_check" CHECK (length(btrim("knowledge_documents"."title")) between 1 and 500),
	CONSTRAINT "knowledge_documents_actor_check" CHECK ((
      ("knowledge_documents"."actor_kind" = 'account' and (("knowledge_documents"."actor_account_id" is not null and "knowledge_documents"."actor_client_id" is null) or ("knowledge_documents"."actor_account_id" is null and "knowledge_documents"."actor_client_id" is null)))
      or ("knowledge_documents"."actor_kind" = 'oauth_client' and (("knowledge_documents"."actor_account_id" is not null and nullif(btrim("knowledge_documents"."actor_client_id"), '') is not null) or ("knowledge_documents"."actor_account_id" is null and "knowledge_documents"."actor_client_id" is null)))
      or ("knowledge_documents"."actor_kind" = 'import' and (("knowledge_documents"."actor_account_id" is not null and "knowledge_documents"."actor_client_id" is null) or ("knowledge_documents"."actor_account_id" is null and "knowledge_documents"."actor_client_id" is null)))
      or ("knowledge_documents"."actor_kind" in ('dreaming', 'system') and "knowledge_documents"."actor_account_id" is null and "knowledge_documents"."actor_client_id" is null)
    )),
	CONSTRAINT "knowledge_documents_current_revision_check" CHECK ("knowledge_documents"."current_revision_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lineage_id" uuid NOT NULL,
	"version_number" integer DEFAULT 1 NOT NULL,
	"supersedes_id" uuid,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"category" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"project_id" uuid,
	"source_excerpt" text,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"captured_at" timestamp with time zone,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_account_id" uuid,
	"actor_client_id" text,
	"actor_source" "mutation_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memories_id_lineage_key" UNIQUE("id","lineage_id"),
	CONSTRAINT "memories_lineage_version_key" UNIQUE("lineage_id","version_number"),
	CONSTRAINT "memories_supersedes_key" UNIQUE("supersedes_id"),
	CONSTRAINT "memories_content_length_check" CHECK (length(btrim("memories"."content")) between 1 and 10000),
	CONSTRAINT "memories_version_number_check" CHECK ("memories"."version_number" > 0),
	CONSTRAINT "memories_lineage_check" CHECK (("memories"."version_number" = 1 and "memories"."supersedes_id" is null and "memories"."lineage_id" = "memories"."id") or ("memories"."version_number" > 1 and "memories"."supersedes_id" is not null)),
	CONSTRAINT "memories_content_hash_check" CHECK ("memories"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "memories_actor_check" CHECK ((
      ("memories"."actor_kind" = 'account' and (("memories"."actor_account_id" is not null and "memories"."actor_client_id" is null) or ("memories"."actor_account_id" is null and "memories"."actor_client_id" is null)))
      or ("memories"."actor_kind" = 'oauth_client' and (("memories"."actor_account_id" is not null and nullif(btrim("memories"."actor_client_id"), '') is not null) or ("memories"."actor_account_id" is null and "memories"."actor_client_id" is null)))
      or ("memories"."actor_kind" = 'import' and (("memories"."actor_account_id" is not null and "memories"."actor_client_id" is null) or ("memories"."actor_account_id" is null and "memories"."actor_client_id" is null)))
      or ("memories"."actor_kind" in ('dreaming', 'system') and "memories"."actor_account_id" is null and "memories"."actor_client_id" is null)
    ))
);
--> statement-breakpoint
CREATE TABLE "memory_people" (
	"memory_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_people_pkey" PRIMARY KEY("memory_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"notes" text,
	"version" integer DEFAULT 1 NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_account_id" uuid,
	"actor_client_id" text,
	"actor_source" "mutation_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "people_name_length_check" CHECK (length(btrim("people"."name")) between 1 and 300),
	CONSTRAINT "people_version_check" CHECK ("people"."version" > 0),
	CONSTRAINT "people_actor_check" CHECK ((
      ("people"."actor_kind" = 'account' and (("people"."actor_account_id" is not null and "people"."actor_client_id" is null) or ("people"."actor_account_id" is null and "people"."actor_client_id" is null)))
      or ("people"."actor_kind" = 'oauth_client' and (("people"."actor_account_id" is not null and nullif(btrim("people"."actor_client_id"), '') is not null) or ("people"."actor_account_id" is null and "people"."actor_client_id" is null)))
      or ("people"."actor_kind" = 'import' and (("people"."actor_account_id" is not null and "people"."actor_client_id" is null) or ("people"."actor_account_id" is null and "people"."actor_client_id" is null)))
      or ("people"."actor_kind" in ('dreaming', 'system') and "people"."actor_account_id" is null and "people"."actor_client_id" is null)
    ))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "project_status" DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_account_id" uuid,
	"actor_client_id" text,
	"actor_source" "mutation_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_name_length_check" CHECK (length(btrim("projects"."name")) between 1 and 300),
	CONSTRAINT "projects_version_check" CHECK ("projects"."version" > 0),
	CONSTRAINT "projects_actor_check" CHECK ((
      ("projects"."actor_kind" = 'account' and (("projects"."actor_account_id" is not null and "projects"."actor_client_id" is null) or ("projects"."actor_account_id" is null and "projects"."actor_client_id" is null)))
      or ("projects"."actor_kind" = 'oauth_client' and (("projects"."actor_account_id" is not null and nullif(btrim("projects"."actor_client_id"), '') is not null) or ("projects"."actor_account_id" is null and "projects"."actor_client_id" is null)))
      or ("projects"."actor_kind" = 'import' and (("projects"."actor_account_id" is not null and "projects"."actor_client_id" is null) or ("projects"."actor_account_id" is null and "projects"."actor_client_id" is null)))
      or ("projects"."actor_kind" in ('dreaming', 'system') and "projects"."actor_account_id" is null and "projects"."actor_client_id" is null)
    ))
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message" text NOT NULL,
	"remind_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"history_version" integer DEFAULT 1 NOT NULL,
	"history_complete_from" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "message")) STORED,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_account_id" uuid,
	"actor_client_id" text,
	"actor_source" "mutation_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminders_message_length_check" CHECK (length(btrim("reminders"."message")) between 1 and 2000),
	CONSTRAINT "reminders_history_version_check" CHECK ("reminders"."history_version" > 0),
	CONSTRAINT "reminders_actor_check" CHECK ((
      ("reminders"."actor_kind" = 'account' and (("reminders"."actor_account_id" is not null and "reminders"."actor_client_id" is null) or ("reminders"."actor_account_id" is null and "reminders"."actor_client_id" is null)))
      or ("reminders"."actor_kind" = 'oauth_client' and (("reminders"."actor_account_id" is not null and nullif(btrim("reminders"."actor_client_id"), '') is not null) or ("reminders"."actor_account_id" is null and "reminders"."actor_client_id" is null)))
      or ("reminders"."actor_kind" = 'import' and (("reminders"."actor_account_id" is not null and "reminders"."actor_client_id" is null) or ("reminders"."actor_account_id" is null and "reminders"."actor_client_id" is null)))
      or ("reminders"."actor_kind" in ('dreaming', 'system') and "reminders"."actor_account_id" is null and "reminders"."actor_client_id" is null)
    ))
);
--> statement-breakpoint
CREATE TABLE "task_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_account_id" uuid,
	"actor_client_id" text,
	"actor_source" "mutation_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_lists_name_length_check" CHECK (length(btrim("task_lists"."name")) between 1 and 300),
	CONSTRAINT "task_lists_actor_check" CHECK ((
      ("task_lists"."actor_kind" = 'account' and (("task_lists"."actor_account_id" is not null and "task_lists"."actor_client_id" is null) or ("task_lists"."actor_account_id" is null and "task_lists"."actor_client_id" is null)))
      or ("task_lists"."actor_kind" = 'oauth_client' and (("task_lists"."actor_account_id" is not null and nullif(btrim("task_lists"."actor_client_id"), '') is not null) or ("task_lists"."actor_account_id" is null and "task_lists"."actor_client_id" is null)))
      or ("task_lists"."actor_kind" = 'import' and (("task_lists"."actor_account_id" is not null and "task_lists"."actor_client_id" is null) or ("task_lists"."actor_account_id" is null and "task_lists"."actor_client_id" is null)))
      or ("task_lists"."actor_kind" in ('dreaming', 'system') and "task_lists"."actor_account_id" is null and "task_lists"."actor_client_id" is null)
    ))
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"project_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"status" "task_status" DEFAULT 'todo' NOT NULL,
	"priority" "task_priority" DEFAULT 'normal' NOT NULL,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"history_version" integer DEFAULT 1 NOT NULL,
	"history_complete_from" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "title" || ' ' || coalesce("description", ''))) STORED,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_account_id" uuid,
	"actor_client_id" text,
	"actor_source" "mutation_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_title_length_check" CHECK (length(btrim("tasks"."title")) between 1 and 500),
	CONSTRAINT "tasks_history_version_check" CHECK ("tasks"."history_version" > 0),
	CONSTRAINT "tasks_completion_check" CHECK (("tasks"."status" = 'done' and "tasks"."completed_at" is not null) or ("tasks"."status" <> 'done' and "tasks"."completed_at" is null)),
	CONSTRAINT "tasks_actor_check" CHECK ((
      ("tasks"."actor_kind" = 'account' and (("tasks"."actor_account_id" is not null and "tasks"."actor_client_id" is null) or ("tasks"."actor_account_id" is null and "tasks"."actor_client_id" is null)))
      or ("tasks"."actor_kind" = 'oauth_client' and (("tasks"."actor_account_id" is not null and nullif(btrim("tasks"."actor_client_id"), '') is not null) or ("tasks"."actor_account_id" is null and "tasks"."actor_client_id" is null)))
      or ("tasks"."actor_kind" = 'import' and (("tasks"."actor_account_id" is not null and "tasks"."actor_client_id" is null) or ("tasks"."actor_account_id" is null and "tasks"."actor_client_id" is null)))
      or ("tasks"."actor_kind" in ('dreaming', 'system') and "tasks"."actor_account_id" is null and "tasks"."actor_client_id" is null)
    ))
);
--> statement-breakpoint
CREATE TABLE "brain_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"next_actions" text[] DEFAULT '{}' NOT NULL,
	"entity_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_account_id" uuid,
	"actor_client_id" text,
	"actor_source" "mutation_source" NOT NULL,
	"request_id" text NOT NULL,
	"correlation_id" text,
	"causation_id" text,
	"dreaming_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "brain_handoffs_title_check" CHECK (length(btrim("brain_handoffs"."title")) between 1 and 300),
	CONSTRAINT "brain_handoffs_summary_check" CHECK (length(btrim("brain_handoffs"."summary")) between 1 and 5000),
	CONSTRAINT "brain_handoffs_entity_refs_check" CHECK (jsonb_typeof("brain_handoffs"."entity_refs") = 'array'),
	CONSTRAINT "brain_handoffs_actor_check" CHECK ((
      ("brain_handoffs"."actor_kind" = 'account' and (("brain_handoffs"."actor_account_id" is not null and "brain_handoffs"."actor_client_id" is null) or ("brain_handoffs"."actor_account_id" is null and "brain_handoffs"."actor_client_id" is null)))
      or ("brain_handoffs"."actor_kind" = 'oauth_client' and (("brain_handoffs"."actor_account_id" is not null and nullif(btrim("brain_handoffs"."actor_client_id"), '') is not null) or ("brain_handoffs"."actor_account_id" is null and "brain_handoffs"."actor_client_id" is null)))
      or ("brain_handoffs"."actor_kind" = 'import' and (("brain_handoffs"."actor_account_id" is not null and "brain_handoffs"."actor_client_id" is null) or ("brain_handoffs"."actor_account_id" is null and "brain_handoffs"."actor_client_id" is null)))
      or ("brain_handoffs"."actor_kind" in ('dreaming', 'system') and "brain_handoffs"."actor_account_id" is null and "brain_handoffs"."actor_client_id" is null)
    ))
);
--> statement-breakpoint
CREATE TABLE "dreaming_change_evidence" (
	"change_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dreaming_change_evidence_key" UNIQUE("change_id","evidence_id")
);
--> statement-breakpoint
CREATE TABLE "dreaming_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"operation" "dreaming_change_operation" NOT NULL,
	"proposal" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"expected_target_memory_id" uuid,
	"expected_target_hash" text,
	"expected_target_version" integer,
	"verification" jsonb,
	"status" "dreaming_change_status" DEFAULT 'proposed' NOT NULL,
	"result_memory_id" uuid,
	"previous_memory_id" uuid,
	"skip_reason" text,
	"activity_event_id" uuid,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dreaming_changes_run_id_key" UNIQUE("run_id","id"),
	CONSTRAINT "dreaming_changes_run_ordinal_key" UNIQUE("run_id","ordinal"),
	CONSTRAINT "dreaming_changes_fingerprint_key" UNIQUE("fingerprint"),
	CONSTRAINT "dreaming_changes_ordinal_check" CHECK ("dreaming_changes"."ordinal" >= 0),
	CONSTRAINT "dreaming_changes_fingerprint_check" CHECK ("dreaming_changes"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "dreaming_changes_target_check" CHECK (("dreaming_changes"."operation" = 'create' and "dreaming_changes"."expected_target_memory_id" is null and "dreaming_changes"."expected_target_hash" is null and "dreaming_changes"."expected_target_version" is null)
        or ("dreaming_changes"."operation" = 'update' and "dreaming_changes"."expected_target_memory_id" is not null and "dreaming_changes"."expected_target_hash" ~ '^[0-9a-f]{64}$' and "dreaming_changes"."expected_target_version" > 0)),
	CONSTRAINT "dreaming_changes_applied_check" CHECK (("dreaming_changes"."status" = 'applied' and "dreaming_changes"."result_memory_id" is not null and "dreaming_changes"."applied_at" is not null and "dreaming_changes"."activity_event_id" is not null and "dreaming_changes"."skip_reason" is null
            and (("dreaming_changes"."operation" = 'create' and "dreaming_changes"."previous_memory_id" is null) or ("dreaming_changes"."operation" = 'update' and "dreaming_changes"."previous_memory_id" = "dreaming_changes"."expected_target_memory_id")))
        or ("dreaming_changes"."status" = 'skipped' and "dreaming_changes"."result_memory_id" is null and "dreaming_changes"."applied_at" is null and "dreaming_changes"."activity_event_id" is null and nullif(btrim("dreaming_changes"."skip_reason"), '') is not null)
        or ("dreaming_changes"."status" not in ('applied', 'skipped') and "dreaming_changes"."result_memory_id" is null and "dreaming_changes"."applied_at" is null and "dreaming_changes"."activity_event_id" is null and "dreaming_changes"."skip_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "dreaming_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"evidence_index" integer NOT NULL,
	"role" "dreaming_evidence_role" NOT NULL,
	"type" "dreaming_evidence_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"version_id" uuid,
	"observed_at" timestamp with time zone NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"excerpt" text NOT NULL,
	"content_hash" text NOT NULL,
	"redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dreaming_evidence_run_id_key" UNIQUE("run_id","id"),
	CONSTRAINT "dreaming_evidence_run_index_key" UNIQUE("run_id","evidence_index"),
	CONSTRAINT "dreaming_evidence_index_check" CHECK ("dreaming_evidence"."evidence_index" >= 0),
	CONSTRAINT "dreaming_evidence_excerpt_check" CHECK (length("dreaming_evidence"."excerpt") between 1 and 2000),
	CONSTRAINT "dreaming_evidence_content_hash_check" CHECK ("dreaming_evidence"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "dreaming_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"mode" "dreaming_mode" NOT NULL,
	"status" "dreaming_run_status" NOT NULL,
	"summary" text NOT NULL,
	"insights" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"memories_created" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"memories_updated" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skipped" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"coverage_warnings" text[] DEFAULT '{}' NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dreaming_reports_run_key" UNIQUE("run_id"),
	CONSTRAINT "dreaming_reports_status_check" CHECK ("dreaming_reports"."status" in ('completed', 'completed_with_skips')),
	CONSTRAINT "dreaming_reports_summary_check" CHECK (length("dreaming_reports"."summary") between 1 and 2000),
	CONSTRAINT "dreaming_reports_json_check" CHECK (jsonb_typeof("dreaming_reports"."insights") = 'array'
        and jsonb_typeof("dreaming_reports"."memories_created") = 'array'
        and jsonb_typeof("dreaming_reports"."memories_updated") = 'array'
        and jsonb_typeof("dreaming_reports"."skipped") = 'array'),
	CONSTRAINT "dreaming_reports_bounds_check" CHECK (jsonb_array_length("dreaming_reports"."insights") <= 10
        and jsonb_array_length("dreaming_reports"."memories_created") + jsonb_array_length("dreaming_reports"."memories_updated") <= 20
        and jsonb_array_length("dreaming_reports"."skipped") <= 20)
);
--> statement-breakpoint
CREATE TABLE "dreaming_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_job_id" uuid NOT NULL,
	"automation_job_kind" "automation_job_kind" DEFAULT 'daily_dreaming' NOT NULL,
	"replay_of_run_id" uuid,
	"canonical" boolean DEFAULT true NOT NULL,
	"local_date" date NOT NULL,
	"time_zone" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"mode" "dreaming_mode" NOT NULL,
	"status" "dreaming_run_status" DEFAULT 'pending' NOT NULL,
	"settings_revision" integer NOT NULL,
	"pipeline_version" text NOT NULL,
	"prompt_version" text NOT NULL,
	"schema_version" text NOT NULL,
	"policy_version" text NOT NULL,
	"snapshot_hash" text,
	"snapshot_truncated" boolean DEFAULT false NOT NULL,
	"coverage_warnings" text[] DEFAULT '{}' NOT NULL,
	"plan_summary" text,
	"plan_insights" jsonb,
	"provider" text,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"sanitized_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dreaming_runs_job_key" UNIQUE("automation_job_id"),
	CONSTRAINT "dreaming_runs_id_replay_key" UNIQUE("id","replay_of_run_id"),
	CONSTRAINT "dreaming_runs_window_check" CHECK ("dreaming_runs"."window_end" > "dreaming_runs"."window_start"),
	CONSTRAINT "dreaming_runs_job_kind_check" CHECK ("dreaming_runs"."automation_job_kind" = 'daily_dreaming'),
	CONSTRAINT "dreaming_runs_replay_check" CHECK ("dreaming_runs"."replay_of_run_id" is null or ("dreaming_runs"."replay_of_run_id" <> "dreaming_runs"."id" and not "dreaming_runs"."canonical")),
	CONSTRAINT "dreaming_runs_settings_revision_check" CHECK ("dreaming_runs"."settings_revision" > 0),
	CONSTRAINT "dreaming_runs_snapshot_hash_check" CHECK ("dreaming_runs"."snapshot_hash" is null or "dreaming_runs"."snapshot_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "dreaming_runs_usage_check" CHECK ("dreaming_runs"."input_tokens" >= 0 and "dreaming_runs"."output_tokens" >= 0 and "dreaming_runs"."attempt_count" >= 0),
	CONSTRAINT "dreaming_runs_plan_check" CHECK (("dreaming_runs"."plan_summary" is null and "dreaming_runs"."plan_insights" is null)
        or (length("dreaming_runs"."plan_summary") between 1 and 2000 and jsonb_typeof("dreaming_runs"."plan_insights") = 'array'))
);
--> statement-breakpoint
CREATE TABLE "decision_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"space_entity_type" "embedding_entity_type" DEFAULT 'decision' NOT NULL,
	"content_hash" text NOT NULL,
	"recipe_version" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_embeddings_entity_space_key" UNIQUE("decision_id","space_id"),
	CONSTRAINT "decision_embeddings_content_hash_check" CHECK ("decision_embeddings"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "decision_embeddings_space_type_check" CHECK ("decision_embeddings"."space_entity_type" = 'decision')
);
--> statement-breakpoint
CREATE TABLE "embedding_spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" "embedding_entity_type" NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"model_revision" text NOT NULL,
	"recipe_version" text NOT NULL,
	"dimensions" integer NOT NULL,
	"metric" "embedding_metric" DEFAULT 'cosine' NOT NULL,
	"status" "embedding_space_status" DEFAULT 'preparing' NOT NULL,
	"promoted_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embedding_spaces_id_type_key" UNIQUE("id","entity_type"),
	CONSTRAINT "embedding_spaces_id_recipe_key" UNIQUE("id","recipe_version"),
	CONSTRAINT "embedding_spaces_recipe_identity_key" UNIQUE("entity_type","provider","model","model_revision","recipe_version"),
	CONSTRAINT "embedding_spaces_dimensions_check" CHECK ("embedding_spaces"."dimensions" = 1536),
	CONSTRAINT "embedding_spaces_state_check" CHECK (("embedding_spaces"."status" = 'preparing' and "embedding_spaces"."promoted_at" is null and "embedding_spaces"."retired_at" is null)
        or ("embedding_spaces"."status" = 'active' and "embedding_spaces"."promoted_at" is not null and "embedding_spaces"."retired_at" is null)
        or ("embedding_spaces"."status" = 'retired' and "embedding_spaces"."promoted_at" is not null and "embedding_spaces"."retired_at" is not null)
        or ("embedding_spaces"."status" = 'failed' and nullif(btrim("embedding_spaces"."failure_code"), '') is not null))
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunk_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chunk_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"space_entity_type" "embedding_entity_type" DEFAULT 'knowledge_chunk' NOT NULL,
	"content_hash" text NOT NULL,
	"recipe_version" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_chunk_embeddings_entity_space_key" UNIQUE("chunk_id","space_id"),
	CONSTRAINT "knowledge_chunk_embeddings_content_hash_check" CHECK ("knowledge_chunk_embeddings"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "knowledge_chunk_embeddings_space_type_check" CHECK ("knowledge_chunk_embeddings"."space_entity_type" = 'knowledge_chunk')
);
--> statement-breakpoint
CREATE TABLE "memory_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"space_entity_type" "embedding_entity_type" DEFAULT 'memory' NOT NULL,
	"content_hash" text NOT NULL,
	"recipe_version" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_embeddings_entity_space_key" UNIQUE("memory_id","space_id"),
	CONSTRAINT "memory_embeddings_content_hash_check" CHECK ("memory_embeddings"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "memory_embeddings_space_type_check" CHECK ("memory_embeddings"."space_entity_type" = 'memory')
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"status" "account_status" DEFAULT 'active' NOT NULL,
	"role" "membership_role" NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_email_normalized_check" CHECK ("accounts"."email" = lower(btrim("accounts"."email")) and length("accounts"."email") between 3 and 320),
	CONSTRAINT "accounts_failed_login_count_check" CHECK ("accounts"."failed_login_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "oauth_artifacts" (
	"model" text NOT NULL,
	"id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"account_id" uuid,
	"client_id" text,
	"grant_id" text,
	"user_code" text,
	"uid" text,
	"expires_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "oauth_artifacts_pkey" PRIMARY KEY("model","id")
);
--> statement-breakpoint
CREATE TABLE "oauth_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingest_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" "ingest_proposal_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"source_quote" text NOT NULL,
	"source_start" integer NOT NULL,
	"source_end" integer NOT NULL,
	"payload_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingest_proposals_run_id_key" UNIQUE("run_id","id"),
	CONSTRAINT "ingest_proposals_run_ordinal_key" UNIQUE("run_id","ordinal"),
	CONSTRAINT "ingest_proposals_ordinal_check" CHECK ("ingest_proposals"."ordinal" >= 0),
	CONSTRAINT "ingest_proposals_source_span_check" CHECK ("ingest_proposals"."source_start" >= 0 and "ingest_proposals"."source_end" > "ingest_proposals"."source_start"),
	CONSTRAINT "ingest_proposals_source_quote_check" CHECK (length("ingest_proposals"."source_quote") between 1 and 4000),
	CONSTRAINT "ingest_proposals_confidence_check" CHECK ("ingest_proposals"."confidence" between 0 and 1),
	CONSTRAINT "ingest_proposals_payload_digest_check" CHECK ("ingest_proposals"."payload_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "ingest_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"entity_type" "ingest_proposal_kind" NOT NULL,
	"entity_id" uuid,
	"status" "ingest_receipt_status" NOT NULL,
	"reason" text,
	"effect_digest" text NOT NULL,
	"activity_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingest_receipts_proposal_key" UNIQUE("proposal_id"),
	CONSTRAINT "ingest_receipts_effect_key" UNIQUE("effect_digest"),
	CONSTRAINT "ingest_receipts_effect_digest_check" CHECK ("ingest_receipts"."effect_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ingest_receipts_status_check" CHECK (("ingest_receipts"."status" = 'committed' and "ingest_receipts"."entity_id" is not null and "ingest_receipts"."activity_event_id" is not null and "ingest_receipts"."reason" is null)
        or ("ingest_receipts"."status" = 'skipped' and "ingest_receipts"."entity_id" is null and "ingest_receipts"."activity_event_id" is null and nullif(btrim("ingest_receipts"."reason"), '') is not null))
);
--> statement-breakpoint
CREATE TABLE "ingest_review_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"decision" "ingest_review_decision" NOT NULL,
	"replacement_payload" jsonb,
	"replacement_digest" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingest_review_items_review_proposal_key" UNIQUE("review_id","proposal_id"),
	CONSTRAINT "ingest_review_items_replacement_check" CHECK (("ingest_review_items"."replacement_payload" is null and "ingest_review_items"."replacement_digest" is null) or ("ingest_review_items"."replacement_payload" is not null and "ingest_review_items"."replacement_digest" ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
CREATE TABLE "ingest_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"review_digest" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_account_id" uuid,
	"actor_client_id" text,
	"actor_source" "mutation_source" NOT NULL,
	"request_id" text NOT NULL,
	"correlation_id" text,
	"causation_id" text,
	"dreaming_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingest_reviews_run_id_key" UNIQUE("run_id","id"),
	CONSTRAINT "ingest_reviews_run_key" UNIQUE("run_id"),
	CONSTRAINT "ingest_reviews_idempotency_key" UNIQUE("idempotency_key"),
	CONSTRAINT "ingest_reviews_digest_check" CHECK ("ingest_reviews"."review_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ingest_reviews_actor_check" CHECK ((
      ("ingest_reviews"."actor_kind" = 'account' and (("ingest_reviews"."actor_account_id" is not null and "ingest_reviews"."actor_client_id" is null) or ("ingest_reviews"."actor_account_id" is null and "ingest_reviews"."actor_client_id" is null)))
      or ("ingest_reviews"."actor_kind" = 'oauth_client' and (("ingest_reviews"."actor_account_id" is not null and nullif(btrim("ingest_reviews"."actor_client_id"), '') is not null) or ("ingest_reviews"."actor_account_id" is null and "ingest_reviews"."actor_client_id" is null)))
      or ("ingest_reviews"."actor_kind" = 'import' and (("ingest_reviews"."actor_account_id" is not null and "ingest_reviews"."actor_client_id" is null) or ("ingest_reviews"."actor_account_id" is null and "ingest_reviews"."actor_client_id" is null)))
      or ("ingest_reviews"."actor_kind" in ('dreaming', 'system') and "ingest_reviews"."actor_account_id" is null and "ingest_reviews"."actor_client_id" is null)
    ))
);
--> statement-breakpoint
CREATE TABLE "ingest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"status" "ingest_run_status" DEFAULT 'proposing' NOT NULL,
	"proposal_provider" text NOT NULL,
	"proposal_model" text NOT NULL,
	"schema_version" text NOT NULL,
	"proposal_count" integer DEFAULT 0 NOT NULL,
	"proposal_digest" text,
	"response_digest" text,
	"reviewed_digest" text,
	"commit_idempotency_key" text,
	"commit_request_digest" text,
	"sanitized_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingest_runs_source_key" UNIQUE("source_id"),
	CONSTRAINT "ingest_runs_commit_idempotency_key" UNIQUE("commit_idempotency_key"),
	CONSTRAINT "ingest_runs_proposal_count_check" CHECK ("ingest_runs"."proposal_count" >= 0),
	CONSTRAINT "ingest_runs_reviewed_digest_check" CHECK ("ingest_runs"."reviewed_digest" is null or "ingest_runs"."reviewed_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ingest_runs_proposal_digest_check" CHECK ("ingest_runs"."proposal_digest" is null or "ingest_runs"."proposal_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ingest_runs_response_digest_check" CHECK ("ingest_runs"."response_digest" is null or "ingest_runs"."response_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ingest_runs_commit_digest_check" CHECK (("ingest_runs"."commit_idempotency_key" is null and "ingest_runs"."commit_request_digest" is null) or (nullif(btrim("ingest_runs"."commit_idempotency_key"), '') is not null and "ingest_runs"."commit_request_digest" ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
CREATE TABLE "ingest_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"excerpt" text NOT NULL,
	"captured_at" timestamp with time zone,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_account_id" uuid,
	"actor_client_id" text,
	"actor_source" "mutation_source" NOT NULL,
	"request_id" text NOT NULL,
	"correlation_id" text,
	"causation_id" text,
	"dreaming_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingest_sources_idempotency_key" UNIQUE("idempotency_key"),
	CONSTRAINT "ingest_sources_request_digest_check" CHECK ("ingest_sources"."request_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ingest_sources_excerpt_check" CHECK (length("ingest_sources"."excerpt") between 1 and 100000),
	CONSTRAINT "ingest_sources_actor_check" CHECK ((
      ("ingest_sources"."actor_kind" = 'account' and (("ingest_sources"."actor_account_id" is not null and "ingest_sources"."actor_client_id" is null) or ("ingest_sources"."actor_account_id" is null and "ingest_sources"."actor_client_id" is null)))
      or ("ingest_sources"."actor_kind" = 'oauth_client' and (("ingest_sources"."actor_account_id" is not null and nullif(btrim("ingest_sources"."actor_client_id"), '') is not null) or ("ingest_sources"."actor_account_id" is null and "ingest_sources"."actor_client_id" is null)))
      or ("ingest_sources"."actor_kind" = 'import' and (("ingest_sources"."actor_account_id" is not null and "ingest_sources"."actor_client_id" is null) or ("ingest_sources"."actor_account_id" is null and "ingest_sources"."actor_client_id" is null)))
      or ("ingest_sources"."actor_kind" in ('dreaming', 'system') and "ingest_sources"."actor_account_id" is null and "ingest_sources"."actor_client_id" is null)
    ))
);
--> statement-breakpoint
CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "activity_kind" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"time_basis" "activity_time_basis" NOT NULL,
	"task_id" uuid,
	"project_id" uuid,
	"summary" text,
	"analysis_allowed" boolean DEFAULT true NOT NULL,
	"idempotency_key" text NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_account_id" uuid,
	"actor_client_id" text,
	"actor_source" "mutation_source" NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retracted_at" timestamp with time zone,
	"retraction_reason" text,
	CONSTRAINT "activities_idempotency_key" UNIQUE("idempotency_key"),
	CONSTRAINT "activities_time_basis_check" CHECK (("activities"."time_basis" = 'instant' and "activities"."ended_at" is null) or ("activities"."time_basis" = 'explicit_interval' and "activities"."ended_at" > "activities"."occurred_at")),
	CONSTRAINT "activities_retraction_check" CHECK (("activities"."retracted_at" is null and "activities"."retraction_reason" is null) or ("activities"."retracted_at" is not null and nullif(btrim("activities"."retraction_reason"), '') is not null)),
	CONSTRAINT "activities_actor_check" CHECK ((
      ("activities"."actor_kind" = 'account' and (("activities"."actor_account_id" is not null and "activities"."actor_client_id" is null) or ("activities"."actor_account_id" is null and "activities"."actor_client_id" is null)))
      or ("activities"."actor_kind" = 'oauth_client' and (("activities"."actor_account_id" is not null and nullif(btrim("activities"."actor_client_id"), '') is not null) or ("activities"."actor_account_id" is null and "activities"."actor_client_id" is null)))
      or ("activities"."actor_kind" = 'import' and (("activities"."actor_account_id" is not null and "activities"."actor_client_id" is null) or ("activities"."actor_account_id" is null and "activities"."actor_client_id" is null)))
      or ("activities"."actor_kind" in ('dreaming', 'system') and "activities"."actor_account_id" is null and "activities"."actor_client_id" is null)
    ))
);
--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" "activity_event_entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" "activity_event_action" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"changed_fields" text[] DEFAULT '{}' NOT NULL,
	"after_version_id" uuid,
	"content_hash" text,
	"request_digest" text NOT NULL,
	"analysis_allowed" boolean DEFAULT true NOT NULL,
	"idempotency_key" text NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_account_id" uuid,
	"actor_client_id" text,
	"actor_source" "mutation_source" NOT NULL,
	"request_id" text NOT NULL,
	"correlation_id" text,
	"causation_id" text,
	"dreaming_run_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redacted_at" timestamp with time zone,
	CONSTRAINT "activity_events_idempotency_key" UNIQUE("idempotency_key"),
	CONSTRAINT "activity_events_request_entity_action_key" UNIQUE("request_id","entity_type","entity_id","action"),
	CONSTRAINT "activity_events_hash_check" CHECK ("activity_events"."content_hash" is null or "activity_events"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "activity_events_request_digest_check" CHECK ("activity_events"."request_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "activity_events_provenance_length_check" CHECK (length(btrim("activity_events"."request_id")) between 1 and 500
        and ("activity_events"."correlation_id" is null or length(btrim("activity_events"."correlation_id")) between 1 and 500)
        and ("activity_events"."causation_id" is null or length(btrim("activity_events"."causation_id")) between 1 and 500)),
	CONSTRAINT "activity_events_actor_check" CHECK ((
        ("activity_events"."actor_kind" = 'account' and (("activity_events"."actor_account_id" is not null and "activity_events"."actor_client_id" is null) or ("activity_events"."actor_account_id" is null and "activity_events"."actor_client_id" is null)))
        or ("activity_events"."actor_kind" = 'oauth_client' and (("activity_events"."actor_account_id" is not null and nullif(btrim("activity_events"."actor_client_id"), '') is not null) or ("activity_events"."actor_account_id" is null and "activity_events"."actor_client_id" is null)))
        or ("activity_events"."actor_kind" = 'import' and (("activity_events"."actor_account_id" is not null and "activity_events"."actor_client_id" is null) or ("activity_events"."actor_account_id" is null and "activity_events"."actor_client_id" is null)))
        or ("activity_events"."actor_kind" in ('dreaming', 'system') and "activity_events"."actor_account_id" is null and "activity_events"."actor_client_id" is null)
      ))
);
--> statement-breakpoint
CREATE TABLE "activity_goal_allocations" (
	"activity_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"allocation_percent" numeric(5, 2) NOT NULL,
	CONSTRAINT "activity_goal_allocations_pkey" PRIMARY KEY("activity_id","goal_id"),
	CONSTRAINT "activity_goal_allocations_percent_check" CHECK ("activity_goal_allocations"."allocation_percent" > 0 and "activity_goal_allocations"."allocation_percent" <= 100)
);
--> statement-breakpoint
CREATE TABLE "goal_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"operation" "version_operation" NOT NULL,
	"origin" "version_origin" DEFAULT 'native' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"success_criteria" text,
	"status" "goal_status" NOT NULL,
	"target_at" timestamp with time zone,
	"project_id" uuid,
	"effective_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_fields" text[] DEFAULT '{}' NOT NULL,
	"activity_event_id" uuid NOT NULL,
	CONSTRAINT "goal_versions_goal_version_key" UNIQUE("goal_id","version_number"),
	CONSTRAINT "goal_versions_number_check" CHECK ("goal_versions"."version_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"success_criteria" text,
	"status" "goal_status" DEFAULT 'active' NOT NULL,
	"target_at" timestamp with time zone,
	"project_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"history_complete_from" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_account_id" uuid,
	"actor_client_id" text,
	"actor_source" "mutation_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goals_title_check" CHECK (length(btrim("goals"."title")) between 1 and 500),
	CONSTRAINT "goals_version_check" CHECK ("goals"."version" > 0),
	CONSTRAINT "goals_actor_check" CHECK ((
      ("goals"."actor_kind" = 'account' and (("goals"."actor_account_id" is not null and "goals"."actor_client_id" is null) or ("goals"."actor_account_id" is null and "goals"."actor_client_id" is null)))
      or ("goals"."actor_kind" = 'oauth_client' and (("goals"."actor_account_id" is not null and nullif(btrim("goals"."actor_client_id"), '') is not null) or ("goals"."actor_account_id" is null and "goals"."actor_client_id" is null)))
      or ("goals"."actor_kind" = 'import' and (("goals"."actor_account_id" is not null and "goals"."actor_client_id" is null) or ("goals"."actor_account_id" is null and "goals"."actor_client_id" is null)))
      or ("goals"."actor_kind" in ('dreaming', 'system') and "goals"."actor_account_id" is null and "goals"."actor_client_id" is null)
    ))
);
--> statement-breakpoint
CREATE TABLE "mutation_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"result_entity_type" text,
	"result_entity_id" uuid,
	"result_version_id" uuid,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"activity_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mutation_receipts_operation_key" UNIQUE("operation","idempotency_key"),
	CONSTRAINT "mutation_receipts_operation_check" CHECK (length(btrim("mutation_receipts"."operation")) between 1 and 100),
	CONSTRAINT "mutation_receipts_request_digest_check" CHECK ("mutation_receipts"."request_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "priority_plan_version_items" (
	"priority_plan_version_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"intended_share_percent" numeric(5, 2),
	CONSTRAINT "priority_plan_version_items_pkey" PRIMARY KEY("priority_plan_version_id","goal_id"),
	CONSTRAINT "priority_plan_version_items_rank_key" UNIQUE("priority_plan_version_id","rank"),
	CONSTRAINT "priority_plan_version_items_rank_check" CHECK ("priority_plan_version_items"."rank" > 0),
	CONSTRAINT "priority_plan_version_items_share_check" CHECK ("priority_plan_version_items"."intended_share_percent" is null or ("priority_plan_version_items"."intended_share_percent" > 0 and "priority_plan_version_items"."intended_share_percent" <= 100))
);
--> statement-breakpoint
CREATE TABLE "priority_plan_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"priority_plan_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"project_id" uuid,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"note" text,
	"effective_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_account_id" uuid,
	"actor_client_id" text,
	"actor_source" "mutation_source" NOT NULL,
	"activity_event_id" uuid NOT NULL,
	CONSTRAINT "priority_plan_versions_plan_id_key" UNIQUE("priority_plan_id","id"),
	CONSTRAINT "priority_plan_versions_plan_version_key" UNIQUE("priority_plan_id","version_number"),
	CONSTRAINT "priority_plan_versions_number_check" CHECK ("priority_plan_versions"."version_number" > 0),
	CONSTRAINT "priority_plan_versions_period_check" CHECK ("priority_plan_versions"."period_end" > "priority_plan_versions"."period_start"),
	CONSTRAINT "priority_plan_versions_actor_check" CHECK ((
      ("priority_plan_versions"."actor_kind" = 'account' and (("priority_plan_versions"."actor_account_id" is not null and "priority_plan_versions"."actor_client_id" is null) or ("priority_plan_versions"."actor_account_id" is null and "priority_plan_versions"."actor_client_id" is null)))
      or ("priority_plan_versions"."actor_kind" = 'oauth_client' and (("priority_plan_versions"."actor_account_id" is not null and nullif(btrim("priority_plan_versions"."actor_client_id"), '') is not null) or ("priority_plan_versions"."actor_account_id" is null and "priority_plan_versions"."actor_client_id" is null)))
      or ("priority_plan_versions"."actor_kind" = 'import' and (("priority_plan_versions"."actor_account_id" is not null and "priority_plan_versions"."actor_client_id" is null) or ("priority_plan_versions"."actor_account_id" is null and "priority_plan_versions"."actor_client_id" is null)))
      or ("priority_plan_versions"."actor_kind" in ('dreaming', 'system') and "priority_plan_versions"."actor_account_id" is null and "priority_plan_versions"."actor_client_id" is null)
    ))
);
--> statement-breakpoint
CREATE TABLE "priority_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"current_version_id" uuid NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_account_id" uuid,
	"actor_client_id" text,
	"actor_source" "mutation_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "priority_plans_period_check" CHECK ("priority_plans"."period_end" > "priority_plans"."period_start"),
	CONSTRAINT "priority_plans_version_check" CHECK ("priority_plans"."version" > 0),
	CONSTRAINT "priority_plans_actor_check" CHECK ((
      ("priority_plans"."actor_kind" = 'account' and (("priority_plans"."actor_account_id" is not null and "priority_plans"."actor_client_id" is null) or ("priority_plans"."actor_account_id" is null and "priority_plans"."actor_client_id" is null)))
      or ("priority_plans"."actor_kind" = 'oauth_client' and (("priority_plans"."actor_account_id" is not null and nullif(btrim("priority_plans"."actor_client_id"), '') is not null) or ("priority_plans"."actor_account_id" is null and "priority_plans"."actor_client_id" is null)))
      or ("priority_plans"."actor_kind" = 'import' and (("priority_plans"."actor_account_id" is not null and "priority_plans"."actor_client_id" is null) or ("priority_plans"."actor_account_id" is null and "priority_plans"."actor_client_id" is null)))
      or ("priority_plans"."actor_kind" in ('dreaming', 'system') and "priority_plans"."actor_account_id" is null and "priority_plans"."actor_client_id" is null)
    ))
);
--> statement-breakpoint
CREATE TABLE "reminder_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reminder_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"operation" "version_operation" NOT NULL,
	"origin" "version_origin" DEFAULT 'native' NOT NULL,
	"message" text NOT NULL,
	"remind_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"effective_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_fields" text[] DEFAULT '{}' NOT NULL,
	"activity_event_id" uuid NOT NULL,
	CONSTRAINT "reminder_versions_reminder_version_key" UNIQUE("reminder_id","version_number"),
	CONSTRAINT "reminder_versions_number_check" CHECK ("reminder_versions"."version_number" > 0),
	CONSTRAINT "reminder_versions_message_check" CHECK (length(btrim("reminder_versions"."message")) between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "task_goal_links" (
	"task_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"basis" "link_basis" NOT NULL,
	"confidence" numeric(4, 3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_goal_links_pkey" PRIMARY KEY("task_id","goal_id"),
	CONSTRAINT "task_goal_links_confidence_check" CHECK (("task_goal_links"."basis" = 'explicit' and "task_goal_links"."confidence" is null)
        or ("task_goal_links"."basis" <> 'explicit' and "task_goal_links"."confidence" between 0 and 1))
);
--> statement-breakpoint
CREATE TABLE "task_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_task_id" uuid NOT NULL,
	"to_task_id" uuid NOT NULL,
	"kind" "task_relation_kind" NOT NULL,
	"actor_kind" "actor_kind" NOT NULL,
	"actor_account_id" uuid,
	"actor_client_id" text,
	"actor_source" "mutation_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retracted_at" timestamp with time zone,
	CONSTRAINT "task_relations_distinct_check" CHECK ("task_relations"."from_task_id" <> "task_relations"."to_task_id"),
	CONSTRAINT "task_relations_actor_check" CHECK ((
      ("task_relations"."actor_kind" = 'account' and (("task_relations"."actor_account_id" is not null and "task_relations"."actor_client_id" is null) or ("task_relations"."actor_account_id" is null and "task_relations"."actor_client_id" is null)))
      or ("task_relations"."actor_kind" = 'oauth_client' and (("task_relations"."actor_account_id" is not null and nullif(btrim("task_relations"."actor_client_id"), '') is not null) or ("task_relations"."actor_account_id" is null and "task_relations"."actor_client_id" is null)))
      or ("task_relations"."actor_kind" = 'import' and (("task_relations"."actor_account_id" is not null and "task_relations"."actor_client_id" is null) or ("task_relations"."actor_account_id" is null and "task_relations"."actor_client_id" is null)))
      or ("task_relations"."actor_kind" in ('dreaming', 'system') and "task_relations"."actor_account_id" is null and "task_relations"."actor_client_id" is null)
    ))
);
--> statement-breakpoint
CREATE TABLE "task_version_goal_links" (
	"task_version_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"basis" "link_basis" NOT NULL,
	"confidence" numeric(4, 3),
	CONSTRAINT "task_version_goal_links_pkey" PRIMARY KEY("task_version_id","goal_id"),
	CONSTRAINT "task_version_goal_links_confidence_check" CHECK (("task_version_goal_links"."basis" = 'explicit' and "task_version_goal_links"."confidence" is null)
        or ("task_version_goal_links"."basis" <> 'explicit' and "task_version_goal_links"."confidence" between 0 and 1))
);
--> statement-breakpoint
CREATE TABLE "task_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"operation" "version_operation" NOT NULL,
	"origin" "version_origin" DEFAULT 'native' NOT NULL,
	"list_id" uuid NOT NULL,
	"project_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"status" "task_status" NOT NULL,
	"priority" "task_priority" NOT NULL,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"effective_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_fields" text[] DEFAULT '{}' NOT NULL,
	"activity_event_id" uuid NOT NULL,
	CONSTRAINT "task_versions_task_version_key" UNIQUE("task_id","version_number"),
	CONSTRAINT "task_versions_number_check" CHECK ("task_versions"."version_number" > 0),
	CONSTRAINT "task_versions_title_check" CHECK (length(btrim("task_versions"."title")) between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "reminder_deliveries" ADD CONSTRAINT "reminder_deliveries_reminder_fkey" FOREIGN KEY ("reminder_id") REFERENCES "public"."reminders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_deliveries" ADD CONSTRAINT "reminder_deliveries_channel_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_deliveries" ADD CONSTRAINT "reminder_deliveries_job_fkey" FOREIGN KEY ("automation_job_id","automation_job_kind") REFERENCES "public"."automation_jobs"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_people" ADD CONSTRAINT "decision_people_decision_fkey" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_people" ADD CONSTRAINT "decision_people_person_fkey" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_supersedes_fkey" FOREIGN KEY ("supersedes_id","lineage_id") REFERENCES "public"."decisions"("id","lineage_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_project_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_revision_fkey" FOREIGN KEY ("revision_id") REFERENCES "public"."knowledge_document_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_document_revisions" ADD CONSTRAINT "knowledge_document_revisions_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_document_revisions" ADD CONSTRAINT "knowledge_document_revisions_document_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_base_fkey" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_supersedes_fkey" FOREIGN KEY ("supersedes_id","lineage_id") REFERENCES "public"."memories"("id","lineage_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_project_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_people" ADD CONSTRAINT "memory_people_memory_fkey" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_people" ADD CONSTRAINT "memory_people_person_fkey" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_lists" ADD CONSTRAINT "task_lists_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_list_fkey" FOREIGN KEY ("list_id") REFERENCES "public"."task_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_handoffs" ADD CONSTRAINT "brain_handoffs_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dreaming_change_evidence" ADD CONSTRAINT "dreaming_change_evidence_change_fkey" FOREIGN KEY ("run_id","change_id") REFERENCES "public"."dreaming_changes"("run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dreaming_change_evidence" ADD CONSTRAINT "dreaming_change_evidence_evidence_fkey" FOREIGN KEY ("run_id","evidence_id") REFERENCES "public"."dreaming_evidence"("run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dreaming_changes" ADD CONSTRAINT "dreaming_changes_run_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."dreaming_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dreaming_changes" ADD CONSTRAINT "dreaming_changes_target_memory_fkey" FOREIGN KEY ("expected_target_memory_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dreaming_changes" ADD CONSTRAINT "dreaming_changes_result_memory_fkey" FOREIGN KEY ("result_memory_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dreaming_changes" ADD CONSTRAINT "dreaming_changes_previous_memory_fkey" FOREIGN KEY ("previous_memory_id") REFERENCES "public"."memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dreaming_changes" ADD CONSTRAINT "dreaming_changes_event_fkey" FOREIGN KEY ("activity_event_id") REFERENCES "public"."activity_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dreaming_evidence" ADD CONSTRAINT "dreaming_evidence_run_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."dreaming_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dreaming_reports" ADD CONSTRAINT "dreaming_reports_run_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."dreaming_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dreaming_runs" ADD CONSTRAINT "dreaming_runs_job_fkey" FOREIGN KEY ("automation_job_id","automation_job_kind") REFERENCES "public"."automation_jobs"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dreaming_runs" ADD CONSTRAINT "dreaming_runs_replay_fkey" FOREIGN KEY ("replay_of_run_id") REFERENCES "public"."dreaming_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_embeddings" ADD CONSTRAINT "decision_embeddings_decision_fkey" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_embeddings" ADD CONSTRAINT "decision_embeddings_space_fkey" FOREIGN KEY ("space_id","space_entity_type") REFERENCES "public"."embedding_spaces"("id","entity_type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_embeddings" ADD CONSTRAINT "decision_embeddings_recipe_fkey" FOREIGN KEY ("space_id","recipe_version") REFERENCES "public"."embedding_spaces"("id","recipe_version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunk_embeddings" ADD CONSTRAINT "knowledge_chunk_embeddings_chunk_fkey" FOREIGN KEY ("chunk_id") REFERENCES "public"."knowledge_chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunk_embeddings" ADD CONSTRAINT "knowledge_chunk_embeddings_space_fkey" FOREIGN KEY ("space_id","space_entity_type") REFERENCES "public"."embedding_spaces"("id","entity_type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunk_embeddings" ADD CONSTRAINT "knowledge_chunk_embeddings_recipe_fkey" FOREIGN KEY ("space_id","recipe_version") REFERENCES "public"."embedding_spaces"("id","recipe_version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_memory_fkey" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_space_fkey" FOREIGN KEY ("space_id","space_entity_type") REFERENCES "public"."embedding_spaces"("id","entity_type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_recipe_fkey" FOREIGN KEY ("space_id","recipe_version") REFERENCES "public"."embedding_spaces"("id","recipe_version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_artifacts" ADD CONSTRAINT "oauth_artifacts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_proposals" ADD CONSTRAINT "ingest_proposals_run_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."ingest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_receipts" ADD CONSTRAINT "ingest_receipts_run_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."ingest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_receipts" ADD CONSTRAINT "ingest_receipts_proposal_fkey" FOREIGN KEY ("run_id","proposal_id") REFERENCES "public"."ingest_proposals"("run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_receipts" ADD CONSTRAINT "ingest_receipts_event_fkey" FOREIGN KEY ("activity_event_id") REFERENCES "public"."activity_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_review_items" ADD CONSTRAINT "ingest_review_items_review_fkey" FOREIGN KEY ("run_id","review_id") REFERENCES "public"."ingest_reviews"("run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_review_items" ADD CONSTRAINT "ingest_review_items_proposal_fkey" FOREIGN KEY ("run_id","proposal_id") REFERENCES "public"."ingest_proposals"("run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_reviews" ADD CONSTRAINT "ingest_reviews_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_reviews" ADD CONSTRAINT "ingest_reviews_run_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."ingest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_runs" ADD CONSTRAINT "ingest_runs_source_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."ingest_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_sources" ADD CONSTRAINT "ingest_sources_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_task_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_project_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_goal_allocations" ADD CONSTRAINT "activity_goal_allocations_activity_fkey" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_goal_allocations" ADD CONSTRAINT "activity_goal_allocations_goal_fkey" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_versions" ADD CONSTRAINT "goal_versions_goal_fkey" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_versions" ADD CONSTRAINT "goal_versions_project_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_versions" ADD CONSTRAINT "goal_versions_event_fkey" FOREIGN KEY ("activity_event_id") REFERENCES "public"."activity_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_project_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mutation_receipts" ADD CONSTRAINT "mutation_receipts_event_fkey" FOREIGN KEY ("activity_event_id") REFERENCES "public"."activity_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "priority_plan_version_items" ADD CONSTRAINT "priority_plan_version_items_version_fkey" FOREIGN KEY ("priority_plan_version_id") REFERENCES "public"."priority_plan_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "priority_plan_version_items" ADD CONSTRAINT "priority_plan_version_items_goal_fkey" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "priority_plan_versions" ADD CONSTRAINT "priority_plan_versions_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "priority_plan_versions" ADD CONSTRAINT "priority_plan_versions_plan_fkey" FOREIGN KEY ("priority_plan_id") REFERENCES "public"."priority_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "priority_plan_versions" ADD CONSTRAINT "priority_plan_versions_project_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "priority_plan_versions" ADD CONSTRAINT "priority_plan_versions_event_fkey" FOREIGN KEY ("activity_event_id") REFERENCES "public"."activity_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "priority_plans" ADD CONSTRAINT "priority_plans_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "priority_plans" ADD CONSTRAINT "priority_plans_project_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_versions" ADD CONSTRAINT "reminder_versions_reminder_fkey" FOREIGN KEY ("reminder_id") REFERENCES "public"."reminders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_versions" ADD CONSTRAINT "reminder_versions_event_fkey" FOREIGN KEY ("activity_event_id") REFERENCES "public"."activity_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_goal_links" ADD CONSTRAINT "task_goal_links_task_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_goal_links" ADD CONSTRAINT "task_goal_links_goal_fkey" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_relations" ADD CONSTRAINT "task_relations_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_relations" ADD CONSTRAINT "task_relations_from_fkey" FOREIGN KEY ("from_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_relations" ADD CONSTRAINT "task_relations_to_fkey" FOREIGN KEY ("to_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_version_goal_links" ADD CONSTRAINT "task_version_goal_links_version_fkey" FOREIGN KEY ("task_version_id") REFERENCES "public"."task_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_version_goal_links" ADD CONSTRAINT "task_version_goal_links_goal_fkey" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_versions" ADD CONSTRAINT "task_versions_task_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_versions" ADD CONSTRAINT "task_versions_list_fkey" FOREIGN KEY ("list_id") REFERENCES "public"."task_lists"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_versions" ADD CONSTRAINT "task_versions_project_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_versions" ADD CONSTRAINT "task_versions_event_fkey" FOREIGN KEY ("activity_event_id") REFERENCES "public"."activity_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_jobs_claim_idx" ON "automation_jobs" USING btree ("status","next_attempt_at","scheduled_for","id");--> statement-breakpoint
CREATE INDEX "automation_jobs_status_idx" ON "automation_jobs" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "notification_channels_kind_idx" ON "notification_channels" USING btree ("kind","id");--> statement-breakpoint
CREATE INDEX "reminder_deliveries_status_idx" ON "reminder_deliveries" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "decision_people_person_idx" ON "decision_people" USING btree ("person_id","decision_id");--> statement-breakpoint
CREATE INDEX "decisions_decided_idx" ON "decisions" USING btree ("decided_at","id");--> statement-breakpoint
CREATE INDEX "knowledge_bases_created_idx" ON "knowledge_bases" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_revision_idx" ON "knowledge_chunks" USING btree ("revision_id","position");--> statement-breakpoint
CREATE INDEX "knowledge_documents_base_idx" ON "knowledge_documents" USING btree ("knowledge_base_id","created_at","id");--> statement-breakpoint
CREATE INDEX "memories_effective_idx" ON "memories" USING btree ("effective_at","id");--> statement-breakpoint
CREATE INDEX "memories_category_idx" ON "memories" USING btree ("category","id");--> statement-breakpoint
CREATE INDEX "memories_tags_gin_idx" ON "memories" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "memory_people_person_idx" ON "memory_people" USING btree ("person_id","memory_id");--> statement-breakpoint
CREATE UNIQUE INDEX "people_name_key" ON "people" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "people_created_idx" ON "people" USING btree ("created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_name_key" ON "projects" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "projects_created_idx" ON "projects" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "reminders_due_idx" ON "reminders" USING btree ("remind_at","id");--> statement-breakpoint
CREATE INDEX "reminders_search_vector_idx" ON "reminders" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "task_lists_created_idx" ON "task_lists" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "tasks_list_status_idx" ON "tasks" USING btree ("list_id","status","id");--> statement-breakpoint
CREATE INDEX "tasks_due_idx" ON "tasks" USING btree ("due_at","id");--> statement-breakpoint
CREATE INDEX "tasks_project_idx" ON "tasks" USING btree ("project_id","id");--> statement-breakpoint
CREATE INDEX "tasks_search_vector_idx" ON "tasks" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "brain_handoffs_created_idx" ON "brain_handoffs" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "dreaming_reports_date_idx" ON "dreaming_reports" USING btree ("local_date","generated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "dreaming_runs_canonical_date_key" ON "dreaming_runs" USING btree ("local_date") WHERE "dreaming_runs"."canonical";--> statement-breakpoint
CREATE INDEX "dreaming_runs_status_idx" ON "dreaming_runs" USING btree ("status","local_date","id");--> statement-breakpoint
CREATE INDEX "decision_embeddings_hnsw_idx" ON "decision_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_spaces_one_active_key" ON "embedding_spaces" USING btree ("entity_type") WHERE "embedding_spaces"."status" = 'active';--> statement-breakpoint
CREATE INDEX "embedding_spaces_status_idx" ON "embedding_spaces" USING btree ("entity_type","status","id");--> statement-breakpoint
CREATE INDEX "knowledge_chunk_embeddings_hnsw_idx" ON "knowledge_chunk_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "memory_embeddings_hnsw_idx" ON "memory_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_email_normalized_key" ON "accounts" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "oauth_artifacts_grant_idx" ON "oauth_artifacts" USING btree ("model","grant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_artifacts_user_code_key" ON "oauth_artifacts" USING btree ("model","user_code") WHERE "oauth_artifacts"."user_code" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_artifacts_uid_key" ON "oauth_artifacts" USING btree ("model","uid") WHERE "oauth_artifacts"."uid" is not null;--> statement-breakpoint
CREATE INDEX "oauth_artifacts_expiry_idx" ON "oauth_artifacts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_artifacts_account_idx" ON "oauth_artifacts" USING btree ("account_id","model");--> statement-breakpoint
CREATE INDEX "oauth_artifacts_client_idx" ON "oauth_artifacts" USING btree ("client_id","model");--> statement-breakpoint
CREATE INDEX "ingest_runs_status_idx" ON "ingest_runs" USING btree ("status","updated_at","id");--> statement-breakpoint
CREATE INDEX "ingest_sources_created_idx" ON "ingest_sources" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "activities_occurred_idx" ON "activities" USING btree ("occurred_at","id");--> statement-breakpoint
CREATE INDEX "activity_events_occurred_idx" ON "activity_events" USING btree ("occurred_at","id");--> statement-breakpoint
CREATE INDEX "activity_events_entity_idx" ON "activity_events" USING btree ("entity_type","entity_id","recorded_at");--> statement-breakpoint
CREATE INDEX "goals_status_idx" ON "goals" USING btree ("status","id");--> statement-breakpoint
CREATE INDEX "mutation_receipts_created_idx" ON "mutation_receipts" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "priority_plans_period_idx" ON "priority_plans" USING btree ("period_start","period_end","id");--> statement-breakpoint
CREATE INDEX "reminder_versions_reminder_effective_idx" ON "reminder_versions" USING btree ("reminder_id","effective_at","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "task_relations_active_key" ON "task_relations" USING btree ("from_task_id","to_task_id","kind") WHERE "task_relations"."retracted_at" is null;--> statement-breakpoint
CREATE INDEX "task_versions_task_effective_idx" ON "task_versions" USING btree ("task_id","effective_at","version_number");--> statement-breakpoint
ALTER TABLE "knowledge_documents"
  ADD CONSTRAINT "knowledge_documents_current_revision_fkey"
  FOREIGN KEY ("id", "current_revision_number")
  REFERENCES "knowledge_document_revisions" ("document_id", "revision_number")
  DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "priority_plans"
  ADD CONSTRAINT "priority_plans_current_version_fkey"
  FOREIGN KEY ("id", "current_version_id")
  REFERENCES "priority_plan_versions" ("priority_plan_id", "id")
  DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "priority_plans"
  ADD CONSTRAINT "priority_plans_general_period_exclusion"
  EXCLUDE USING gist (
    tstzrange("period_start", "period_end", '[)') WITH &&
  ) WHERE ("project_id" IS NULL);--> statement-breakpoint
ALTER TABLE "priority_plans"
  ADD CONSTRAINT "priority_plans_project_period_exclusion"
  EXCLUDE USING gist (
    "project_id" WITH =,
    tstzrange("period_start", "period_end", '[)') WITH &&
  ) WHERE ("project_id" IS NOT NULL);--> statement-breakpoint
CREATE FUNCTION "validate_automation_time_zone"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.time_zone) THEN
    RAISE EXCEPTION 'Unknown IANA time zone.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "automation_settings_time_zone_trigger"
  BEFORE INSERT OR UPDATE OF "time_zone" ON "automation_settings"
  FOR EACH ROW EXECUTE FUNCTION "validate_automation_time_zone"();--> statement-breakpoint
CREATE FUNCTION "validate_activity_allocation_total"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_activity uuid := COALESCE(NEW.activity_id, OLD.activity_id);
  total numeric;
BEGIN
  PERFORM 1 FROM activities
    WHERE id = target_activity
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(sum(allocation_percent), 0)
    INTO total
    FROM activity_goal_allocations
    WHERE activity_id = target_activity;
  IF total > 100 THEN
    RAISE EXCEPTION 'Activity goal allocations cannot exceed 100 percent.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE FUNCTION "prevent_activity_allocation_parent_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.activity_id IS DISTINCT FROM NEW.activity_id THEN
    RAISE EXCEPTION 'Activity allocation ownership is immutable.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "activity_goal_allocations_parent_trigger"
  BEFORE UPDATE OF "activity_id" ON "activity_goal_allocations"
  FOR EACH ROW EXECUTE FUNCTION "prevent_activity_allocation_parent_change"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "activity_goal_allocations_total_trigger"
  AFTER INSERT OR UPDATE OR DELETE ON "activity_goal_allocations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "validate_activity_allocation_total"();--> statement-breakpoint
CREATE FUNCTION "assert_priority_plan_version_items"(target_version uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  item_count integer;
  minimum_rank integer;
  maximum_rank integer;
  share_count integer;
  total_share numeric;
BEGIN
  PERFORM 1 FROM priority_plan_versions
    WHERE id = target_version
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT count(*)::integer, min(rank), max(rank),
         count(intended_share_percent)::integer,
         COALESCE(sum(intended_share_percent), 0)
    INTO item_count, minimum_rank, maximum_rank, share_count, total_share
    FROM priority_plan_version_items
    WHERE priority_plan_version_id = target_version;
  IF item_count = 0 OR item_count > 20 OR minimum_rank <> 1 OR maximum_rank <> item_count THEN
    RAISE EXCEPTION 'Priority plan item ranks must be contiguous from one.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (
    share_count = 0 OR
    (share_count = item_count AND abs(total_share - 100) < 0.001)
  ) THEN
    RAISE EXCEPTION 'Priority plan shares must be all absent or total 100 percent.'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;--> statement-breakpoint
CREATE FUNCTION "prevent_priority_item_parent_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.priority_plan_version_id IS DISTINCT FROM NEW.priority_plan_version_id THEN
    RAISE EXCEPTION 'Priority plan item ownership is immutable.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "priority_plan_items_parent_trigger"
  BEFORE UPDATE OF "priority_plan_version_id"
  ON "priority_plan_version_items"
  FOR EACH ROW EXECUTE FUNCTION "prevent_priority_item_parent_change"();--> statement-breakpoint
CREATE FUNCTION "validate_priority_plan_item_set"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM assert_priority_plan_version_items(
    COALESCE(NEW.priority_plan_version_id, OLD.priority_plan_version_id)
  );
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "priority_plan_items_set_trigger"
  AFTER INSERT OR UPDATE OR DELETE ON "priority_plan_version_items"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "validate_priority_plan_item_set"();--> statement-breakpoint
CREATE FUNCTION "validate_priority_plan_version_has_items"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM assert_priority_plan_version_items(NEW.id);
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "priority_plan_versions_items_trigger"
  AFTER INSERT OR UPDATE ON "priority_plan_versions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "validate_priority_plan_version_has_items"();
