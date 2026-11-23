<!-- Creates a sandbox without leaving the canvas. -->
<script lang="ts">
    import { orpc } from "$lib/api/orpc";
    import ConnectionField from "$lib/components/clusters/connection-field.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import {
        Dialog,
        DialogContent,
        DialogFooter,
        DialogHeader,
        DialogPanel,
        DialogTitle,
    } from "$lib/components/ui/dialog";
    import {
        Empty,
        EmptyContent,
        EmptyHeader,
        EmptyMedia,
        EmptyTitle,
    } from "$lib/components/ui/empty";
    import {
        Field,
        FieldDescription,
    } from "$lib/components/ui/field";
    import {
        InputGroup,
        InputGroupAddon,
        InputGroupInput,
    } from "$lib/components/ui/input-group";
    import { Label } from "$lib/components/ui/label";
    import {
        Select,
        SelectContent,
        SelectItem,
        SelectTrigger,
        SelectValue,
    } from "$lib/components/ui/select";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { Textarea } from "$lib/components/ui/textarea";
    import {
        ToggleGroup,
        ToggleGroupItem,
    } from "$lib/components/ui/toggle-group";
    import { randomName } from "$lib/random-name";
    import { downloadText } from "$lib/utils";
    import { sshKeyPair } from "@clowder/workflows/ssh-key";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";
    import {
        parseAsString,
        parseAsStringLiteral,
        useQueryStates,
    } from "nuqs-svelte";
    import ArrowsClockwise from "phosphor-svelte/lib/ArrowsClockwiseIcon";
    import Cube from "phosphor-svelte/lib/CubeIcon";

    let {
        projectId,
        oncreated,
        onclose,
    }: {
        projectId: string;
        oncreated: (resourceId: string) => void;
        onclose: () => void;
    } = $props();

    const TTL_OPTIONS = [
        { value: "none", label: "No limit", seconds: undefined },
        { value: "1h", label: "1 hour", seconds: 3600 },
        { value: "8h", label: "8 hours", seconds: 8 * 3600 },
        { value: "1d", label: "1 day", seconds: 86_400 },
        { value: "7d", label: "7 days", seconds: 7 * 86_400 },
    ];

    // Select values can't be empty, so "let Uncloud decide" and "new volume" get a sentinel.
    const ANY = "any";

    // Everything but secrets lives in the URL, so a reload or a shared link keeps the form.
    // Prefixed like `addSandbox`, since the canvas owns the other params.
    const fields = useQueryStates(
        {
            name: parseAsString,
            image: parseAsString,
            cluster: parseAsString,
            machine: parseAsString.withDefault(ANY),
            volume: parseAsString.withDefault(ANY),
            ttl: parseAsStringLiteral(
                TTL_OPTIONS.map((option) => option.value),
            ).withDefault("none"),
            access: parseAsStringLiteral([
                "key",
                "password",
            ]).withDefault("key"),
            keys: parseAsString.withDefault(""),
        },
        {
            history: "replace",
            shallow: true,
            scroll: false,
            urlKeys: {
                name: "sandboxName",
                image: "sandboxImage",
                cluster: "sandboxCluster",
                machine: "sandboxMachine",
                volume: "sandboxVolume",
                ttl: "sandboxTtl",
                access: "sandboxAccess",
                keys: "sandboxKeys",
            },
        },
    );

    // Suggested until one is typed or rolled.
    const suggested = randomName();

    const name = $derived(fields.name.current ?? suggested);

    const machine = $derived(fields.machine.current);

    const volume = $derived(fields.volume.current);

    const ttl = $derived(fields.ttl.current);

    const access = $derived(fields.access.current);

    const keys = $derived(fields.keys.current);

    // Secrets stay in memory, never in the URL.
    let privateKey = $state("");

    let password = $state("");

    const projectQuery = createQuery(() =>
        orpc.projects.getProject.queryOptions({
            input: { projectId },
        }),
    );

    const imagesQuery = createQuery(() =>
        orpc.sandboxes.images.list.queryOptions(),
    );

    const clustersQuery = createQuery(() =>
        orpc.cluster.listClusters.queryOptions({
            input: {
                includeDiagnostics: false,
                includeSettingUp: false,
                limit: 100,
            },
        }),
    );

    const images = $derived(
        (imagesQuery.data ?? []).filter(
            (image) => image.provider === "uncloud",
        ),
    );

    // Defaults until one is picked: the first image and the project's own cluster.
    const imageId = $derived(
        fields.image.current ?? images[0]?.id ?? "",
    );

    const clusterId = $derived(
        fields.cluster.current ?? projectQuery.data?.clusterId ?? "",
    );

    const machinesQuery = createQuery(() =>
        orpc.cluster.getInitializationOptions.queryOptions({
            input: { clusterId },
            enabled: Boolean(clusterId),
        }),
    );

    const volumesQuery = createQuery(() =>
        orpc.volumes.listUnused.queryOptions({
            input: { clusterId },
            enabled: Boolean(clusterId),
        }),
    );

    const imageItems = $derived(
        images.map((image) => ({
            value: image.id,
            label: image.image,
        })),
    );

    const clusterItems = $derived(
        (clustersQuery.data?.items ?? []).map((cluster) => ({
            value: cluster.id,
            label: cluster.name,
        })),
    );

    const machineItems = $derived([
        { value: ANY, label: "Any machine" },
        ...(machinesQuery.data?.machines ?? []).map((item) => ({
            value: item.name,
            label: item.name,
        })),
    ]);

    const volumeItems = $derived([
        { value: ANY, label: "New volume" },
        ...(volumesQuery.data ?? []).map((item) => ({
            value: item.id,
            label: item.machine
                ? `${item.name} on ${item.machine}`
                : item.name,
        })),
    ]);

    const ttlItems = TTL_OPTIONS.map(({ value, label }) => ({
        value,
        label,
    }));

    const createState = createMutation(() =>
        orpc.sandboxes.create.mutationOptions({
            onSuccess: ({ id }) => {
                void fields.set(null);
                oncreated(id);
            },
        }),
    );

    function close() {
        void fields.set(null);
        onclose();
    }

    const login = $derived(access === "key" ? keys.trim() : password);

    const canSubmit = $derived(
        Boolean(
            name.trim() &&
            imageId &&
            clusterId &&
            login &&
            !createState.isPending,
        ),
    );

    async function generateKey() {
        const pair = await sshKeyPair(name || "sandbox");

        fields.keys.current = pair.publicKey;
        privateKey = pair.privateKey;
    }

    function selectCluster(value: string | null) {
        if (!value) return;

        void fields.set({
            cluster: value,
            machine: null,
            volume: null,
        });
    }

    function create(event: SubmitEvent) {
        event.preventDefault();

        if (!canSubmit) return;

        createState.mutate({
            projectId,
            slug: name.trim(),
            imageId,
            clusterId,
            machine: machine === ANY ? undefined : machine,
            volumeId: volume === ANY ? undefined : volume,
            authorizedKeys: access === "key" ? keys : undefined,
            password: access === "key" ? undefined : password,
            ttlSeconds: TTL_OPTIONS.find(
                (option) => option.value === ttl,
            )?.seconds,
        });
    }
</script>

{#snippet select(
    id: string,
    value: string,
    items: { value: string; label: string }[],
    onchange: (value: string | null) => void,
    disabled: boolean,
)}
    <Select
        {value}
        {items}
        disabled={disabled || createState.isPending}
        onValueChange={onchange}
    >
        <SelectTrigger {id}>
            <SelectValue />
        </SelectTrigger>
        <SelectContent>
            {#each items as item (item.value)}
                <SelectItem value={item.value} label={item.label}>
                    {item.label}
                </SelectItem>
            {/each}
        </SelectContent>
    </Select>
{/snippet}

<Dialog
    bind:open={
        () => true,
        (open) => {
            if (!open && !createState.isPending) close();
        }
    }
>
    <DialogContent class="sm:max-w-xl">
        <DialogHeader>
            <DialogTitle>New sandbox</DialogTitle>
        </DialogHeader>
        <DialogPanel>
            {#if imagesQuery.isError}
                <Alert variant="error">
                    <AlertDescription>
                        Unable to load sandbox images: {imagesQuery
                            .error.message}
                    </AlertDescription>
                </Alert>
            {:else if imagesQuery.isPending}
                <Skeleton loading label="Loading sandbox options">
                    <div class="space-y-4">
                        {#each ["Name", "Image", "Cluster", "Access"] as label (label)}
                            <Field>
                                <Label>{label}</Label>
                                <InputGroup>
                                    <InputGroupInput readonly />
                                </InputGroup>
                            </Field>
                        {/each}
                    </div>
                </Skeleton>
            {:else if images.length === 0}
                <Empty>
                    <EmptyHeader>
                        <EmptyMedia variant="icon">
                            <Cube aria-hidden="true" />
                        </EmptyMedia>
                        <EmptyTitle>No sandbox images</EmptyTitle>
                    </EmptyHeader>
                    <EmptyContent>
                        <Button
                            size="sm"
                            href="/settings?section=sandbox-images"
                        >
                            Add an image
                        </Button>
                    </EmptyContent>
                </Empty>
            {:else}
                <form
                    id="canvas-sandbox-form"
                    class="space-y-4"
                    aria-busy={createState.isPending}
                    onsubmit={create}
                >
                    {#if createState.isError}
                        <Alert variant="error" role="alert">
                            <AlertDescription>
                                {createState.error.message}
                            </AlertDescription>
                        </Alert>
                    {/if}
                    <Field>
                        <Label for="sandbox-name" required>
                            Name
                        </Label>
                        <InputGroup>
                            <InputGroupInput
                                id="sandbox-name"
                                bind:value={
                                    () => name,
                                    (value) =>
                                        (fields.name.current = value)
                                }
                                class="font-mono"
                                autocomplete="off"
                                spellcheck="false"
                                maxlength={55}
                                disabled={createState.isPending}
                            />
                            <InputGroupAddon align="inline-end">
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    onclick={() =>
                                        (fields.name.current =
                                            randomName())}
                                    aria-label="Pick another name"
                                    title="Pick another name"
                                >
                                    <ArrowsClockwise
                                        aria-hidden="true"
                                    />
                                </Button>
                            </InputGroupAddon>
                        </InputGroup>
                    </Field>
                    <Field>
                        <Label for="sandbox-image" required>
                            Image
                        </Label>
                        {@render select(
                            "sandbox-image",
                            imageId,
                            imageItems,
                            (value) => (fields.image.current = value),
                            false,
                        )}
                    </Field>
                    <div class="grid gap-4 sm:grid-cols-2">
                        <Field>
                            <Label for="sandbox-cluster" required>
                                Cluster
                            </Label>
                            {@render select(
                                "sandbox-cluster",
                                clusterId,
                                clusterItems,
                                selectCluster,
                                false,
                            )}
                        </Field>
                        <Field>
                            <Label for="sandbox-machine">
                                Machine
                            </Label>
                            {@render select(
                                "sandbox-machine",
                                machine,
                                machineItems,
                                (value) =>
                                    (fields.machine.current =
                                        value ?? ANY),
                                !clusterId,
                            )}
                            <FieldDescription>
                                KVM is required. Check that
                                <code>/dev/kvm</code>
                                exists on it.
                            </FieldDescription>
                        </Field>
                        <Field>
                            <Label for="sandbox-volume">Volume</Label>
                            {@render select(
                                "sandbox-volume",
                                volume,
                                volumeItems,
                                (value) =>
                                    (fields.volume.current =
                                        value ?? ANY),
                                !clusterId,
                            )}
                        </Field>
                        <Field>
                            <Label for="sandbox-ttl">
                                Time to live
                            </Label>
                            {@render select(
                                "sandbox-ttl",
                                ttl,
                                ttlItems,
                                (value) =>
                                    (fields.ttl.current =
                                        TTL_OPTIONS.find(
                                            (option) =>
                                                option.value ===
                                                value,
                                        )?.value ?? "none"),
                                false,
                            )}
                        </Field>
                    </div>
                    <Field>
                        <div
                            class="flex items-center justify-between gap-2"
                        >
                            <Label>Access</Label>
                            <ToggleGroup
                                variant="outline"
                                size="sm"
                                aria-label="Access"
                                value={[access]}
                                onValueChange={(next) => {
                                    if (
                                        next[0] === "key" ||
                                        next[0] === "password"
                                    )
                                        fields.access.current =
                                            next[0];
                                }}
                            >
                                <ToggleGroupItem value="key">
                                    SSH key
                                </ToggleGroupItem>
                                <ToggleGroupItem value="password">
                                    Password
                                </ToggleGroupItem>
                            </ToggleGroup>
                        </div>
                        {#if access === "key"}
                            <Textarea
                                id="sandbox-keys"
                                aria-label="Public keys"
                                bind:value={fields.keys.current}
                                class="font-mono"
                                rows={3}
                                placeholder="ssh-ed25519 AAAA… you@laptop"
                                disabled={createState.isPending}
                            />
                            <FieldDescription>
                                <button
                                    type="button"
                                    class="underline"
                                    onclick={generateKey}
                                >
                                    Generate a key
                                </button>
                                or paste public keys, one per line.
                            </FieldDescription>
                        {:else}
                            <InputGroup>
                                <InputGroupInput
                                    id="sandbox-password"
                                    aria-label="Password"
                                    bind:value={password}
                                    class="font-mono"
                                    autocomplete="new-password"
                                    minlength={8}
                                    maxlength={256}
                                    disabled={createState.isPending}
                                />
                                <InputGroupAddon align="inline-end">
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onclick={() =>
                                            (password =
                                                crypto.randomUUID())}
                                    >
                                        Generate
                                    </Button>
                                </InputGroupAddon>
                            </InputGroup>
                            <FieldDescription>
                                You can see it again in the sandbox's
                                settings.
                            </FieldDescription>
                        {/if}
                    </Field>
                    {#if access === "key" && privateKey}
                        <ConnectionField
                            label="Private key"
                            value={privateKey}
                            secret
                        />
                        <div
                            class="flex items-center justify-between gap-2"
                        >
                            <p class="text-xs text-muted-foreground">
                                Save it now. Clowder never stores it.
                            </p>
                            <Button
                                variant="outline"
                                size="sm"
                                onclick={() =>
                                    downloadText(
                                        `${name}_ed25519`,
                                        privateKey,
                                    )}
                            >
                                Download
                            </Button>
                        </div>
                    {/if}
                </form>
            {/if}
        </DialogPanel>
        <DialogFooter>
            <Button
                variant="outline"
                onclick={close}
                disabled={createState.isPending}
            >
                Cancel
            </Button>
            <Button
                type="submit"
                form="canvas-sandbox-form"
                loading={createState.isPending}
                disabled={!canSubmit}
            >
                Create sandbox
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
