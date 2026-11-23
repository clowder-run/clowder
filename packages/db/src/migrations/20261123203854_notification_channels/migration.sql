CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" text NOT NULL,
	"events" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "notification_channels_type_check" CHECK ("type" in ('discord', 'telegram', 'ntfy', 'gchat', 'webhook'))
);
--> statement-breakpoint
CREATE INDEX "notification_channels_organization_idx" ON "notification_channels" ("organization_id");--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;