import { useQuery } from "@tanstack/react-query";
import { Check, ExternalLink } from "lucide-react";
import { useMemo, useState, type ComponentType } from "react";

import { AnthropicMark, OpenAIMark, ReplitMark } from "../components/brand-marks";
import { Meta, MetaItem, Page, PageHeader } from "../components/page";
import { Alert } from "../components/ui/alert";
import { ButtonLink, ExternalButtonLink } from "../components/ui/button-link";
import { Card, CardContent } from "../components/ui/card";
import { CodeBlock, codeSurfaceClass } from "../components/ui/code-block";
import { CopyButton } from "../components/ui/copy-button";
import { Disclosure } from "../components/ui/disclosure";
import { ExampleBubble } from "../components/ui/example-bubble";
import { GlossaryTerm } from "../components/ui/glossary-term";
import { ExternalTextLink } from "../components/ui/link";
import { Step, StepHint } from "../components/ui/step";
import { TabPanel, Tabs } from "../components/ui/tabs";
import { api } from "../lib/api";
import { useTranslation, type Translator } from "../lib/i18n";
import { cn } from "../lib/utils";
import {
  buildMcpConnectionDetails,
  connectClientOrder,
  defaultConnectClient,
  isPubliclyReachableOrigin,
  type ConnectClientId,
} from "../lib/mcp-connection";

const clientMarks: Record<ConnectClientId, ComponentType<{ className?: string }>> = {
  chatgpt: OpenAIMark,
  claudeDesktop: AnthropicMark,
  claudeCode: AnthropicMark,
  codex: OpenAIMark,
  replit: ReplitMark,
};

function connectTabLabel(id: ConnectClientId, t: Translator): string {
  switch (id) {
    case "chatgpt":
      return t("connect.tabs.chatgpt");
    case "claudeDesktop":
      return t("connect.tabs.claudeDesktop");
    case "claudeCode":
      return t("connect.tabs.claudeCode");
    case "codex":
      return t("connect.tabs.codex");
    case "replit":
      return t("connect.tabs.replit");
  }
}

function UnreachableWarning({ client }: { client: string }) {
  const t = useTranslation();
  return (
    <Alert title={t("connect.reachability.title")} tone="warning">
      {t("connect.reachability.body", { client })}
    </Alert>
  );
}

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="grid max-w-prose list-decimal gap-1.5 pl-5 text-[13px] leading-relaxed text-foreground">
      {items.map((item) => <li key={item}>{item}</li>)}
    </ol>
  );
}

export function ConnectPage() {
  const t = useTranslation();
  // The admin console and the MCP endpoint are served from the same public
  // origin (compose.yaml routes "/mcp" to the engine and "/admin" to this
  // console on the same host), so the browser's own origin is always the
  // right value — no server round-trip needed to learn it.
  const origin = window.location.origin;
  const details = useMemo(() => buildMcpConnectionDetails(origin), [origin]);
  const reachable = useMemo(() => isPubliclyReachableOrigin(origin), [origin]);
  const [tab, setTab] = useState<ConnectClientId>(() => defaultConnectClient(reachable));
  const identity = useQuery({
    queryKey: ["me"],
    queryFn: ({ signal }) => api.me(signal),
    refetchInterval: 5_000,
  });
  const connected = identity.data?.connectedClientCount ?? 0;

  const tabItems = connectClientOrder(reachable).map((id) => ({
    id,
    label: connectTabLabel(id, t),
    icon: clientMarks[id],
  }));

  return (
    <Page>
      <PageHeader
        description={t("connect.pageDescription")}
        title={t("nav.connect.label")}
        {...(connected > 0
          ? {
              meta: (
                <Meta>
                  <MetaItem tone="success">
                    <Check aria-hidden="true" />
                    {t("connect.status.connected", { count: connected })}
                  </MetaItem>
                </Meta>
              ),
            }
          : {})}
      />

      {!reachable && (
        <Alert title={t("connect.reachability.localTitle")} tone="warning">
          {t("connect.reachability.localBody")}
        </Alert>
      )}

      <Card>
        <CardContent className="grid divide-y divide-border/60 p-0 sm:p-0">
          <Step number={1} title={t("connect.steps.pick")}>
            <Tabs items={tabItems} label={t("connect.tabs.label")} onChange={(id) => setTab(id as ConnectClientId)} value={tab} />
          </Step>

          <Step number={2} title={t("connect.serverUrl.title")}>
            <div className={cn("flex max-w-xl items-center justify-between gap-3 px-3 py-2", codeSurfaceClass)}>
              <code className="min-w-0 truncate font-mono text-[13px]">{details.serverUrl}</code>
              <span className="group/copy inline-flex shrink-0">
                <CopyButton className="opacity-100" label={t("connect.serverUrl.copyLabel")} value={details.serverUrl} />
              </span>
            </div>
            <StepHint>{t("connect.serverUrl.description")}</StepHint>
          </Step>

          <Step number={3} title={t("connect.steps.setUp", { app: connectTabLabel(tab, t) })}>
            <TabPanel active={tab === "claudeCode"} id="claudeCode">
              <StepHint>{t("connect.claudeCode.description")}</StepHint>
              <CodeBlock className="max-w-xl" copyLabel={t("connect.claudeCode.copyLabel")} label={t("connect.claudeCode.title")} value={details.claudeCodeCommand} />
            </TabPanel>

            <TabPanel active={tab === "claudeDesktop"} id="claudeDesktop">
              {!reachable && <UnreachableWarning client={t("connect.tabs.claudeDesktop")} />}
              <StepHint>{t("connect.claudeDesktop.description")}</StepHint>
              <Steps items={[t("connect.claudeDesktop.step1"), t("connect.claudeDesktop.step2"), t("connect.claudeDesktop.step3"), t("connect.claudeDesktop.step4")]} />
            </TabPanel>

            <TabPanel active={tab === "codex"} id="codex">
              <StepHint>{t("connect.codex.description")}</StepHint>
              <CodeBlock className="max-w-xl" copyLabel={t("connect.codex.addCommandCopyLabel")} label={t("connect.codex.addCommandLabel")} value={details.codexAddCommand} />
              <StepHint>{t("connect.codex.loginHint")}</StepHint>
              <CodeBlock className="max-w-xl" copyLabel={t("connect.codex.loginCommandCopyLabel")} label={t("connect.codex.loginCommandLabel")} value={details.codexLoginCommand} />
              <Disclosure size="sm" summary={t("connect.codex.manualToggle")}>
                <div className="grid gap-2">
                  <StepHint>{t("connect.codex.manualDescription")}</StepHint>
                  <CodeBlock className="max-w-xl" copyLabel={t("connect.codex.tomlCopyLabel")} label={t("connect.codex.tomlLabel")} value={details.codexConfigToml} />
                </div>
              </Disclosure>
            </TabPanel>

            <TabPanel active={tab === "chatgpt"} id="chatgpt">
              {!reachable && <UnreachableWarning client={t("connect.tabs.chatgpt")} />}
              <StepHint>{t("connect.chatgpt.description")}</StepHint>
              <Steps items={[t("connect.chatgpt.step1"), t("connect.chatgpt.step2"), t("connect.chatgpt.step3"), t("connect.chatgpt.step4")]} />
              <StepHint>{t("connect.chatgpt.availabilityNote")}</StepHint>
              {!reachable && (
                <ExternalTextLink className="text-[13px]" href="https://developers.openai.com/api/docs/guides/secure-mcp-tunnels">
                  {t("connect.chatgpt.secureTunnelLink")} <ExternalLink aria-hidden="true" />
                </ExternalTextLink>
              )}
            </TabPanel>

            <TabPanel active={tab === "replit"} id="replit">
              {!reachable && <UnreachableWarning client={t("connect.tabs.replit")} />}
              <StepHint>{t("connect.replit.description")}</StepHint>
              <ExternalButtonLink className="w-fit" href={details.replitInstallUrl} size="sm" variant="outline">
                <ReplitMark />
                {t("connect.replit.installButtonLabel")} <ExternalLink aria-hidden="true" />
              </ExternalButtonLink>
              <StepHint>{t("connect.replit.manualHint")}</StepHint>
            </TabPanel>
          </Step>

          <Step done={connected > 0} number={4} title={t("connect.steps.signIn")}>
            <StepHint>{t("connect.steps.signInBody")}</StepHint>
            <Disclosure size="sm" summary={t("connect.howItWorks.title")}>
              <div className="grid max-w-prose gap-2 text-[13px] leading-relaxed text-muted-foreground">
                <p>{t("connect.auth.body")}</p>
                <p>
                  {t("connect.howItWorks.body")}{" "}
                  <GlossaryTerm id="mcp" variant="text">
                    {t("connect.intro.whatIsMcpLink")}
                  </GlossaryTerm>
                </p>
              </div>
            </Disclosure>
          </Step>

          <Step number={5} title={t("connect.test.title")}>
            <StepHint>{t("connect.test.description")}</StepHint>
            <div className="grid max-w-xl gap-2">
              <ExampleBubble copyLabel={t("connect.test.rememberCopyLabel")} text={t("connect.test.rememberPrompt")} />
              <ExampleBubble copyLabel={t("connect.test.recallCopyLabel")} text={t("connect.test.recallPrompt")} />
            </div>
            <p className="text-xs text-muted-foreground">{t("connect.test.statusHint")}</p>
          </Step>
        </CardContent>
      </Card>
      <ButtonLink className="w-fit" to="/agent-resources" variant="outline">
        {t("agentResources.title")}
      </ButtonLink>
    </Page>
  );
}
