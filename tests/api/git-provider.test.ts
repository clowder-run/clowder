import type { LookupAddress, LookupAllOptions } from "node:dns";
import dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import https, { Agent, type RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Reply = {
    data?: unknown;
    status?: number;
    headers?: Record<string, string>;
    chunks?: Buffer[];
    behavior?: "hang" | "error" | "aborted" | "close" | "throw";
};

const network = {
    addresses: [{ address: "93.184.216.34", family: 4 }],
    reply: (_url: URL): Reply => ({ data: {} }),
    // SAFETY: only the transport mock below appends these request records.
    calls: [] as {
        url: URL;
        options: RequestOptions;
        body?: Buffer;
        destroy: ReturnType<typeof vi.fn>;
    }[],
};

// The provider adapter resolves hosts with { all: true }; answer with the configured addresses.
function fakeLookup(hostname: string): Promise<LookupAddress>;
function fakeLookup(hostname: string, options: LookupAllOptions): Promise<LookupAddress[]>;
async function fakeLookup(_hostname: string, options?: LookupAllOptions) {
    return options?.all ? network.addresses : network.addresses[0]!;
}

// Answers each HTTPS request from network.reply without opening a socket.
const fakeRequest = (
    url: URL,
    options: RequestOptions,
    // The fake response below; production code only reads these IncomingMessage fields.
    callback: (
        res: InstanceType<typeof EventEmitter> &
            Pick<IncomingMessage, "statusCode" | "headers" | "complete"> & {
                destroy: () => void;
            },
    ) => void,
) => {
    const reply = network.reply(url);

    if (reply.behavior === "throw") throw new Error("secret-token request URL");

    const req = Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
        end: (_body?: Buffer) => {},
    });

    req.end = (body) => {
        network.calls.push({ url, options, body, destroy: req.destroy });
        void Promise.resolve().then(() => {
            if (reply.behavior === "hang") return;

            if (reply.behavior === "error") {
                req.emit("error", new Error("secret-token TLS error URL"));

                return;
            }

            const res = Object.assign(new EventEmitter(), {
                statusCode: reply.status ?? 200,
                headers: { "content-type": "application/json", ...reply.headers },
                complete: false,
                destroy: vi.fn(),
            });

            callback(res);

            if (reply.behavior === "aborted" || reply.behavior === "close") {
                res.emit(reply.behavior);

                return;
            }

            for (const chunk of reply.chunks ?? [Buffer.from(JSON.stringify(reply.data ?? {}))]) {
                res.emit("data", chunk);
            }

            res.complete = true;
            res.emit("end");
            res.emit("close");
        });
    };

    return req;
};

// Built-ins are spied through their default export; syncing republishes the spies to the
// named imports the provider adapter uses, without replacing whole modules.
const lookup = vi.spyOn(dns, "lookup");

// SAFETY: the adapter only uses the request/response surface that fakeRequest implements.
const request = vi
    .spyOn(https, "request")
    .mockImplementation(fakeRequest as typeof fakeRequest & typeof https.request);

syncBuiltinESMExports();

afterAll(() => {
    lookup.mockRestore();
    request.mockRestore();
    syncBuiltinESMExports();
});

import {
    ensureGitWebhook,
    getGitAccount,
    gitCloneUsername,
    gitProviderRequest,
    listGitRepositories,
    readGitWebhook,
    validateGitServerUrl,
} from "../../packages/api/src/git/provider";
import type { GitProvider } from "../../packages/api/src/git/provider";

const github = {
    provider: "github" as const,
    serverUrl: "https://github.com",
    token: "secret-token",
};

const forgejo = {
    provider: "forgejo" as const,
    serverUrl: "https://git.example.com/forge",
    token: "secret-token",
};

function repo(index: number, server = "https://github.com") {
    return {
        id: index + 1,
        name: `repo-${index}`,
        full_name: `team/repo-${index}`,
        owner: { login: "team", id: 1 },
        html_url: `${server}/team/repo-${index}`,
        clone_url: `${server}/team/repo-${index}.git`,
        default_branch: "release/stable",
        token: "must-not-return",
    };
}

beforeEach(() => {
    network.addresses = [{ address: "93.184.216.34", family: 4 }];
    network.reply = () => ({ data: {} });
    network.calls = [];
    lookup.mockReset().mockImplementation(fakeLookup);
    request.mockClear();
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
});

describe("Git server validation", () => {
    it("exports exactly the agreed runtime API", async () => {
        expect(Object.keys(await import("../../packages/api/src/git/provider")).sort()).toEqual([
            "ensureGitWebhook",
            "getGitAccount",
            "gitCloneUsername",
            "gitProviderFetch",
            "gitProviderRequest",
            "listGitRepositories",
            "readGitWebhook",
            "validateGitServerUrl",
        ]);
    });

    it.each([
        ["https://GitHub.COM:443/", "github", "https://github.com"],
        ["https://GIT.example.com./forge/team/", "forgejo", "https://git.example.com/forge/team"],
        ["https://git.example.com:8443/forge", "forgejo", "https://git.example.com:8443/forge"],
        ["https://git.example.com", "generic", "https://git.example.com"],
        ["ssh://git.example.com:2222/", "generic", "ssh://git.example.com:2222"],
        ["https://git.example.com/%66orge/", "forgejo", "https://git.example.com/forge"],
    ] as const)("normalizes %s as %s", (url, provider, expected) => {
        expect(validateGitServerUrl(url, provider)).toBe(expected);
        expect(validateGitServerUrl(expected, provider)).toBe(expected);
    });

    it.each([
        "http://git.example.com",
        "ssh://git.example.com",
        "git@git.example.com:forge",
        "https://user:secret@git.example.com",
        "https://user@git.example.com",
        "https://@git.example.com",
        "https://git.example.com?token=secret",
        "https://git.example.com?",
        "https://git.example.com#",
        "https://git.example.com\\@evil.example",
        "https://git.example.com/forge\n",
        "https://git.example.com:0",
        "https://bad_host.example",
        "https:///git.example.com",
        "https://git.example.com/a/../forge",
        "https://git.example.com/a/./forge",
        "https://git.example.com/a/%2e%2e/forge",
        "https://git.example.com/a/%252e%252e/forge",
        "https://git.example.com/forge%2fadmin",
        "https://git.example.com/forge//admin",
        "https://git.example.com/%00",
        "https://git.example.com/%zz",
        "https://git.example.com/%5cadmin",
    ])("rejects unsafe server URL %s", (url) => {
        expect(() => validateGitServerUrl(url, "forgejo")).toThrow();
    });

    it("does not accept public GitHub API prefixes/alternate ports or Bitbucket servers", () => {
        expect(() => validateGitServerUrl("https://github.com/api/v3", "github")).toThrow();
        expect(() => validateGitServerUrl("https://github.com:8443", "github")).toThrow();
        expect(() => validateGitServerUrl("https://bitbucket.example.com", "bitbucket")).toThrow();
        expect(validateGitServerUrl("https://bitbucket.org/", "bitbucket")).toBe(
            "https://bitbucket.org",
        );
        expect(validateGitServerUrl("https://gitlab.example.com/", "gitlab")).toBe(
            "https://gitlab.example.com",
        );
    });

    it("rejects a forge forges does not cover as a runtime provider", () => {
        // SAFETY: intentionally unsupported provider exercises runtime validation.
        expect(() => validateGitServerUrl(forgejo.serverUrl, "sourcehut" as GitProvider)).toThrow();
    });

    it("rejects long invalid paths without pathological regex backtracking", () => {
        expect(() =>
            validateGitServerUrl(`https://git.example.com/${"a".repeat(3000)}!`, "forgejo"),
        ).toThrow();
    });

    it.each([
        "localhost",
        "a.localhost",
        "metadata.google.internal",
        "127.0.0.1",
        "127.1",
        "2130706433",
        "0x7f000001",
        "169.254.169.254",
        "100.100.100.200",
        "168.63.129.16",
        "0.0.0.0",
        "224.0.0.1",
        "[::1]",
        "[::]",
        "[::ffff:127.0.0.1]",
        "[fe80::1]",
        "[fd00:ec2::254]",
        "[fd20:ce::254]",
        "[64:ff9b::7f00:1]",
        "[2002:7f00:1::]",
    ])("blocks special host %s", (host) => {
        expect(() => validateGitServerUrl(`https://${host}`, "forgejo")).toThrow();
    });
});

describe("Pinned HTTPS JSON transport", () => {
    it("pins the validated address and retains hostname TLS verification without proxy inheritance", async () => {
        vi.stubEnv("HTTPS_PROXY", "http://secret:password@127.0.0.1:1234");
        vi.stubEnv("NODE_USE_ENV_PROXY", "1");
        vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
        network.addresses.push({ address: "2606:4700:4700::1111", family: 6 });
        await expect(gitProviderRequest("https://git.example.com/api/v1/user")).resolves.toEqual(
            {},
        );
        expect(lookup).toHaveBeenCalledExactlyOnceWith("git.example.com", {
            all: true,
            verbatim: true,
        });
        const { url, options, destroy } = network.calls[0]!;
        expect(url.hostname).toBe("git.example.com");
        expect(options.rejectUnauthorized).toBe(true);
        expect(options.family).toBe(4);
        assert(options.agent instanceof Agent);
        expect(options.agent.options.proxyEnv).toEqual({});
        const pinnedLookup = options.lookup!;
        network.addresses = [{ address: "127.0.0.1", family: 4 }];
        const callback = vi.fn();
        pinnedLookup("git.example.com", {}, callback);
        expect(callback).toHaveBeenLastCalledWith(null, "93.184.216.34", 4);
        pinnedLookup("git.example.com", { all: true }, callback);
        expect(callback).toHaveBeenLastCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(destroy).toHaveBeenCalled();
    });

    it("supports OAuth form POST bodies and JSON responses", async () => {
        network.reply = () => ({ data: { access_token: "new-token", token_type: "bearer" } });
        const body = "client_id=id&client_secret=secret&code=code";
        await expect(
            gitProviderRequest("https://github.com/login/oauth/access_token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body,
            }),
        ).resolves.toEqual({ access_token: "new-token", token_type: "bearer" });
        expect(String(network.calls[0]!.body)).toBe(body);
        expect(network.calls[0]!.options.headers).toMatchObject({
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
            "content-length": String(Buffer.byteLength(body)),
            "accept-encoding": "identity",
        });
    });

    it.each(["10.1.2.3", "172.16.0.1", "192.168.1.1", "fd12::1"])(
        "allows private DNS %s",
        async (address) => {
            network.addresses = [{ address, family: address.includes(":") ? 6 : 4 }];
            await expect(gitProviderRequest("https://git.example.com/user")).resolves.toEqual({});
        },
    );

    it.each([
        "127.0.0.1",
        "169.254.169.254",
        "168.63.129.16",
        "100.100.100.200",
        "0.0.0.0",
        "192.0.0.1",
        "192.0.2.1",
        "192.88.99.1",
        "198.18.0.1",
        "198.51.100.1",
        "203.0.113.1",
        "224.0.0.1",
        "::1",
        "::ffff:10.1.2.3",
        "fe80::1",
        "fd00:ec2::254",
        "fd20:ce::254",
        "64:ff9b::1",
        "2001::1",
        "2001:db8::1",
        "2002::1",
        "3fff::1",
        "not-an-address",
    ])("rejects all DNS records if any answer is unsafe: %s", async (address) => {
        network.addresses.push({ address, family: address.includes(":") ? 6 : 4 });
        await expect(gitProviderRequest("https://git.example.com/user")).rejects.toThrow();
        expect(request).not.toHaveBeenCalled();
    });

    it("rejects empty and excessively large DNS answers", async () => {
        for (const addresses of [
            [],
            Array.from({ length: 65 }, () => ({ address: "93.184.216.34", family: 4 })),
        ]) {
            network.addresses = addresses;
            await expect(gitProviderRequest("https://git.example.com/user")).rejects.toThrow();
        }

        expect(request).not.toHaveBeenCalled();
    });

    it.each(["93.184.216.34", "[2606:4700:4700::1111]"])(
        "uses literal public addresses without DNS: %s",
        async (host) => {
            await gitProviderRequest(`https://${host}/user`);
            expect(lookup).not.toHaveBeenCalled();
            expect(request).toHaveBeenCalledTimes(1);
        },
    );

    it.each([301, 302, 303, 307, 308, 400, 401, 403, 404, 429, 500])(
        "rejects HTTP %s without leaking bodies or following redirects",
        async (status) => {
            network.reply = () => ({
                status,
                data: { error: "secret-token" },
                headers: { location: "https://evil.example/secret-token" },
            });

            const error = await gitProviderRequest(
                "https://git.example.com/user?code=secret-token",
            ).catch((error: Error) => error);

            expect(error).toMatchObject({
                code: "BAD_GATEWAY",
                message: "Git provider request failed",
            });
            assert(error instanceof Error);
            expect(error.cause).toBeUndefined();
            expect(JSON.stringify(error)).not.toContain("secret-token");
            expect(request).toHaveBeenCalledTimes(1);
        },
    );

    it.each(["error", "aborted", "close", "throw"] as const)(
        "sanitizes %s failures",
        async (behavior) => {
            network.reply = () => ({ behavior });

            const error = await gitProviderRequest(
                "https://git.example.com/user?token=secret-token",
            ).catch((error: Error) => error);

            expect(error).toMatchObject({
                message: "Git provider request failed",
            });
            assert(error instanceof Error);
            expect(error.cause).toBeUndefined();
        },
    );

    it("rejects invalid JSON, invalid UTF-8, compressed and non-JSON responses", async () => {
        const replies: Reply[] = [
            { chunks: [Buffer.from("secret-token")] },
            { chunks: [Buffer.from([0xff])] },
            { headers: { "content-type": "text/html" } },
            { headers: { "content-encoding": "gzip" } },
        ];

        for (const reply of replies) {
            network.reply = () => reply;
            await expect(gitProviderRequest("https://git.example.com/user")).rejects.toMatchObject({
                code: "BAD_GATEWAY",
            });
        }
    });

    it("caps streamed output even without Content-Length", async () => {
        network.reply = () => ({
            chunks: [Buffer.alloc(2 * 1024 * 1024), Buffer.alloc(2 * 1024 * 1024 + 1)],
        });
        await expect(gitProviderRequest("https://git.example.com/user")).rejects.toMatchObject({
            code: "PAYLOAD_TOO_LARGE",
        });
        expect(network.calls[0]!.destroy).toHaveBeenCalled();
    });

    it("bounds DNS resolution and sanitizes DNS failures", async () => {
        vi.useFakeTimers();
        lookup.mockImplementation(() => new Promise(() => {}));

        const pending = expect(
            gitProviderRequest("https://git.example.com/user"),
        ).rejects.toMatchObject({
            code: "BAD_GATEWAY",
            message: "Unable to resolve Git provider host",
        });

        await vi.advanceTimersByTimeAsync(5000);
        await pending;
        expect(request).not.toHaveBeenCalled();
        lookup.mockRejectedValueOnce(new Error("secret-token"));
        await expect(gitProviderRequest("https://git.example.com/user")).rejects.toThrow(
            "Unable to resolve Git provider host",
        );
    });

    it("has an absolute request deadline and destroys the socket", async () => {
        vi.useFakeTimers();
        network.reply = () => ({ behavior: "hang" });

        const pending = expect(
            gitProviderRequest("https://git.example.com/user"),
        ).rejects.toMatchObject({ code: "TIMEOUT" });

        await vi.advanceTimersByTimeAsync(15_000);
        await pending;
        expect(network.calls[0]!.destroy).toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects unsafe headers, oversized bodies and non-HTTPS transport before DNS", async () => {
        const unsafeHeaders: Record<string, string>[] = [
            { Host: "evil.example" },
            { Authorization: "secret\r\nHost: evil.example" },
            { "Proxy-Authorization": "secret" },
            { "Transfer-Encoding": "chunked" },
            { "Content-Length": "1" },
        ];

        for (const headers of unsafeHeaders) {
            await expect(
                gitProviderRequest("https://git.example.com/user", { headers }),
            ).rejects.toThrow();
        }

        await expect(
            gitProviderRequest("https://git.example.com/user", {
                method: "POST",
                body: "x".repeat(65537),
            }),
        ).rejects.toThrow();
        await expect(
            gitProviderRequest("https://git.example.com/user", { body: "secret" }),
        ).rejects.toThrow();
        await expect(gitProviderRequest("http://git.example.com/user")).rejects.toThrow();
        expect(lookup).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
    });
});

describe("Account discovery", () => {
    it.each([
        [github, "https://api.github.com/user"],
        [
            { ...github, serverUrl: "https://github.enterprise.example" },
            "https://github.enterprise.example/api/v3/user",
        ],
        [
            { ...github, serverUrl: "https://github.com.example/forge" },
            "https://github.com.example/forge/api/v3/user",
        ],
        [forgejo, "https://git.example.com/forge/api/v1/user"],
        [
            { provider: "gitlab" as const, serverUrl: "https://gitlab.com", token: "secret-token" },
            "https://gitlab.com/api/v4/user",
        ],
    ])("uses the correct /user endpoint for %j", async (input, endpoint) => {
        network.reply = () => ({
            data: {
                id: 123,
                login: "alice.smith",
                username: "alice.smith",
                name: "Alice",
                full_name: "Alice",
                token: "never-return",
            },
        });
        await expect(getGitAccount(input)).resolves.toEqual({
            id: "123",
            login: "alice.smith",
            name: "Alice",
        });
        expect(network.calls[0]!.url.toString()).toBe(endpoint);
        expect(JSON.stringify(network.calls[0]!.options.headers)).toContain("secret-token");
    });

    it.each([null, {}, { id: 1, login: "alice:password" }, { id: 1, login: "alice\n" }])(
        "rejects invalid account data %j",
        async (data) => {
            network.reply = () => ({ data });
            await expect(getGitAccount(github)).rejects.toMatchObject({ code: "BAD_GATEWAY" });
        },
    );

    it("preserves string IDs and drops unsafe optional display names", async () => {
        network.reply = () => ({
            data: { id: "9007199254740993", login: "alice", name: "unsafe\nname" },
        });
        await expect(getGitAccount(github)).resolves.toEqual({
            id: "9007199254740993",
            login: "alice",
            name: null,
        });
    });

    it("rejects generic discovery at runtime and in the public type", async () => {
        // @ts-expect-error Generic hosts do not provide an account API.
        await expect(getGitAccount({ ...github, provider: "generic" })).rejects.toThrow();
        // @ts-expect-error Generic hosts do not provide repository discovery.
        await expect(listGitRepositories({ ...github, provider: "generic" })).rejects.toThrow();
        await expect(getGitAccount({ ...github, token: "secret\n" })).rejects.toThrow();
        expect(request).not.toHaveBeenCalled();
    });

    it("clones with each forge's token username", () => {
        const account = { id: "1", login: "alice", name: null };
        expect(gitCloneUsername("github", account)).toBe("x-access-token");
        expect(gitCloneUsername("gitlab", account)).toBe("oauth2");
        expect(gitCloneUsername("bitbucket", account)).toBe("x-token-auth");
        expect(gitCloneUsername("forgejo", account)).toBe("alice");
    });
});

// Answers /user/repos with `total` repositories, 100 per page, linking same-origin next pages.
function pagedRepos(total: number, server = "https://github.com") {
    return (url: URL): Reply => {
        const page = Number(url.searchParams.get("page") ?? "1");
        const start = (page - 1) * 100;
        const next = new URL(url);
        next.searchParams.set("page", String(page + 1));

        return {
            data: Array.from({ length: Math.max(0, Math.min(100, total - start)) }, (_, i) =>
                repo(start + i, server),
            ),
            headers: start + 100 < total ? { link: `<${next.href}>; rel="next"` } : {},
        };
    };
}

describe("Repository discovery", () => {
    it("uses the Enterprise API while retaining the Enterprise clone origin", async () => {
        const server = "https://github.enterprise.example:8443";
        network.reply = pagedRepos(1, server);
        await expect(listGitRepositories({ ...github, serverUrl: server })).resolves.toEqual({
            repositories: [
                {
                    url: `${server}/team/repo-0.git`,
                    name: "team/repo-0",
                    defaultBranch: "release/stable",
                },
            ],
            truncated: false,
        });
        expect(network.calls[0]!.url.origin).toBe(server);
        expect(network.calls[0]!.url.pathname).toBe("/api/v3/user/repos");
    });

    it("follows same-origin pages and returns only sanitized fields", async () => {
        network.reply = pagedRepos(150);
        const result = await listGitRepositories(github);
        expect(result.truncated).toBe(false);
        expect(result.repositories).toHaveLength(150);
        expect(result.repositories[0]).toEqual({
            url: repo(0).clone_url,
            name: repo(0).full_name,
            defaultBranch: "release/stable",
        });
        expect(network.calls).toHaveLength(2);

        for (const { url } of network.calls) expect(url.origin).toBe("https://api.github.com");
    });

    it("refuses pagination links to another origin without sending the token there", async () => {
        network.reply = (url) => ({
            data: url.host === "api.github.com" ? [repo(1)] : [],
            headers: { link: '<https://evil.example/user/repos?page=2>; rel="next"' },
        });
        await expect(listGitRepositories(github)).rejects.toMatchObject({ code: "BAD_GATEWAY" });
        expect(network.calls.map(({ url }) => url.host)).toEqual(["api.github.com"]);
    });

    it("keeps Forgejo path prefixes", async () => {
        network.reply = pagedRepos(3, forgejo.serverUrl);
        const result = await listGitRepositories(forgejo);
        expect(result.repositories).toHaveLength(3);
        expect(result.truncated).toBe(false);
        expect(network.calls[0]!.url.pathname).toBe("/forge/api/v1/user/repos");
    });

    it.each([999, 1000, 1001, 1200])(
        "reports truncation correctly for %s repositories",
        async (total) => {
            network.reply = pagedRepos(total);
            const result = await listGitRepositories(github);
            expect(result.repositories).toHaveLength(Math.min(total, 1000));
            expect(result.truncated).toBe(total > 1000);
            expect(network.calls.length).toBeLessThanOrEqual(11);
        },
    );

    it.each([
        "https://evil.example/forge/team/repo.git",
        "https://git.example.com/forge-other/team/repo.git",
        "https://git.example.com/team/repo.git",
        "https://git.example.com:8443/forge/team/repo.git",
        "http://git.example.com/forge/team/repo.git",
        "ssh://git.example.com/forge/team/repo.git",
        "https://git.example.com/forge/team/repo.git?token=secret",
        "https://git.example.com/forge/team/repo.git#fragment",
        "https://git.example.com/forge/../team/repo.git",
        "https://git.example.com/forge/%2e%2e/team/repo.git",
        "https://git.example.com/forge/",
    ])("rejects clone URL outside the configured trust boundary: %s", async (clone_url) => {
        network.reply = () => ({ data: [{ ...repo(1, forgejo.serverUrl), clone_url }] });
        await expect(listGitRepositories(forgejo)).rejects.toMatchObject({ code: "BAD_GATEWAY" });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it("drops the account a forge puts in its clone URL", async () => {
        network.reply = () => ({
            data: [
                {
                    ...repo(1, forgejo.serverUrl),
                    clone_url: "https://alice@git.example.com/forge/team/repo-1.git",
                },
            ],
        });
        await expect(listGitRepositories(forgejo)).resolves.toMatchObject({
            repositories: [{ url: "https://git.example.com/forge/team/repo-1.git" }],
        });
    });

    it("does not allow api.github.com as a public GitHub clone origin", async () => {
        network.reply = () => ({ data: [repo(1, "https://api.github.com")] });
        await expect(listGitRepositories(github)).rejects.toThrow();
    });

    it("rejects a non-list repository response", async () => {
        network.reply = () => ({ data: { message: "secret" } });
        await expect(listGitRepositories(github)).rejects.toMatchObject({ code: "BAD_GATEWAY" });
    });

    it.each([
        "refs/release",
        "-option",
        "HEAD",
        "",
        null,
        123,
        "unsafe\nbranch",
        "unsafe\0branch",
        "unsafe\x7fbranch",
        "a".repeat(256),
        "é".repeat(128),
        "\ud800",
    ])(
        "retains repositories with unavailable or unsupported default branch %j",
        async (default_branch) => {
            network.reply = () => ({ data: [{ ...repo(1), default_branch }] });
            await expect(listGitRepositories(github)).resolves.toEqual({
                repositories: [
                    { url: repo(1).clone_url, name: repo(1).full_name, defaultBranch: "" },
                ],
                truncated: false,
            });
        },
    );

    it("does not return a partial success when a later page fails", async () => {
        network.reply = (url) =>
            url.searchParams.get("page") === null
                ? {
                      data: [repo(1)],
                      headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' },
                  }
                : { status: 500, data: "secret" };
        await expect(listGitRepositories(github)).rejects.toMatchObject({ code: "BAD_GATEWAY" });
    });
});

describe("Push webhooks", () => {
    const hookUrl = "https://clowder.example/git/webhook/connection";

    it("creates a GitHub push hook for the repository", async () => {
        network.reply = () => ({
            data:
                network.calls.at(-1)?.options.method === "POST"
                    ? { id: 1, config: { url: hookUrl }, events: ["push"], active: true }
                    : [],
        });
        await ensureGitWebhook(github, "https://github.com/team/repo.git", hookUrl, "secret");

        const [list, create] = network.calls;
        expect(list!.url.pathname).toBe("/repos/team/repo/hooks");
        expect(create!.url.pathname).toBe("/repos/team/repo/hooks");
        expect(create!.options.method).toBe("POST");
        expect(JSON.parse(String(create!.body))).toMatchObject({
            config: { url: hookUrl, content_type: "json", secret: "secret" },
            events: ["push"],
            active: true,
        });
    });

    it("skips a Forgejo repository that already has the hook", async () => {
        network.reply = () => ({
            data: [
                {
                    id: 1,
                    type: "forgejo",
                    config: { url: hookUrl },
                    events: ["push"],
                    active: true,
                },
            ],
        });
        await ensureGitWebhook(
            forgejo,
            "https://git.example.com/forge/team/repo.git",
            hookUrl,
            "secret",
        );

        expect(network.calls.map(({ url }) => url.pathname)).toEqual([
            "/forge/api/v1/repos/team/repo/hooks",
        ]);
    });

    it("rejects a repository on another server", async () => {
        await expect(
            ensureGitWebhook(github, "https://evil.example/team/repo.git", hookUrl, "secret"),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(network.calls).toEqual([]);
    });
});

describe("Webhook deliveries", () => {
    const body = Buffer.from(
        JSON.stringify({
            ref: "refs/heads/main",
            before: "0".repeat(40),
            after: "1".repeat(40),
            commits: [],
            repository: {
                id: 1,
                name: "repo",
                full_name: "team/repo",
                owner: { login: "team", id: 1 },
            },
            sender: { login: "alice", id: 2 },
        }),
    );

    it("accepts a signed GitHub push and reads it as a push", async () => {
        const signature = createHmac("sha256", "secret").update(body).digest("hex");

        const events = await readGitWebhook(
            "github",
            github.serverUrl,
            "secret",
            new Headers({
                "x-github-event": "push",
                "x-github-delivery": "1",
                "x-hub-signature-256": `sha256=${signature}`,
                "content-type": "application/json",
            }),
            body,
        );

        expect(events?.some((event) => event.kind === "push")).toBe(true);
        expect(request).not.toHaveBeenCalled();
    });

    // Hooks created before forges sign with X-Forgejo-Signature; live installs depend on them.
    it("accepts a signed push from an existing Forgejo hook", async () => {
        const signature = createHmac("sha256", "secret").update(body).digest("hex");

        const events = await readGitWebhook(
            "forgejo",
            forgejo.serverUrl,
            "secret",
            new Headers({ "x-forgejo-event": "push", "x-forgejo-signature": signature }),
            body,
        );

        expect(events?.some((event) => event.kind === "push")).toBe(true);
    });

    it("rejects deliveries for a forge without webhook verification", async () => {
        await expect(
            readGitWebhook("pushin", "https://pushin.eu", "secret", new Headers(), body),
        ).resolves.toBeUndefined();
    });

    it("rejects a GitHub delivery with the wrong signature", async () => {
        const signature = createHmac("sha256", "other").update(body).digest("hex");

        await expect(
            readGitWebhook(
                "github",
                github.serverUrl,
                "secret",
                new Headers({
                    "x-github-event": "push",
                    "x-hub-signature-256": `sha256=${signature}`,
                }),
                body,
            ),
        ).resolves.toBeUndefined();
    });

    it("checks GitLab's plain secret token", async () => {
        const headers = (token: string) =>
            new Headers({ "x-gitlab-event": "Push Hook", "x-gitlab-token": token });

        await expect(
            readGitWebhook("gitlab", "https://gitlab.com", "secret", headers("wrong"), body),
        ).resolves.toBeUndefined();
        await expect(
            readGitWebhook("gitlab", "https://gitlab.com", "secret", headers("secret"), body),
        ).resolves.toBeDefined();
    });
});
