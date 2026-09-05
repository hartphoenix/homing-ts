ALTER TABLE "agent_run_projects" DROP CONSTRAINT "agent_run_projects_prompt_revision_id_prompt_revisions_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_run_queries" DROP CONSTRAINT "agent_run_queries_source_query_revision_id_source_query_revisions_id_fk";
--> statement-breakpoint
ALTER TABLE "source_query_revisions" DROP CONSTRAINT "source_query_revisions_creation_prompt_revision_id_prompt_revisions_id_fk";
--> statement-breakpoint
CREATE UNIQUE INDEX "leads_id_project_uniq" ON "leads" USING btree ("id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_revisions_id_project_uniq" ON "prompt_revisions" USING btree ("id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_query_revisions_id_project_uniq" ON "source_query_revisions" USING btree ("id","project_id");--> statement-breakpoint
ALTER TABLE "agent_run_projects" ADD CONSTRAINT "agent_run_projects_prompt_revision_project_fk" FOREIGN KEY ("prompt_revision_id","project_id") REFERENCES "public"."prompt_revisions"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_queries" ADD CONSTRAINT "agent_run_queries_run_project_fk" FOREIGN KEY ("run_id","project_id") REFERENCES "public"."agent_run_projects"("run_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_queries" ADD CONSTRAINT "agent_run_queries_source_query_revision_project_fk" FOREIGN KEY ("source_query_revision_id","project_id") REFERENCES "public"."source_query_revisions"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_observations" ADD CONSTRAINT "match_observations_lead_project_fk" FOREIGN KEY ("lead_id","project_id") REFERENCES "public"."leads"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_observations" ADD CONSTRAINT "match_observations_prompt_revision_project_fk" FOREIGN KEY ("prompt_revision_id","project_id") REFERENCES "public"."prompt_revisions"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_query_revisions" ADD CONSTRAINT "source_query_revisions_creation_prompt_revision_project_fk" FOREIGN KEY ("creation_prompt_revision_id","project_id") REFERENCES "public"."prompt_revisions"("id","project_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
