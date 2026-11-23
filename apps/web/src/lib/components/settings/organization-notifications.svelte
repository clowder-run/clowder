<script lang="ts">
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
    import {
        Button,
        buttonVariants,
    } from "$lib/components/ui/button";
    import { Card, CardPanel } from "$lib/components/ui/card";
    import { Checkbox } from "$lib/components/ui/checkbox";
    import {
        Dialog,
        DialogContent,
        DialogDescription,
        DialogFooter,
        DialogHeader,
        DialogPanel,
        DialogTitle,
    } from "$lib/components/ui/dialog";
    import {
        Empty,
        EmptyHeader,
        EmptyMedia,
        EmptyTitle,
    } from "$lib/components/ui/empty";
    import {
        Field,
        FieldDescription,
    } from "$lib/components/ui/field";
    import {
        Fieldset,
        FieldsetLegend,
    } from "$lib/components/ui/fieldset";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import {
        Menu,
        MenuItem,
        MenuPopup,
        MenuTrigger,
    } from "$lib/components/ui/menu";
    import {
        Select,
        SelectContent,
        SelectItem,
        SelectTrigger,
        SelectValue,
    } from "$lib/components/ui/select";
    import { Separator } from "$lib/components/ui/separator";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { toastManager } from "$lib/components/ui/toast";
    import { orpc, queryClient } from "$lib/api/orpc";
    import type {
        NotificationChannelConfig,
        NotificationChannelType,
        NotificationEvent,
    } from "@clowder/db/schema/index";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";
    import BellRinging from "phosphor-svelte/lib/BellRingingIcon";
    import DiscordLogo from "phosphor-svelte/lib/DiscordLogoIcon";
    import Ellipsis from "phosphor-svelte/lib/DotsThreeIcon";
    import GoogleLogo from "phosphor-svelte/lib/GoogleLogoIcon";
    import PaperPlaneTilt from "phosphor-svelte/lib/PaperPlaneTiltIcon";
    import Pause from "phosphor-svelte/lib/PauseIcon";
    import Play from "phosphor-svelte/lib/PlayIcon";
    import Plus from "phosphor-svelte/lib/PlusIcon";
    import TelegramLogo from "phosphor-svelte/lib/TelegramLogoIcon";
    import Trash2 from "phosphor-svelte/lib/TrashIcon";
    import WebhooksLogo from "phosphor-svelte/lib/WebhooksLogoIcon";
    import type { Component } from "svelte";
    import ConfirmDialog from "./confirm-dialog.svelte";
    import SettingsSection from "./settings-section.svelte";
    import { parseAsBoolean, useQueryState } from "nuqs-svelte";

    type ChannelField = {
        key: string;
        label: string;
        placeholder: string;
        optional?: boolean;
        secret?: boolean;
        hint?: string;
    };

    const channelTypes: Record<
        NotificationChannelType,
        { label: string; icon: Component; fields: ChannelField[] }
    > = {
        discord: {
            label: "Discord",
            icon: DiscordLogo,
            fields: [
                {
                    key: "webhookUrl",
                    label: "Webhook URL",
                    placeholder: "https://discord.com/api/webhooks/…",
                    secret: true,
                    hint: "Channel settings → Integrations → Webhooks.",
                },
            ],
        },
        telegram: {
            label: "Telegram",
            icon: TelegramLogo,
            fields: [
                {
                    key: "botToken",
                    label: "Bot token",
                    placeholder: "123456789:AA…",
                    secret: true,
                    hint: "From @BotFather. Add the bot to the chat first.",
                },
                {
                    key: "chatId",
                    label: "Chat ID",
                    placeholder: "-1001234567890 or @channel",
                },
            ],
        },
        ntfy: {
            label: "ntfy",
            icon: BellRinging,
            fields: [
                {
                    key: "serverUrl",
                    label: "Server URL",
                    placeholder: "https://ntfy.sh",
                },
                {
                    key: "topic",
                    label: "Topic",
                    placeholder: "clowder-deployments",
                },
                {
                    key: "token",
                    label: "Access token",
                    placeholder: "tk_…",
                    optional: true,
                    secret: true,
                },
            ],
        },
        gchat: {
            label: "Google Chat",
            icon: GoogleLogo,
            fields: [
                {
                    key: "webhookUrl",
                    label: "Webhook URL",
                    placeholder:
                        "https://chat.googleapis.com/v1/spaces/…",
                    secret: true,
                    hint: "Space → Apps & integrations → Webhooks.",
                },
            ],
        },
        webhook: {
            label: "Webhook",
            icon: WebhooksLogo,
            fields: [
                {
                    key: "url",
                    label: "URL",
                    placeholder: "https://example.com/hooks/clowder",
                },
                {
                    key: "secret",
                    label: "Signing secret",
                    placeholder: "A long random string",
                    optional: true,
                    secret: true,
                    hint: "Adds X-Clowder-Signature: sha256= HMAC of “timestamp.body”, with the timestamp in X-Clowder-Timestamp.",
                },
            ],
        },
    };

    const typeItems = Object.entries(channelTypes).map(
        ([value, { label }]) => ({ value, label }),
    );

    const eventOptions: {
        value: NotificationEvent;
        label: string;
    }[] = [
        { value: "deployment.failed", label: "Deployment failed" },
        {
            value: "deployment.succeeded",
            label: "Deployment succeeded",
        },
    ];

    function eventSummary(events: NotificationEvent[]) {
        if (events.length === 2) return "Failures and successes";

        return events[0] === "deployment.failed"
            ? "Failures only"
            : "Successes only";
    }

    const channelsQuery = createQuery(() =>
        orpc.notifications.list.queryOptions(),
    );

    async function refresh() {
        await queryClient.invalidateQueries({
            queryKey: orpc.notifications.list.key(),
        });
    }

    let createOpen = useQueryState(
        "createOpen",
        parseAsBoolean.withDefault(false),
    ); //$state(false);

    let type = $state<NotificationChannelType>("discord");

    let name = $state("");

    let values = $state<Record<string, string>>({});

    let events = $state<NotificationEvent[]>([
        "deployment.failed",
        "deployment.succeeded",
    ]);

    const fields = $derived(channelTypes[type].fields);

    const valid = $derived(
        name.trim() !== "" &&
            events.length > 0 &&
            fields.every(
                (field) =>
                    field.optional || values[field.key]?.trim(),
            ),
    );

    const createState = createMutation(() =>
        orpc.notifications.create.mutationOptions({
            onSuccess: async (channel) => {
                createOpen.set(false);
                await refresh();
                testState.mutate({ channelId: channel.id });
            },
        }),
    );

    function openCreate() {
        type = "discord";
        name = "";
        values = {};
        events = ["deployment.failed", "deployment.succeeded"];
        createState.reset();
        createOpen.set(true);
    }

    function selectType(next: string | null) {
        if (!next || !(next in channelTypes)) return;
        // SAFETY: checked against the channelTypes keys above.
        type = next as NotificationChannelType;
        values =
            type === "ntfy" ? { serverUrl: "https://ntfy.sh" } : {};
    }

    function toggleEvent(event: NotificationEvent, checked: boolean) {
        events = checked
            ? [...events, event]
            : events.filter((item) => item !== event);
    }

    function create(submit: SubmitEvent) {
        submit.preventDefault();

        if (!valid || createState.isPending) return;

        const entries = fields.flatMap((field) => {
            const value = values[field.key]?.trim();

            return value ? [[field.key, value]] : [];
        });

        createState.mutate({
            name: name.trim(),
            events,
            // SAFETY: the fields come from this type's entry; the server validates the shape.
            config: {
                type,
                ...Object.fromEntries(entries),
            } as NotificationChannelConfig,
        });
    }

    const testState = createMutation(() =>
        orpc.notifications.test.mutationOptions({
            onSuccess: () =>
                toastManager.add({
                    type: "success",
                    title: "Test notification sent",
                }),
            onError: (error) =>
                toastManager.add({
                    type: "error",
                    title: "Test notification failed",
                    description: error.message,
                }),
        }),
    );

    const enabledState = createMutation(() =>
        orpc.notifications.setEnabled.mutationOptions({
            onSuccess: refresh,
        }),
    );

    let removeId = $state("");

    let removeOpen = $state(false);

    const removeState = createMutation(() =>
        orpc.notifications.remove.mutationOptions({
            onSuccess: async () => {
                removeOpen = false;
                await refresh();
            },
        }),
    );

    function askRemove(channelId: string) {
        removeId = channelId;
        removeState.reset();
        removeOpen = true;
    }
</script>

<SettingsSection
    title="Notifications"
    description="Where Clowder reports finished deployments, cluster setups and sandboxes."
    count={channelsQuery.data
        ? `${channelsQuery.data.length} ${channelsQuery.data.length === 1 ? "channel" : "channels"}`
        : undefined}
>
    {#snippet actions()}
        <Button onclick={openCreate}>
            <Plus class="size-4" aria-hidden="true" />
            Add channel
        </Button>
    {/snippet}
    {#if channelsQuery.isError}
        <Alert variant="error">
            <AlertDescription>
                {channelsQuery.error.message}
            </AlertDescription>
        </Alert>
    {:else if channelsQuery.isSuccess && channelsQuery.data.length === 0}
        <Empty class="rounded-xl border border-dashed border-border">
            <EmptyHeader>
                <EmptyMedia variant="icon">
                    <BellRinging aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No notification channels yet</EmptyTitle>
            </EmptyHeader>
        </Empty>
    {:else}
        <Card>
            <CardPanel class="p-0">
                {#if channelsQuery.isPending}
                    <Skeleton
                        loading
                        count={2}
                        gap={1}
                        label="Loading channels"
                    >
                        <div class="flex items-center gap-3 p-3">
                            <span
                                class="size-10 shrink-0 rounded-full"
                            ></span>
                            <span class="text-sm">
                                Deployments channel
                            </span>
                        </div>
                    </Skeleton>
                {:else}
                    <ul>
                        {#each channelsQuery.data as channel, index (channel.id)}
                            {@const Icon =
                                channelTypes[channel.type].icon}
                            <li class="min-w-0">
                                {#if index > 0}<Separator />{/if}
                                <div
                                    class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 p-3"
                                    class:opacity-64={!channel.enabled}
                                >
                                    <span
                                        class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
                                    >
                                        <Icon
                                            class="size-5"
                                            aria-hidden="true"
                                        />
                                    </span>
                                    <div class="min-w-0">
                                        <h3
                                            class="flex min-w-0 items-center gap-2 text-sm font-medium leading-5"
                                        >
                                            <span class="truncate">
                                                {channel.name}
                                            </span>
                                            {#if !channel.enabled}
                                                <Badge
                                                    variant="secondary"
                                                >
                                                    Paused
                                                </Badge>
                                            {/if}
                                        </h3>
                                        <p
                                            class="mt-1 text-xs leading-5 text-muted-foreground"
                                        >
                                            {channelTypes[
                                                channel.type
                                            ].label} · {eventSummary(
                                                channel.events,
                                            )}
                                        </p>
                                    </div>
                                    <Menu>
                                        <MenuTrigger
                                            class={buttonVariants({
                                                variant: "ghost",
                                                size: "icon-sm",
                                            })}
                                            aria-label={`Actions for ${channel.name}`}
                                        >
                                            <Ellipsis
                                                class="size-4"
                                                aria-hidden="true"
                                            />
                                        </MenuTrigger>
                                        <MenuPopup align="end">
                                            <MenuItem
                                                disabled={testState.isPending}
                                                onclick={() =>
                                                    testState.mutate({
                                                        channelId:
                                                            channel.id,
                                                    })}
                                            >
                                                <PaperPlaneTilt
                                                    aria-hidden="true"
                                                />
                                                Send test
                                            </MenuItem>
                                            <MenuItem
                                                onclick={() =>
                                                    enabledState.mutate(
                                                        {
                                                            channelId:
                                                                channel.id,
                                                            enabled:
                                                                !channel.enabled,
                                                        },
                                                    )}
                                            >
                                                {#if channel.enabled}
                                                    <Pause
                                                        aria-hidden="true"
                                                    />
                                                    Pause
                                                {:else}
                                                    <Play
                                                        aria-hidden="true"
                                                    />
                                                    Resume
                                                {/if}
                                            </MenuItem>
                                            <MenuItem
                                                variant="destructive"
                                                onclick={() =>
                                                    askRemove(
                                                        channel.id,
                                                    )}
                                            >
                                                <Trash2
                                                    aria-hidden="true"
                                                />
                                                Remove
                                            </MenuItem>
                                        </MenuPopup>
                                    </Menu>
                                </div>
                            </li>
                        {/each}
                    </ul>
                {/if}
            </CardPanel>
        </Card>
    {/if}
</SettingsSection>

<Dialog bind:open={createOpen.current}>
    <DialogContent>
        <DialogHeader>
            <DialogTitle>Add notification channel</DialogTitle>
            <DialogDescription>
                Clowder sends a test message once it's added.
            </DialogDescription>
        </DialogHeader>
        <DialogPanel>
            {#if createState.isError}
                <Alert variant="error" class="mb-4" role="alert">
                    <AlertDescription>
                        {createState.error.message}
                    </AlertDescription>
                </Alert>
            {/if}
            <form
                id="add-notification-channel-form"
                method="POST"
                class="space-y-4"
                onsubmit={create}
            >
                <Field>
                    <Label for="notification-type">Service</Label>
                    <Select
                        value={type}
                        items={typeItems}
                        disabled={createState.isPending}
                        onValueChange={selectType}
                    >
                        <SelectTrigger id="notification-type">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {#each typeItems as item (item.value)}
                                <SelectItem
                                    value={item.value}
                                    label={item.label}
                                >
                                    {item.label}
                                </SelectItem>
                            {/each}
                        </SelectContent>
                    </Select>
                </Field>
                <Field>
                    <Label for="notification-name" required>
                        Name
                    </Label>
                    <Input
                        id="notification-name"
                        bind:value={name}
                        placeholder="#deployments"
                        autocomplete="off"
                        maxlength={100}
                        disabled={createState.isPending}
                    />
                </Field>
                {#each fields as field (`${type}:${field.key}`)}
                    <Field>
                        <Label
                            for={`notification-${field.key}`}
                            required={!field.optional}
                        >
                            {field.label}
                        </Label>
                        <Input
                            id={`notification-${field.key}`}
                            bind:value={values[field.key]}
                            type={field.secret ? "password" : "text"}
                            class="font-mono"
                            placeholder={field.placeholder}
                            autocomplete="off"
                            maxlength={2048}
                            disabled={createState.isPending}
                        />
                        {#if field.hint}
                            <FieldDescription>
                                {field.hint}
                            </FieldDescription>
                        {/if}
                    </Field>
                {/each}
                <Fieldset class="flex flex-col gap-2">
                    <FieldsetLegend class="mb-1 text-sm font-medium">
                        Notify when
                    </FieldsetLegend>
                    {#each eventOptions as option (option.value)}
                        <label
                            class="flex cursor-pointer items-center gap-2 text-sm"
                        >
                            <Checkbox
                                checked={events.includes(
                                    option.value,
                                )}
                                disabled={createState.isPending}
                                onCheckedChange={(checked) =>
                                    toggleEvent(
                                        option.value,
                                        checked,
                                    )}
                            />
                            {option.label}
                        </label>
                    {/each}
                </Fieldset>
            </form>
        </DialogPanel>
        <DialogFooter>
            <Button
                type="submit"
                form="add-notification-channel-form"
                loading={createState.isPending}
                disabled={!valid || createState.isPending}
            >
                Add channel
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>

<ConfirmDialog
    bind:open={removeOpen}
    title="Remove this channel?"
    description="It stops getting notifications. Adding it back means entering its details again."
    confirmLabel="Remove"
    pending={removeState.isPending}
    error={removeState.error?.message ?? ""}
    onconfirm={() => removeState.mutate({ channelId: removeId })}
/>
