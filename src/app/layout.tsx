import type { Metadata } from "next";
// Self-hosted fonts (no network dependency at build time):
// - Cairo variable (Arabic + Latin) from the google/fonts repo (OFL).
// - Geist Mono from the `geist` npm package.
import localFont from "next/font/local";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { AppProviders } from "@/components/app-providers";

const cairo = localFont({
  src: "../fonts/Cairo-Variable.ttf",
  variable: "--font-cairo",
  display: "swap",
});

export const metadata: Metadata = {
  title: "CodeMind Academy",
  description:
    "CodeMind Academy is a modern educational platform for learning programming, artificial intelligence, and digital skills through structured lessons, interactive assessments, and guided learning experiences.",
  keywords: [
    "CodeMind",
    "CodeMind Academy",
    "Programming",
    "AI",
    "Egyptian Baccalaureate",
    "تعليم",
    "برمجة",
    "ذكاء اصطناعي",
    "ثانوية عامة",
  ],
  authors: [{ name: "CodeMind Academy" }],
  manifest: "/manifest.json",
  openGraph: {
    title: "CodeMind Academy",
    description:
      "CodeMind Academy is a modern educational platform for learning programming, artificial intelligence, and digital skills through structured lessons, interactive assessments, and guided learning experiences.",
    siteName: "CodeMind Academy",
    type: "website",
    locale: "ar_EG",
  },
  twitter: {
    card: "summary_large_image",
    title: "CodeMind Academy",
    description:
      "CodeMind Academy is a modern educational platform for learning programming, artificial intelligence, and digital skills through structured lessons, interactive assessments, and guided learning experiences.",
  },
};

export const viewport = {
  themeColor: "#10b981",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <body
        className={`${cairo.variable} ${GeistMono.variable} font-sans antialiased bg-background text-foreground min-h-screen`}
        suppressHydrationWarning
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem
          disableTransitionOnChange
        >
          <AppProviders>{children}</AppProviders>
          <Toaster />
          <Sonner position="top-center" richColors closeButton />
        </ThemeProvider>
      </body>
    </html>
  );
}
