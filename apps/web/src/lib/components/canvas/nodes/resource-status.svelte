<script lang="ts">
    import { sourceLabels } from "$lib/deployments/labels";
    import { orpc } from "$lib/api/orpc";
    import { isActiveDeploymentStatus } from "$lib/deployments/status";
    import { ago } from "$lib/format";
    import {
        allExited,
        containerInfo,
    } from "$lib/resources/container-info";
    import CircleCheck from "phosphor-svelte/lib/CheckCircleIcon";
    import CircleX from "phosphor-svelte/lib/XCircleIcon";
    import LoaderCircle from "phosphor-svelte/lib/CircleNotchIcon";
    import { createQuery } from "@tanstack/svelte-query";
    import { getCanvasClock, getCanvasCluster } from "../context";
    import type { CanvasResource } from "../graph";

    let {
        resource,
        draftOnly,
    }: { resource: CanvasResource; draftOnly: boolean } = $props();

    // Railway says "Just deployed" for a few minutes, then settles on "Online".
    const JUST_DEPLOYED_MS = 10 * 60_000;

    const clock = getCanvasClock();

    const status = $derived(resource.deploymentStatus);

    const cluster = getCanvasCluster();

    // Buckets and sandboxes report their own job's state rather than a deployment's.
    const jobStatus = $derived(
        resource.bucketStatus ?? resource.sandboxStatus,
    );

    // A finished deploy only says the rollout worked; the containers say whether it still runs.
    // Every card reads one project-wide query, so the canvas polls the sidecar once.
    const containersQuery = createQuery(() =>
        orpc.resources.getProjectContainers.queryOptions({
            input: {
                clusterId: cluster.id,
                projectId: resource.projectId,
            },
            enabled:
                cluster.id.length > 0 &&
                status === "ready" &&
                !jobStatus,
            refetchInterval: 30_000,
        }),
    );

    // A stop-first rollout keeps the replaced container, exited, until the new one is healthy. The
    // shared query may have polled during that window, so once this deploy turns ready, ignore
    // snapshots from before then and fetch a fresh one. Client clock only, so skew can't matter.
    let readyAt = $state<number>();

    // "unseen" until the first run, so a card that loads already ready doesn't refetch.
    let previousStatus: typeof status | "unseen" = "unseen";

    $effect(() => {
        if (
            status === "ready" &&
            previousStatus !== "unseen" &&
            previousStatus !== "ready"
        ) {
            readyAt = Date.now();
            void containersQuery.refetch();
        }

        previousStatus = status;
    });

    const containers = $derived(
        readyAt && containersQuery.dataUpdatedAt < readyAt
            ? undefined
            : containersQuery.data?.[resource.id],
    );

    const unhealthy = $derived(
        containers?.some(({ container }) => {
            const info = containerInfo(container);

            return (
                info.health === "unhealthy" ||
                info.status === "exited"
            );
        }) ?? false,
    );

    const stopped = $derived(
        containers ? allExited(containers) : false,
    );

    const finishedAt = $derived(
        resource.deploymentFinishedAt ?? resource.deploymentCreatedAt,
    );

    // Deployments from before metadata existed fall back to the resource's current source.
    const via = $derived.by(() => {
        const source =
            resource.deploymentSource ??
            (resource.gitBranch ? "git" : "docker");

        // An image is the default, so the card only names Git sources.
        return source === "docker"
            ? ""
            : ` via ${sourceLabels[source]}`;
    });

    // A sandbox is a running VM, so it reads like a service; a bucket keeps its plain job text.
    const sandboxStates = {
        running: "online",
        provisioning: "provisioning",
        destroying: "destroying",
        failed: "failed",
    } as const;

    const cardState = $derived.by(() => {
        if (resource.sandboxStatus)
            return sandboxStates[resource.sandboxStatus];

        if (jobStatus) return "job";

        if (!status) return "offline";

        // A cancelled deploy may never have started, so it says nothing about the running service.
        if (status === "cancelled") return "cancelled";

        if (isActiveDeploymentStatus(status)) return "deploying";

        if (status === "failed") return "failed";

        // Deployed, but the cluster has no containers for it, e.g. its service was removed by hand.
        if (containers?.length === 0) return "offline";

        if (stopped) return "stopped";

        if (unhealthy) return "unhealthy";

        return finishedAt &&
            clock.now - new Date(finishedAt).getTime() <
                JUST_DEPLOYED_MS
            ? "deployed"
            : "online";
    });
</script>

{#if cardState === "job"}
    <!-- Railway's bucket card: plain grey text, with a braille spinner while a job runs. -->
    <p
        class="flex items-center gap-2 truncate text-sm text-muted-foreground capitalize"
    >
        {#if jobStatus === "provisioning" || jobStatus === "deleting" || jobStatus === "destroying"}
            <span
                class="spinner w-3 shrink-0"
                aria-hidden="true"
            ></span>
        {/if}
        {jobStatus}
    </p>
{:else if cardState === "offline"}
    <p class="truncate text-sm text-muted-foreground">
        {draftOnly ? "Draft, not deployed" : "Service is offline"}
    </p>
{:else if cardState === "stopped"}
    <p class="truncate text-sm text-muted-foreground">Stopped</p>
{:else if cardState === "cancelled"}
    <p class="truncate text-sm text-muted-foreground">
        Deploy cancelled {finishedAt
            ? ago(finishedAt, clock.now)
            : ""}
    </p>
{:else}
    <!-- Status row: icon in a 24px column, 12px gap, 14px text. -->
    <span
        class="grid min-w-0 grid-cols-[24px_1fr] items-center gap-3 text-sm"
    >
        {#if cardState === "online"}
            <svg
                class="size-4 text-success"
                viewBox="0 0 16 16"
                aria-hidden="true"
            >
                <circle cx="8" cy="8" r="3" fill="currentColor" />
            </svg>
            <span class="truncate text-success-foreground">
                Online
            </span>
        {:else if cardState === "deployed"}
            <CircleCheck
                class="size-4 text-success-foreground"
                aria-hidden="true"
            />
            <span class="truncate text-muted-foreground">
                Just deployed{via}
            </span>
        {:else if cardState === "deploying" || cardState === "provisioning" || cardState === "destroying"}
            <LoaderCircle
                class="size-4 animate-spin text-warning-foreground motion-reduce:animate-none"
                aria-hidden="true"
            />
            <span class="truncate text-warning-foreground">
                {cardState === "provisioning"
                    ? "Provisioning"
                    : cardState === "destroying"
                      ? "Destroying"
                      : status === "queued"
                        ? "Queued"
                        : "Deploying"}
            </span>
        {:else}
            <CircleX
                class="size-4 text-destructive-foreground"
                aria-hidden="true"
            />
            <span class="truncate text-destructive-foreground">
                {cardState === "unhealthy"
                    ? "Unhealthy"
                    : `Failed ${finishedAt ? ago(finishedAt, clock.now) : ""}`}
            </span>
        {/if}
    </span>
{/if}

<style>
    .spinner::before {
        content: "⠋";
        animation: braille 0.8s steps(1) infinite;
    }

    @keyframes braille {
        10% {
            content: "⠙";
        }
        20% {
            content: "⠹";
        }
        30% {
            content: "⠸";
        }
        40% {
            content: "⠼";
        }
        50% {
            content: "⠴";
        }
        60% {
            content: "⠦";
        }
        70% {
            content: "⠧";
        }
        80% {
            content: "⠇";
        }
        90% {
            content: "⠏";
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .spinner::before {
            animation: none;
        }
    }
</style>
