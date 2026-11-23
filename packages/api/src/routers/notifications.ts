import { ORPCError } from "@orpc/server";
import { notificationChannels } from "@clowder/db/schema/index";
import { testNotice } from "@clowder/workflows/notifications/notice";
import { readChannelConfig, sendNotice } from "@clowder/workflows/notifications/send";
import { and, asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as v from "valibot";

import { organizationProcedure } from "..";

const id = v.pipe(v.string(), v.uuid());

const text = (max: number) => v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max));

const httpUrl = v.pipe(
    text(2048),
    v.url("Enter a full URL."),
    v.regex(/^https?:\/\//iu, "Use an http or https URL."),
);

// Fixed hosts are checked here; user-chosen hosts are checked when the request connects.
const config = v.variant("type", [
    v.object({
        type: v.literal("discord"),
        webhookUrl: v.pipe(
            text(2048),
            v.regex(
                /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+(?:\?[^\s#]*)?$/u,
                "Enter a Discord webhook URL.",
            ),
        ),
    }),
    v.object({
        type: v.literal("telegram"),
        botToken: v.pipe(text(256), v.regex(/^\d+:[\w-]+$/u, "Enter the token from @BotFather.")),
        chatId: v.pipe(
            text(64),
            v.regex(/^(?:-?\d+|@\w{5,})$/u, "Enter a numeric chat ID or @channelname."),
        ),
    }),
    v.object({
        type: v.literal("ntfy"),
        serverUrl: httpUrl,
        topic: v.pipe(
            text(64),
            v.regex(/^[\w-]+$/u, "Topics are letters, numbers, dashes and underscores."),
        ),
        token: v.optional(text(256)),
    }),
    v.object({
        type: v.literal("gchat"),
        webhookUrl: v.pipe(
            text(2048),
            v.regex(
                /^https:\/\/chat\.googleapis\.com\/v1\/spaces\/[^/\s]+\/messages\?\S+$/u,
                "Enter a Google Chat webhook URL.",
            ),
        ),
    }),
    v.object({ type: v.literal("webhook"), url: httpUrl, secret: v.optional(text(256)) }),
]);

const events = v.pipe(
    v.array(v.picklist(["deployment.succeeded", "deployment.failed"])),
    v.minLength(1, "Pick at least one event."),
    v.maxLength(2),
);

const channelColumns = {
    id: notificationChannels.id,
    name: notificationChannels.name,
    type: notificationChannels.type,
    events: notificationChannels.events,
    enabled: notificationChannels.enabled,
};

function notFound() {
    return new ORPCError("NOT_FOUND", { message: "Notification channel not found." });
}

export const notificationsRouter = {
    // Never returns the destination: webhook URLs and tokens are credentials.
    list: organizationProcedure.handler(({ context: { db, organizationId } }) =>
        db
            .select(channelColumns)
            .from(notificationChannels)
            .where(eq(notificationChannels.organizationId, organizationId))
            .orderBy(asc(notificationChannels.name)),
    ),
    create: organizationProcedure
        .input(v.object({ name: text(100), events, config }))
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [created] = await db
                .insert(notificationChannels)
                .values({
                    id: randomUUID(),
                    organizationId,
                    name: input.name,
                    type: input.config.type,
                    config: JSON.stringify(input.config),
                    events: [...new Set(input.events)],
                })
                .returning(channelColumns);

            return created!;
        }),
    setEnabled: organizationProcedure
        .input(v.object({ channelId: id, enabled: v.boolean() }))
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [updated] = await db
                .update(notificationChannels)
                .set({ enabled: input.enabled })
                .where(
                    and(
                        eq(notificationChannels.id, input.channelId),
                        eq(notificationChannels.organizationId, organizationId),
                    ),
                )
                .returning(channelColumns);

            if (!updated) throw notFound();

            return updated;
        }),
    remove: organizationProcedure
        .input(v.object({ channelId: id }))
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [removed] = await db
                .delete(notificationChannels)
                .where(
                    and(
                        eq(notificationChannels.id, input.channelId),
                        eq(notificationChannels.organizationId, organizationId),
                    ),
                )
                .returning({ id: notificationChannels.id });

            if (!removed) throw notFound();

            return removed;
        }),
    // Sends right away, so the dialog can show whether the destination works.
    test: organizationProcedure
        .input(v.object({ channelId: id }))
        .handler(async ({ context: { db, organizationId }, input, signal }) => {
            const [channel] = await db
                .select({ name: notificationChannels.name, config: notificationChannels.config })
                .from(notificationChannels)
                .where(
                    and(
                        eq(notificationChannels.id, input.channelId),
                        eq(notificationChannels.organizationId, organizationId),
                    ),
                )
                .limit(1);

            if (!channel) throw notFound();

            try {
                await sendNotice(
                    readChannelConfig(channel.config),
                    testNotice(channel.name),
                    signal,
                );
            } catch (error) {
                throw new ORPCError("BAD_GATEWAY", {
                    message: `Sending failed: ${error instanceof Error ? error.message : "unknown error"}`,
                });
            }
        }),
};
