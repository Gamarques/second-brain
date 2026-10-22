CREATE TABLE "briefing_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"insight_index" integer NOT NULL,
	"kind" text NOT NULL,
	"input_digest" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"entity_id" uuid,
	"account_id" uuid,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "briefing_actions_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "briefing_actions_insight_kind_key" UNIQUE("report_id","insight_index","kind"),
	CONSTRAINT "briefing_actions_index_check" CHECK ("briefing_actions"."insight_index" between 0 and 9),
	CONSTRAINT "briefing_actions_kind_check" CHECK ("briefing_actions"."kind" in ('task', 'reminder', 'resolve')),
	CONSTRAINT "briefing_actions_digest_check" CHECK ("briefing_actions"."input_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "briefing_actions_result_check" CHECK (("briefing_actions"."kind" = 'resolve') = ("briefing_actions"."entity_id" is null))
);
--> statement-breakpoint
ALTER TABLE "briefing_actions" ADD CONSTRAINT "briefing_actions_report_id_dreaming_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."dreaming_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefing_actions" ADD CONSTRAINT "briefing_actions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "briefing_actions_created_idx" ON "briefing_actions" USING btree ("created_at","id");