import { sql } from "drizzle-orm";
import * as t from "drizzle-orm/pg-core";
import { encryptedText } from "../secret-column";
import { resourceSlug } from "../slug";
import { organization, user } from "./auth";

export type MonitoringStorage = { type: "volume" | "bind"; source: string };

export const instanceSettings = t.pgTable(
    "instance_settings",
    {
        id: t.integer("id").primaryKey().default(1),
        signupsEnabled: t.boolean("signups_enabled").notNull().default(false),
    },
    (table) => [t.check("instance_settings_singleton", sql`${table.id} = 1`)],
);

// Nothing reads this since the list view was removed; kept so no migration drops user data.
export const userSettings = t.pgTable("user_settings", {
    userId: t
        .text("user_id")
        .primaryKey()
        .references(() => user.id, { onDelete: "cascade" }),
    canvasMode: t.boolean("canvas_mode").notNull().default(true),
});

/**
 * A cluster Clowder is setting up on a server over SSH. `initState` tracks how far `uc machine init`
 * got: "partial" means a cluster exists on the server but its setup failed, and "reset" that the
 * user approved resetting it on the next attempt.
 */
export type ClusterProvisioning = {
    host: string;
    port: number;
    user: string;
    /** Authorized on the server by the user; the private half is in `provisioningSecrets`. */
    publicKey: string;
    initState: "none" | "partial" | "reset" | "done";
    /** Caddy shares certificates through Uncloud's cluster store once the cluster is ready. */
    caddyStorage: boolean;
};

/** A server an admin is adding to a ready cluster over SSH, one at a time. */
export type PendingMachine = {
    host: string;
    port: number;
    user: string;
    /** The Uncloud machine name; null lets Uncloud name it after its hostname. */
    name: string | null;
    /** Authorized on the server by the admin; the private half is in `pendingMachineKey`. */
    publicKey: string;
    /** ISO time it was prepared; only `AddMachine` attempts since then are its own. */
    preparedAt: string;
    /** Set once an attempt runs uc on it, so a retry knows a member it finds was added by Clowder. */
    joining?: boolean;
    /** Set once it is a member, so a retry only finishes spreading the cluster's services to it. */
    joined: { id: string; name: string } | null;
};

export type ClusterInitializationConfiguration = {
    /** Uncloud machine name. Legacy rows may still hold an ID; Uncloud accepts either. */
    machine: string;
    retentionDays: number;
    /** Fixed managed volumes; omitted in new requests and defaulted server-side. */
    greptimeStorage?: MonitoringStorage;
    alloyStorage?: MonitoringStorage;
};

export const clusters = t.pgTable(
    "clusters",
    {
        id: t.uuid("id").primaryKey(),
        name: t.text("name").notNull(),
        sidecarUrl: t.text("sidecar_url").notNull(),
        sidecarToken: encryptedText("sidecar_token", "sidecar-token").notNull(),
        // The self-signed certificate Clowder pinned for a cluster it created; null trusts public CAs.
        sidecarCertificate: t.text("sidecar_certificate"),
        // Set while Clowder creates the cluster on a server over SSH, and cleared once it's ready.
        provisioning: t.jsonb("provisioning").$type<ClusterProvisioning>(),
        // JSON of the single-use SSH private key and the sidecar's TLS key, deleted with `provisioning`.
        provisioningSecrets: encryptedText("provisioning_secrets", "cluster-provisioning"),
        // A server being added to the cluster over SSH, cleared once it has joined.
        pendingMachine: t.jsonb("pending_machine").$type<PendingMachine>(),
        // The single-use SSH private key for `pendingMachine`, deleted with it.
        pendingMachineKey: encryptedText("pending_machine_key", "cluster-pending-machine"),
        greptimeUrl: t.text("greptime_url"),
        // The `caddy` service as a resource in the cluster's internal project; adopted on first view.
        caddyResourceId: t
            .uuid("caddy_resource_id")
            .references((): t.AnyPgColumn => resources.id, { onDelete: "set null" }),
        organizationId: t
            .text("organization_id")
            .notNull()
            .references(() => organization.id, { onDelete: "cascade" }),
        initializedAt: t.timestamp("initialised_at", { withTimezone: true }),
        initializationRequestedAt: t.timestamp("initialization_requested_at", {
            withTimezone: true,
        }),
        initializationStatus: t.text("initialization_status").notNull().default("uninitialized"),
        initializationError: t.text("initialization_error"),
        initializationConfiguration: t
            .jsonb("initialization_configuration")
            .$type<ClusterInitializationConfiguration>(),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
        updatedAt: t
            .timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table) => [t.index("clusters_organization_idx").on(table.organizationId)],
);

// Card and frame positions on the project canvas, keyed by node id.
export type CanvasLayout = Record<string, { x: number; y: number }>;

export const projects = t.pgTable(
    "projects",
    {
        id: t.uuid("id").primaryKey(),
        name: t.text("name").notNull(),
        description: t.text("description"),
        clusterId: t
            .uuid("cluster_id")
            .notNull()
            .references(() => clusters.id, { onDelete: "cascade" }),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
        isInternal: t.boolean("is_internal").default(false),
        canvasLayout: t.jsonb("canvas_layout").$type<CanvasLayout>(),
        updatedAt: t
            .timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table) => [t.index("projects_cluster_idx").on(table.clusterId)],
);

// Railway's starred projects, per user.
export const projectFavorites = t.pgTable(
    "project_favorites",
    {
        userId: t
            .text("user_id")
            .notNull()
            .references(() => user.id, { onDelete: "cascade" }),
        projectId: t
            .uuid("project_id")
            .notNull()
            .references(() => projects.id, { onDelete: "cascade" }),
    },
    (table) => [
        t.primaryKey({ columns: [table.userId, table.projectId] }),
        t.index("project_favorites_project_idx").on(table.projectId),
    ],
);

export type GitProvider =
    | "forgejo"
    | "github"
    | "gitlab"
    | "gitea"
    | "bitbucket"
    | "gitee"
    | "gitcafe"
    | "pushin"
    | "upstream"
    | "generic";

export type GitAccount = { id: string; login: string; name: string | null };

export type GitKnownRepository = { url: string; name: string; defaultBranch: string };

export const gitOAuthProviders = t.pgTable(
    "git_oauth_providers",
    {
        id: t.text("id").primaryKey(),
        organizationId: t
            .text("organization_id")
            .notNull()
            .references(() => organization.id, { onDelete: "cascade" }),
        name: t.text("name").notNull(),
        provider: t.text("provider").$type<"forgejo" | "github" | "gitea">().notNull(),
        serverUrl: t.text("server_url").notNull(),
        clientId: t.text("client_id").notNull(),
        encryptedClientSecret: t.text("encrypted_client_secret").notNull(),
        active: t.boolean("active").notNull().default(true),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
    },
    (table) => [t.index("git_oauth_providers_organization_idx").on(table.organizationId)],
);

export const gitConnections = t.pgTable(
    "git_connections",
    {
        id: t.uuid("id").primaryKey(),
        organizationId: t
            .text("organization_id")
            .notNull()
            .references(() => organization.id, { onDelete: "cascade" }),
        name: t.text("name").notNull(),
        provider: t.text("provider").$type<GitProvider>().notNull(),
        serverUrl: t.text("server_url").notNull(),
        authType: t.text("auth_type").$type<"token" | "oauth">().notNull().default("token"),
        account: t.jsonb("account").$type<GitAccount>(),
        repositories: t.jsonb("repositories").$type<GitKnownRepository[]>().notNull().default([]),
        encryptedCredentials: t.text("encrypted_credentials"),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
        updatedAt: t
            .timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table) => [t.index("git_connections_organization_idx").on(table.organizationId)],
);

export type ResourceGitSource = {
    repositoryUrl: string;
    branch: string;
    path: string;
    revision: string;
    // The commit message of `revision`.
    message: string;
    // Object ids at `revision`: the Compose file's blob and the watched directory's tree.
    // A draft whose blob id differs from `blob` has changes that are not in Git yet.
    blob: string;
    tree: string;
    // Redeploy when a push changes the tree at `watchPath` ("." is the repository root).
    autoDeploy: boolean;
    watchPath: string;
};

// Canvas frames around a project's resources. Layout only: deploys never read it.
export const resourceGroups = t.pgTable(
    "resource_groups",
    {
        id: t.uuid("id").primaryKey(),
        projectId: t
            .uuid("project_id")
            .notNull()
            .references(() => projects.id, { onDelete: "cascade" }),
        name: t.text("name").notNull(),
        icon: t.text("icon"),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
    },
    (table) => [t.index("resource_groups_project_idx").on(table.projectId)],
);

export const resources = t.pgTable(
    "resources",
    {
        id: t.uuid("id").primaryKey(),
        name: t.text("name").notNull(),
        // Permanent prefix of its service and volume names; see `resourceSlug`.
        slug: t
            .text("slug")
            .notNull()
            .$defaultFn(() => resourceSlug()),
        description: t.text("description"),
        icon: t.text("icon"),
        type: t.text("type").default("compose"),
        // Last successfully deployed source; edits are saved separately.
        spec: t.text("spec"),
        draftSpec: t.text("draft_spec"),
        // Edited Git config files (`configs.*.file`, as written in Compose) not committed yet;
        // the next deploy commits them with the draft.
        draftConfigFiles: t.jsonb("draft_config_files").$type<Record<string, string>>(),
        // Staged for deletion: removed when the staged changes are applied, cleared by discard.
        pendingDelete: t.boolean("pending_delete").notNull().default(false),
        settings: t.jsonb("settings"),
        // Migration makes this FK deferred so organization-wide cascades can finish.
        gitConnectionId: t
            .uuid("git_connection_id")
            .references(() => gitConnections.id, { onDelete: "no action" }),
        gitSource: t.jsonb("git_source").$type<ResourceGitSource>(),
        projectId: t
            .uuid("project_id")
            .notNull()
            .references(() => projects.id, { onDelete: "cascade" }),
        // Always a group of the same project; the API checks it on every write.
        groupId: t.uuid("group_id").references(() => resourceGroups.id, { onDelete: "set null" }),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
        updatedAt: t
            .timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table) => [
        t.index("resources_project_idx").on(table.projectId),
        t.index("resources_group_idx").on(table.groupId),
        t.index("resources_git_connection_idx").on(table.gitConnectionId),
        t.uniqueIndex("resources_slug_idx").on(table.slug),
    ],
);

// Private provisioning state. Never return this table through resource/project APIs.
export const clusterMonitoring = t.pgTable("cluster_monitoring", {
    clusterId: t
        .uuid("cluster_id")
        .primaryKey()
        .references(() => clusters.id, { onDelete: "cascade" }),
    projectId: t
        .uuid("project_id")
        .notNull()
        .unique()
        .references(() => projects.id, { onDelete: "cascade" }),
    resourceId: t
        .uuid("resource_id")
        .notNull()
        .unique()
        .references(() => resources.id, { onDelete: "cascade" }),
    encryptedPassword: t.text("encrypted_password").notNull(),
    // MONITORING_VERSION of the last successful deploy; null predates versioning.
    templateVersion: t.integer("template_version"),
});

// "pending" waits for the user to authorize the public key on the server.

export type DeploymentStatus = "queued" | "running" | "ready" | "failed" | "cancelled";

// Where a resource deployment came from. "docker" is a Compose edited in Clowder, without Git.
export type DeploymentMetadata = {
    source: Exclude<GitProvider, "generic"> | "git" | "docker";
    trigger: "manual" | "webhook" | "poll";
    commit?: { sha: string; message: string };
    /** Each service's image with Variables and references resolved, saved by the worker. */
    images?: Record<string, string>;
};

export const deployments = t.pgTable(
    "deployments",
    {
        id: t.uuid("id").primaryKey(),
        clusterId: t
            .uuid("cluster_id")
            .notNull()
            .references(() => clusters.id, { onDelete: "cascade" }),
        name: t.text("name").notNull(),
        resourceId: t.uuid("resource_id").references(() => resources.id, { onDelete: "cascade" }),
        status: t.text("status").notNull().default("queued"),
        // Deterministic effect-mq job id (`${clusterId}:${requestId}`), used by
        // the worker to attach progress to the right deployment.
        jobId: t.text("job_id").notNull().unique(),
        // Compose spec captured at deploy time. Null for cluster initialization.
        spec: t.text("spec"),
        // Null for cluster initialization.
        metadata: t.jsonb("metadata").$type<DeploymentMetadata>(),
        configuration: t.jsonb("configuration").$type<ClusterInitializationConfiguration>(),
        error: t.text("error"),
        progress: t.smallint("progress").notNull().default(0),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
        updatedAt: t
            .timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
        finishedAt: t.timestamp("finished_at", { withTimezone: true }),
    },
    (table) => [
        t.index("deployments_cluster_idx").on(table.clusterId, table.createdAt.desc()),
        // Latest deployment per resource (status badges, history, removal checks).
        t.index("deployments_resource_idx").on(table.resourceId, table.createdAt.desc()),
        // The outbox sweep reads queued rows every few seconds.
        t
            .index("deployments_queued_idx")
            .on(table.name)
            .where(sql`${table.status} = 'queued'`),
    ],
);

export const deploymentLogs = t.pgTable(
    "deployment_logs",
    {
        id: t.bigserial("id", { mode: "number" }).primaryKey(),
        deploymentId: t
            .uuid("deployment_id")
            .notNull()
            .references(() => deployments.id, { onDelete: "cascade" }),
        stream: t.text("stream").notNull().default("build"),
        text: t.text("text").notNull(),
        metadata: t
            .jsonb("metadata")
            .$type<{ level?: "info" | "debug" | "error"; event?: string }>()
            .notNull()
            .default({}),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
    },
    (table) => [t.index("deployment_logs_deployment_idx").on(table.deploymentId, table.id)],
);

// Private deploy inputs (naming prefix, env, recreate). The Compose spec lives on
// deployments.spec so every deployment row carries what it deployed.
export const resourceDeploymentInputs = t.pgTable("resource_deployment_inputs", {
    deploymentId: t
        .uuid("deployment_id")
        .primaryKey()
        .references(() => deployments.id, { onDelete: "cascade" }),
    prefix: t.text("prefix").notNull(),
    env: t.text("env").notNull().default(""),
    recreate: t.boolean("recreate").notNull().default(false),
    // Contents of relative `configs.*.file` paths read from Git, keyed as written in the Compose file.
    configFiles: t.jsonb("config_files").$type<Record<string, string>>().notNull().default({}),
});

// Mirrors `S3ProviderId` in @clowder/s3; the check constraint below keeps the database honest.
export type S3Provider = "generic" | "rustfs" | "r2";

// Account-level provider access; buckets are provisioned as project resources.
export const s3Connections = t.pgTable(
    "s3_connections",
    {
        id: t.uuid("id").primaryKey(),
        organizationId: t
            .text("organization_id")
            .notNull()
            .references(() => organization.id, { onDelete: "cascade" }),
        name: t.text("name").notNull(),
        provider: t.text("provider").$type<S3Provider>().notNull(),
        // R2 derives its endpoint from the account ID.
        endpoint: t.text("endpoint").notNull(),
        region: t.text("region").notNull().default("us-east-1"),
        forcePathStyle: t.boolean("force_path_style").notNull().default(false),
        // Encrypted S3 access-key/secret-key pair. R2 derives it from the API token.
        encryptedCredentials: t.text("encrypted_credentials").notNull(),
        // Provider's account identifier; R2 uses the Cloudflare account ID.
        providerAccountId: t.text("provider_account_id"),
        // Provider management API token, used to mint per-bucket tokens.
        encryptedApiToken: t.text("encrypted_api_token"),
        lastTestedAt: t.timestamp("last_tested_at", { withTimezone: true }),
        lastTestStatus: t.text("last_test_status").$type<"success" | "failure">(),
        lastTestError: t.text("last_test_error"),
        version: t.integer("version").notNull().default(1),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
        updatedAt: t
            .timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table) => [
        t.index("s3_connections_organization_idx").on(table.organizationId),
        t.unique("s3_connections_organization_name_uidx").on(table.organizationId, table.name),
        t.check(
            "s3_connections_provider_check",
            sql`${table.provider} in ('generic', 'rustfs', 'r2')`,
        ),
        t.check(
            "s3_connections_provider_account_check",
            sql`(${table.provider} = 'r2') = (
                ${table.providerAccountId} is not null and ${table.encryptedApiToken} is not null
            )`,
        ),
        t.check(
            "s3_connections_test_status_check",
            sql`${table.lastTestStatus} in ('success', 'failure') or ${table.lastTestStatus} is null`,
        ),
    ],
);

export type S3BucketStatus = "provisioning" | "ready" | "failed" | "deleting";

// Written by the HealthCheck job; null until a bucket is first measured.
export type S3BucketMetadata = {
    /** Total bytes across every object. */
    size: number;
    objects: number;
    /** When the provider took this snapshot (ISO); provider usage APIs lag behind writes. */
    measuredAt: string;
};

// Private state of `bucket` resources. Never return this table through resource/project APIs.
export const s3Buckets = t.pgTable(
    "s3_buckets",
    {
        resourceId: t
            .uuid("resource_id")
            .primaryKey()
            .references(() => resources.id, { onDelete: "cascade" }),
        // No cascade: deleting a connection would lose the credentials needed to revoke keys.
        // Migration makes this FK deferred so organization-wide cascades can finish.
        connectionId: t
            .uuid("connection_id")
            .notNull()
            .references(() => s3Connections.id, { onDelete: "no action" }),
        name: t.text("name").notNull(),
        status: t.text("status").$type<S3BucketStatus>().notNull(),
        // Durable outbox: a new request time is a new job, so retries are not deduplicated away.
        requestedAt: t.timestamp("requested_at", { withTimezone: true }).notNull(),
        error: t.text("error"),
        // Provider key ID and its encrypted key pair; null when the provider shares connection keys.
        keyId: t.text("key_id"),
        encryptedCredentials: t.text("encrypted_credentials"),
        metadata: t.jsonb("metadata").$type<S3BucketMetadata>(),
        // Storage limit in bytes; null means unlimited. Enforced only where the provider supports it.
        quota: t.bigint("quota", { mode: "number" }),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
        updatedAt: t
            .timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table) => [
        t.unique("s3_buckets_connection_name_uidx").on(table.connectionId, table.name),
        t.check(
            "s3_buckets_status_check",
            sql`${table.status} in ('provisioning', 'ready', 'failed', 'deleting')`,
        ),
    ],
);

// Where a sandbox runs: "uncloud" is the project's own cluster. Widen the checks below with each
// new provider integration.
export type SandboxProvider = "uncloud";

// Images an organization offers per provider, all managed by the organization; none are built in.
export const sandboxImages = t.pgTable(
    "sandbox_images",
    {
        id: t.uuid("id").primaryKey(),
        organizationId: t
            .text("organization_id")
            .notNull()
            .references(() => organization.id, { onDelete: "cascade" }),
        provider: t.text("provider").$type<SandboxProvider>().notNull(),
        // An OCI reference on Uncloud, the provider's own image ID elsewhere; also its label in the UI.
        image: t.text("image").notNull(),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
        updatedAt: t
            .timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table) => [
        t
            .unique("sandbox_images_organization_image_uidx")
            .on(table.organizationId, table.provider, table.image),
        t.check("sandbox_images_provider_check", sql`${table.provider} in ('uncloud')`),
    ],
);

export type SandboxStatus = "provisioning" | "running" | "failed" | "destroying";

// A sandbox's disk on an Uncloud cluster. It outlives its sandbox so a new one can reuse it.
/**
 * A Docker volume Clowder keeps track of: a sandbox's disk, or one left on the machines by a
 * destroyed sandbox or a deleted resource, so its data stays reachable until someone deletes it.
 */
export const volumes = t.pgTable(
    "volumes",
    {
        id: t.uuid("id").primaryKey(),
        clusterId: t
            .uuid("cluster_id")
            .notNull()
            .references(() => clusters.id, { onDelete: "cascade" }),
        // Its Docker name on the machines, such as `sandbox-<slug>-data`.
        name: t.text("name").notNull(),
        // Where a sandbox's volume lives; null until its first deploy places it, or for a volume
        // on several machines.
        machine: t.text("machine"),
        // Its card on the canvas while nothing uses it; null while a sandbox mounts it. Deleting the
        // card deletes this row first, so the database never forgets data still on the machines.
        // Migration makes this FK deferred so cluster and organization cascades can finish.
        resourceId: t
            .uuid("resource_id")
            .unique("volumes_resource_uidx")
            .references(() => resources.id),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
    },
    (table) => [t.unique("volumes_cluster_name_uidx").on(table.clusterId, table.name)],
);

// Private state of `sandbox` resources, like `s3_buckets`. Never return this table through
// resource/project APIs. Each provisioning or destroy attempt is a deployment of the resource.
export const sandboxes = t.pgTable(
    "sandboxes",
    {
        resourceId: t
            .uuid("resource_id")
            .primaryKey()
            .references(() => resources.id, { onDelete: "cascade" }),
        // Owns the slug namespace; projects only reach their organization through a cluster.
        organizationId: t
            .text("organization_id")
            .notNull()
            .references(() => organization.id, { onDelete: "cascade" }),
        // An adjective-noun generated by the client, such as "brave-otter", and the VM's hostname.
        // Its service and volume are `sandbox-<slug>` (see `sandboxServiceName`).
        slug: t.text("slug").notNull(),
        provider: t.text("provider").$type<SandboxProvider>().notNull(),
        // The Uncloud cluster it runs on, chosen by the user; null for other providers.
        clusterId: t.uuid("cluster_id").references(() => clusters.id, { onDelete: "cascade" }),
        // Uncloud machine name to pin it to; null lets Uncloud place it. The machine needs /dev/kvm.
        machine: t.text("machine"),
        // Host port published to the VM's port 22 on Uncloud.
        sshPort: t.integer("ssh_port"),
        // Where to SSH to: the machine's public IP, recorded once the sandbox runs.
        sshHost: t.text("ssh_host"),
        volumeId: t.uuid("volume_id").references(() => volumes.id, { onDelete: "set null" }),
        // The chosen image pinned to its digest at creation, so retries boot the same image.
        image: t.text("image").notNull(),
        status: t.text("status").$type<SandboxStatus>().notNull().default("provisioning"),
        // The provider's handle for it: the Uncloud service, or the provider's instance ID.
        externalId: t.text("external_id"),
        // Login is any of these. Authorized keys are public; the password is kept to re-provision
        // the VM and goes with the row.
        authorizedKeys: t.text("authorized_keys"),
        password: encryptedText("password", "sandbox-password"),
        // Passed to the VM as `SANDBOX_TTL_SECONDS`; the microVM shuts itself down once it expires.
        ttlSeconds: t.integer("ttl_seconds"),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
        updatedAt: t
            .timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table) => [
        t.check("sandboxes_provider_check", sql`${table.provider} in ('uncloud')`),
        t.check(
            "sandboxes_status_check",
            sql`${table.status} in ('provisioning', 'running', 'failed', 'destroying')`,
        ),
        t.check("sandboxes_ttl_check", sql`${table.ttlSeconds} is null or ${table.ttlSeconds} > 0`),
        t.unique("sandboxes_organization_slug_uidx").on(table.organizationId, table.slug),
        // Uncloud's service name rule, with room for the `sandbox-` prefix.
        t.check(
            "sandboxes_slug_check",
            sql`${table.slug} ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' and length(${table.slug}) <= 55`,
        ),
        t.check(
            "sandboxes_cluster_check",
            sql`(${table.provider} = 'uncloud') = (${table.clusterId} is not null and ${table.sshPort} is not null)`,
        ),
        t.check(
            "sandboxes_ssh_port_check",
            sql`${table.sshPort} is null or ${table.sshPort} between 1 and 65535`,
        ),
        // Destroying a sandbox deletes its row, so a taken port or volume is always a live one.
        t.unique("sandboxes_cluster_ssh_port_uidx").on(table.clusterId, table.sshPort),
        t.unique("sandboxes_volume_uidx").on(table.volumeId),
    ],
);

export type NotificationEvent = "deployment.succeeded" | "deployment.failed";

/** Where a channel delivers. Webhook URLs and bot tokens are credentials. */
export type NotificationChannelConfig =
    | { type: "discord"; webhookUrl: string }
    | { type: "telegram"; botToken: string; chatId: string }
    | { type: "ntfy"; serverUrl: string; topic: string; token?: string }
    | { type: "gchat"; webhookUrl: string }
    | { type: "webhook"; url: string; secret?: string };

export type NotificationChannelType = NotificationChannelConfig["type"];

// Where an organization hears about deployments settling. The destination is never returned to
// the browser; changing it means adding the channel again.
export const notificationChannels = t.pgTable(
    "notification_channels",
    {
        id: t.uuid("id").primaryKey(),
        organizationId: t
            .text("organization_id")
            .notNull()
            .references(() => organization.id, { onDelete: "cascade" }),
        name: t.text("name").notNull(),
        type: t.text("type").$type<NotificationChannelType>().notNull(),
        // JSON of `NotificationChannelConfig`, including its type.
        config: encryptedText("config", "notification-channel").notNull(),
        events: t.jsonb("events").$type<NotificationEvent[]>().notNull(),
        enabled: t.boolean("enabled").notNull().default(true),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
        updatedAt: t
            .timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table) => [
        t.index("notification_channels_organization_idx").on(table.organizationId),
        t.check(
            "notification_channels_type_check",
            sql`${table.type} in ('discord', 'telegram', 'ntfy', 'gchat', 'webhook')`,
        ),
    ],
);

export * from "./auth";
