CREATE TABLE "knowledge_document_people" (
	"document_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_document_people_pkey" PRIMARY KEY("document_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "person_knowledge_bases" (
	"person_id" uuid NOT NULL,
	"knowledge_base_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_knowledge_bases_pkey" PRIMARY KEY("person_id","knowledge_base_id")
);
--> statement-breakpoint
CREATE TABLE "person_projects" (
	"person_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_projects_pkey" PRIMARY KEY("person_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', "content")) STORED;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_document_people" ADD CONSTRAINT "knowledge_document_people_document_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_document_people" ADD CONSTRAINT "knowledge_document_people_person_fkey" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_knowledge_bases" ADD CONSTRAINT "person_knowledge_bases_person_fkey" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_knowledge_bases" ADD CONSTRAINT "person_knowledge_bases_base_fkey" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_projects" ADD CONSTRAINT "person_projects_person_fkey" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_projects" ADD CONSTRAINT "person_projects_project_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_document_people_person_idx" ON "knowledge_document_people" USING btree ("person_id","document_id");--> statement-breakpoint
CREATE INDEX "person_knowledge_bases_base_idx" ON "person_knowledge_bases" USING btree ("knowledge_base_id","person_id");--> statement-breakpoint
CREATE INDEX "person_projects_project_idx" ON "person_projects" USING btree ("project_id","person_id");--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_project_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_chunks_search_vector_idx" ON "knowledge_chunks" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "knowledge_documents_project_idx" ON "knowledge_documents" USING btree ("project_id","id");--> statement-breakpoint
CREATE INDEX "knowledge_documents_tags_gin_idx" ON "knowledge_documents" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "people_tags_gin_idx" ON "people" USING gin ("tags");--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_summary_length_check" CHECK ("people"."summary" is null or length(btrim("people"."summary")) between 1 and 1000);