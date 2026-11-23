import { isMap, isScalar, parseDocument } from "yaml";
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
