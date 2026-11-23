import { call } from "@orpc/server";
import { createDb } from "@clowder/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Context } from "../../packages/api/src/context";
import { notificationsRouter } from "../../packages/api/src/routers/notifications";
import { insertUserWithOrganization } from "../users";

describe("notifications API", () => {
    const databaseName = `clowder_notify_${randomUUID().replaceAll("-", "")}`;
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let member: Context;
    let outsider: Context;

    function sessionContext(userId: string, organizationId: string) {
        // SAFETY: these procedures read only the session identity and active organization.
        return {
            db,
            session: { user: { id: userId }, session: { activeOrganizationId: organizationId } },
        } as Context;
    }

    beforeAll(async () => {
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });

        member = sessionContext(
            "notify-member",
            await insertUserWithOrganization(db, "notify-member", "Member", "m@example.test"),
        );
        outsider = sessionContext(
            "notify-outsider",
            await insertUserWithOrganization(db, "notify-outsider", "Outsider", "o@example.test"),
        );
    }, 30_000);

    afterAll(async () => {
        await db?.$client.end();
        await admin?.$client.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
        await admin?.$client.end();
    });

    const webhookUrl = "https://discord.com/api/webhooks/123/secret-token";

    it("creates, lists without the destination, pauses and removes a channel", async () => {
        const created = await call(
            notificationsRouter.create,
            {
                name: "#deploys",
                events: ["deployment.failed"],
                config: { type: "discord", webhookUrl },
            },
            { context: member },
        );

        const listed = await call(notificationsRouter.list, undefined, { context: member });

        expect(listed).toEqual([
            {
                id: created.id,
                name: "#deploys",
                type: "discord",
                events: ["deployment.failed"],
                enabled: true,
            },
        ]);
        expect(JSON.stringify(listed)).not.toContain("secret-token");

        // Matches the worker's lookup of channels that want an event.
        const { rows } = await db.$client.query(
            `SELECT id FROM notification_channels WHERE events @> $1::jsonb`,
            [JSON.stringify(["deployment.failed"])],
        );

        expect(rows).toEqual([{ id: created.id }]);

        await expect(
            call(notificationsRouter.list, undefined, { context: outsider }),
        ).resolves.toEqual([]);
        await expect(
            call(notificationsRouter.remove, { channelId: created.id }, { context: outsider }),
        ).rejects.toThrow(/not found/iu);

        const paused = await call(
            notificationsRouter.setEnabled,
            { channelId: created.id, enabled: false },
            { context: member },
        );

        expect(paused.enabled).toBe(false);
        await call(notificationsRouter.remove, { channelId: created.id }, { context: member });
        await expect(
            call(notificationsRouter.list, undefined, { context: member }),
        ).resolves.toEqual([]);
    });

    it("rejects destinations outside a service's own host", async () => {
        await expect(
            call(
                notificationsRouter.create,
                {
                    name: "Sneaky",
                    events: ["deployment.failed"],
                    config: {
                        type: "discord",
                        webhookUrl: "https://evil.example.com/api/webhooks/1/x",
                    },
                },
                { context: member },
            ),
        ).rejects.toThrow();
        await expect(
            call(
                notificationsRouter.create,
                {
                    name: "No events",
                    events: [],
                    config: { type: "webhook", url: "https://hooks.example.com" },
                },
                { context: member },
            ),
        ).rejects.toThrow();
    });
});
