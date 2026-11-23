import { appSecret, databaseUrl } from "@clowder/config/env";
import { createDb, type Database } from "@clowder/db";
import {
    appendDeploymentLog,
    getDeploymentByJobId,
    setDeploymentStatus,
} from "@clowder/db/deployments";
import { markBucketFailed, pendingBucketRequests } from "@clowder/db/buckets";
import { markSandboxFailed } from "@clowder/db/sandboxes";
import { listOutdatedMonitoring, setInitializationStatus } from "@clowder/db/initialization";
import { s3FailureMessage } from "@clowder/s3";
import { JobSchedules, JobStore, Worker } from "effect-mq";
import { Cause, Effect, Layer } from "effect";
import { addMachine } from "./add-machine";
import { createInitializeClusterHandler } from "./initialize-cluster";
import { MONITORING_VERSION } from "./monitoring-compose";
import { deployResource, RESOURCE_FAILURE_MESSAGE } from "./deploy-resource";
import { runHealthCheck } from "./health-check";
import {
    AddMachine,
    DeployResource,
    HealthCheck,
    InitializeCluster,
    ProvisionCluster,
    ReconcileBucket,
    DestroySandbox,
    ProvisionSandbox,
    RollOutMonitoring,
    SendNotification,
    WatchGitSources,
} from "./jobs";
import { deliverNotification, notifyDeploymentSettled } from "./notifications/send";
import { provisionCluster } from "./provision-cluster";
import { reconcileBucket } from "./reconcile-bucket";
import { destroySandbox, provisionSandbox } from "./sandbox";
import { JobStoreLive, PgLive } from "./store";

// One pool for the whole worker; it ends when the worker layer is released.
const WorkerDb = Effect.acquireRelease(
    Effect.sync(() => createDb({ DATABASE_URL: databaseUrl() })),
    (db) => Effect.promise(() => db.$client.end()).pipe(Effect.ignore),
);

const TERMINAL_FAILURE_MESSAGE =
    "Cluster monitoring initialization failed. Check the selected machine and sidecar connectivity, then retry.";

// Plain async attempt. The AbortSignal comes from Effect.callback and aborts on
// interruption, timeout, or cancel so deployMonitoring stops promptly.
async function runAttemptAsync(
    db: Database,
    clusterId: string,
    requestId: string,
    signal: AbortSignal,
) {
    const jobId = `${clusterId}:${requestId}`;

    await setInitializationStatus(db, clusterId, "running", null).catch(() => {});
    const deployment = await getDeploymentByJobId(db, jobId).catch(() => null);

    if (deployment?.status === "cancelled") return;

    if (deployment && deployment.status !== "running") {
        await setDeploymentStatus(db, deployment.id, "running").catch(() => {});
    }

    signal.throwIfAborted();

    const handler = createInitializeClusterHandler(
        db,
        appSecret(),
        deployment ? { deploymentId: deployment.id } : undefined,
    );

    try {
        await handler(clusterId, signal);
    } catch (error) {
        // Handler errors are fixed redacted strings, safe for the log.
        // Skipped on abort: interruption releases the job without an attempt.
        if (!signal.aborted && deployment) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Cluster monitoring initialization failed.";

            await appendDeploymentLog(db, deployment.id, `Step failed: ${message}`, {
                level: "error",
            }).catch(() => {});
        }

        throw error;
    }

    if (deployment) {
        await setDeploymentStatus(db, deployment.id, "ready").catch(() => {});
    }

    await setInitializationStatus(db, clusterId, "ready", null).catch(() => {});

    if (deployment) await notifyDeploymentSettled(db, deployment.id);
}

// Never rolls monitoring backward: a newer version's job waits for a newer worker, and a stale
// one deploys this worker's newer version instead (the handler skips clusters already current).
async function rollOutMonitoring(
    db: Database,
    clusterId: string,
    version: number,
    signal: AbortSignal,
) {
    if (version > MONITORING_VERSION)
        throw new Error(`Monitoring v${version} needs a newer worker than v${MONITORING_VERSION}.`);

    await createInitializeClusterHandler(db, appSecret(), { rollout: true })(clusterId, signal);
}

function runAttempt(db: Database, clusterId: string, requestId: string) {
    return attempt(
        (signal) => runAttemptAsync(db, clusterId, requestId, signal),
        () => new Error(TERMINAL_FAILURE_MESSAGE),
    );
}

// Runs one attempt on the worker's pool. Interruption aborts the signal, then the returned effect
// drains pending writes and releases the lock before effect-mq invokes its terminal failure hook.
function attempt(run: (signal: AbortSignal) => Promise<void>, failure: (error: Error) => Error) {
    return Effect.callback<void>((resume, signal) => {
        const done = run(signal).then(
            () => resume(Effect.void),
            (error) =>
                resume(
                    Effect.die(failure(error instanceof Error ? error : new Error(String(error)))),
                ),
        );

        return Effect.promise(() => done);
    });
}

type GitWatcher = (db: Database, signal: AbortSignal, connectionId?: string) => Promise<void>;

// The Git watcher lives in @clowder/api (it needs Git and deploy logic), which depends on this
// package, so the worker bootstrap passes it in.
function jobHandlersLive(db: Database, watchGitSources: GitWatcher) {
    return Layer.mergeAll(
        InitializeCluster.toLayer(
            (payload) => runAttempt(db, payload.clusterId, payload.requestId),
            {
                concurrency: 1,
            },
        ),
        DeployResource.toLayer(
            ({ deploymentId }) =>
                attempt(
                    (signal) =>
                        deployResource(db, deploymentId, signal).then(() =>
                            notifyDeploymentSettled(db, deploymentId),
                        ),
                    // Keep the redacted failure (and its unrecoverable mark), never a raw cause.
                    (error) =>
                        error.message === RESOURCE_FAILURE_MESSAGE
                            ? error
                            : new Error(RESOURCE_FAILURE_MESSAGE),
                ),
            { concurrency: 4 },
        ),
        ProvisionCluster.toLayer(
            ({ deploymentId }) =>
                attempt(
                    (signal) =>
                        provisionCluster(db, deploymentId, signal).then(() =>
                            notifyDeploymentSettled(db, deploymentId),
                        ),
                    // provisionCluster records its own failure; uc's messages carry no secrets.
                    (error) => error,
                ),
            { concurrency: 2 },
        ),
        AddMachine.toLayer(
            ({ deploymentId }) =>
                attempt(
                    (signal) =>
                        addMachine(db, deploymentId, signal).then(() =>
                            notifyDeploymentSettled(db, deploymentId),
                        ),
                    // addMachine records its own failure; uc's messages carry no secrets.
                    (error) => error,
                ),
            { concurrency: 2 },
        ),
        ReconcileBucket.toLayer(
            ({ resourceId, requestId }) =>
                attempt(
                    (signal) => reconcileBucket(db, resourceId, requestId, signal),
                    (error) => new Error(s3FailureMessage(error)),
                ),
            { concurrency: 2 },
        ),
        ProvisionSandbox.toLayer(
            ({ deploymentId }) =>
                attempt(
                    (signal) =>
                        provisionSandbox(db, deploymentId, signal).then(() =>
                            notifyDeploymentSettled(db, deploymentId),
                        ),
                    // provisionSandbox records its own failure; deployCompose masks the password.
                    (error) => error,
                ),
            { concurrency: 2 },
        ),
        DestroySandbox.toLayer(
            ({ deploymentId }) =>
                attempt(
                    (signal) =>
                        destroySandbox(db, deploymentId, signal).then(() =>
                            notifyDeploymentSettled(db, deploymentId),
                        ),
                    // destroySandbox records its own failure; uc's messages carry no secrets.
                    (error) => error,
                ),
            { concurrency: 2 },
        ),
        RollOutMonitoring.toLayer(
            ({ clusterId, version }) =>
                attempt(
                    (signal) => rollOutMonitoring(db, clusterId, version, signal),
                    (error) => error,
                ),
            { concurrency: 1 },
        ),
        HealthCheck.toLayer(
            ({ clusterId }) =>
                attempt(
                    (signal) => runHealthCheck(db, signal, clusterId),
                    (error) => error,
                ),
            { concurrency: 1 },
        ),
        WatchGitSources.toLayer(
            ({ connectionId }) =>
                attempt(
                    (signal) => watchGitSources(db, signal, connectionId),
                    (error) => error,
                ),
            // A webhook check runs beside a slow poll instead of waiting behind it; row locks keep both safe.
            { concurrency: 2 },
        ),
        SendNotification.toLayer(
            ({ deploymentId, channelId }) =>
                attempt(
                    (signal) => deliverNotification(db, deploymentId, channelId, signal),
                    // Status codes and resolver errors only; response bodies are never read.
                    (error) => error,
                ),
            { concurrency: 4 },
        ),
    );
}

// Top of every hour, UTC.
const HEALTH_CHECK_CRON = "0 * * * *";

const GIT_WATCH_CRON = "* * * * *";

// Upserted on startup. Each tick is claimed atomically, so it runs once across web replicas.
export const SchedulesLive = JobSchedules.layer({
    group: "stoat",
    schedules: [
        JobSchedules.schedule(HealthCheck, "hourly", { cron: HEALTH_CHECK_CRON, payload: {} }),
        JobSchedules.schedule(WatchGitSources, "minutely", { cron: GIT_WATCH_CRON, payload: {} }),
    ],
    // Schedules dropped from this list are removed after the grace window.
    removal: "group",
    removeAfter: "10 minutes",
});

async function recordBucketFailureAsync(db: Database, failure: Worker.JobFailure) {
    if (failure.willRetry) return;

    // effect-mq ids are `ReconcileBucket/<resourceId>:<requestId>`.
    const key = failure.jobId.slice(failure.jobId.indexOf("/") + 1);
    const separator = key.indexOf(":");
    const cause = Cause.squash(failure.cause);

    // The handler only dies with messages built by s3FailureMessage; timeouts carry their own.
    await markBucketFailed(
        db,
        key.slice(0, separator),
        new Date(key.slice(separator + 1)),
        cause instanceof Error ? cause.message : "Bucket job failed.",
    );
}

// The job's own message when an attempt failed without recording one.
function deploymentFailureMessage(name: string) {
    if (name === "ProvisionCluster") return "Setting up the cluster failed.";

    if (name === "AddMachine") return "Adding the machine failed.";

    if (name === "ProvisionSandbox") return "Creating the sandbox failed.";

    if (name === "DestroySandbox") return "Destroying the sandbox failed.";

    return RESOURCE_FAILURE_MESSAGE;
}

// effect-mq namespaces deterministic ids as `<JobName>/<idempotencyKey>`; deployments store the key.
function jobKey(jobId: string) {
    return jobId.includes("/") ? jobId.slice(jobId.indexOf("/") + 1) : jobId;
}

// A retry settles later, so only the last attempt's outcome is news.
async function notifyFailure(db: Database, failure: Worker.JobFailure) {
    if (failure.willRetry) return;
    const deployment = await getDeploymentByJobId(db, jobKey(failure.jobId)).catch(() => null);

    if (deployment) await notifyDeploymentSettled(db, deployment.id);
}

async function recordFailureAsync(db: Database, failure: Worker.JobFailure) {
    // Matches our `${clusterId}:${requestId}` shape once the prefix is stripped.
    const key = jobKey(failure.jobId);
    const sep = key.indexOf(":");
    const clusterId = sep === -1 ? key : key.slice(0, sep);
    const deployment = key ? await getDeploymentByJobId(db, key).catch(() => null) : null;

    // A user-cancelled deployment already carries its final state.
    if (deployment?.status === "cancelled") return;

    if (failure.name === "InitializeCluster" && failure.willRetry) {
        if (!deployment || !["queued", "running"].includes(deployment.status)) return;

        await appendDeploymentLog(
            db,
            deployment.id,
            `Attempt ${failure.attempt} of ${failure.attemptsMax} failed; retrying.`,
            { level: "error", event: "retry" },
        );
        await setDeploymentStatus(db, deployment.id, "queued", TERMINAL_FAILURE_MESSAGE).catch(
            () => {},
        );
        await setInitializationStatus(db, clusterId, "retrying", null).catch(() => {});

        return;
    }

    if (
        failure.name === "DeployResource" ||
        failure.name === "ProvisionCluster" ||
        failure.name === "AddMachine" ||
        failure.name === "ProvisionSandbox" ||
        failure.name === "DestroySandbox"
    ) {
        if (!deployment || !["queued", "running"].includes(deployment.status)) return;
        const cause = Cause.squash(failure.cause);
        const timedOut = Cause.isTimeoutError(cause);

        const reason = timedOut
            ? cause.message
            : (deployment.error ?? deploymentFailureMessage(failure.name));

        // The attempt already logged its own reason; only timeouts are new here.
        const text = timedOut ? reason : "Deployment failed.";

        await appendDeploymentLog(db, deployment.id, text, {
            level: "error",
            event: "failed",
        });
        await setDeploymentStatus(db, deployment.id, "failed", reason);

        // A timed-out attempt never reached its own catch, so the sandbox is settled here.
        if (
            (failure.name === "ProvisionSandbox" || failure.name === "DestroySandbox") &&
            deployment.resourceId
        )
            await markSandboxFailed(db, deployment.resourceId, failure.name);

        return;
    }

    if (deployment) {
        await appendDeploymentLog(db, deployment.id, TERMINAL_FAILURE_MESSAGE, {
            level: "error",
            event: "failed",
        });
        await setDeploymentStatus(db, deployment.id, "failed", TERMINAL_FAILURE_MESSAGE).catch(
            () => {},
        );
    }

    if (clusterId) {
        await setInitializationStatus(db, clusterId, "failed", TERMINAL_FAILURE_MESSAGE).catch(
            () => {},
        );
    }
}

function workerLive(db: Database) {
    return Worker.layer({
        queues: {
            initialize: { concurrency: 1 },
            deploy: { concurrency: 4 },
            buckets: { concurrency: 2 },
            sandboxes: { concurrency: 2 },
            monitoring: { concurrency: 1 },
            health: { concurrency: 1 },
            git: { concurrency: 2 },
            provision: { concurrency: 2 },
            machines: { concurrency: 2 },
            notifications: { concurrency: 4 },
        },
        lockDuration: "10 minutes",
        // effect-mq also delivers cross-process cancellation on this heartbeat.
        lockRenewInterval: "2 seconds",
        stalledInterval: "1 minute",
        maxStalledCount: 2,
        onJobFailure: (failure) => {
            if (failure.name === "ReconcileBucket")
                return Effect.promise(() => recordBucketFailureAsync(db, failure)).pipe(
                    Effect.ignore,
                );

            if (
                failure.name !== "DeployResource" &&
                failure.name !== "ProvisionCluster" &&
                failure.name !== "AddMachine" &&
                failure.name !== "ProvisionSandbox" &&
                failure.name !== "DestroySandbox" &&
                failure.name !== "InitializeCluster"
            )
                return Effect.void;

            return Effect.promise(() =>
                recordFailureAsync(db, failure).finally(() => notifyFailure(db, failure)),
            ).pipe(Effect.ignore);
        },
    });
}

export function monitoringWorkerLive(watchGitSources: GitWatcher) {
    return Layer.unwrap(
        Effect.map(WorkerDb, (db) =>
            Layer.mergeAll(jobHandlersLive(db, watchGitSources), SchedulesLive).pipe(
                Layer.provideMerge(workerLive(db)),
                Layer.provideMerge(JobStoreLive),
            ),
        ),
    );
}

// Enqueue (or re-enqueue) initialization for a cluster. Idempotent per
// (clusterId, requestId) via the job's idempotencyKey.
export function enqueueInitialization(clusterId: string, requestId: string) {
    return InitializeCluster.enqueue({ clusterId, requestId });
}

export async function queueResourceDeployment(deploymentId: string): Promise<void> {
    await Effect.runPromise(
        DeployResource.enqueue({ deploymentId }).pipe(Effect.provide(JobStoreLive)),
    );
}

// A push webhook fired: check that connection's resources now instead of on the next tick.
export async function queueGitWatch(connectionId: string): Promise<void> {
    await Effect.runPromise(
        WatchGitSources.enqueue({ connectionId }).pipe(Effect.provide(JobStoreLive)),
    );
}

// The bucket row is the durable outbox if enqueue is temporarily unavailable.
export async function queueBucketReconcile(resourceId: string, requestedAt: Date): Promise<void> {
    await Effect.runPromise(
        ReconcileBucket.enqueue({ resourceId, requestId: requestedAt.toISOString() }).pipe(
            Effect.provide(JobStoreLive),
        ),
    );
}

// At most one manual run per cluster a minute, however often the button is pressed.
export async function queueClusterHealthCheck(clusterId: string): Promise<void> {
    await Effect.runPromise(
        HealthCheck.enqueue(
            { clusterId },
            { dedupe: { key: `cluster:${clusterId}`, ttl: "1 minute" } },
        ).pipe(Effect.provide(JobStoreLive)),
    );
}

/**
 * Best-effort cancel of a queued or running deployment job.
 * effect-mq namespaces the stored jobId internally, which is added here. Never throws:
 * a missing or already-settled job simply means there is nothing to stop.
 */
export async function cancelDeploymentJob(
    jobId: string,
    name:
        | "InitializeCluster"
        | "DeployResource"
        | "ProvisionCluster"
        | "AddMachine"
        | "ProvisionSandbox"
        | "DestroySandbox" = "InitializeCluster",
): Promise<void> {
    try {
        const job = {
            InitializeCluster,
            DeployResource,
            ProvisionCluster,
            AddMachine,
            ProvisionSandbox,
            DestroySandbox,
        }[name];

        const program = job
            .cancel(JobStore.JobId(`${name}/${jobId}`))
            .pipe(Effect.provide(JobStoreLive));

        await Effect.runPromise(program);
    } catch {
        /* ignore: already settled or never enqueued */
    }
}

async function pollOutboxAsync(db: Database) {
    const initialization = await db.$client.query<{ clusterId: string; requestedAt: Date }>(
        `SELECT id AS "clusterId", initialization_requested_at AS "requestedAt" FROM clusters
         WHERE initialization_status = 'queued' AND initialization_requested_at IS NOT NULL
         AND initialised_at IS NULL`,
    );

    const queued = await db.$client.query<{ deploymentId: string; name: string }>(
        `SELECT id AS "deploymentId", name FROM deployments
         WHERE status = 'queued' AND name IN ('DeployResource', 'ProvisionCluster', 'AddMachine', 'ProvisionSandbox', 'DestroySandbox')`,
    );

    const buckets = await pendingBucketRequests(db);
    // Every worker checks on every sweep, so a cluster whose init an older worker finishes
    // mid-update is still caught. Older workers find nothing: their version is never higher.
    const monitoring = await listOutdatedMonitoring(db, MONITORING_VERSION);

    return {
        initialization: initialization.rows,
        resources: queued.rows.filter((row) => row.name === "DeployResource"),
        buckets,
        monitoring,
        provisions: queued.rows.filter((row) => row.name === "ProvisionCluster"),
        machines: queued.rows.filter((row) => row.name === "AddMachine"),
        sandboxes: queued.rows.filter(
            (row) => row.name === "ProvisionSandbox" || row.name === "DestroySandbox",
        ),
    };
}

// Sweep durable request rows, never deployment logs. Every job type is idempotent.
export function pollInitializationOutbox(db: Database) {
    return Effect.promise(() => pollOutboxAsync(db)).pipe(
        Effect.flatMap(
            ({ initialization, resources, buckets, monitoring, provisions, machines, sandboxes }) =>
                Effect.forEach(
                    [
                        ...initialization.map((row) =>
                            enqueueInitialization(row.clusterId, row.requestedAt.toISOString()),
                        ),
                        ...resources.map(({ deploymentId }) =>
                            DeployResource.enqueue({ deploymentId }),
                        ),
                        ...buckets.map((row) =>
                            ReconcileBucket.enqueue({
                                resourceId: row.resourceId,
                                requestId: row.requestedAt.toISOString(),
                            }),
                        ),
                        ...monitoring.map(({ clusterId }) =>
                            RollOutMonitoring.enqueue({ clusterId, version: MONITORING_VERSION }),
                        ),
                        ...provisions.map(({ deploymentId }) =>
                            ProvisionCluster.enqueue({ deploymentId }),
                        ),
                        ...machines.map(({ deploymentId }) => AddMachine.enqueue({ deploymentId })),
                        ...sandboxes.map(({ deploymentId, name }) =>
                            (name === "DestroySandbox" ? DestroySandbox : ProvisionSandbox).enqueue(
                                {
                                    deploymentId,
                                },
                            ),
                        ),
                    ],
                    (enqueue) => enqueue.pipe(Effect.catch(() => Effect.void)),
                ),
        ),
        Effect.catch(() => Effect.void),
    );
}

export { JobStoreLive, PgLive };

export {
    DeployResource,
    HealthCheck,
    InitializeCluster,
    ProvisionCluster,
    ReconcileBucket,
    DestroySandbox,
    ProvisionSandbox,
    RollOutMonitoring,
};

export type { Database };
