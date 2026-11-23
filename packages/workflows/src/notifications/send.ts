import type { Database } from "@clowder/db";
import { type NotificationChannelConfig, notificationChannels } from "@clowder/db/schema/index";
import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { lookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { isBlockedAddress } from "../blocked-address";
import { SendNotification } from "../jobs";
import { JobStoreLive } from "../store";
import { deploymentEvent, deploymentNotice, loadSettledDeployment, type Notice } from "./notice";
import { type Delivery, render } from "./render";

const TIMEOUT_MS = 10_000;

// Checks every address at connect time, so the request goes to the address that was checked.
const publicLookup: LookupFunction = (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error) return callback(error, "");

        const first = addresses[0];

        if (!first || addresses.some(({ address }) => isBlockedAddress(address)))
            return callback(
                new Error(`${hostname} resolves to an address Clowder won't call.`),
                "",
            );

        if (options.all) callback(null, addresses);
        else callback(null, first.address, first.family);
    });
};

/**
 * POSTs a delivery. No redirects, and the response body is never read, so a user-entered URL can't
 * be used to read internal services.
 */
export function post(delivery: Delivery, signal: AbortSignal): Promise<void> {
    const url = new URL(delivery.url);
    const host = url.hostname.replace(/^\[|\]$/gu, "");

    if (url.protocol !== "https:" && url.protocol !== "http:")
        return Promise.reject(new Error("Only http and https URLs can be notified."));

    // Literal addresses skip the lookup.
    if (isIP(host) && isBlockedAddress(host))
        return Promise.reject(new Error(`${host} is an address Clowder won't call.`));

    return new Promise((resolve, reject) => {
        const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
            url,
            {
                method: "POST",
                headers: { "user-agent": "Clowder", ...delivery.headers },
                lookup: publicLookup,
                signal,
            },
            (response) => {
                response.resume();
                const status = response.statusCode ?? 0;

                if (status >= 200 && status < 300) resolve();
                else reject(new Error(`The channel responded with HTTP ${status}.`));
            },
        );

        request.on("error", reject);
        request.end(delivery.body);
    });
}

export function sendNotice(
    config: NotificationChannelConfig,
    notice: Notice,
    signal?: AbortSignal,
) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);

    return post(render(config, notice), signal ? AbortSignal.any([signal, timeout]) : timeout);
}

export function readChannelConfig(stored: string): NotificationChannelConfig {
    // SAFETY: only the notifications router writes this column, from a validated config.
    return JSON.parse(stored) as NotificationChannelConfig;
}

/**
 * Queues one `SendNotification` per enabled channel that wants this deployment's outcome. Call it
 * after a deployment settles; it skips anything but ready or failed, and repeats are deduplicated.
 * Never throws, so a notification never fails a deployment.
 */
export async function notifyDeploymentSettled(db: Database, deploymentId: string) {
    try {
        const deployment = await loadSettledDeployment(db, deploymentId);
        const event = deployment && deploymentEvent(deployment.status);

        if (!event) return;

        const channels = await db
            .select({ id: notificationChannels.id })
            .from(notificationChannels)
            .where(
                and(
                    eq(notificationChannels.organizationId, deployment.cluster.organizationId),
                    eq(notificationChannels.enabled, true),
                    sql`${notificationChannels.events} @> ${JSON.stringify([event])}::jsonb`,
                ),
            );

        if (!channels.length) return;

        await Effect.runPromise(
            Effect.forEach(
                channels,
                ({ id }) => SendNotification.enqueue({ deploymentId, channelId: id }),
                { discard: true },
            ).pipe(Effect.provide(JobStoreLive)),
        );
    } catch (error) {
        console.error(`[notifications] Could not queue notifications for ${deploymentId}:`, error);
    }
}

/** The `SendNotification` job: deliver one deployment's outcome to one channel. */
export async function deliverNotification(
    db: Database,
    deploymentId: string,
    channelId: string,
    signal: AbortSignal,
) {
    const [channel] = await db
        .select()
        .from(notificationChannels)
        .where(eq(notificationChannels.id, channelId))
        .limit(1);

    // Removed or paused since it was queued.
    if (!channel?.enabled) return;

    const deployment = await loadSettledDeployment(db, deploymentId);
    const notice = deployment && deploymentNotice(deployment);

    if (!notice || deployment.cluster.organizationId !== channel.organizationId) return;

    await sendNotice(readChannelConfig(channel.config), notice, signal);
}
