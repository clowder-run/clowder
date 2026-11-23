import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import template from "../../../internal/caddy/compose.yaml?raw";
import { formatEnvValue } from "./env-lines";
import { setServiceCaddy } from "./ingress";

/** Uncloud only treats a service with this name as the cluster's ingress. */
export const CADDY_SERVICE = "caddy";

/**
 * Caddy with Uncloud's storage module, so every machine shares certificates and ACME challenges
 * through the cluster store. Needs Uncloud 0.21+ on every machine.
 */
export const CLUSTER_STORAGE_CADDY = {
    image: "ghcr.io/unlabs-dev/caddy-uncloud:0.1.3",
    caddyfile: "{\n\tstorage uncloud\n}\n",
};

/** The template's own `x-ports`, written like `extraPorts` so they compare equal. */
const TEMPLATE_PORTS = ["80:80@host", "443:443@host", "443:443/udp@host"];

/** Where the template's Caddy pushes HTTP metrics: the current Alloy service. */
export const CADDY_METRICS_ENDPOINT = String(
    parseDocument(template).getIn([
        "services",
        CADDY_SERVICE,
        "environment",
        "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    ]),
);

/** A short-syntax volume's container path: `source:target[:mode]`. */
function mountTarget(volume: string) {
    return volume.split(":")[1] ?? volume;
}

/**
 * Carries a running Caddy's bind mounts (`host:target[:ro]`) into its resource's Compose. One at
 * a template path replaces the template's, so Caddy keeps its certificates and configuration.
 * Mounts that can't be written back are listed in a comment at the top of the draft.
 */
export function withCaddyMounts(
    spec: string,
    mounts: readonly string[],
    dropped: readonly string[],
) {
    const doc = parseDocument(spec);
    const path = ["services", CADDY_SERVICE, "volumes"];
    const volumes = doc.getIn(path);
    const current = isSeq(volumes) ? volumes.items.map(String) : [];
    const targets = new Set(mounts.map(mountTarget));

    if (mounts.length)
        doc.setIn(path, [
            ...current.filter((volume) => !targets.has(mountTarget(volume))),
            ...mounts,
        ]);

    if (dropped.length)
        doc.commentBefore = [
            " The running Caddy also mounts these, which this draft doesn't. Add them back before deploying:",
            ...dropped.map((mount) => ` - ${mount}`),
        ].join("\n");

    return doc.toString();
}

/**
 * The Caddy resource's Compose: the template with this global Caddyfile and, when given, the
 * image, extra `x-ports` and the machines it is pinned to.
 */
export function caddyCompose(
    caddyfile: string,
    image?: string,
    extraPorts: readonly string[] = [],
    machines: readonly string[] = [],
) {
    const doc = parseDocument(template);
    const service = ["services", CADDY_SERVICE];

    if (image) doc.setIn([...service, "image"], image);

    for (const port of extraPorts)
        if (!TEMPLATE_PORTS.includes(port)) doc.addIn([...service, "x-ports"], port);

    if (machines.length) doc.setIn([...service, "x-machines"], [...machines]);

    if (!caddyfile.trim()) return doc.toString();

    // Deploys interpolate Compose, so `{$CF_API_TOKEN}` must reach Caddy as written.
    return setServiceCaddy(
        doc.toString(),
        CADDY_SERVICE,
        caddyfile.replaceAll("$", () => "$$"),
    );
}

/** The running Caddy's environment beyond the template's own, as the resource's Variables. */
export function caddyVariables(env: Readonly<Record<string, string>>) {
    const environment = parseDocument(template).getIn(["services", CADDY_SERVICE, "environment"]);

    const own = new Set(
        isMap(environment)
            ? environment.items.flatMap(({ key }) => (isScalar(key) ? [String(key.value)] : []))
            : [],
    );

    return Object.entries(env)
        .filter(([key]) => !own.has(key))
        .map(([key, value]) => {
            try {
                return `${key}=${formatEnvValue(value)}\n`;
            } catch {
                // Still set on the running Caddy; only a .env file can't hold it.
                return `# ${key}: set this again, its value mixes ", ' and \` quotes.\n`;
            }
        })
        .join("");
}
