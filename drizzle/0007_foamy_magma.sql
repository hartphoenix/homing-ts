CREATE TYPE "public"."agent_config_status" AS ENUM('legacy', 'needs_review', 'complete');--> statement-breakpoint
CREATE TYPE "public"."agent_protocol_version" AS ENUM('v1', 'v2');--> statement-breakpoint
CREATE TYPE "public"."agent_run_phase" AS ENUM('snapshot', 'acquire', 'match', 'deliver', 'finish');--> statement-breakpoint
CREATE TYPE "public"."agent_run_query_status" AS ENUM('pending', 'completed', 'blocked', 'unavailable', 'malformed', 'partial');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('started', 'completed', 'incomplete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."match_disposition" AS ENUM('pending', 'rejected', 'insufficient', 'kept');--> statement-breakpoint
CREATE TYPE "public"."source_adapter" AS ENUM('zumper-com', 'streeteasy-com');--> statement-breakpoint
CREATE TYPE "public"."source_query_status" AS ENUM('needs_review', 'ready');--> statement-breakpoint
CREATE TABLE "agent_run_projects" (
	"run_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"prompt_revision_id" bigint NOT NULL,
	"prompt_revision" integer NOT NULL,
	"canonical_sha256" varchar(64) NOT NULL,
	CONSTRAINT "agent_run_projects_run_id_project_id_pk" PRIMARY KEY("run_id","project_id"),
	CONSTRAINT "agent_run_projects_canonical_hash_hex" CHECK ("agent_run_projects"."canonical_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "agent_run_queries" (
	"run_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source_query_revision_id" uuid NOT NULL,
	"source_query_revision" integer NOT NULL,
	"canonical_sha256" varchar(64) NOT NULL,
	"status" "agent_run_query_status" DEFAULT 'pending' NOT NULL,
	"error_class" varchar(64),
	"attempted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "agent_run_queries_run_id_source_query_revision_id_pk" PRIMARY KEY("run_id","source_query_revision_id"),
	CONSTRAINT "agent_run_queries_canonical_hash_hex" CHECK ("agent_run_queries"."canonical_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invocation_id" uuid NOT NULL,
	"user_id" bigint NOT NULL,
	"token_id" uuid,
	"agent_label" varchar(160) NOT NULL,
	"status" "agent_run_status" DEFAULT 'started' NOT NULL,
	"phase" "agent_run_phase" DEFAULT 'snapshot' NOT NULL,
	"source_queries_attempted" integer DEFAULT 0 NOT NULL,
	"source_queries_completed" integer DEFAULT 0 NOT NULL,
	"candidates_observed" integer DEFAULT 0 NOT NULL,
	"candidates_evaluated" integer DEFAULT 0 NOT NULL,
	"candidates_kept" integer DEFAULT 0 NOT NULL,
	"candidates_insufficient" integer DEFAULT 0 NOT NULL,
	"deliveries_acknowledged" integer DEFAULT 0 NOT NULL,
	"deliveries_pending" integer DEFAULT 0 NOT NULL,
	"failure_phase" varchar(24),
	"failure_code" varchar(64),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runs_counts_nonnegative" CHECK (
        "agent_runs"."source_queries_attempted" >= 0 and
        "agent_runs"."source_queries_completed" >= 0 and
        "agent_runs"."candidates_observed" >= 0 and
        "agent_runs"."candidates_evaluated" >= 0 and
        "agent_runs"."candidates_kept" >= 0 and
        "agent_runs"."candidates_insufficient" >= 0 and
        "agent_runs"."deliveries_acknowledged" >= 0 and
        "agent_runs"."deliveries_pending" >= 0
      ),
	CONSTRAINT "agent_runs_evaluated_lte_observed" CHECK ("agent_runs"."candidates_evaluated" <= "agent_runs"."candidates_observed"),
	CONSTRAINT "agent_runs_dispositions_lte_evaluated" CHECK ("agent_runs"."candidates_kept" + "agent_runs"."candidates_insufficient" <= "agent_runs"."candidates_evaluated")
);
--> statement-breakpoint
CREATE TABLE "match_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"prompt_revision_id" bigint NOT NULL,
	"facts_hash" varchar(64) NOT NULL,
	"disposition" "match_disposition" DEFAULT 'pending' NOT NULL,
	"reason" varchar(500) DEFAULT '' NOT NULL,
	"unknowns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_observations_facts_hash_hex" CHECK ("match_observations"."facts_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "prompt_revision_source_queries" (
	"prompt_revision_id" bigint NOT NULL,
	"source_query_revision_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "prompt_revision_source_queries_prompt_revision_id_source_query_revision_id_pk" PRIMARY KEY("prompt_revision_id","source_query_revision_id"),
	CONSTRAINT "prompt_revision_source_queries_position_bounds" CHECK ("prompt_revision_source_queries"."position" >= 0 and "prompt_revision_source_queries"."position" < 8)
);
--> statement-breakpoint
CREATE TABLE "source_query_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"adapter" "source_adapter" NOT NULL,
	"revision" integer NOT NULL,
	"normalized_query" jsonb NOT NULL,
	"query_identity" varchar(64) NOT NULL,
	"acquisition_basis_hash" varchar(64) NOT NULL,
	"canonical_bytes" bytea NOT NULL,
	"canonical_sha256" varchar(64) NOT NULL,
	"status" "source_query_status" DEFAULT 'needs_review' NOT NULL,
	"creation_prompt_revision_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_query_revisions_query_identity_hex" CHECK ("source_query_revisions"."query_identity" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "source_query_revisions_basis_hash_hex" CHECK ("source_query_revisions"."acquisition_basis_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "source_query_revisions_canonical_hash_hex" CHECK ("source_query_revisions"."canonical_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "agent_links" ADD COLUMN "protocol_version" "agent_protocol_version" DEFAULT 'v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD COLUMN "source_write_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "agent_paused_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "current_config_revision_id" bigint;--> statement-breakpoint
ALTER TABLE "prompt_revisions" ADD COLUMN "config_status" "agent_config_status" DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "prompt_revisions" ADD COLUMN "required_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "prompt_revisions" ADD COLUMN "acquisition_basis" jsonb;--> statement-breakpoint
ALTER TABLE "prompt_revisions" ADD COLUMN "canonical_bytes" bytea;--> statement-breakpoint
ALTER TABLE "prompt_revisions" ADD COLUMN "canonical_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_current_config_revision_id_prompt_revisions_id_fk" FOREIGN KEY ("current_config_revision_id") REFERENCES "public"."prompt_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_projects" ADD CONSTRAINT "agent_run_projects_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_projects" ADD CONSTRAINT "agent_run_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_projects" ADD CONSTRAINT "agent_run_projects_prompt_revision_id_prompt_revisions_id_fk" FOREIGN KEY ("prompt_revision_id") REFERENCES "public"."prompt_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_queries" ADD CONSTRAINT "agent_run_queries_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_queries" ADD CONSTRAINT "agent_run_queries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_queries" ADD CONSTRAINT "agent_run_queries_source_query_revision_id_source_query_revisions_id_fk" FOREIGN KEY ("source_query_revision_id") REFERENCES "public"."source_query_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_token_id_agent_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."agent_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_observations" ADD CONSTRAINT "match_observations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_observations" ADD CONSTRAINT "match_observations_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_observations" ADD CONSTRAINT "match_observations_prompt_revision_id_prompt_revisions_id_fk" FOREIGN KEY ("prompt_revision_id") REFERENCES "public"."prompt_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_revision_source_queries" ADD CONSTRAINT "prompt_revision_source_queries_prompt_revision_id_prompt_revisions_id_fk" FOREIGN KEY ("prompt_revision_id") REFERENCES "public"."prompt_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_revision_source_queries" ADD CONSTRAINT "prompt_revision_source_queries_source_query_revision_id_source_query_revisions_id_fk" FOREIGN KEY ("source_query_revision_id") REFERENCES "public"."source_query_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_query_revisions" ADD CONSTRAINT "source_query_revisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_query_revisions" ADD CONSTRAINT "source_query_revisions_creation_prompt_revision_id_prompt_revisions_id_fk" FOREIGN KEY ("creation_prompt_revision_id") REFERENCES "public"."prompt_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_invocation_uniq" ON "agent_runs" USING btree ("invocation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "match_observations_identity_uniq" ON "match_observations" USING btree ("project_id","lead_id","prompt_revision_id","facts_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_revision_source_queries_position_uniq" ON "prompt_revision_source_queries" USING btree ("prompt_revision_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "source_query_revisions_project_adapter_identity_uniq" ON "source_query_revisions" USING btree ("project_id","adapter","query_identity");--> statement-breakpoint
CREATE UNIQUE INDEX "source_query_revisions_project_adapter_revision_uniq" ON "source_query_revisions" USING btree ("project_id","adapter","revision");--> statement-breakpoint
CREATE FUNCTION "homing_v2_revision_immutable_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.project_id IS DISTINCT FROM NEW.project_id
     OR OLD.revision IS DISTINCT FROM NEW.revision
     OR OLD.prompt IS DISTINCT FROM NEW.prompt
     OR OLD.criteria IS DISTINCT FROM NEW.criteria
     OR OLD.config_status IS DISTINCT FROM NEW.config_status
     OR OLD.required_evidence IS DISTINCT FROM NEW.required_evidence
     OR OLD.acquisition_basis IS DISTINCT FROM NEW.acquisition_basis
     OR OLD.canonical_bytes IS DISTINCT FROM NEW.canonical_bytes
     OR OLD.canonical_sha256 IS DISTINCT FROM NEW.canonical_sha256 THEN
    RAISE EXCEPTION 'v2 prompt revisions are immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "prompt_revisions_v2_immutable_guard"
  BEFORE UPDATE ON "prompt_revisions"
  FOR EACH ROW EXECUTE FUNCTION "homing_v2_revision_immutable_guard"();--> statement-breakpoint
CREATE FUNCTION "homing_v2_query_immutable_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.project_id IS DISTINCT FROM NEW.project_id
     OR OLD.adapter IS DISTINCT FROM NEW.adapter
     OR OLD.revision IS DISTINCT FROM NEW.revision
     OR OLD.normalized_query IS DISTINCT FROM NEW.normalized_query
     OR OLD.query_identity IS DISTINCT FROM NEW.query_identity
     OR OLD.acquisition_basis_hash IS DISTINCT FROM NEW.acquisition_basis_hash
     OR OLD.canonical_bytes IS DISTINCT FROM NEW.canonical_bytes
     OR OLD.canonical_sha256 IS DISTINCT FROM NEW.canonical_sha256
     OR OLD.creation_prompt_revision_id IS DISTINCT FROM NEW.creation_prompt_revision_id THEN
    RAISE EXCEPTION 'v2 source query revisions are immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "source_query_revisions_v2_immutable_guard"
  BEFORE UPDATE ON "source_query_revisions"
  FOR EACH ROW EXECUTE FUNCTION "homing_v2_query_immutable_guard"();--> statement-breakpoint
CREATE FUNCTION "homing_v2_observation_immutable_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'v2 match observations are immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "match_observations_v2_immutable_guard"
  BEFORE UPDATE ON "match_observations"
  FOR EACH ROW EXECUTE FUNCTION "homing_v2_observation_immutable_guard"();--> statement-breakpoint
ALTER TABLE "prompt_revisions" ADD CONSTRAINT "prompt_revisions_v2_payload_complete" CHECK (("prompt_revisions"."config_status" = 'legacy') or
          ("prompt_revisions"."acquisition_basis" is not null and "prompt_revisions"."canonical_bytes" is not null and
           "prompt_revisions"."canonical_sha256" is not null and "prompt_revisions"."canonical_sha256" ~ '^[0-9a-f]{64}$'));
