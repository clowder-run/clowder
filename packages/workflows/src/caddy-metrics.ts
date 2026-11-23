/** Caddyfile edits for HTTP metrics: the Caddy resource's template and the cluster's Ingress card. */

/** The `metrics` subdirectives HTTP traffic needs: hostnames map metrics to services, OTLP pushes them to Alloy. */
export const REQUIRED_METRICS_SUBDIRECTIVES = ["per_host", "otlp"];

const METRICS_OPTION = ["\tmetrics {", "\t\tper_host", "\t\totlp", "\t}"];

type MetricsOption = { start: number; end: number; subdirectives: string[] };

/** A line without its quoted text and trailing comment, so neither counts as braces. */
function code(line: string) {
    return line
        .replace(/"(?:[^"\\]|\\.)*"|`[^`]*`/g, '""')
        .replace(/(^|\s)#.*$/, "")
        .trim();
}

function braceDelta(line: string) {
    const text = code(line);

    return (text.match(/\{/g)?.length ?? 0) - (text.match(/\}/g)?.length ?? 0);
}

/** The global options block's opening line, or -1. Caddy only accepts it as the first thing in the file. */
function globalBlockStart(lines: string[]) {
    const start = lines.findIndex((line) => line.trim() !== "" && !line.trim().startsWith("#"));

    return start !== -1 && lines[start]!.trim() === "{" ? start : -1;
}

/** Reads `metrics`, `metrics { per_host }` or a multi-line `metrics { … }` starting at `start`. */
function readMetricsOption(lines: string[], start: number): MetricsOption | null {
    const line = code(lines[start]!);

    if (!line.includes("{")) return { start, end: start, subdirectives: [] };

    if (line.endsWith("}")) {
        const inner = line.slice(line.indexOf("{") + 1, -1).trim();

        return { start, end: start, subdirectives: inner ? inner.split(/\s+/) : [] };
    }

    const subdirectives: string[] = [];
    let depth = 1;

    for (let index = start + 1; index < lines.length; index++) {
        const inner = code(lines[index]!);

        if (inner === "") continue;

        if (depth === 1 && inner !== "}") subdirectives.push(inner.split(/\s+/)[0]!);

        depth += braceDelta(inner);

        if (depth === 0) return { start, end: index, subdirectives };
    }

    return null;
}

function findMetricsOption(lines: string[]): MetricsOption | null {
    const start = globalBlockStart(lines);

    if (start === -1) return null;

    let depth = 0;

    for (let index = start; index < lines.length; index++) {
        const line = lines[index]!.trim();

        if (line.startsWith("#")) continue;

        if (depth === 1 && /^metrics(\s|\{|$)/.test(line)) return readMetricsOption(lines, index);

        depth += braceDelta(line);

        if (depth === 0) break;
    }

    return null;
}

/**
 * Turns on per-host HTTP metrics with OTLP export in the global options block, creating the
 * block when there is none. A `metrics` option the user already wrote is left alone; see
 * missingMetricsSubdirectives.
 */
export function withCaddyMetrics(caddyfile: string): string {
    const lines = caddyfile.trim().split("\n");
    const start = globalBlockStart(lines);

    if (start === -1) {
        const block = ["{", ...METRICS_OPTION, "}"].join("\n");

        return caddyfile.trim() ? `${block}\n\n${caddyfile.trim()}\n` : `${block}\n`;
    }

    if (findMetricsOption(lines)) return caddyfile;

    lines.splice(start + 1, 0, ...METRICS_OPTION);

    return `${lines.join("\n")}\n`;
}

/**
 * Subdirectives the global `metrics` option lacks for HTTP traffic: all of them when there is
 * no such option. Clowder never edits a running Caddyfile, so the Ingress card asks for them.
 */
export function missingMetricsSubdirectives(caddyfile: string): string[] {
    const option = findMetricsOption(caddyfile.split("\n"));

    // No `metrics` option at all records nothing either.
    if (!option) return REQUIRED_METRICS_SUBDIRECTIVES;

    return REQUIRED_METRICS_SUBDIRECTIVES.filter((name) => !option.subdirectives.includes(name));
}
