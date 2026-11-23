import type { NotificationChannelConfig } from "@clowder/db/schema/index";
import { createHmac } from "node:crypto";
import type { Notice } from "./notice";

/** One HTTP POST that delivers a notice. */
export type Delivery = { url: string; headers: Record<string, string>; body: string };

const colors = { success: 0x22c55e, failure: 0xef4444, info: 0x3b82f6 };

const emoji = { success: "✅", failure: "🚨", info: "🔔" };

export function render(config: NotificationChannelConfig, notice: Notice): Delivery {
    switch (config.type) {
        case "discord":
            return json(config.webhookUrl, JSON.stringify(discord(notice)));
        case "telegram":
            return json(
                `https://api.telegram.org/bot${config.botToken}/sendMessage`,
                JSON.stringify(telegram(notice, config.chatId)),
            );
        case "ntfy":
            return json(
                config.serverUrl.replace(/\/+$/u, ""),
                JSON.stringify(ntfy(notice, config.topic)),
                config.token ? { authorization: `Bearer ${config.token}` } : {},
            );
        case "gchat":
            return json(config.webhookUrl, JSON.stringify(gchat(notice)));
        case "webhook":
            return webhook(config.url, notice, config.secret);
    }
}

function json(url: string, body: string, headers: Delivery["headers"] = {}): Delivery {
    return { url, headers: { "content-type": "application/json", ...headers }, body };
}

export function clip(text: string, max: number) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Error text is the user's own output, so it may hold a fence or HTML of its own.
function codeBlock(text: string) {
    return `\`\`\`\n${clip(text, 1500).replaceAll("```", "`​``")}\n\`\`\``;
}

export function escapeHtml(text: string) {
    return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// Limits are Discord's (title 256, field 1024, 25 fields, 6000 per embed); clipping keeps us well under.
export function discord(notice: Notice) {
    return {
        // A commit message saying @everyone must not ping the server.
        allowed_mentions: { parse: [] },
        embeds: [
            {
                title: clip(`${emoji[notice.tone]} ${notice.title}`, 256),
                // JSON.stringify drops the undefined ones.
                url: notice.url ?? undefined,
                description: notice.detail
                    ? notice.event === "test"
                        ? notice.detail
                        : codeBlock(notice.detail)
                    : undefined,
                color: colors[notice.tone],
                fields: notice.facts.slice(0, 25).map((fact) => ({
                    name: clip(fact.label, 256),
                    value: clip(fact.value, 256),
                    inline: true,
                })),
                timestamp: notice.at.toISOString(),
                footer: { text: "Clowder" },
            },
        ],
    };
}

export function telegram(notice: Notice, chatId: string) {
    const lines = [`${emoji[notice.tone]} <b>${escapeHtml(notice.title)}</b>`];

    if (notice.detail)
        lines.push(
            "",
            notice.event === "test"
                ? escapeHtml(notice.detail)
                : `<pre>${escapeHtml(clip(notice.detail, 1500))}</pre>`,
        );

    if (notice.facts.length) lines.push("");

    for (const fact of notice.facts)
        lines.push(`<b>${escapeHtml(fact.label)}:</b> ${escapeHtml(fact.value)}`);

    if (notice.url) lines.push("", `<a href="${escapeHtml(notice.url)}">Open deployment</a>`);

    return {
        chat_id: chatId,
        text: lines.join("\n"),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
    };
}

// JSON publishing to the server root, so non-ASCII titles survive (headers would mangle them).
export function ntfy(notice: Notice, topic: string) {
    const lines = notice.facts.map((fact) => `**${fact.label}:** ${fact.value}`);

    if (notice.detail)
        lines.unshift(notice.event === "test" ? notice.detail : codeBlock(notice.detail), "");

    return {
        topic,
        title: notice.title,
        message: lines.join("\n").trim() || notice.title,
        markdown: true,
        tags: [
            { success: "white_check_mark", failure: "rotating_light", info: "bell" }[notice.tone],
        ],
        priority: notice.tone === "failure" ? 4 : 3,
        click: notice.url ?? undefined,
        actions: notice.url
            ? [{ action: "view", label: "Open deployment", url: notice.url }]
            : undefined,
    };
}

export function gchat(notice: Notice) {
    const widgets: object[] = notice.facts.map((fact) => ({
        decoratedText: { topLabel: fact.label, text: escapeHtml(fact.value) },
    }));

    if (notice.url)
        widgets.push({
            buttonList: {
                buttons: [{ text: "Open deployment", onClick: { openLink: { url: notice.url } } }],
            },
        });

    const sections: object[] = [];

    if (notice.detail)
        sections.push({
            widgets: [{ textParagraph: { text: escapeHtml(clip(notice.detail, 1500)) } }],
        });

    if (widgets.length) sections.push({ widgets });

    return {
        // Shown in notifications and clients without card support.
        text: `${emoji[notice.tone]} ${notice.title}`,
        cardsV2: [
            {
                cardId: "clowder-notification",
                card: {
                    header: {
                        title: clip(notice.title, 200),
                        subtitle: { success: "Succeeded", failure: "Failed", info: "Clowder" }[
                            notice.tone
                        ],
                    },
                    sections,
                },
            },
        ],
    };
}

/**
 * Signed like Stripe: `X-Clowder-Signature: sha256=<hex HMAC of "<timestamp>.<body>">`, so a
 * receiver can reject forged and replayed requests without the secret ever being sent.
 */
export function webhook(url: string, notice: Notice, secret?: string): Delivery {
    // Send time, not the deployment's, so a retried delivery still passes a replay window.
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const body = JSON.stringify({
        event: notice.event,
        title: notice.title,
        detail: notice.detail,
        url: notice.url,
        timestamp: notice.at.toISOString(),
        deployment: notice.deployment,
    });

    const headers: Delivery["headers"] = {
        "content-type": "application/json",
        "x-clowder-event": notice.event,
        "x-clowder-timestamp": timestamp,
    };

    if (secret)
        headers["x-clowder-signature"] =
            `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

    return { url, headers, body };
}
