"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ViewKey =
  | "landing"
  | "login"
  | "register"
  | "enroll"
  | "student-dashboard"
  | "student-course"
  | "student-lesson"
  | "student-quiz"
  | "student-homework"
  | "student-notifications"
  | "student-progress"
  | "student-exam"
  | "student-bookmarks"
  | "student-scheduler"
  | "student-referral"
  | "student-leaderboard"
  | "student-achievements"
  | "student-certificate"
  | "parent-dashboard"
  | "parent-report"
  | "teacher-dashboard"
  | "teacher-attendance"
  | "teacher-quizzes"
  | "teacher-homework"
  | "teacher-templates"
  | "teacher-analytics"
  | "admin-overview"
  | "admin-students"
  | "admin-teachers"
  | "admin-groups"
  | "admin-courses"
  | "admin-payments"
  | "admin-subscriptions"
  | "admin-coupons"
  | "admin-question-bank"
  | "admin-notifications"
  | "admin-settings";

type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: "STUDENT" | "PARENT" | "TEACHER" | "ADMIN";
  avatarUrl?: string | null;
};

type AppState = {
  // navigation
  view: ViewKey;
  setView: (v: ViewKey) => void;
  navParam: string | null;
  setNavParam: (p: string | null) => void;

  // session
  user: SessionUser | null;
  setUser: (u: SessionUser | null) => void;
  logout: () => Promise<void>;

  // ui
  sidebarOpen: boolean;
  setSidebar: (v: boolean) => void;
  theme: "light" | "dark";
  toggleTheme: () => void;
  locale: "ar" | "en";
  setLocale: (v: "ar" | "en") => void;

  // landing nav
  scrollTo: (id: string) => void;
};

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      view: "landing",
      setView: (view) => set({ view, navParam: null }),
      navParam: null,
      setNavParam: (navParam) => set({ navParam }),

      user: null,
      setUser: (user) => set({ user }),
      logout: async () => {
        await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
        set({ user: null, view: "landing" });
      },

      sidebarOpen: true,
      setSidebar: (sidebarOpen) => set({ sidebarOpen }),
      theme: "light",
      toggleTheme: () => {
        const next = get().theme === "light" ? "dark" : "light";
        set({ theme: next });
        if (typeof document !== "undefined") {
          document.documentElement.classList.toggle("dark", next === "dark");
          try {
            localStorage.setItem("cm-theme", next);
          } catch {}
        }
      },
      locale: "ar",
      setLocale: (locale) => {
        set({ locale });
        if (typeof document !== "undefined") {
          document.documentElement.lang = locale === "ar" ? "ar" : "en";
          document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
          try {
            localStorage.setItem("cm-locale", locale);
            // Mirror to a cookie so API routes can localize server-side too.
            document.cookie = `cm-locale=${locale}; path=/; max-age=31536000; samesite=lax`;
          } catch {}
        }
      },

      scrollTo: (id) => {
        if (typeof document === "undefined") return;
        const el = document.getElementById(id);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      },
    }),
    {
      name: "cm-app",
      partialize: (s) => ({ theme: s.theme, locale: s.locale } as any),
    }
  )
);

export const homeViewForRole = (role: SessionUser["role"]): ViewKey => {
  switch (role) {
    case "STUDENT":
      return "student-dashboard";
    case "PARENT":
      return "parent-dashboard";
    case "TEACHER":
      return "teacher-dashboard";
    case "ADMIN":
      return "admin-overview";
  }
};
