import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ToastProvider } from "./components/ui/toast";
import { LocaleProvider } from "./lib/i18n";
import { ThemeProvider } from "./lib/theme";
import { AppRouter } from "./router";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocaleProvider>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <AppRouter />
          </ToastProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </LocaleProvider>
  </StrictMode>,
);
