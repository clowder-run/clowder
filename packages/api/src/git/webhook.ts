import { appSecret, appUrl } from "@clowder/config/env";
import { ORPCError } from "@orpc/server";
import type { Database } from "@clowder/db";
import { gitConnections } from "@clowder/db/schema/index";
import { queueGitWatch } from "@clowder/workflows/runtime";
import { eq } from "drizzle-orm";
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import * as v from "valibot";

import { readGitWebhook } from "./provider";

// Derived from APP_SECRET, so there is nothing to store. Rotating APP_SECRET rotates every one.
// The label keeps the legacy name on purpose: Git hosts hold the derived secret, so renaming it breaks every webhook.
export function gitWebhookSecret(connectionId: string): string {
    const key = hkdfSync("sha256", appSecret(), "", `stoat/git-webhook/v1/${connectionId}`, 32);

    return Buffer.from(key).toString("hex");
}

// Relative to APP_URL, which may include a base path.
export function gitWebhookUrl(connectionId: string): string {
    const base = appUrl();

    if (!base)
        throw new ORPCError("PRECONDITION_FAILED", {
            message: "Set APP_URL to Clowder's public URL to receive Git webhooks.",
        });

    return new URL(`git/webhook/${connectionId}`, base.endsWith("/") ? base : `${base}/`).href;
}

/**
 * A push webhook from any forge. The payload is only a signed nudge: it queues a check of the
 * connection's resources, which reads Git itself, so nothing in the body is trusted.
 */
export async function receiveGitWebhook(
    db: Database,
    connectionId: string,
    headers: Headers,
    body: Buffer,
): Promise<{ status: number; message: string }> {
    if (!v.safeParse(v.pipe(v.string(), v.uuid()), connectionId).success)
        return { status: 404, message: "Unknown webhook." };

    const [connection] = await db
        .select({ provider: gitConnections.provider, serverUrl: gitConnections.serverUrl })
        .from(gitConnections)
        .where(eq(gitConnections.id, connectionId));

    if (!connection) return { status: 404, message: "Unknown webhook." };

    const secret = gitWebhookSecret(connectionId);

    const push =
        connection.provider === "generic"
            ? signedPush(secret, headers, body)
            : (
                  await readGitWebhook(
                      connection.provider,
                      connection.serverUrl,
                      secret,
                      headers,
                      body,
                  )
              )?.some((event) => event.kind === "push");

    if (push === undefined) return { status: 401, message: "Invalid webhook signature." };

    if (!push) return { status: 200, message: "Webhook is active." };

    await queueGitWatch(connectionId);

    return { status: 202, message: "Checking for changes." };
}

// A generic server's hook is set up by hand in GitHub's or Forgejo's format, which forges cannot pick for us.
function signedPush(secret: string, headers: Headers, body: Buffer): boolean | undefined {
    // GitHub prefixes its hex HMAC-SHA256 with "sha256="; Forgejo sends it bare.
    const signature =
        headers.get("x-hub-signature-256")?.replace(/^sha256=/u, "") ??
        headers.get("x-forgejo-signature") ??
        "";

    const expected = createHmac("sha256", secret).update(body).digest();
    const received = Buffer.from(signature, "hex");

    if (received.length !== expected.length || !timingSafeEqual(received, expected))
        return undefined;

    // Forgejo also sends X-GitHub-Event, so this header covers both.
    return (headers.get("x-forgejo-event") ?? headers.get("x-github-event")) === "push";
}
