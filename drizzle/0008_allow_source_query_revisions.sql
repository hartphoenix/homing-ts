DROP INDEX "source_query_revisions_project_adapter_identity_uniq";--> statement-breakpoint
CREATE INDEX "source_query_revisions_project_adapter_identity_idx" ON "source_query_revisions" USING btree ("project_id","adapter","query_identity");
