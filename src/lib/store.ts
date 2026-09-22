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
  | "student-session-videos"
  | "student-bookmarks"
  | "student-scheduler"
  | "student-sessions"
  | "student-absences"
  | "student-referral"
  | "student-leaderboard"
  | "student-achievements"
  | "student-certificate"
  | "parent-dashboard"
  | "parent-report"
  | "parent-absences"
  | "parent-notifications"
  | "teacher-dashboard"
  | "teacher-sessions"
  | "teacher-attendance"
  | "teacher-live-sessions"
  | "teacher-quizzes"
  | "teacher-homework"
  | "teacher-templates"
  | "teacher-analytics"
  | "teacher-notifications"
  | "teacher-readiness"
  | "admin-overview"
  | "admin-students"
  | "admin-teachers"
  | "admin-groups"
  | "admin-courses"
  | "admin-sessions"
  | "admin-live-sessions"
  | "admin-payments"
  | "admin-subscriptions"
  | "admin-coupons"
  | "admin-question-bank"
  | "admin-notifications"
  | "admin-session-videos"
  | "admin-mock-exams"
  | "admin-quiz-review"
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
  courseSlug: string | null;
  lessonId: string | null;
  quizId: string | null;
  homeworkId: string | null;
  // Phase I — the Parent's SELECTED CHILD. Session-scoped on purpose (it is
  // NOT persisted): a fresh tab must start from the parent's own first linked
  // child rather than replaying a stale id. It is a UI convenience only —
  // every Parent API re-verifies the ParentStudentLink server-side, so a wrong
  // id resolves to 404 instead of another child's data.
  parentChildId: string | null;
  setParentChildId: (id: string | null) => void;
  setCourseSlug: (p: string | null) => void;
  setLessonId: (p: string | null) => void;
  setQuizId: (p: string | null) => void;
  setHomeworkId: (p: string | null) => void;

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
      courseSlug: null,
      lessonId: null,
      quizId: null,
      homeworkId: null,
      setCourseSlug: (courseSlug) => set({ courseSlug }),
      setLessonId: (lessonId) => set({ lessonId }),
      setQuizId: (quizId) => set({ quizId }),
      setHomeworkId: (homeworkId) => set({ homeworkId }),
      parentChildId: null,
      setParentChildId: (parentChildId) => set({ parentChildId }),

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
