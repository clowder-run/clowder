<script lang="ts">
    import { Menu as MenuPrimitive } from "@shardsui/svelte/menu";
    import type { ComponentProps } from "svelte";

    let {
        open = $bindable(false),
        // Non-modal so opening a menu doesn't lock page scroll and shift the layout.
        modal = false,
        ...restProps
    }: ComponentProps<typeof MenuPrimitive.Root> = $props();
</script>

<MenuPrimitive.Root bind:open {modal} {...restProps} />
