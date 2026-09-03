"use client";

import dynamic from "next/dynamic";
import { ErrorBoundary } from "@/components/error-boundary";

// AppShell pulls in many client components (framer-motion etc.).
// Load it client-side only to avoid SSR hydration mismatches with theme.
const AppShell = dynamic(
  () => import("@/components/app-shell").then((m) => m.AppShell),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-screen flex items-center justify-center bg-mesh">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
          <div className="text-sm text-muted-foreground">CodeMind Academy</div>
        </div>
      </div>
    ),
  }
);

export default function Home() {
  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  );
}
