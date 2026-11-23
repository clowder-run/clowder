<script lang="ts">
    import type { ComponentProps } from "svelte";
    import { Select as SelectPrimitive } from "@shardsui/svelte/select";

    type SelectItemDef = { label: string; value: string };

    let {
        value = $bindable(),
        items = [],
        // Non-modal so opening a select doesn't lock page scroll and shift the layout.
        modal = false,
        ...restProps
    }: Omit<
        ComponentProps<typeof SelectPrimitive.Root>,
        "value" | "items"
    > & {
        value?: string | string[];
        items?: SelectItemDef[];
    } = $props();
</script>

<SelectPrimitive.Root
    bind:value={value as never}
    {items}
    {modal}
    {...restProps}
/>
