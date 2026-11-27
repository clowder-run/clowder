import { appUrl } from "@clowder/config/env";
import type { Database } from "@clowder/db";
import {
    clusters,
    type DeploymentMetadata,
    deployments,
    type NotificationEvent,
    projects,
    resources,
} from "@clowder/db/schema/index";
import { eq } from "drizzle-orm";

/** One message, rendered by each channel in its own format. */
export type Notice = {
    event: NotificationEvent | "test";
    tone: "success" | "failure" | "info";
    title: string;
    /** Why it failed, or the test's explanation. */
    detail: string | null;
    /** The deployment page; null without APP_URL, since a localhost link helps nobody. */
    url: string | null;
    facts: { label: string; value: string }[];
    at: Date;
    deployment: DeploymentSummary | null;
};

/** What generic webhooks receive about the deployment. */
export type DeploymentSummary = {
    id: string;
    kind: string;
    status: "ready" | "failed";
    error: string | null;
    cluster: { id: string; name: string };
    project: { id: string; name: string } | null;
    resource: { id: string; name: string } | null;
    trigger: DeploymentMetadata["trigger"] | null;
    commit: { sha: string; message: string } | null;
    createdAt: string;
    finishedAt: string | null;
};

export type SettledDeployment = {
    id: string;
    name: string;
    status: string;
    error: string | null;
    metadata: DeploymentMetadata | null;
    createdAt: Date;
    finishedAt: Date | null;
    cluster: { id: string; name: string; organizationId: string };
    resource: { id: string; name: string } | null;
    project: { id: string; name: string } | null;
};

// Keyed by the deployment's job name.
function titles(name: string): [success: string, failure: string] {
    switch (name) {
        case "DeployResource":
            return ["{resource} deployed", "{resource} failed to deploy"];
        case "ProvisionCluster":
            return ["Cluster {cluster} is ready", "Setting up cluster {cluster} failed"];
        case "AddMachine":
            return ["Machine added to {cluster}", "Adding a machine to {cluster} failed"];
        case "InitializeCluster":
            return [
                "Monitoring is ready on {cluster}",
                "Setting up monitoring on {cluster} failed",
            ];
        case "ProvisionSandbox":
            return ["Sandbox {resource} is running", "Creating sandbox {resource} failed"];
        case "DestroySandbox":
            return ["Sandbox {resource} destroyed", "Destroying sandbox {resource} failed"];
        default:
            return ["Deployment finished", "Deployment failed"];
    }
}

const triggers: Record<DeploymentMetadata["trigger"], string> = {
    manual: "Manual",
    webhook: "Git push",
    poll: "Git push (polled)",
};

export async function loadSettledDeployment(
    db: Database,
    deploymentId: string,
): Promise<SettledDeployment | null> {
    const [row] = await db
        .select({
            id: deployments.id,
            name: deployments.name,
            status: deployments.status,
            error: deployments.error,
            metadata: deployments.metadata,
            createdAt: deployments.createdAt,
            finishedAt: deployments.finishedAt,
            cluster: {
                id: clusters.id,
                name: clusters.name,
                organizationId: clusters.organizationId,
            },
            resource: { id: resources.id, name: resources.name },
            project: { id: projects.id, name: projects.name },
        })
        .from(deployments)
        .innerJoin(clusters, eq(clusters.id, deployments.clusterId))
        .leftJoin(resources, eq(resources.id, deployments.resourceId))
        .leftJoin(projects, eq(projects.id, resources.projectId))
        .where(eq(deployments.id, deploymentId))
        .limit(1);

    return row ?? null;
}

export function deploymentEvent(status: string): NotificationEvent | null {
    if (status === "ready") return "deployment.succeeded";

    if (status === "failed") return "deployment.failed";

    return null;
}

export function deploymentNotice(deployment: SettledDeployment): Notice | null {
    const event = deploymentEvent(deployment.status);

    if (!event) return null;
    const failed = event === "deployment.failed";
    const [success, failure] = titles(deployment.name);

    const title = (failed ? failure : success)
        .replace("{resource}", deployment.resource?.name ?? "A resource")
        .replace("{cluster}", deployment.cluster.name);

    const commit = deployment.metadata?.commit ?? null;
    const trigger = deployment.metadata?.trigger ?? null;
    const base = appUrl();

    const facts = [
        deployment.project && { label: "Project", value: deployment.project.name },
        { label: "Cluster", value: deployment.cluster.name },
        trigger && { label: "Trigger", value: triggers[trigger] },
        commit && {
            label: "Commit",
            value: `${commit.sha.slice(0, 7)} ${firstLine(commit.message)}`.trim(),
        },
        deployment.finishedAt && {
            label: "Duration",
            value: formatDuration(deployment.finishedAt.getTime() - deployment.createdAt.getTime()),
        },
    ].flatMap((fact) => (fact ? [fact] : []));

    return {
        event,
        tone: failed ? "failure" : "success",
        title,
        detail: failed ? (deployment.error ?? "No reason was recorded.") : null,
        url: base ? new URL(`/deployments/${deployment.id}`, base).toString() : null,
        facts,
        at: deployment.finishedAt ?? new Date(),
        deployment: {
            id: deployment.id,
            kind: deployment.name,
            status: failed ? "failed" : "ready",
            error: deployment.error,
            cluster: { id: deployment.cluster.id, name: deployment.cluster.name },
            project: deployment.project,
            resource: deployment.resource,
            trigger,
            commit,
            createdAt: deployment.createdAt.toISOString(),
            finishedAt: deployment.finishedAt?.toISOString() ?? null,
        },
    };
}

export function testNotice(channelName: string): Notice {
    return {
        event: "test",
        tone: "info",
        title: "Test notification",
        detail: `${channelName} is set up. Deployments will show up here when they finish.`,
        url: appUrl() ?? null,
        facts: [],
        at: new Date(),
        deployment: null,
    };
}

function firstLine(text: string) {
    const line = text.split("\n", 1)[0]!.trim();

    return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}

export function formatDuration(ms: number) {
    const seconds = Math.max(0, Math.round(ms / 1000));

    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);

    if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;

    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
