import { useQuery } from "@tanstack/react-query";
import { BrainCircuit, LogIn } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";

import { ErrorState, LoadingState } from "../components/async-state";
import { AppShell } from "../components/app-shell";
import { LocaleToggle } from "../components/locale-toggle";
import { ThemeToggle } from "../components/theme-toggle";
import { Alert } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { api } from "../lib/api";
import { useLocale, useTranslation } from "../lib/i18n";
import {
  beginOAuthAuthorization,
  completeOAuthAuthorization,
  hasPreviousOAuthSignIn,
  OAuthSilentRecoveryError,
  signOutOAuth,
  useOAuthSession,
} from "../lib/oauth";

const recoveryAttemptKey = "second-brain-admin.oauth.recovery-attempted";

function AuthFrame({ children }: { children: React.ReactNode }) {
  const t = useTranslation();
  return (
    <main className="relative isolate grid min-h-screen place-items-center overflow-hidden bg-background p-4 outline-none" id="main-content" tabIndex={-1}>
      <div aria-hidden="true" className="aurora-glow auth-aurora" />
      <div className="absolute right-4 top-4 z-20 flex items-center gap-2">
        <LocaleToggle />
        <ThemeToggle />
      </div>
      <div className="relative z-10 w-full max-w-md animate-rise">
        <div className="mb-8 flex flex-col items-center justify-center gap-3 text-center">
          <div className="aurora flex size-12 items-center justify-center rounded-xl shadow-md">
            <BrainCircuit aria-hidden="true" className="size-6" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-foreground">{t("shell.appName")}</h1>
            <p className="text-sm text-muted-foreground">{t("shell.adminConsole")}</p>
          </div>
        </div>
        {children}
      </div>
    </main>
  );
}

function requestedDestination(state: unknown): string {
  if (typeof state !== "object" || state === null || !("from" in state)) return "/";
  const from = (state as { from?: unknown }).from;
  return typeof from === "string" && from.startsWith("/") && !from.startsWith("//") ? from : "/";
}

export function LoginPage() {
  const location = useLocation();
  const session = useOAuthSession();
  const t = useTranslation();
  const { locale } = useLocale();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (session.authenticated) return <Navigate replace to="/" />;
  const destination = requestedDestination(location.state);

  useEffect(() => {
    if (!hasPreviousOAuthSignIn() || sessionStorage.getItem(recoveryAttemptKey) === "true") return;
    sessionStorage.setItem(recoveryAttemptKey, "true");
    setPending(true);
    void beginOAuthAuthorization(destination, { prompt: "none", locale }).catch((failure: unknown) => {
      setPending(false);
      setError(failure instanceof Error ? failure.message : t("auth.login.startFailedFallback"));
    });
  }, [destination, locale, t]);

  async function authorize() {
    setPending(true);
    setError(null);
    try {
      sessionStorage.removeItem(recoveryAttemptKey);
      await beginOAuthAuthorization(destination, { locale });
    } catch (failure) {
      setPending(false);
      setError(failure instanceof Error ? failure.message : t("auth.login.startFailedFallback"));
    }
  }

  return (
    <AuthFrame>
      <Card className="shadow-lg">
        <CardHeader className="text-center">
          <CardTitle className="text-lg">{t("auth.login.title")}</CardTitle>
          <CardDescription>
            {t("auth.login.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {error && <Alert title={t("auth.login.authFailedTitle")} tone="danger">{error}</Alert>}
          <Button className="w-full" loading={pending} onClick={() => void authorize()} size="lg">
            {!pending && <LogIn aria-hidden="true" />}
            {pending ? t("auth.login.pending") : t("auth.login.submit")}
          </Button>
          <p className="text-center text-xs leading-relaxed text-muted-foreground">{t("auth.login.tokenNotice")}</p>
        </CardContent>
      </Card>
    </AuthFrame>
  );
}

export function OAuthCallbackPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const started = useRef(false);
  const t = useTranslation();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void completeOAuthAuthorization(location.search)
      .then((returnTo) => {
        sessionStorage.removeItem(recoveryAttemptKey);
        navigate(returnTo, { replace: true });
      })
      .catch((failure: unknown) => {
        if (failure instanceof OAuthSilentRecoveryError) {
          navigate("/login", { replace: true });
          return;
        }
        setError(failure instanceof Error ? failure.message : t("auth.callback.fallback"));
      });
  }, [location.search, navigate, t]);

  if (error === null) return <AuthFrame><LoadingState label={t("auth.callback.loading")} /></AuthFrame>;
  return (
    <AuthFrame>
      <Card>
        <CardHeader>
          <CardTitle>{t("auth.callback.failedTitle")}</CardTitle>
          <CardDescription>{t("auth.callback.failedDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Alert title={t("auth.callback.alertTitle")} tone="danger">{error}</Alert>
          <Button onClick={() => navigate("/login", { replace: true })}>{t("auth.callback.returnToSignIn")}</Button>
        </CardContent>
      </Card>
    </AuthFrame>
  );
}

export function ProtectedRoute() {
  const location = useLocation();
  const session = useOAuthSession();
  if (!session.authenticated) return <Navigate replace state={{ from: `${location.pathname}${location.search}` }} to="/login" />;
  return <AppPermissionGate />;
}

function AppPermissionGate() {
  const t = useTranslation();
  const me = useQuery({ queryKey: ["me"], queryFn: ({ signal }) => api.me(signal), retry: false });
  if (me.isPending) return <main className="grid min-h-screen place-items-center p-6"><LoadingState label={t("auth.permission.verifying")} /></main>;
  if (me.isError) return <main className="grid min-h-screen place-items-center p-6"><div className="max-w-lg"><ErrorState error={me.error} /><Button className="mt-4" onClick={() => void signOutOAuth()}>{t("shell.signOut")}</Button></div></main>;
  if (me.data.role !== "admin" && me.data.role !== "owner") return <main className="grid min-h-screen place-items-center p-6"><Alert title={t("auth.permission.deniedTitle")} tone="danger">{t("auth.permission.deniedBody", { role: t(`status.role.${me.data.role}`) })}</Alert></main>;
  return <AppShell identity={me.data} />;
}
