<script lang="ts">
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import {
        Button,
        buttonVariants,
    } from "$lib/components/ui/button";
    import { Card, CardPanel } from "$lib/components/ui/card";
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
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import {
        Menu,
        MenuItem,
        MenuPopup,
        MenuTrigger,
    } from "$lib/components/ui/menu";
    import { Separator } from "$lib/components/ui/separator";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { orpc, queryClient } from "$lib/api/orpc";
    import { parseImageReference } from "@clowder/api/image-reference";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";
    import Cube from "phosphor-svelte/lib/CubeIcon";
    import Ellipsis from "phosphor-svelte/lib/DotsThreeIcon";
    import Plus from "phosphor-svelte/lib/PlusIcon";
    import Trash2 from "phosphor-svelte/lib/TrashIcon";
    import ConfirmDialog from "./confirm-dialog.svelte";
    import SettingsSection from "./settings-section.svelte";

    const imagesQuery = createQuery(() =>
        orpc.sandboxes.images.list.queryOptions(),
    );

    async function refresh() {
        await queryClient.invalidateQueries({
            queryKey: orpc.sandboxes.images.list.key(),
        });
    }

    let createOpen = $state(false);

    let image = $state("");

    const valid = $derived(
        parseImageReference(image.trim()) !== null,
    );

    const createState = createMutation(() =>
        orpc.sandboxes.images.create.mutationOptions({
            onSuccess: async () => {
                createOpen = false;
                await refresh();
            },
        }),
    );

    function openCreate() {
        image = "";
        createState.reset();
        createOpen = true;
    }

    function create(event: SubmitEvent) {
        event.preventDefault();

        if (!valid || createState.isPending) return;

        createState.mutate({
            provider: "uncloud",
            image: image.trim(),
        });
    }

    let removeId = $state("");

    let removeOpen = $state(false);

    const removeState = createMutation(() =>
        orpc.sandboxes.images.remove.mutationOptions({
            onSuccess: async () => {
                removeOpen = false;
                await refresh();
            },
        }),
    );

    function askRemove(imageId: string) {
        removeId = imageId;
        removeState.reset();
        removeOpen = true;
    }
</script>

<SettingsSection
    title="Sandbox images"
    description="The images people can pick when they create a sandbox."
    count={imagesQuery.data
        ? `${imagesQuery.data.length} ${imagesQuery.data.length === 1 ? "image" : "images"}`
        : undefined}
>
    {#snippet actions()}
        <Button onclick={openCreate}>
            <Plus class="size-4" aria-hidden="true" />
            Add image
        </Button>
    {/snippet}

    {#if imagesQuery.isError}
        <Alert variant="error">
            <AlertDescription>
                {imagesQuery.error.message}
            </AlertDescription>
        </Alert>
    {:else if imagesQuery.isSuccess && imagesQuery.data.length === 0}
        <Empty class="rounded-xl border border-dashed border-border">
            <EmptyHeader>
                <EmptyMedia variant="icon">
                    <Cube aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No sandbox images yet</EmptyTitle>
            </EmptyHeader>
        </Empty>
    {:else}
        <Card>
            <CardPanel class="p-0">
                {#if imagesQuery.isPending}
                    <Skeleton
                        loading
                        count={2}
                        gap={1}
                        label="Loading images"
                    >
                        <div class="flex items-center gap-3 p-3">
                            <span
                                class="size-10 shrink-0 rounded-full"
                            ></span>
                            <span class="text-sm">
                                pkg.bar/sandbox:latest
                            </span>
                        </div>
                    </Skeleton>
                {:else}
                    <ul>
                        {#each imagesQuery.data as item, index (item.id)}
                            <li class="min-w-0">
                                {#if index > 0}<Separator />{/if}
                                <div
                                    class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 p-3"
                                >
                                    <span
                                        class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
                                    >
                                        <Cube
                                            class="size-5"
                                            aria-hidden="true"
                                        />
                                    </span>
                                    <div class="min-w-0">
                                        <h3
                                            class="truncate font-mono text-sm font-medium leading-5"
                                            title={item.image}
                                        >
                                            {item.image}
                                        </h3>
                                        <p
                                            class="mt-1 text-xs capitalize leading-5 text-muted-foreground"
                                        >
                                            {item.provider}
                                        </p>
                                    </div>
                                    <Menu>
                                        <MenuTrigger
                                            class={buttonVariants({
                                                variant: "ghost",
                                                size: "icon-sm",
                                            })}
                                            aria-label={`Actions for ${item.image}`}
                                        >
                                            <Ellipsis
                                                class="size-4"
                                                aria-hidden="true"
                                            />
                                        </MenuTrigger>
                                        <MenuPopup align="end">
                                            <MenuItem
                                                variant="destructive"
                                                onclick={() =>
                                                    askRemove(
                                                        item.id,
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

<Dialog bind:open={createOpen}>
    <DialogContent>
        <DialogHeader>
            <DialogTitle>Add sandbox image</DialogTitle>
            <DialogDescription>
                A public image for Uncloud clusters. Sandboxes pin it
                to its digest when they're created.
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
                id="add-sandbox-image-form"
                method="POST"
                onsubmit={create}
            >
                <Field>
                    <Label for="sandbox-image-reference" required>
                        Image
                    </Label>
                    <Input
                        id="sandbox-image-reference"
                        bind:value={image}
                        class="font-mono"
                        placeholder="pkg.bar/sandbox:latest"
                        autocomplete="off"
                        maxlength={255}
                        disabled={createState.isPending}
                    />
                    {#if image.trim() && !valid}
                        <FieldDescription
                            class="text-destructive-foreground"
                        >
                            Enter an image reference like
                            <code>registry/name:tag</code>
                            .
                        </FieldDescription>
                    {/if}
                </Field>
            </form>
        </DialogPanel>
        <DialogFooter>
            <Button
                type="submit"
                form="add-sandbox-image-form"
                loading={createState.isPending}
                disabled={!valid || createState.isPending}
            >
                Add image
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>

<ConfirmDialog
    bind:open={removeOpen}
    title="Remove this image?"
    description="Existing sandboxes keep running it; it just stops being offered for new ones."
    confirmLabel="Remove"
    pending={removeState.isPending}
    error={removeState.error?.message ?? ""}
    onconfirm={() => removeState.mutate({ imageId: removeId })}
/>
