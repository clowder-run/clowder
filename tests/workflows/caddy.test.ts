import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createDb } from "@clowder/db";
import { ensureCaddyResource, getCaddyResource, queueCaddyDeployment } from "@clowder/db/caddy";
import { clusters, projects, resourceDeploymentInputs, resources } from "@clowder/db/schema/index";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
    CADDY_METRICS_ENDPOINT,
    caddyCompose,
    caddyVariables,
    withCaddyMounts,
} from "../../packages/workflows/src/caddy";
import { interpolateCompose } from "../../packages/workflows/src/compose";
import {
    missingMetricsSubdirectives,
    withCaddyMetrics,
} from "../../packages/workflows/src/caddy-metrics";
import { parseIngressCompose } from "../../packages/workflows/src/ingress";
import { ALLOY_SERVICE } from "../../packages/workflows/src/monitoring-compose";

describe("caddy resource compose", () => {
    it("is Uncloud's caddy service with the image and global Caddyfile as given", () => {
        const caddyfile = withCaddyMetrics("{\n\temail ops@example.com\n}\n");
        const spec = caddyCompose(caddyfile, "ghcr.io/example/caddy:2.10");
        const { services } = parse(spec);

        expect(Object.keys(services)).toEqual(["caddy"]);
        expect(services.caddy.image).toBe("ghcr.io/example/caddy:2.10");
        expect(services.caddy["x-caddy"]).toBe(caddyfile);
        expect(services.caddy.deploy).toEqual({ mode: "global" });
        expect(services.caddy["x-ports"]).toEqual([
            "80:80@host",
            "443:443@host",
            "443:443/udp@host",
        ]);
        expect(services.caddy.environment.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toContain(
            `nearest.${ALLOY_SERVICE}.internal`,
        );
    });

    it("keeps the template's image and leaves x-caddy out without a Caddyfile", () => {
        const { caddy } = parse(caddyCompose("")).services;

        expect(caddy.image).toMatch(/^caddy:2\.11\./u);
        expect(caddy["x-caddy"]).toBeUndefined();
    });

    it("keeps a running Caddy's extra ports and placement", () => {
        const { caddy } = parse(
            caddyCompose("", "caddy:2", ["80:80@host", "2222:2222@host"], ["edge-1"]),
        ).services;

        expect(caddy["x-ports"]).toEqual([
            "80:80@host",
            "443:443@host",
            "443:443/udp@host",
            "2222:2222@host",
        ]);
        expect(caddy["x-machines"]).toEqual(["edge-1"]);
    });

    it("delivers Caddy's own {$ENV} placeholders through a deploy unchanged", () => {
        const caddyfile = "{\n\tacme_dns cloudflare {$CF_API_TOKEN}\n}\n";
        const deployed = interpolateCompose(caddyCompose(caddyfile), "CF_API_TOKEN=secret\n");

        // uc's Compose loader turns `$$` back into `$`; a bare `$CF_API_TOKEN` would be replaced.
        expect(parse(deployed).services.caddy["x-caddy"].replaceAll("$$", "$")).toBe(caddyfile);
    });

    it("moves only the environment the template lacks into Variables", () => {
        expect(
            caddyVariables({
                CADDY_ADMIN: "unix//run/caddy/admin.sock",
                OTEL_SERVICE_NAME: "caddy",
                CF_API_TOKEN: "secret value",
            }),
        ).toBe('CF_API_TOKEN="secret value"\n');
    });

    it("keeps a running Caddy's bind mounts, replacing the template's at the same path", () => {
        const spec = withCaddyMounts(
            caddyCompose("", "caddy:2"),
            ["/srv/caddy-data:/data", "/etc/dns-token:/run/secrets/dns:ro"],
            ["certs (volume) at /certs"],
        );

        const { caddy } = parse(spec).services;

        expect(caddy.volumes).toEqual([
            "/var/lib/uncloud/caddy:/etc/caddy:ro",
            "/run/uncloud/caddy:/run/caddy",
            "/run/uncloud/api:/run/uncloud/api:ro",
            "/srv/caddy-data:/data",
            "/etc/dns-token:/run/secrets/dns:ro",
        ]);
        expect(spec).toMatch(/^# .*\n# - certs \(volume\) at \/certs\n/u);
        expect(CADDY_METRICS_ENDPOINT).toBe(caddy.environment.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT);
    });

    it("passes the canvas ingress checks", () => {
        expect(parseIngressCompose(caddyCompose(withCaddyMetrics(""))).issues).toEqual([]);
    });
});

describe("caddy metrics", () => {
    it("creates the global options block when there is none", () => {
        expect(withCaddyMetrics("")).toBe("{\n\tmetrics {\n\t\tper_host\n\t\totlp\n\t}\n}\n");
        expect(withCaddyMetrics("(headers) {\n\theader -Server\n}\n")).toBe(
            "{\n\tmetrics {\n\t\tper_host\n\t\totlp\n\t}\n}\n\n(headers) {\n\theader -Server\n}\n",
        );
    });

    it("adds metrics to an existing global options block, after leading comments", () => {
        const caddyfile = "# Global\n{\n\temail ops@example.com\n}\n\nexample.com {\n\tmetrics\n}";

        expect(withCaddyMetrics(caddyfile)).toBe(
            "# Global\n{\n\tmetrics {\n\t\tper_host\n\t\totlp\n\t}\n\temail ops@example.com\n}\n\nexample.com {\n\tmetrics\n}\n",
        );
    });

    it("keeps a metrics option the user configured, and is idempotent", () => {
        const custom = "{\n\tservers {\n\t\ttimeouts {\n\t\t\tidle 1m\n\t\t}\n\t}\n\tmetrics\n}";

        expect(withCaddyMetrics(custom)).toBe(custom);
        expect(withCaddyMetrics(withCaddyMetrics("{\n\temail a@b.c\n}"))).toBe(
            withCaddyMetrics("{\n\temail a@b.c\n}"),
        );
    });

    it("reports what the global metrics option lacks", () => {
        expect(missingMetricsSubdirectives("")).toEqual(["per_host", "otlp"]);
        expect(missingMetricsSubdirectives("{\n\temail a@b.c\n}")).toEqual(["per_host", "otlp"]);
        expect(missingMetricsSubdirectives("{\n\tmetrics\n}")).toEqual(["per_host", "otlp"]);
        expect(missingMetricsSubdirectives("{\n    metrics {\n        per_host\n    }\n}")).toEqual(
            ["otlp"],
        );
        expect(missingMetricsSubdirectives("{\n\tmetrics { otlp per_host }\n}")).toEqual([]);
        // Site-level metrics directives are not the global option.
        expect(missingMetricsSubdirectives("example.com {\n\tmetrics\n}")).toEqual([
            "per_host",
            "otlp",
        ]);
    });
});

describe("caddy resource adoption (PostgreSQL)", () => {
    const databaseName = `clowder_caddy_test_${randomUUID().replaceAll("-", "")}`;
    const organizationId = randomUUID();
    const clusterId = randomUUID();

    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;

    beforeAll(async () => {
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });
        await db.$client.query(
            `INSERT INTO organization (id, name, slug, created_at) VALUES ($1, 'Caddy', $1, now())`,
            [organizationId],
        );
        await db.insert(clusters).values({
            id: clusterId,
            organizationId,
            name: "Caddy cluster",
            sidecarUrl: "http://sidecar.test",
            sidecarToken: "secret",
        });
    }, 30_000);

    afterAll(async () => {
        await db?.$client.end();

        if (admin) {
            await admin.$client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
            await admin.$client.end();
        }
    });

    it("creates one unprefixed Caddy resource in the internal project, once", async () => {
        expect(await getCaddyResource(db, clusterId)).toBeNull();

        const spec = caddyCompose("");

        const [first, second] = await Promise.all([
            ensureCaddyResource(db, clusterId, spec),
            ensureCaddyResource(db, clusterId, "services: {}\n"),
        ]);

        expect(second).toEqual(first);
        expect(await getCaddyResource(db, clusterId)).toEqual(first);

        const internal = await db.select().from(projects).where(eq(projects.clusterId, clusterId));
        expect(internal).toMatchObject([{ id: first.projectId, isInternal: true }]);

        const [resource] = await db
            .select()
            .from(resources)
            .where(eq(resources.id, first.resourceId));

        expect(resource).toMatchObject({
            name: "Caddy",
            type: "compose",
            settings: { prefixNames: false },
        });
        // Whichever call won, the draft is never deployed by adoption.
        expect(resource?.spec).toBeNull();
    });

    it("queues setup's Caddy as the resource's draft, with its Variables", async () => {
        const { resourceId } = await ensureCaddyResource(db, clusterId, "services: {}\n");
        await db
            .update(resources)
            .set({ settings: { prefixNames: false, env: "CF_API_TOKEN=secret\n" } })
            .where(eq(resources.id, resourceId));

        const spec = caddyCompose(withCaddyMetrics(""), "caddy:2");
        const deploymentId = await queueCaddyDeployment(db, clusterId, resourceId, spec);

        expect(deploymentId).not.toBeNull();
        expect(await queueCaddyDeployment(db, clusterId, resourceId, "services: {}\n")).toBeNull();

        const [resource] = await db.select().from(resources).where(eq(resources.id, resourceId));
        expect(resource?.draftSpec).toBe(spec);

        const [inputs] = await db
            .select()
            .from(resourceDeploymentInputs)
            .where(eq(resourceDeploymentInputs.deploymentId, deploymentId!));

        expect(inputs).toMatchObject({ prefix: "", env: "CF_API_TOKEN=secret\n" });
    });

    it("still deletes a cluster with a Caddy resource", async () => {
        await db.delete(clusters).where(eq(clusters.id, clusterId));

        expect(await db.select().from(resources)).toEqual([]);
    });
});
