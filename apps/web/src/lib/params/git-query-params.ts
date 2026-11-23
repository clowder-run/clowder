import { gitProviders } from "@clowder/api/git/providers";
import { createSerializer, parseAsBoolean, parseAsString, parseAsStringLiteral } from "nuqs-svelte";

export {
    gitOAuthProviderKind,
    gitProviderLabels,
    gitProviders,
    gitProviderServerUrls,
    type GitProvider,
} from "@clowder/api/git/providers";

// Only non-secret fields belong in the URL.
export const connectionFormParsers = {
    name: parseAsString,
    provider: parseAsStringLiteral(gitProviders),
    authMode: parseAsStringLiteral(["token", "oauth"]),
    credentialType: parseAsStringLiteral(["https", "ssh"]),
    oauthProviderId: parseAsString,
    setupExpanded: parseAsBoolean,
};

export const connectionDialogParsers = {
    connectionId: parseAsString,
    dialog: parseAsString,
    edit: parseAsString,
};

const serializeDialog = createSerializer(connectionDialogParsers);

const serializeForm = createSerializer(connectionFormParsers);

export function connectionDialogUrl(
    url: URL,
    dialog: "add-connection" | "edit-connection" | null,
    edit: string | null = null,
    saved = false,
) {
    const previousEdit = url.searchParams.get("edit");
    const clearDraft = saved || (dialog !== null && edit !== previousEdit);

    return (
        serializeDialog(clearDraft ? serializeForm(url, null) : url, {
            dialog,
            edit: dialog === null && !saved ? previousEdit : edit,
        }) + url.hash
    );
}
