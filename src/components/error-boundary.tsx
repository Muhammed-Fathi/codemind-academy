"use client";

import * as React from "react";
import { translate } from "@/lib/i18n";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";

type Props = {
  children: React.ReactNode;
};

type State = {
  hasError: boolean;
  error?: Error;
};

/**
 * ErrorBoundary — catches unhandled render errors and shows a friendly
 * Egyptian Arabic fallback with retry/home actions instead of a white screen.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: undefined });
  };

  handleHome = () => {
    this.setState({ hasError: false, error: undefined });
    if (typeof window !== "undefined") {
      window.location.href = "/";
    }
  };

  render() {
    if (this.state.hasError) {
      // Class component — read the locale non-reactively (error screens are
      // transient; the dictionary is static anyway).
      const t = (key: string) =>
        translate(
          useApp.getState().locale === "en" ? "en" : "ar",
          key
        );
      return (
        <div className="min-h-screen flex items-center justify-center bg-mesh p-6">
          <div className="max-w-md w-full text-center">
            <div className="mx-auto w-16 h-16 rounded-2xl bg-amber-100 dark:bg-amber-500/10 flex items-center justify-center mb-5">
              <AlertTriangle className="w-8 h-8 text-amber-600 dark:text-amber-400" />
            </div>
            <h1 className="text-2xl font-extrabold mb-2">
              {t("app.002")}
            </h1>
            <p className="text-sm text-muted-foreground mb-6 leading-relaxed">
              {t("app.003")}
            </p>
            <div className="flex items-center justify-center gap-3">
              <Button onClick={this.handleReset} className="font-bold">
                <RefreshCw className="w-4 h-4 ms-2" />
                {t("app.004")}
              </Button>
              <Button variant="outline" onClick={this.handleHome}>
                <Home className="w-4 h-4 ms-2" />
                {t("app.005")}
              </Button>
            </div>
            {this.state.error?.message && (
              <details className="mt-6 text-start text-xs text-muted-foreground">
                <summary className="cursor-pointer text-center">
                  {t("app.006")}
                </summary>
                <pre className="mt-2 p-3 rounded-md bg-muted overflow-x-auto whitespace-pre-wrap break-words">
                  {this.state.error.message}
                </pre>
              </details>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
