ALTER TABLE "clusters" ADD COLUMN "caddy_resource_id" uuid;--> statement-breakpoint
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_caddy_resource_id_resources_id_fkey" FOREIGN KEY ("caddy_resource_id") REFERENCES "resources"("id") ON DELETE SET NULL;--> statement-breakpoint
-- The DeployCaddy job is gone: Caddy deploys as a resource now. Settle rollouts still waiting for it.
UPDATE "deployments" SET "status" = 'cancelled', "finished_at" = now(), "updated_at" = now() WHERE "name" = 'DeployCaddy' AND "status" IN ('queued', 'running');
