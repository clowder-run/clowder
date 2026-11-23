import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
    deploymentNotice,
    formatDuration,
    type SettledDeployment,
} from "../../packages/workflows/src/notifications/notice";
import { discord, render, telegram } from "../../packages/workflows/src/notifications/render";
import { post } from "../../packages/workflows/src/notifications/send";

const failed: SettledDeployment = {
    id: "0b6c3f3e-0000-4000-8000-000000000001",
    name: "DeployResource",
    status: "failed",
    error: "Image <app> not found\n```\n@everyone",
    metadata: {
        source: "github",
        trigger: "webhook",
        commit: { sha: "abcdef1234567890", message: "Fix @everyone <b>bug</b>\n\nlong body" },
    },
    createdAt: new Date("2026-11-23T10:00:00Z"),
    finishedAt: new Date("2026-11-23T10:01:05Z"),
    cluster: { id: "c1", name: "prod", organizationId: "org" },
    resource: { id: "r1", name: "api" },
    project: { id: "p1", name: "Shop" },
};

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("deployment notices", () => {
    it("describes a failed resource deployment with its facts and link", () => {
        vi.stubEnv("APP_URL", "https://clowder.example.com");
        const notice = deploymentNotice(failed)!;

        expect(notice.event).toBe("deployment.failed");
        expect(notice.title).toBe("api failed to deploy");
        expect(notice.url).toBe(`https://clowder.example.com/deployments/${failed.id}`);
        expect(notice.facts).toEqual([
            { label: "Project", value: "Shop" },
            { label: "Cluster", value: "prod" },
            { label: "Trigger", value: "Git push" },
            { label: "Commit", value: "abcdef1 Fix @everyone <b>bug</b>" },
            { label: "Duration", value: "1m 05s" },
        ]);
    });

    it("leaves links out without APP_URL and skips unsettled deployments", () => {
        vi.stubEnv("APP_URL", "");
        expect(deploymentNotice({ ...failed, status: "ready" })!.url).toBeNull();
        expect(deploymentNotice({ ...failed, status: "cancelled" })).toBeNull();
        expect(deploymentNotice({ ...failed, status: "running" })).toBeNull();
    });

    it("formats durations", () => {
        expect(formatDuration(4_200)).toBe("4s");
        expect(formatDuration(3_725_000)).toBe("1h 02m");
    });
});

describe("channel messages", () => {
    const notice = deploymentNotice(failed)!;

    it("keeps Discord from pinging and from breaking out of the error block", () => {
        const payload = discord(notice);
        const embed = payload.embeds[0]!;

        expect(payload.allowed_mentions).toEqual({ parse: [] });
        expect(embed.color).toBe(0xef4444);
        expect(embed.description).toMatch(/^```\n/u);
        expect(embed.description!.slice(4, -4)).not.toContain("```");
        expect(embed.fields.every((field) => field.value.length <= 256)).toBe(true);
    });

    it("clips long errors for Discord", () => {
        const embed = discord({ ...notice, detail: "x".repeat(10_000) }).embeds[0]!;

        expect(embed.description!.length).toBeLessThan(1600);
    });

    it("escapes user text in Telegram's HTML", () => {
        const { text } = telegram(notice, "-100");

        expect(text).toContain("Image &lt;app&gt; not found");
        expect(text).toContain("Fix @everyone &lt;b&gt;bug&lt;/b&gt;");
        expect(text).not.toContain("<app>");
    });

    it("signs webhooks over the timestamp and body", () => {
        const delivery = render(
            { type: "webhook", url: "https://hooks.example.com", secret: "s3cret" },
            notice,
        );

        const timestamp = delivery.headers["x-clowder-timestamp"]!;

        const expected = createHmac("sha256", "s3cret")
            .update(`${timestamp}.${delivery.body}`)
            .digest("hex");

        expect(delivery.headers["x-clowder-signature"]).toBe(`sha256=${expected}`);
        expect(JSON.parse(delivery.body).deployment.status).toBe("failed");
        expect(
            render({ type: "webhook", url: "https://hooks.example.com" }, notice).headers,
        ).not.toHaveProperty("x-clowder-signature");
    });

    it("publishes ntfy as JSON to the server root with the token as a bearer", () => {
        const delivery = render(
            {
                type: "ntfy",
                serverUrl: "https://ntfy.example.com/",
                topic: "deploys",
                token: "tk_1",
            },
            notice,
        );

        expect(delivery.url).toBe("https://ntfy.example.com");
        expect(delivery.headers.authorization).toBe("Bearer tk_1");
        expect(JSON.parse(delivery.body)).toMatchObject({ topic: "deploys", priority: 4 });
    });
});

describe("delivery", () => {
    const delivery = { headers: {}, body: "{}" };

    it("refuses loopback and metadata addresses, literal or resolved", async () => {
        const signal = AbortSignal.timeout(5_000);

        await expect(post({ ...delivery, url: "http://127.0.0.1:9/" }, signal)).rejects.toThrow(
            /won't call/u,
        );
        await expect(post({ ...delivery, url: "http://[::1]:9/" }, signal)).rejects.toThrow(
            /won't call/u,
        );
        await expect(
            post({ ...delivery, url: "http://169.254.169.254/latest" }, signal),
        ).rejects.toThrow(/won't call/u);
        await expect(post({ ...delivery, url: "http://localhost:9/" }, signal)).rejects.toThrow(
            /won't call/u,
        );
    });

    it("refuses other protocols", async () => {
        await expect(
            post({ ...delivery, url: "file:///etc/passwd" }, AbortSignal.timeout(1_000)),
        ).rejects.toThrow(/http and https/u);
    });
});
