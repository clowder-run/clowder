import { clusters, deployments } from "@clowder/db/schema/index";
import { ensureCaddyResource, getCaddyResource } from "@clowder/db/caddy";
import { unwrap, type UcClient } from "@clowder/uncloud";
import {
    CADDY_METRICS_ENDPOINT,
    CADDY_SERVICE,
    caddyCompose,
    caddyVariables,
    withCaddyMounts,
} from "@clowder/workflows/caddy";
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
        Container: v.object({
            Env: v.nullish(v.record(v.string(), v.string())),
            VolumeMounts: v.nullish(
                v.array(
                    v.object({
                        VolumeName: v.string(),
                        ContainerPath: v.string(),
                        ReadOnly: v.nullish(v.boolean()),
                    }),
                ),
            ),
            ConfigMounts: v.nullish(
                v.array(v.object({ ConfigName: v.string(), ContainerPath: v.nullish(v.string()) })),
            ),
        }),
        Volumes: v.nullish(
            v.array(
                v.object({
                    Name: v.string(),
                    Type: v.string(),
                    BindOptions: v.nullish(v.object({ HostPath: v.string() })),
                }),
            ),
        ),
        Ports: v.nullish(v.array(portSpec)),
        Placement: v.nullish(v.object({ Machines: v.nullish(v.array(v.string())) })),
    }),
});

type LiveCaddy = v.InferOutput<typeof liveCaddySpec>["ServiceSpec"];

async function liveCaddy(uc: UcClient, signal?: AbortSignal) {
    const { containers } = await unwrap(
        uc.GET("/api/v1/services/{id}", { params: { path: { id: CADDY_SERVICE } }, signal }),
    );

    // A global service runs one spec everywhere, unless a rollout is midway.
    return containers[0] ? v.parse(liveCaddySpec, containers[0].container).ServiceSpec : null;
}

/**
 * The Caddy resource's draft for a cluster that runs Caddy without one, and its Variables: the
 * running service's image, global Caddyfile, environment, extra ports, bind mounts and
 * placement. Its healthcheck is the template's, and mounts a Compose file can't hold are listed
 * in the draft. A cluster without Caddy starts from the template.
 */
function adoptedCaddy(image: string, caddyfile: string, live: LiveCaddy | null) {
    if (!image) return { spec: caddyCompose(withCaddyMetrics("")), env: "" };

    const volumes = new Map((live?.Volumes ?? []).map((volume) => [volume.Name, volume]));
    const mounts: string[] = [];
    const dropped: string[] = [];

    for (const mount of live?.Container.VolumeMounts ?? []) {
        const volume = volumes.get(mount.VolumeName);
        const readOnly = mount.ReadOnly ? ":ro" : "";

        if (volume?.Type === "bind" && volume.BindOptions)
            mounts.push(`${volume.BindOptions.HostPath}:${mount.ContainerPath}${readOnly}`);
        else
            dropped.push(
                `${mount.VolumeName} (${volume?.Type ?? "volume"}) at ${mount.ContainerPath}`,
            );
    }

    for (const mount of live?.Container.ConfigMounts ?? [])
        dropped.push(
            `config ${mount.ConfigName} at ${mount.ContainerPath ?? `/${mount.ConfigName}`}`,
        );

    const spec = caddyCompose(caddyfile, image, live?.Ports ?? [], live?.Placement?.Machines ?? []);

    return {
        spec: withCaddyMounts(spec, mounts, dropped),
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

            const live = settings.deployed ? await liveCaddy(uc, signal) : null;

            // Clusters from before Caddy was a resource adopt the running one as a draft. It is
            // never deployed here: a restart would take down the whole cluster's ingress.
            let resource = await getCaddyResource(db, input.clusterId);

            if (!resource) {
                const adopted = adoptedCaddy(
                    settings.deployed ? settings.image : "",
                    settings.caddyfile,
                    live,
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
                // Without a running Caddy there is no Caddyfile to check yet.
                missingMetrics: settings.deployed
                    ? missingMetricsSubdirectives(settings.caddyfile)
                    : [],
                // Caddy from `uc`, or from before monitoring renamed Alloy, pushes elsewhere.
                metricsEndpointOutdated:
                    settings.deployed &&
                    live?.Container.Env?.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT !==
                        CADDY_METRICS_ENDPOINT,
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
