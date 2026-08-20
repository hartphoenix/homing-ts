ALTER TABLE "leads" ALTER COLUMN "source_listing_id" SET DATA TYPE varchar(300);--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "source_listing_id" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "price_display" SET DATA TYPE varchar(200);--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "price_display" SET DEFAULT '';