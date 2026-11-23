import { type SerializedPageTree, useFumadocsLoader } from "fumadocs-core/source/client";
import type { TOCItemType } from "fumadocs-core/toc";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import {
    DocsDescription,
    DocsPage,
    DocsTitle,
    MarkdownCopyButton,
    ViewOptionsPopover,
} from "fumadocs-ui/layouts/docs/page";
import { Provider, type ProviderProps } from "@/components/provider";
import type { RepoStats } from "@/lib/shared";
import { docsOptions, sidebarOptions } from "@/lib/layout.shared";

export interface DocsProps extends ProviderProps {
    tree: SerializedPageTree;
    title: string;
    description?: string;
    toc: TOCItemType[];
    markdownUrl: string;
    githubUrl: string;
    repoStats: RepoStats | null;
}

/**
 * The React island of docs pages, the content is passed as children.
 */
export function Docs({
    tree,
    title,
    description,
    toc,
    markdownUrl,
    githubUrl,
    repoStats,
    children,
    ...props
}: DocsProps) {
    const data = useFumadocsLoader({ tree });

    return (
        <Provider {...props}>
            <DocsLayout {...docsOptions(repoStats)} sidebar={sidebarOptions} tree={data.tree}>
                <DocsPage toc={toc}>
                    <div className="flex justify-between border-b">
                        <div>
                            <DocsTitle>{title}</DocsTitle>
                            <DocsDescription>{description}</DocsDescription>
                        </div>
                        <div className="flex flex-row gap-2 items-center -mt-4 pb-6">
                            <MarkdownCopyButton markdownUrl={markdownUrl} />
                            <ViewOptionsPopover markdownUrl={markdownUrl} githubUrl={githubUrl} />
                        </div>
                    </div>
                    {children}
                </DocsPage>
            </DocsLayout>
        </Provider>
    );
}
