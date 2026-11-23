import type { GitProvider } from "@clowder/db/schema/index";

export type { GitProvider };

// Client-safe catalog of Git connection providers. Order drives the order of provider pickers.
// Every one but "generic" talks to its forge through the `forges` client (see provider.ts).
export const gitProviders = [
    "forgejo",
    "github",
    "gitlab",
    "gitea",
    "bitbucket",
    "gitee",
    "gitcafe",
    "pushin",
    "upstream",
    "generic",
] as const satisfies readonly GitProvider[];

export type GitForge = Exclude<GitProvider, "generic">;

// Forgejo and Gitea share GitHub's /login/oauth endpoints; the other forges take access tokens only.
export const gitOAuthProviderKinds = ["forgejo", "github", "gitea"] as const satisfies GitForge[];

/** The provider as an OAuth kind, or `undefined` when it takes access tokens only. */
export function gitOAuthProviderKind(provider: GitProvider) {
    return gitOAuthProviderKinds.find((kind) => kind === provider);
}

export const gitProviderLabels: Record<GitProvider, string> = {
    forgejo: "Forgejo",
    github: "GitHub",
    gitlab: "GitLab",
    gitea: "Gitea",
    bitbucket: "Bitbucket",
    gitee: "Gitee",
    gitcafe: "GitCafe",
    pushin: "Pushin",
    upstream: "Upstream",
    generic: "Generic Git server",
};

// The public instance new connections start from; Forgejo and generic servers have none.
export const gitProviderServerUrls: Partial<Record<GitProvider, string>> = {
    github: "https://github.com",
    gitlab: "https://gitlab.com",
    gitea: "https://gitea.com",
    bitbucket: "https://bitbucket.org",
    gitee: "https://gitee.com",
    gitcafe: "https://git.cafe",
    pushin: "https://pushin.eu",
    upstream: "https://upstream.codes",
};
