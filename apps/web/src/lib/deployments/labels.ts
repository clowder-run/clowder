/** Names for workflow jobs that deploy no resource; a resource deployment shows the resource. */
export const jobLabels = new Map([
    ["InitializeCluster", "Cluster initialization"],
    ["DeployCaddy", "Caddy deployment"],
    ["ProvisionCluster", "Cluster creation"],
    ["AddMachine", "New machine"],
    ["ProvisionSandbox", "New sandbox"],
    ["DestroySandbox", "Sandbox removal"],
]);

/** Where a deployment's code came from, as in "via GitHub". */
export const sourceLabels = {
    forgejo: "Forgejo",
    github: "GitHub",
    git: "Git",
    docker: "Docker",
};
