import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Database } from "./index";
import { ensureInternalProject } from "./initialization";
import {
    clusters,
    deploymentLogs,
    deployments,
    resourceDeploymentInputs,
    resources,
} from "./schema";
import { resourceSlug } from "./slug";

/** The cluster's Caddy resource, if it has one yet. */
export async function getCaddyResource(db: Database, clusterId: string) {
    const [row] = await db
        .select({ resourceId: resources.id, projectId: resources.projectId })
        .from(clusters)
        .innerJoin(resources, eq(resources.id, clusters.caddyResourceId))
        .where(eq(clusters.id, clusterId));

    return row ?? null;
}

/**
 * Creates the cluster's Caddy resource in its internal project with `draftSpec` and the Variables
 * `env`, unless it has one already. Names stay unprefixed: Uncloud only treats a service called
 * `caddy` as ingress.
 */
export async function ensureCaddyResource(
    db: Database,
    clusterId: string,
    draftSpec: string,
    env = "",
) {
    return db.transaction(async (tx) => {
        const [cluster] = await tx
            .select({ id: clusters.id, name: clusters.name })
            .from(clusters)
            .where(eq(clusters.id, clusterId))
            .for("update");

        if (!cluster) throw new Error("Cluster not found.");

        const [existing] = await tx
            .select({ resourceId: resources.id, projectId: resources.projectId })
            .from(clusters)
            .innerJoin(resources, eq(resources.id, clusters.caddyResourceId))
            .where(eq(clusters.id, clusterId));

        if (existing) return existing;

        const projectId = await ensureInternalProject(tx, cluster);
        const resourceId = randomUUID();

        await tx.insert(resources).values({
            id: resourceId,
            projectId,
            name: "Caddy",
            slug: resourceSlug("caddy"),
            type: "compose",
            draftSpec,
            settings: { prefixNames: false, env },
        });
        await tx
            .update(clusters)
            .set({ caddyResourceId: resourceId })
            .where(eq(clusters.id, clusterId));

        return { resourceId, projectId };
    });
}

/**
 * Queues a deployment of the Caddy resource's draft, like deploying it from the canvas. Returns
 * the deployment id to enqueue (the outbox sweep picks it up otherwise), or null when one is
 * already queued or running, say from an earlier setup attempt.
 */
export async function queueCaddyDeployment(
    db: Database,
    clusterId: string,
    resourceId: string,
    spec: string,
) {
    const deploymentId = randomUUID();

    const queued = await db.transaction(async (tx) => {
        // Locking the resource row serializes this check with a deploy from the canvas.
        await tx
            .select({ id: resources.id })
            .from(resources)
            .where(eq(resources.id, resourceId))
            .for("update");

        const [active] = await tx
            .select({ id: deployments.id })
            .from(deployments)
            .where(
                and(
                    eq(deployments.resourceId, resourceId),
                    inArray(deployments.status, ["queued", "running"]),
                ),
            )
            .limit(1);

        if (active) return false;

        await tx.insert(deployments).values({
            id: deploymentId,
            jobId: deploymentId,
            clusterId,
            resourceId,
            name: "DeployResource",
            status: "queued",
            spec,
            metadata: { source: "docker", trigger: "manual" },
        });
        // An empty prefix deploys the service as plain `caddy`.
        await tx.insert(resourceDeploymentInputs).values({ deploymentId, prefix: "" });
        await tx.insert(deploymentLogs).values({
            deploymentId,
            text: "Resource deployment queued. Saved Compose snapshot captured.",
            metadata: { level: "info" },
        });

        return true;
    });

    return queued ? deploymentId : null;
}
