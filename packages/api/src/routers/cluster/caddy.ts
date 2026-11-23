import { clusters, deployments } from "@clowder/db/schema/index";
import { ensureCaddyResource, getCaddyResource } from "@clowder/db/caddy";
import { unwrap, type UcClient } from "@clowder/uncloud";
import { CADDY_SERVICE, caddyCompose, caddyVariables } from "@clowder/workflows/caddy";
import { missingMetricsSubdirectives, withCaddyMetrics } from "@clowder/workflows/caddy-metrics";
import { and, eq, inArray } from "drizzle-orm";
import * as v from "valibot";
import { organizationProcedure, uncloudMiddleware } from "../..";

const clusterInput = v.object({
    clusterId: v.pipe(v.string(), v.uuid()),
});

// Uncloud's PortSpec, written back as an `x-ports` entry.
const portSpec = v.pipe(
    v.object({
        Hostname: v.nullish(v.string()),
        HostIP: v.nullish(v.string()),
        PublishedPort: v.nullish(v.number()),
        ContainerPort: v.number(),
        Protocol: v.nullish(v.string()),
        Mode: v.nullish(v.string()),
    }),
    v.transform((port) => {
        const protocol = port.Protocol && port.Protocol !== "tcp" ? `/${port.Protocol}` : "";

        if (port.Mode === "host") {
            const ip = port.HostIP?.includes(":")
                ? `[${port.HostIP}]:`
                : port.HostIP
                  ? `${port.HostIP}:`
                  : "";

            return `${ip}${port.PublishedPort}:${port.ContainerPort}${protocol}@host`;
        }

        const published = port.PublishedPort ? `${port.PublishedPort}:` : "";
        const hostname = port.Hostname ? `${port.Hostname}:` : "";

        return `${hostname}${published}${port.ContainerPort}${protocol}`;
    }),
);

// The parts of a running caddy container's service spec that adoption keeps.
const liveCaddySpec = v.object({
    ServiceSpec: v.object({
        Container: v.object({ Env: v.nullish(v.record(v.string(), v.string())) }),
        Ports: v.nullish(v.array(portSpec)),
        Placement: v.nullish(v.object({ Machines: v.nullish(v.array(v.string())) })),
    }),
});

/**
 * The Caddy resource's draft for a cluster that runs Caddy without one, and its Variables: the
 * running service's image, global Caddyfile, environment, extra ports and placement, so deploying
 * it changes nothing. A cluster without Caddy starts from the template.
 */
async function adoptedCaddy(uc: UcClient, image: string, caddyfile: string, signal?: AbortSignal) {
    if (!image) return { spec: caddyCompose(withCaddyMetrics("")), env: "" };

    const { containers } = await unwrap(
        uc.GET("/api/v1/services/{id}", { params: { path: { id: CADDY_SERVICE } }, signal }),
    );

    // A global service runs one spec everywhere, unless a rollout is midway.
    const live = containers[0] ? v.parse(liveCaddySpec, containers[0].container).ServiceSpec : null;

    return {
        spec: caddyCompose(caddyfile, image, live?.Ports ?? [], live?.Placement?.Machines ?? []),
        env: caddyVariables(live?.Container.Env ?? {}),
    };
}

export const caddyRouter = {
    // Reads the live caddy service, so settings changed with `uc caddy deploy` show up here too.
    getCaddy: organizationProcedure
        .input(clusterInput)
        .use(uncloudMiddleware)
        .handler(async ({ context: { db, uc }, input, signal }) => {
            const [settings, configs, [cluster]] = await Promise.all([
                unwrap(uc.GET("/api/v1/caddy", { signal })),
                unwrap(uc.GET("/api/v1/caddy/configs", { signal })),
                db
                    .select({ initializedAt: clusters.initializedAt })
                    .from(clusters)
                    .where(eq(clusters.id, input.clusterId))
                    .limit(1),
            ]);

            // Clusters from before Caddy was a resource adopt the running one as a draft. It is
            // never deployed here: a restart would take down the whole cluster's ingress.
            let resource = await getCaddyResource(db, input.clusterId);

            if (!resource) {
                const adopted = await adoptedCaddy(
                    uc,
                    settings.deployed ? settings.image : "",
                    settings.caddyfile,
                    signal,
                );

                resource = await ensureCaddyResource(
                    db,
                    input.clusterId,
                    adopted.spec,
                    adopted.env,
                );
            }

            const [active] = await db
                .select({ id: deployments.id })
                .from(deployments)
                .where(
                    and(
                        eq(deployments.resourceId, resource.resourceId),
                        inArray(deployments.status, ["queued", "running"]),
                    ),
                )
                .limit(1);

            return {
                ...resource,
                deployed: settings.deployed,
                image: settings.image,
                hasCaddyfile: settings.caddyfile !== "",
                // Caddy pushes HTTP metrics only while monitoring runs.
                monitoring: !!cluster?.initializedAt,
                missingMetrics: missingMetricsSubdirectives(settings.caddyfile),
                // Caddy keeps serving its previous config on these machines.
                reconciliationErrors: configs.items.flatMap((item) =>
                    item.lastReconciliationError
                        ? [{ machine: item.machineName, error: item.lastReconciliationError }]
                        : [],
                ),
                activeDeploymentId: active?.id ?? null,
            };
        }),
};
