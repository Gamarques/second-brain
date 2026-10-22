CREATE TABLE "knowledge_pack_run_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_item_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"space_id" uuid NOT NULL,
	"recipe_version" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_pack_run_chunks_position_key" UNIQUE("run_item_id","position"),
	CONSTRAINT "knowledge_pack_run_chunks_position_check" CHECK ("knowledge_pack_run_chunks"."position" >= 0),
	CONSTRAINT "knowledge_pack_run_chunks_content_check" CHECK (length("knowledge_pack_run_chunks"."content") between 1 and 1000000),
	CONSTRAINT "knowledge_pack_run_chunks_content_hash_check" CHECK ("knowledge_pack_run_chunks"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "knowledge_pack_run_items" ADD COLUMN "local_revision" integer;--> statement-breakpoint
ALTER TABLE "knowledge_pack_run_chunks" ADD CONSTRAINT "knowledge_pack_run_chunks_run_item_fkey" FOREIGN KEY ("run_item_id") REFERENCES "public"."knowledge_pack_run_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_pack_run_chunks" ADD CONSTRAINT "knowledge_pack_run_chunks_recipe_fkey" FOREIGN KEY ("space_id","recipe_version") REFERENCES "public"."embedding_spaces"("id","recipe_version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_pack_run_chunks_run_item_idx" ON "knowledge_pack_run_chunks" USING btree ("run_item_id","position");--> statement-breakpoint
ALTER TABLE "knowledge_pack_run_items" ADD CONSTRAINT "knowledge_pack_run_items_local_revision_check" CHECK ("knowledge_pack_run_items"."local_revision" is null or "knowledge_pack_run_items"."local_revision" > 0);