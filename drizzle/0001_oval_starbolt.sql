CREATE TABLE "migration_records" (
	"source_project_id" uuid PRIMARY KEY NOT NULL,
	"source_checksum" varchar(64) NOT NULL,
	"target_checksum" varchar(64) NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
