ALTER TABLE "prompt_revision_source_queries" DROP CONSTRAINT "prompt_revision_source_queries_prompt_revision_id_prompt_revisions_id_fk";
--> statement-breakpoint
ALTER TABLE "prompt_revision_source_queries" DROP CONSTRAINT "prompt_revision_source_queries_source_query_revision_id_source_query_revisions_id_fk";
--> statement-breakpoint
ALTER TABLE "prompt_revision_source_queries" ADD COLUMN "project_id" uuid;--> statement-breakpoint
UPDATE "prompt_revision_source_queries" link
   SET "project_id" = revision."project_id"
  FROM "prompt_revisions" revision
 WHERE revision."id" = link."prompt_revision_id";--> statement-breakpoint
ALTER TABLE "prompt_revision_source_queries" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "prompt_revision_source_queries" ADD CONSTRAINT "prompt_revision_source_queries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_revision_source_queries" ADD CONSTRAINT "prompt_revision_source_queries_prompt_revision_project_fk" FOREIGN KEY ("prompt_revision_id","project_id") REFERENCES "public"."prompt_revisions"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_revision_source_queries" ADD CONSTRAINT "prompt_revision_source_queries_source_query_revision_project_fk" FOREIGN KEY ("source_query_revision_id","project_id") REFERENCES "public"."source_query_revisions"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM projects project
      JOIN prompt_revisions revision ON revision.id = project.current_config_revision_id
     WHERE revision.project_id <> project.id
  ) THEN
    RAISE EXCEPTION 'v2 current configuration belongs to another project';
  END IF;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "homing_v2_current_config_project_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_config_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM prompt_revisions revision
     WHERE revision.id = NEW.current_config_revision_id
       AND revision.project_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'v2 current configuration belongs to another project';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "projects_v2_current_config_project_guard"
  BEFORE INSERT OR UPDATE OF current_config_revision_id, id ON "projects"
  FOR EACH ROW EXECUTE FUNCTION "homing_v2_current_config_project_guard"();
