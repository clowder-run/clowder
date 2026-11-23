<script lang="ts">
    import { page } from "$app/state";
    import {
        Sidebar,
        SidebarContent,
        SidebarFooter,
        SidebarGroup,
        SidebarGroupContent,
        SidebarGroupLabel,
        SidebarHeader,
        SidebarMenu,
        SidebarRail,
        SidebarSeparator,
    } from "$lib/components/ui/sidebar";
    import { useSidebar } from "$lib/components/ui/sidebar/context.svelte";
    import Shield from "phosphor-svelte/lib/ShieldCheckIcon";
    import OrgSwitcher from "./org-switcher.svelte";
    import ObservabilityNav from "./observability-nav.svelte";
    import SidebarAppFooter from "./sidebar-footer.svelte";
    import SidebarNavLink from "./sidebar-nav-link.svelte";
    import SearchButton from "$lib/components/search/search-button.svelte";
    import {
        configSections,
        isSectionActive,
        mainSections,
    } from "./nav-sections";

    let {
        variant = "inset",
        user,
        organizations,
        activeOrganizationId,
    }: {
        variant?: "sidebar" | "floating" | "inset";
        user: {
            name: string;
            email: string;
            image?: string | null;
            role?: string | null;
        };
        organizations: { id: string; name: string; slug: string }[];
        activeOrganizationId?: string | null;
    } = $props();

    const sidebar = useSidebar();

    function closeNavigation() {
        sidebar.setOpenMobile(false);
    }

    const pathname = $derived(page.url.pathname);

    const isAdmin = $derived(user.role === "admin");
</script>

<Sidebar {variant} collapsible="icon">
    <SidebarHeader>
        <OrgSwitcher
            {organizations}
            {activeOrganizationId}
            onNavigate={closeNavigation}
        />
        <SidebarMenu>
            <SearchButton />
        </SidebarMenu>
    </SidebarHeader>
    <SidebarContent class="overflow-x-hidden">
        <SidebarGroup>
            <SidebarGroupLabel>Main</SidebarGroupLabel>
            <SidebarGroupContent>
                <SidebarMenu>
                    {#each mainSections as link (link.url)}
                        <SidebarNavLink
                            href={link.url}
                            title={link.title}
                            icon={link.icon}
                            active={isSectionActive(
                                link.url,
                                pathname,
                            )}
                            current={pathname === link.url}
                            onclick={closeNavigation}
                        >
                            {link.title}
                        </SidebarNavLink>
                    {/each}
                    <ObservabilityNav onNavigate={closeNavigation} />
                </SidebarMenu>
            </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <SidebarGroup>
            <SidebarGroupLabel>Configuration</SidebarGroupLabel>
            <SidebarGroupContent>
                <SidebarMenu>
                    {#each configSections as link (link.url)}
                        <SidebarNavLink
                            href={link.url}
                            title={link.title}
                            icon={link.icon}
                            active={isSectionActive(
                                link.url,
                                pathname,
                            )}
                            current={pathname === link.url}
                            onclick={closeNavigation}
                        >
                            {link.title}
                        </SidebarNavLink>
                    {/each}
                </SidebarMenu>
            </SidebarGroupContent>
        </SidebarGroup>
        {#if isAdmin}
            <SidebarSeparator />
            <SidebarGroup>
                <SidebarGroupLabel>Admin</SidebarGroupLabel>
                <SidebarGroupContent>
                    <SidebarMenu>
                        <SidebarNavLink
                            href="/admin"
                            title="Admin"
                            icon={Shield}
                            active={pathname.startsWith("/admin")}
                            current={pathname === "/admin"}
                            onclick={closeNavigation}
                        >
                            Admin
                        </SidebarNavLink>
                    </SidebarMenu>
                </SidebarGroupContent>
            </SidebarGroup>
        {/if}
    </SidebarContent>
    <SidebarFooter>
        <SidebarAppFooter {user} />
    </SidebarFooter>
    <SidebarRail />
</Sidebar>
