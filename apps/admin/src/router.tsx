import { Compass } from "lucide-react";
import { lazy, Suspense, useEffect } from "react";
import { PageSkeleton } from "./components/async-state";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";

import { RouteErrorBoundary } from "./components/route-error-boundary";
import { ButtonLink } from "./components/ui/button-link";

import { useLocale, useTranslation } from "./lib/i18n";
import { routeTitle } from "./lib/navigation";
import { LoginPage, OAuthCallbackPage, ProtectedRoute } from "./routes/auth";

const RemindersPage = lazy(() => import("./routes/reminders").then((module) => ({ default: module.RemindersPage })));
const HomePage = lazy(() => import("./routes/home").then((module) => ({ default: module.HomePage })));
const ProjectsPage = lazy(() => import("./routes/projects").then((module) => ({ default: module.ProjectsPage })));
const ProjectPage = lazy(() => import("./routes/projects").then((module) => ({ default: module.ProjectPage })));
const LearningPage = lazy(() => import("./routes/learning").then((module) => ({ default: module.LearningPage })));
const LearningDreamingPage = lazy(() => import("./routes/learning").then((module) => ({ default: module.LearningDreamingPage })));
const LearningIngestionPage = lazy(() => import("./routes/learning").then((module) => ({ default: module.LearningIngestionPage })));
const UsagePage = lazy(() => import("./routes/usage").then((module) => ({ default: module.UsagePage })));
const AuditPage = lazy(() => import("./routes/audit").then((module) => ({ default: module.AuditPage })));
const BrainPacksPage = lazy(() => import("./routes/brain-packs").then((module) => ({ default: module.BrainPacksPage })));
const BrainPackExportPage = lazy(() => import("./routes/brain-pack-export").then((module) => ({ default: module.BrainPackExportPage })));
const BrainPackImportStartPage = lazy(() => import("./routes/brain-packs").then((module) => ({ default: module.BrainPackImportStartPage })));
const BrainPackImportRunPage = lazy(() => import("./routes/brain-packs").then((module) => ({ default: module.BrainPackImportRunPage })));
const BrainMapPage = lazy(() => import("./routes/brain-map").then((module) => ({ default: module.BrainMapPage })));
const ConfigurationPage = lazy(() => import("./routes/configuration").then((module) => ({ default: module.ConfigurationPage })));
const ConnectPage = lazy(() => import("./routes/connect").then((module) => ({ default: module.ConnectPage })));
const AgentResourcesPage = lazy(() => import("./routes/agent-resources").then((module) => ({ default: module.AgentResourcesPage })));
const DashboardPage = lazy(() => import("./routes/dashboard").then((module) => ({ default: module.DashboardPage })));
const DreamingPage = lazy(() => import("./routes/dreaming").then((module) => ({ default: module.DreamingPage })));
const DreamingRunPage = lazy(() => import("./routes/dreaming").then((module) => ({ default: module.DreamingRunPage })));
const GettingStartedPage = lazy(() => import("./routes/getting-started").then((module) => ({ default: module.GettingStartedPage })));
const JobsPage = lazy(() => import("./routes/jobs").then((module) => ({ default: module.JobsPage })));
const KnowledgeBasePage = lazy(() => import("./routes/knowledge").then((module) => ({ default: module.KnowledgeBasePage })));
const KnowledgeDocumentPage = lazy(() => import("./routes/knowledge").then((module) => ({ default: module.KnowledgeDocumentPage })));
const KnowledgePage = lazy(() => import("./routes/knowledge").then((module) => ({ default: module.KnowledgePage })));
const MemoriesPage = lazy(() => import("./routes/memories").then((module) => ({ default: module.MemoriesPage })));

export function AppRouter() {
  return <BrowserRouter basename="/admin"><RouteErrorBoundary><Suspense fallback={<PageSkeleton />}><Routes>
    <Route element={<LoginPage />} path="login" />
    <Route element={<OAuthCallbackPage />} path="oauth/callback" />
    <Route element={<ProtectedRoute />}>
      <Route element={<HomePage />} index />
      <Route element={<DashboardPage />} path="status" />
      <Route element={<GettingStartedPage />} path="getting-started" />
      <Route element={<ConnectPage />} path="connect" />
      <Route element={<AgentResourcesPage />} path="agent-resources" />
      <Route element={<BrainMapPage />} path="brain-map" />
      <Route element={<ConfigurationPage />} path="configuration/environment" />
      <Route element={<DreamingPage />} path="automation/dreaming" />
      <Route element={<DreamingRunPage />} path="automation/dreaming/runs/:runId" />
      <Route element={<RemindersPage />} path="reminders" />
      <Route element={<HomeRedirect />} path="briefing" />
      <Route element={<HomeRedirect />} path="ask" />
      <Route element={<ProjectsPage />} path="projects" />
      <Route element={<ProjectPage />} path="projects/:projectId" />
      <Route element={<LearningPage />} path="learning" />
      <Route element={<LearningDreamingPage />} path="learning/dreaming/:changeId" />
      <Route element={<LearningIngestionPage />} path="learning/ingestion/:runId" />
      <Route element={<UsagePage />} path="usage" />
      <Route element={<JobsPage />} path="automation/jobs" />
      <Route element={<MemoriesPage />} path="memories" />
      <Route element={<KnowledgePage />} path="knowledge" />
      <Route element={<BrainPacksPage />} path="knowledge/packs" />
      <Route element={<BrainPackExportPage />} path="knowledge/packs/export" />
      <Route element={<BrainPackImportStartPage />} path="knowledge/packs/import" />
      <Route element={<BrainPackImportRunPage />} path="knowledge/packs/imports/:runId" />
      <Route element={<KnowledgeBasePage />} path="knowledge/:baseId" />
      <Route element={<KnowledgeDocumentPage />} path="knowledge/:baseId/documents/:documentId" />
      <Route element={<NotFoundPage />} path="*" />
      <Route element={<AuditPage />} path="audit" />
    </Route>
  </Routes><RouteEffects /></Suspense></RouteErrorBoundary></BrowserRouter>;
}

/** The former Ask and Daily briefing pages now live on Home; keep their links and queries working. */
function HomeRedirect() {
  const { search } = useLocation();
  return <Navigate replace to={{ pathname: "/", search }} />;
}

function RouteEffects() {
  const location = useLocation();
  const { locale } = useLocale();
  const t = useTranslation();
  useEffect(() => {
    document.title = `${routeTitle(location.pathname, locale)} | ${t("router.documentTitleSuffix")}`;
    const frame = window.requestAnimationFrame(() => {
      const main = document.getElementById("main-content");
      const target = main?.querySelector<HTMLElement>("[data-route-focus]") ?? main;
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [location.pathname, locale, t]);
  return null;
}

function NotFoundPage() {
  const t = useTranslation();
  return (
    <div className="grid min-h-[60vh] place-items-center text-center">
      <div className="flex max-w-md flex-col items-center">
        <div className="mb-5 flex size-12 items-center justify-center rounded-xl border border-border bg-muted/60 text-muted-foreground">
          <Compass aria-hidden="true" className="size-6" />
        </div>
        <span className="rounded-full border border-border bg-muted/40 px-3 py-1 text-xs font-medium text-muted-foreground">
          {t("router.notFoundBadge")}
        </span>
        <h1 className="mt-4 text-2xl font-medium tracking-tight text-foreground sm:text-3xl">{t("route.notFound")}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t("router.notFoundDescription")}</p>
        <ButtonLink className="mt-6" to="/">
          {t("router.returnToDashboard")}
        </ButtonLink>
      </div>
    </div>
  );
}
