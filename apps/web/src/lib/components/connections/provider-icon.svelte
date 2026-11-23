<script lang="ts">
    let { provider }: { provider: string } = $props();

    const icons = new Map([
        ["forgejo", "/icons/forgejo.svg"],
        ["gitlab", "/icons/gitlab.svg"],
        ["gitea", "/icons/gitea.svg"],
        ["bitbucket", "/icons/bitbucket.svg"],
        ["gitee", "/icons/gitee.svg"],
        ["gitcafe", "/icons/gitcafe.svg"],
        ["pushin", "/icons/pushin.png"],
        ["upstream", "/icons/upstream.svg"],
    ]);
</script>

{#if provider === "github"}
    <img
        src="/icons/github-light.svg"
        alt=""
        aria-hidden="true"
        class="size-4 shrink-0 dark:hidden"
    />
    <img
        src="/icons/github-dark.svg"
        alt=""
        aria-hidden="true"
        class="hidden size-4 shrink-0 dark:block"
    />
{:else}
    <img
        src={icons.get(provider) ?? "/icons/git.svg"}
        alt=""
        aria-hidden="true"
        class="size-4 shrink-0"
    />
{/if}
