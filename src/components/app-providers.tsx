"use client";

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useApp } from "@/lib/store";

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      })
  );
  return (
    <QueryClientProvider client={client}>
      <GlobalUiHydration />
      {children}
    </QueryClientProvider>
  );
}

/**
 * Applies persisted theme + locale globally on every page load —
 * including public / pre-login pages — so Dark mode and EN/AR work
 * before the user ever logs in.
 */
function GlobalUiHydration() {
  React.useEffect(() => {
    try {
      const storedTheme =
        localStorage.getItem("cm-theme") ||
        (useApp.getState().theme as string) ||
        "light";
      if (storedTheme === "dark") {
        document.documentElement.classList.add("dark");
      } else if (storedTheme === "light") {
        document.documentElement.classList.remove("dark");
      }
    } catch {}
    try {
      const storedLocale = localStorage.getItem("cm-locale");
      const locale =
        storedLocale === "en" || storedLocale === "ar"
          ? storedLocale
          : useApp.getState().locale || "ar";
      document.documentElement.lang = locale === "ar" ? "ar" : "en";
      document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
      if (locale !== useApp.getState().locale) {
        useApp.getState().setLocale(locale as "ar" | "en");
      }
    } catch {}
  }, []);
  return null;
}
