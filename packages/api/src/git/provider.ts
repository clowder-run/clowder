/* eslint-disable no-control-regex -- Reject control bytes at URL and credential boundaries. */
import { lookup } from "node:dns/promises";
import { type OutgoingHttpHeaders, validateHeaderName, validateHeaderValue } from "node:http";
import { Agent, request } from "node:https";
import { isIP } from "node:net";

import { ORPCError } from "@orpc/server";
import { Predicate } from "effect";
import {
    bitbucket,
    forgejo,
    type ForgeEvent,
    type ForgeProvider,
    gitcafe,
    gitea,
    gitee,
    github,
    gitlab,
    pushin,
    repoRef,
    repoSlug,
    upstream,
} from "forges";

import { isBlockedAddress, validateGitBranch, validateGitUrl } from "./index";
import { type GitForge, type GitProvider, gitProviders } from "./providers";

export type { GitForge, GitProvider };

export type GitAccount = { id: string; login: string; name: string | null };

export type GitDiscoveredRepository = { url: string; name: string; defaultBranch: string };

export type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | { [key: string]: JsonValue };

type AccountInput = {
    provider: GitForge;
    serverUrl: string;
    token: string;
};

type RequestOptions = {
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
};

const maxResponseBytes = 4 * 1024 * 1024;

const maxRepositories = 1000;

// Requests one forge client may send; 1000 repositories take 11 pages of 100, with room for smaller pages.
const maxForgeRequests = 110;

function invalid(): never {
    throw new ORPCError("BAD_REQUEST", { message: "Invalid Git provider request" });
}

function badResponse(): never {
    throw new ORPCError("BAD_GATEWAY", { message: "Invalid Git provider response" });
}

function requestFailed(): never {
    throw new ORPCError("BAD_GATEWAY", { message: "Git provider request failed" });
}

function parseUrl(value: string, ssh = false, query = false): URL {
    if (
        !Predicate.isString(value) ||
        value.length > 4096 ||
        /[\s\x00-\x1f\x7f\\]/u.test(value) ||
        !/^\w+:\/\/[^/?#]+(?:\/|\?|#|$)/u.test(value) ||
        /^\w+:\/\/[^/?#]*@/u.test(value)
    )
        invalid();

    try {
        const url = new URL(value);

        if (
            !(url.protocol === "https:" || (ssh && url.protocol === "ssh:")) ||
            url.username ||
            url.password ||
            value.includes("#") ||
            (!query && value.includes("?"))
        )
            invalid();
        // Inspect the raw path before WHATWG URL parsing can erase dot segments.
        const rawPath = /^\w+:\/\/[^/?#]+([^?#]*)/u.exec(value)![1] || "/";
        const path = decodeURIComponent(rawPath);

        if (
            !/^\/(?:[a-zA-Z0-9_.~@+-]+\/)*[a-zA-Z0-9_.~@+-]*$/u.test(path) ||
            /%2f/iu.test(rawPath) ||
            path.split("/").some((part) => part === "." || part === "..")
        )
            invalid();
        // Reuse the existing literal-host policy without changing git.ts's exports.
        const checked = new URL(validateGitUrl(`${url.protocol}//${url.host}/server`));
        url.hostname = checked.hostname;
        url.pathname = path;

        return url;
    } catch {
        return invalid();
    }
}

export function validateGitServerUrl(value: string, provider: GitProvider): string {
    if (!gitProviders.includes(provider)) invalid();
    const url = parseUrl(value, provider === "generic");
    const server = url.toString().replace(/\/$/u, "");

    if (
        provider === "github" &&
        url.hostname === "github.com" &&
        (url.port || url.pathname !== "/")
    )
        invalid();

    // forges only speaks to Bitbucket Cloud.
    if (provider === "bitbucket" && server !== "https://bitbucket.org") invalid();

    return server;
}

async function pinnedAddress(host: string): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        const addresses = isIP(host)
            ? [{ address: host }]
            : await Promise.race([
                  lookup(host, { all: true, verbatim: true }),
                  new Promise<never>((_, reject) => {
                      timer = setTimeout(() => reject(new Error()), 5000);
                  }),
              ]);

        if (!addresses.length || addresses.length > 64) invalid();

        if (addresses.some(({ address }) => isBlockedAddress(address))) invalid();

        return addresses[0]!.address;
    } catch (error) {
        if (error instanceof ORPCError) throw error;
        throw new ORPCError("BAD_GATEWAY", { message: "Unable to resolve Git provider host" });
    } finally {
        clearTimeout(timer);
    }
}

function requestHeaders(input: RequestInit["headers"]): OutgoingHttpHeaders {
    const headers: OutgoingHttpHeaders = { accept: "application/json", "user-agent": "Clowder" };

    try {
        let size = 0;

        for (const [name, value] of new Headers(input)) {
            validateHeaderName(name);
            validateHeaderValue(name, value);

            if (
                /^(?:host|connection|proxy-.*|content-length|transfer-encoding|upgrade|te|trailer)$/u.test(
                    name,
                )
            )
                invalid();
            size += Buffer.byteLength(name) + Buffer.byteLength(value);

            if (size > 32 * 1024) invalid();
            headers[name] = value;
        }
    } catch {
        invalid();
    }

    headers["accept-encoding"] = "identity";

    return headers;
}

/**
 * The `fetch` every forges provider uses: HTTPS only, DNS pinned to a public address, no proxies,
 * no redirects followed, bounded in time and size. Non-2xx responses pass through so forges can
 * map them to its own errors.
 */
export async function gitProviderFetch(input: string, init: RequestInit = {}): Promise<Response> {
    init.signal?.throwIfAborted();
    let parsed: URL;

    try {
        parsed = new URL(input);
        // Reuse the literal-host policy; the path is the forge's own API path.
        parsed.hostname = new URL(validateGitUrl(`https://${parsed.host}/server`)).hostname;
    } catch {
        return invalid();
    }

    const method = (init.method ?? "GET").toUpperCase();

    if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        !["GET", "HEAD", "POST"].includes(method)
    )
        invalid();

    const body =
        init.body === undefined || init.body === null
            ? undefined
            : Buffer.from(await new Response(init.body).arrayBuffer());

    if (body && (method !== "POST" || body.length > 64 * 1024)) invalid();
    const headers = requestHeaders(init.headers);

    if (body) headers["content-length"] = String(body.length);
    const host = parsed.hostname.replace(/^\[|\]$/gu, "");
    const address = await pinnedAddress(host);
    // A fresh explicit agent avoids global-agent proxy settings and reused sockets.
    const agent = new Agent({ keepAlive: false, maxSockets: 1, proxyEnv: {} });
    let req: ReturnType<typeof request> | undefined;
    let response: import("node:http").IncomingMessage | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await new Promise<Response>((resolve, reject) => {
            let settled = false;

            const fail = (
                code: "BAD_GATEWAY" | "TIMEOUT" | "PAYLOAD_TOO_LARGE" = "BAD_GATEWAY",
            ) => {
                if (settled) return;
                settled = true;
                reject(new ORPCError(code, { message: "Git provider request failed" }));
                response?.destroy();
                req?.destroy();
            };

            timer = setTimeout(() => fail("TIMEOUT"), 15_000);

            // Aborted during the DNS lookup: fail without sending the request.
            if (init.signal?.aborted) {
                fail("TIMEOUT");

                return;
            }

            init.signal?.addEventListener("abort", () => fail("TIMEOUT"), { once: true });
            req = request(
                parsed,
                {
                    method,
                    headers,
                    agent,
                    rejectUnauthorized: true,
                    maxHeaderSize: 16 * 1024,
                    family: isIP(address),
                    lookup: (_hostname, lookupOptions, callback) => {
                        const family = isIP(address);

                        if (lookupOptions.all) callback(null, [{ address, family }]);
                        else callback(null, address, family);
                    },
                },
                (res) => {
                    response = res;
                    res.on("error", () => fail());
                    res.on("aborted", () => fail());
                    res.on("close", () => {
                        if (!res.complete) fail();
                    });

                    if (settled) {
                        res.destroy();

                        return;
                    }

                    const status = res.statusCode ?? 0;

                    if (
                        status < 200 ||
                        status > 599 ||
                        (res.headers["content-encoding"] &&
                            res.headers["content-encoding"] !== "identity")
                    ) {
                        fail();

                        return;
                    }

                    const chunks: Buffer[] = [];
                    let bytes = 0;
                    res.on("data", (chunk: Buffer) => {
                        if (settled) return;
                        bytes += chunk.length;

                        if (bytes > maxResponseBytes) fail("PAYLOAD_TOO_LARGE");
                        else chunks.push(chunk);
                    });
                    res.on("end", () => {
                        if (settled) return;
                        settled = true;
                        const responseHeaders = new Headers();

                        for (const [name, value] of Object.entries(res.headers)) {
                            for (const item of [value ?? []].flat())
                                responseHeaders.append(name, item);
                        }

                        const empty = method === "HEAD" || [204, 205, 304].includes(status);

                        resolve(
                            new Response(empty ? null : Buffer.concat(chunks), {
                                status,
                                headers: responseHeaders,
                            }),
                        );
                    });
                },
            );
            req.on("error", () => fail());
            req.end(body);
        });
    } catch (error) {
        if (error instanceof ORPCError) throw error;

        return requestFailed();
    } finally {
        clearTimeout(timer);
        response?.destroy();
        req?.destroy();
        agent.destroy();
    }
}

/** JSON-only transport for OAuth exchanges. Never follows redirects. */
export async function gitProviderRequest(
    url: string,
    options: RequestOptions = {},
): Promise<JsonValue> {
    parseUrl(url, false, true);
    const method = options.method ?? "GET";

    if (
        !["GET", "POST"].includes(method) ||
        (options.body !== undefined && (method !== "POST" || !Predicate.isString(options.body)))
    )
        invalid();

    const response = await gitProviderFetch(url, {
        method,
        headers: options.headers,
        body: options.body,
    });

    if (
        !response.ok ||
        !/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/iu.test(
            response.headers.get("content-type") ?? "",
        )
    )
        requestFailed();

    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(await response.arrayBuffer());

        const data: JsonValue = JSON.parse(text);

        return data;
    } catch {
        return requestFailed();
    }
}

type ForgeOptions = {
    baseUrl: string;
    auth: { type: "token"; token: string } | { type: "anonymous" };
    fetch: typeof gitProviderFetch;
    userAgent: string;
    timeout: number;
    webhookSecret?: string;
};

// `baseUrl` is the instance root for every forge but GitHub (its API root) and Bitbucket (Cloud only).
const forgeFactories: Record<GitForge, (options: ForgeOptions) => ForgeProvider> = {
    forgejo,
    github: (options) =>
        github({
            ...options,
            baseUrl:
                options.baseUrl === "https://github.com"
                    ? "https://api.github.com"
                    : `${options.baseUrl}/api/v3`,
        }),
    gitlab,
    gitea,
    bitbucket: ({ baseUrl: _cloud, ...options }) => bitbucket(options),
    gitee,
    gitcafe,
    pushin,
    upstream,
};

function forge(input: AccountInput, webhookSecret?: string): ForgeProvider {
    if (
        !Object.hasOwn(forgeFactories, input.provider) ||
        (webhookSecret === undefined &&
            (!Predicate.isString(input.token) || !/^[\x21-\x7e]{1,16384}$/u.test(input.token)))
    )
        invalid();
    let requests = 0;

    return forgeFactories[input.provider]({
        baseUrl: validateGitServerUrl(input.serverUrl, input.provider),
        auth:
            webhookSecret === undefined
                ? { type: "token", token: input.token }
                : { type: "anonymous" },
        // forges follows next-page links even from empty pages, so a hostile server could page forever.
        fetch: (url, init) =>
            ++requests > maxForgeRequests ? badResponse() : gitProviderFetch(url, init),
        userAgent: "Clowder",
        timeout: 15_000,
        webhookSecret,
    });
}

/** Calls the forge, keeping our transport errors and reporting anything else as a bad response. */
async function forgeCall<T>(call: () => Promise<T>): Promise<T> {
    try {
        return await call();
    } catch (error) {
        if (error instanceof ORPCError) throw error;

        // forges wraps what our fetch throws in its own network error.
        if (error instanceof Error && error.cause instanceof ORPCError) throw error.cause;

        return requestFailed();
    }
}

function safeText(value: string | undefined, limit: number): value is string {
    return (
        Predicate.isString(value) &&
        value.length > 0 &&
        value.length <= limit &&
        value.isWellFormed() &&
        !/[\x00-\x1f\x7f]/u.test(value)
    );
}

export async function getGitAccount(input: AccountInput): Promise<GitAccount> {
    const user = await forgeCall(() => forge(input).users.me());

    // The login can become the HTTPS username, which git splits on ":".
    if (!safeText(user.id, 256) || !safeText(user.login, 255) || user.login.includes(":"))
        badResponse();

    return { id: user.id, login: user.login, name: safeText(user.name, 256) ? user.name : null };
}

/** The HTTPS username to clone with an account token; GitHub, GitLab and Bitbucket expect a fixed one. */
export function gitCloneUsername(provider: GitForge, account: GitAccount): string {
    if (provider === "github") return "x-access-token";

    if (provider === "gitlab") return "oauth2";

    if (provider === "bitbucket") return "x-token-auth";

    return account.login;
}

function repositoryName(name: string): boolean {
    return safeText(name, 512) && /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/u.test(name);
}

export async function listGitRepositories(input: AccountInput): Promise<{
    repositories: GitDiscoveredRepository[];
    truncated: boolean;
}> {
    const provider = forge(input);
    const base = new URL(validateGitServerUrl(input.serverUrl, input.provider));
    const prefix = `${base.pathname.replace(/\/$/u, "")}/`;
    const repositories: GitDiscoveredRepository[] = [];
    const seen = new Set<string>();
    let count = 0;

    return forgeCall(async () => {
        for await (const repo of provider.repos.list({ perPage: 100 })) {
            if (count++ >= maxRepositories) return { repositories, truncated: true };
            const https = repo.cloneUrls?.https;

            // Some forges list repositories without an HTTPS remote; those cannot be cloned with a token.
            if (!https) continue;
            let clone: URL;

            try {
                const remote = new URL(https);
                // Bitbucket puts the account in its clone URL; credentials come from the connection instead.
                remote.username = "";
                clone = parseUrl(remote.href);
            } catch {
                return badResponse();
            }

            const name = repoSlug(repo.ref);

            // Credentials are scoped to the server, so a forged clone URL elsewhere is a bad response.
            if (
                clone.search ||
                clone.origin !== base.origin ||
                !clone.pathname.startsWith(prefix) ||
                clone.pathname === prefix ||
                !repositoryName(name)
            )
                badResponse();
            const normalized = validateGitUrl(clone.toString());
            let defaultBranch = "";

            try {
                if (repo.defaultBranch) defaultBranch = validateGitBranch(repo.defaultBranch);
            } catch {
                // Unusable default-branch metadata must not hide accessible repositories.
            }

            if (!seen.has(normalized)) {
                seen.add(normalized);
                repositories.push({ url: normalized, name, defaultBranch });
            }
        }

        return { repositories, truncated: false };
    });
}

/** Adds a push webhook to the repository unless one already points at `hookUrl`. */
export async function ensureGitWebhook(
    input: AccountInput,
    repositoryUrl: string,
    hookUrl: string,
    secret: string,
): Promise<void> {
    const provider = forge(input);

    if (!provider.can("webhooks.create")) return;
    const server = new URL(validateGitServerUrl(input.serverUrl, input.provider));
    const prefix = `${server.pathname.replace(/\/$/u, "")}/`;
    const repository = new URL(validateGitUrl(repositoryUrl));
    const name = repository.pathname.slice(prefix.length).replace(/\.git$/u, "");

    if (
        repository.origin !== server.origin ||
        !repository.pathname.startsWith(prefix) ||
        !repositoryName(name)
    )
        invalid();
    const ref = repoRef(provider, name);

    await forgeCall(async () => {
        // shortcut: an existing hook is not checked, so a rotated APP_SECRET leaves it failing;
        // update it if secret rotation becomes common.
        for await (const hook of provider.webhooks.list(ref)) if (hook.url === hookUrl) return;

        await provider.webhooks.create(ref, {
            url: hookUrl,
            events: ["push"],
            secret,
            contentType: "json",
            active: true,
        });
    });
}

/**
 * Verifies a webhook delivery against `secret` and returns its events, or `undefined` when the
 * signature or token does not match.
 */
export async function readGitWebhook(
    provider: GitForge,
    serverUrl: string,
    secret: string,
    headers: Headers,
    body: Uint8Array,
): Promise<ForgeEvent[] | undefined> {
    const forgeProvider = forge({ provider, serverUrl, token: "" }, secret);

    try {
        // Forges without webhook verification throw rather than answer false.
        if (!(await forgeProvider.webhooks.verify({ headers, body }))) return undefined;
    } catch {
        return undefined;
    }

    try {
        return await forgeProvider.webhooks.ingest({ headers, body });
    } catch {
        // A verified delivery forges cannot translate, such as a ping, carries no push.
        return [];
    }
}
