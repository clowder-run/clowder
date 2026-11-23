import FolderOpen from "phosphor-svelte/lib/FolderOpenIcon";
import GitBranch from "phosphor-svelte/lib/GitBranchIcon";
import HardDrive from "phosphor-svelte/lib/DatabaseIcon";
import LayoutDashboard from "phosphor-svelte/lib/HouseIcon";
import Rocket from "phosphor-svelte/lib/RocketIcon";
import Server from "phosphor-svelte/lib/HardDrivesIcon";
import Stack from "phosphor-svelte/lib/StackIcon";
import Settings from "phosphor-svelte/lib/GearSixIcon";

/** The sidebar's sections; the header title reads the same names. */
export const mainSections = [
    { title: "Home", url: "/", icon: LayoutDashboard },
    { title: "Projects", url: "/projects", icon: FolderOpen },
    { title: "Deployments", url: "/deployments", icon: Rocket },
    { title: "Templates", url: "/templates", icon: Stack },
];

export const configSections = [
    { title: "Clusters", url: "/clusters", icon: Server },
    { title: "Git connections", url: "/git", icon: GitBranch },
    { title: "S3 connections", url: "/s3", icon: HardDrive },
    { title: "Settings", url: "/settings", icon: Settings },
];

export function isSectionActive(url: string, pathname: string) {
    return url === "/" ? pathname === "/" : pathname.startsWith(url);
}

export function sectionTitle(pathname: string) {
    return (
        [...mainSections, ...configSections].find((section) =>
            isSectionActive(section.url, pathname),
        )?.title ?? "Home"
    );
}
