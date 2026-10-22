CREATE TYPE "public"."model_failure_reason" AS ENUM('authentication', 'credits', 'privacy', 'unavailable', 'rate_limit', 'timeout', 'network', 'malformed', 'canceled', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."model_operation" AS ENUM('embedding', 'knowledge_ask', 'brain_ask', 'ingestion', 'dreaming', 'verification', 'diagnostic');--> statement-breakpoint
CREATE TYPE "public"."model_request_outcome" AS ENUM('succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "model_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation" "model_operation" NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer NOT NULL,
	"outcome" "model_request_outcome" NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost" double precision,
	"error_reason" "model_failure_reason",
	CONSTRAINT "model_requests_measurements_check" CHECK ("model_requests"."duration_ms" >= 0 and ("model_requests"."input_tokens" is null or "model_requests"."input_tokens" >= 0) and ("model_requests"."output_tokens" is null or "model_requests"."output_tokens" >= 0) and ("model_requests"."cost" is null or ("model_requests"."cost" >= 0 and "model_requests"."cost" < 'Infinity'::float8))),
	CONSTRAINT "model_requests_outcome_check" CHECK (("model_requests"."outcome" = 'succeeded' and "model_requests"."error_reason" is null) or ("model_requests"."outcome" = 'failed' and "model_requests"."error_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "model_runtime_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service" text NOT NULL,
	"configuration_revision" integer NOT NULL,
	"models" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "model_requests_occurred_idx" ON "model_requests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "model_requests_operation_occurred_idx" ON "model_requests" USING btree ("operation","created_at");--> statement-breakpoint
CREATE INDEX "model_runtime_instances_seen_idx" ON "model_runtime_instances" USING btree ("updated_at");