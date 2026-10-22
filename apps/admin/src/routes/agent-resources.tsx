import { Download, Plug } from "lucide-react";

import { Page, PageHeader } from "../components/page";
import { buttonVariants } from "../components/ui/button";
import { ButtonLink } from "../components/ui/button-link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { codeSurfaceClass } from "../components/ui/code-block";
import { CopyButton } from "../components/ui/copy-button";
import { Disclosure } from "../components/ui/disclosure";
import { agentResources } from "../lib/agent-resources";
import { useTranslation } from "../lib/i18n";
import { cn } from "../lib/utils";

export function AgentResourcesPage() {
  const t = useTranslation();

  return (
    <Page>
      <PageHeader
        actions={
          <ButtonLink size="sm" to="/connect" variant="outline">
            <Plug aria-hidden="true" />
            {t("nav.connect.label")}
          </ButtonLink>
        }
        description={t("agentResources.description")}
        title={t("agentResources.title")}
      />
      <p className="max-w-3xl text-[13px] leading-relaxed text-muted-foreground">{t("agentResources.languageHint")}</p>
      <div className="grid gap-4">
        {agentResources.map((resource) => {
          const title = t(resource.titleKey);
          return (
            <Card key={resource.id}>
              <CardHeader>
                <CardTitle>{title}</CardTitle>
                <CardDescription>{t(resource.descriptionKey)}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4">
                <p className="max-w-3xl text-[13px] leading-relaxed text-muted-foreground">{t(resource.usageKey)}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    aria-label={t("agentResources.downloadLabel", { title })}
                    className={buttonVariants({ size: "sm", variant: "outline" })}
                    download={resource.filename}
                    href={`data:text/markdown;charset=utf-8,${encodeURIComponent(resource.content)}`}
                  >
                    <Download aria-hidden="true" />
                    {t("agentResources.download")}
                  </a>
                  <CopyButton className="size-8 opacity-100" label={title} value={resource.content} />
                </div>
                <Disclosure size="sm" summary={t("agentResources.preview", { title })}>
                  <pre
                    aria-label={title}
                    className={cn("max-h-96 overflow-auto whitespace-pre-wrap break-words p-3.5 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/20", codeSurfaceClass)}
                    lang="en"
                    role="region"
                    tabIndex={0}
                  >
                    {resource.content}
                  </pre>
                </Disclosure>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </Page>
  );
}
