CREATE TYPE "public"."brain_pack_artifact_kind" AS ENUM('upload', 'export');--> statement-breakpoint
CREATE TYPE "public"."brain_pack_item_classification" AS ENUM('new', 'updated', 'unchanged', 'conflicting', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."brain_pack_item_decision" AS ENUM('create', 'update', 'skip', 'separate_copy', 'keep_local');--> statement-breakpoint
CREATE TYPE "public"."brain_pack_item_kind" AS ENUM('collection', 'document');--> statement-breakpoint
CREATE TYPE "public"."brain_pack_run_item_result" AS ENUM('created', 'updated', 'skipped', 'excluded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."brain_pack_run_kind" AS ENUM('import', 'export');--> statement-breakpoint
CREATE TYPE "public"."brain_pack_run_status" AS ENUM('uploaded', 'validating', 'awaiting_review', 'reviewed', 'indexing', 'publishing', 'queued', 'snapshotting', 'encoding', 'completed', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."knowledge_content_representation" AS ENUM('canonical', 'reconstructed');--> statement-breakpoint
ALTER TYPE "public"."automation_job_kind" ADD VALUE 'brain_pack_export';--> statement-breakpoint
ALTER TYPE "public"."automation_job_kind" ADD VALUE 'brain_pack_import';--> statement-breakpoint
CREATE TABLE "knowledge_pack_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "brain_pack_artifact_kind" NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"content_type" text DEFAULT 'application/zip' NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "knowledge_pack_artifacts_content_type_check" CHECK ("knowledge_pack_artifacts"."content_type" = 'application/zip'),
	CONSTRAINT "knowledge_pack_artifacts_byte_size_check" CHECK ("knowledge_pack_artifacts"."byte_size" between 1 and 67108864),
	CONSTRAINT "knowledge_pack_artifacts_sha256_check" CHECK ("knowledge_pack_artifacts"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "knowledge_pack_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_revision_id" uuid NOT NULL,
	"kind" "brain_pack_item_kind" NOT NULL,
	"item_key" text NOT NULL,
	"collection_key" text,
	"title" text NOT NULL,
	"representation" "knowledge_content_representation",
	"content_sha256" text,
	"byte_size" integer,
	"character_count" integer,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_pack_items_key" UNIQUE("pack_revision_id","kind","item_key"),
	CONSTRAINT "knowledge_pack_items_item_key_check" CHECK ("knowledge_pack_items"."item_key" ~ '^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$'),
	CONSTRAINT "knowledge_pack_items_document_check" CHECK (("knowledge_pack_items"."kind" = 'document' and "knowledge_pack_items"."collection_key" is not null and "knowledge_pack_items"."representation" is not null and "knowledge_pack_items"."content_sha256" ~ '^[0-9a-f]{64}$' and "knowledge_pack_items"."byte_size" >= 0 and "knowledge_pack_items"."character_count" between 1 and 1000000)
        or ("knowledge_pack_items"."kind" = 'collection' and "knowledge_pack_items"."collection_key" is null and "knowledge_pack_items"."representation" is null and "knowledge_pack_items"."content_sha256" is null and "knowledge_pack_items"."byte_size" is null and "knowledge_pack_items"."character_count" is null)),
	CONSTRAINT "knowledge_pack_items_title_check" CHECK (length(btrim("knowledge_pack_items"."title")) between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "knowledge_pack_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"document_id" uuid NOT NULL,
	"imported_pack_revision" integer NOT NULL,
	"imported_content_sha256" text NOT NULL,
	"local_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_pack_mappings_identity_key" UNIQUE("pack_id","item_key"),
	CONSTRAINT "knowledge_pack_mappings_document_key" UNIQUE("document_id"),
	CONSTRAINT "knowledge_pack_mappings_item_key_check" CHECK ("knowledge_pack_mappings"."item_key" ~ '^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$'),
	CONSTRAINT "knowledge_pack_mappings_revision_check" CHECK ("knowledge_pack_mappings"."imported_pack_revision" > 0),
	CONSTRAINT "knowledge_pack_mappings_content_sha256_check" CHECK ("knowledge_pack_mappings"."imported_content_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "knowledge_pack_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_id" uuid NOT NULL,
	"pack_revision" integer NOT NULL,
	"format_version" integer NOT NULL,
	"manifest" jsonb NOT NULL,
	"manifest_sha256" text NOT NULL,
	"publisher_display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_pack_revisions_number_key" UNIQUE("pack_id","pack_revision"),
	CONSTRAINT "knowledge_pack_revisions_number_check" CHECK ("knowledge_pack_revisions"."pack_revision" > 0),
	CONSTRAINT "knowledge_pack_revisions_format_check" CHECK ("knowledge_pack_revisions"."format_version" > 0),
	CONSTRAINT "knowledge_pack_revisions_manifest_sha256_check" CHECK ("knowledge_pack_revisions"."manifest_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "knowledge_pack_run_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"pack_item_id" uuid,
	"item_key" text NOT NULL,
	"collection_key" text NOT NULL,
	"title" text NOT NULL,
	"classification" "brain_pack_item_classification" NOT NULL,
	"decision" "brain_pack_item_decision",
	"expected_local_revision" integer,
	"local_document_id" uuid,
	"destination_knowledge_base_id" uuid,
	"result" "brain_pack_run_item_result",
	"result_document_id" uuid,
	"result_revision_id" uuid,
	"checkpoint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sanitized_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_pack_run_items_key" UNIQUE("run_id","item_key"),
	CONSTRAINT "knowledge_pack_run_items_item_key_check" CHECK ("knowledge_pack_run_items"."item_key" ~ '^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$'),
	CONSTRAINT "knowledge_pack_run_items_collection_key_check" CHECK ("knowledge_pack_run_items"."collection_key" ~ '^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$'),
	CONSTRAINT "knowledge_pack_run_items_expected_revision_check" CHECK ("knowledge_pack_run_items"."expected_local_revision" is null or "knowledge_pack_run_items"."expected_local_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "knowledge_pack_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "brain_pack_run_kind" NOT NULL,
	"status" "brain_pack_run_status" NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"pack_id" uuid,
	"pack_revision_id" uuid,
	"artifact_id" uuid,
	"job_id" uuid,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"review_version" integer DEFAULT 0 NOT NULL,
	"review_digest" text,
	"frozen_selection" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"receipt" jsonb,
	"sanitized_error" text,
	"cancel_requested_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_pack_runs_idempotency_key" UNIQUE("kind","idempotency_key"),
	CONSTRAINT "knowledge_pack_runs_status_kind_check" CHECK (("knowledge_pack_runs"."kind" = 'import' and "knowledge_pack_runs"."status" in ('uploaded', 'validating', 'awaiting_review', 'reviewed', 'indexing', 'publishing', 'completed', 'failed', 'canceled'))
        or ("knowledge_pack_runs"."kind" = 'export' and "knowledge_pack_runs"."status" in ('queued', 'snapshotting', 'encoding', 'completed', 'failed', 'canceled'))),
	CONSTRAINT "knowledge_pack_runs_review_version_check" CHECK ("knowledge_pack_runs"."review_version" >= 0),
	CONSTRAINT "knowledge_pack_runs_review_digest_check" CHECK ("knowledge_pack_runs"."review_digest" is null or "knowledge_pack_runs"."review_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "knowledge_pack_runs_request_digest_check" CHECK ("knowledge_pack_runs"."request_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "knowledge_pack_runs_idempotency_key_check" CHECK (length(btrim("knowledge_pack_runs"."idempotency_key")) between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "knowledge_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publisher_namespace" text NOT NULL,
	"external_pack_id" uuid NOT NULL,
	"owned" boolean DEFAULT false NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"language" text,
	"latest_revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_packs_identity_key" UNIQUE("publisher_namespace","external_pack_id"),
	CONSTRAINT "knowledge_packs_namespace_check" CHECK ("knowledge_packs"."publisher_namespace" ~ '^[a-z0-9]+(?:[.-][a-z0-9]+)*$' and length("knowledge_packs"."publisher_namespace") <= 200),
	CONSTRAINT "knowledge_packs_title_check" CHECK (length(btrim("knowledge_packs"."title")) between 1 and 500),
	CONSTRAINT "knowledge_packs_latest_revision_check" CHECK ("knowledge_packs"."latest_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "knowledge_revision_contents" (
	"revision_id" uuid PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"representation" "knowledge_content_representation" NOT NULL,
	"content_sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_revision_contents_length_check" CHECK (length("knowledge_revision_contents"."content") between 1 and 1000000),
	CONSTRAINT "knowledge_revision_contents_byte_size_check" CHECK ("knowledge_revision_contents"."byte_size" >= 1),
	CONSTRAINT "knowledge_revision_contents_sha256_check" CHECK ("knowledge_revision_contents"."content_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "knowledge_revision_origins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"pack_revision_id" uuid NOT NULL,
	"pack_item_id" uuid NOT NULL,
	"attribution" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"imported_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_revision_origins_revision_key" UNIQUE("revision_id")
);
--> statement-breakpoint
ALTER TABLE "knowledge_pack_artifacts" ADD CONSTRAINT "knowledge_pack_artifacts_owner_fkey" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_pack_items" ADD CONSTRAINT "knowledge_pack_items_revision_fkey" FOREIGN KEY ("pack_revision_id") REFERENCES "public"."knowledge_pack_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_pack_mappings" ADD CONSTRAINT "knowledge_pack_mappings_pack_fkey" FOREIGN KEY ("pack_id") REFERENCES "public"."knowledge_packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_pack_mappings" ADD CONSTRAINT "knowledge_pack_mappings_document_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_pack_mappings" ADD CONSTRAINT "knowledge_pack_mappings_local_revision_fkey" FOREIGN KEY ("local_revision_id") REFERENCES "public"."knowledge_document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_pack_revisions" ADD CONSTRAINT "knowledge_pack_revisions_pack_fkey" FOREIGN KEY ("pack_id") REFERENCES "public"."knowledge_packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_pack_run_items" ADD CONSTRAINT "knowledge_pack_run_items_run_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."knowledge_pack_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_pack_run_items" ADD CONSTRAINT "knowledge_pack_run_items_pack_item_fkey" FOREIGN KEY ("pack_item_id") REFERENCES "public"."knowledge_pack_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_pack_run_items" ADD CONSTRAINT "knowledge_pack_run_items_local_document_fkey" FOREIGN KEY ("local_document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_pack_run_items" ADD CONSTRAINT "knowledge_pack_run_items_destination_fkey" FOREIGN KEY ("destination_knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_pack_run_items" ADD CONSTRAINT "knowledge_pack_run_items_result_document_fkey" FOREIGN KEY ("result_document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_pack_run_items" ADD CONSTRAINT "knowledge_pack_run_items_result_revision_fkey" FOREIGN KEY ("result_revision_id") REFERENCES "public"."knowledge_document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_pack_runs" ADD CONSTRAINT "knowledge_pack_runs_owner_fkey" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_pack_runs" ADD CONSTRAINT "knowledge_pack_runs_pack_fkey" FOREIGN KEY ("pack_id") REFERENCES "public"."knowledge_packs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_pack_runs" ADD CONSTRAINT "knowledge_pack_runs_pack_revision_fkey" FOREIGN KEY ("pack_revision_id") REFERENCES "public"."knowledge_pack_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_pack_runs" ADD CONSTRAINT "knowledge_pack_runs_artifact_fkey" FOREIGN KEY ("artifact_id") REFERENCES "public"."knowledge_pack_artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_pack_runs" ADD CONSTRAINT "knowledge_pack_runs_job_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."automation_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_revision_contents" ADD CONSTRAINT "knowledge_revision_contents_revision_fkey" FOREIGN KEY ("revision_id") REFERENCES "public"."knowledge_document_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_revision_origins" ADD CONSTRAINT "knowledge_revision_origins_revision_fkey" FOREIGN KEY ("revision_id") REFERENCES "public"."knowledge_document_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_revision_origins" ADD CONSTRAINT "knowledge_revision_origins_pack_revision_fkey" FOREIGN KEY ("pack_revision_id") REFERENCES "public"."knowledge_pack_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_revision_origins" ADD CONSTRAINT "knowledge_revision_origins_pack_item_fkey" FOREIGN KEY ("pack_item_id") REFERENCES "public"."knowledge_pack_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_revision_origins" ADD CONSTRAINT "knowledge_revision_origins_importer_fkey" FOREIGN KEY ("imported_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_pack_artifacts_owner_idx" ON "knowledge_pack_artifacts" USING btree ("owner_account_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_pack_artifacts_expires_idx" ON "knowledge_pack_artifacts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "knowledge_pack_items_collection_idx" ON "knowledge_pack_items" USING btree ("pack_revision_id","collection_key");--> statement-breakpoint
CREATE INDEX "knowledge_pack_run_items_run_idx" ON "knowledge_pack_run_items" USING btree ("run_id","classification");--> statement-breakpoint
CREATE INDEX "knowledge_pack_runs_owner_idx" ON "knowledge_pack_runs" USING btree ("owner_account_id","created_at","id");--> statement-breakpoint
CREATE INDEX "knowledge_pack_runs_status_idx" ON "knowledge_pack_runs" USING btree ("kind","status","updated_at");--> statement-breakpoint
CREATE INDEX "knowledge_revision_origins_pack_item_idx" ON "knowledge_revision_origins" USING btree ("pack_item_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "knowledge_revision_origins_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'knowledge_revision_origins rows are immutable' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "knowledge_revision_origins_immutable_trigger"
BEFORE UPDATE ON "knowledge_revision_origins"
FOR EACH ROW EXECUTE FUNCTION "knowledge_revision_origins_immutable"();
