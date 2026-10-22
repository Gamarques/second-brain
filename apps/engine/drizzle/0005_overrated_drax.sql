CREATE TABLE "dreaming_reviews" (
	"change_id" uuid PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"decision" "ingest_review_decision" NOT NULL,
	"idempotency_key" text NOT NULL,
	"result_memory_id" uuid,
	"reviewer_account_id" uuid,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dreaming_reviews_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "dreaming_reviews_fingerprint_check" CHECK ("dreaming_reviews"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "dreaming_reviews_result_check" CHECK (("dreaming_reviews"."decision" = 'accept') = ("dreaming_reviews"."result_memory_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "dreaming_reviews" ADD CONSTRAINT "dreaming_reviews_change_id_dreaming_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."dreaming_changes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dreaming_reviews" ADD CONSTRAINT "dreaming_reviews_reviewer_account_id_accounts_id_fk" FOREIGN KEY ("reviewer_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dreaming_reviews_created_idx" ON "dreaming_reviews" USING btree ("created_at","change_id");