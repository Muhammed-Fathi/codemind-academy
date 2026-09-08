"use client";
import { useT , pickAuto } from "@/lib/i18n";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useApp, homeViewForRole } from "@/lib/store";
import { LandingHero } from "@/components/landing/hero";
import {
  WhySection,
  JourneySection,
  CurriculumSection,
  FeaturesSection,
  ParentSection,
  PricingSection,
  FaqSection,
  TestimonialSection,
  FinalCtaSection,
  Footer,
} from "@/components/landing/sections";
import { AuthView } from "@/components/auth/auth-view";
import { EnrollView } from "@/components/auth/enroll-view";
import { DashboardShell } from "@/components/dashboard/shell";
import { KodgyAssistant } from "@/components/kodgy/kodgy-assistant";
import { StudentDashboard } from "@/components/student/student-dashboard";
import { ParentDashboard } from "@/components/parent/parent-dashboard";
import { TeacherDashboard } from "@/components/teacher/teacher-dashboard";
import { AdminDashboard } from "@/components/admin/admin-dashboard";
import { StudentCourseView } from "@/components/course/student-course";
import { StudentLessonView } from "@/components/course/student-lesson";
import { QuizRunner } from "@/components/course/quiz-runner";
import { MockExamRunner } from "@/components/student/mock-exam";
import { BookmarksView } from "@/components/student/bookmarks-view";
import { CertificateView } from "@/components/student/certificate-view";
import { StudySchedulerView } from "@/components/student/study-scheduler";
import { ReferralView } from "@/components/student/referral-view";
import { LeaderboardView } from "@/components/student/leaderboard-view";
import { AchievementsView } from "@/components/student/achievements-view";
import { StudentSessionVideosView } from "@/components/course/session-videos-view";

const pageTransition = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const },
};

export function AppShell() {
  const t = useT();
  const view = useApp((s) => s.view);
  const user = useApp((s) => s.user);

  // Restore session on mount
  React.useEffect(() => {
    // Password reset links arrive as /?token=… — open the auth view directly
    // so ForgotPasswordForm can pre-fill the token from the URL.
    const resetToken = new URLSearchParams(window.location.search).get("token");
    const initialView: "login" | "landing" = resetToken ? "login" : "landing";
    if (resetToken) useApp.getState().setView("login");

    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => {
        if (u) {
          useApp.getState().setUser(u);
          const currentView = useApp.getState().view;
          // If we are on a public/landing page, or the current view doesn't
          // belong to the authenticated user's role (e.g. a stale student
          // view surviving after an admin login), redirect to the correct
          // role home. This prevents ADMINs from accidentally rendering a
          // STUDENT-only component that would hit /api/students/me/* and 403.
          if (currentView === "landing" || !isViewForRole(currentView, u.role)) {
            useApp.getState().setView(homeViewForRole(u.role));
          }
        } else {
          // No session; open the reset form for reset links, otherwise force
          // landing (defensive in case of stale state).
          useApp.getState().setView(initialView);
        }
      })
      .catch(() => {});
  }, []);

  // Landing
  if (view === "landing") {
    return (
      <div className="min-h-screen flex flex-col">
        <main className="flex-1">
          <LandingHero />
          <WhySection />
          <JourneySection />
          <CurriculumSection />
          <FeaturesSection />
          <ParentSection />
          <PricingSection />
          <TestimonialSection />
          <FaqSection />
          <FinalCtaSection />
        </main>
        <Footer />
      </div>
    );
  }

  // Auth views
  if (view === "login" || view === "register") {
    return (
      <div className="min-h-screen flex flex-col bg-mesh">
        <AuthView />
        <Footer />
      </div>
    );
  }

  // Enrollment flow (requires auth)
  if (view === "enroll") {
    if (!user) {
      return (
        <div className="min-h-screen flex flex-col bg-mesh">
          <AuthView />
          <Footer />
        </div>
      );
    }
    return (
      <DashboardShell>
        <AnimatePresence mode="wait">
          <motion.div key="enroll" {...pageTransition}>
            <EnrollView />
          </motion.div>
        </AnimatePresence>
      </DashboardShell>
    );
  }

  // Dashboard route — require auth, otherwise go to landing
  if (!user) {
    // try to fetch user, while showing a minimal loading
    return (
      <div className="min-h-screen flex items-center justify-center bg-mesh">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex flex-col items-center gap-3"
        >
          <div className="w-8 h-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
          <div className="text-sm text-muted-foreground">{t("app.001")}</div>
        </motion.div>
      </div>
    );
  }

  // Map view to dashboard page
  return (
    <>
      <DashboardShell>
        <AnimatePresence mode="wait">
          <motion.div key={view} {...pageTransition}>
            {renderView(view, user?.role)}
          </motion.div>
        </AnimatePresence>
      </DashboardShell>
      <KodgyAssistant />
    </>
  );
}

function renderView(view: string, role?: string | null) {
  // Role-aware default: never render a student-only component for non-students
  // (the old default silently fell through to <StudentDashboard/> which would
  // call /api/students/me/* and 403 for admins).
  const fallback = (() => {
    switch (role) {
      case "ADMIN":
        return <AdminDashboard />;
      case "TEACHER":
        return <TeacherDashboard />;
      case "PARENT":
        return <ParentDashboard />;
      default:
        return <StudentDashboard />;
    }
  })();

  switch (view) {
    case "student-dashboard":
    case "student-homework":
    case "student-notifications":
    case "student-progress":
      return <StudentDashboard />;
    case "student-course":
      return <StudentCourseView />;
    case "student-lesson":
      return <StudentLessonView />;
    case "student-quiz":
      return <QuizRunner />;
    case "student-session-videos":
      return <StudentSessionVideosView />;
    case "student-exam":
      return <MockExamRunner />;
    case "student-bookmarks":
      return <BookmarksView />;
    case "student-scheduler":
      return <StudySchedulerView />;
    case "student-referral":
      return <ReferralView />;
    case "student-leaderboard":
      return <LeaderboardView />;
    case "student-achievements":
      return <AchievementsView />;
    case "student-certificate":
      return <CertificateView />;
    case "parent-dashboard":
    case "parent-report":
      return <ParentDashboard />;
    case "teacher-dashboard":
    case "teacher-attendance":
    case "teacher-quizzes":
    case "teacher-homework":
    case "teacher-templates":
    case "teacher-analytics":
      return <TeacherDashboard />;
    // All admin-* views route to the AdminDashboard shell
    case "admin-overview":
    case "admin-students":
    case "admin-teachers":
    case "admin-groups":
    case "admin-courses":
    case "admin-payments":
    case "admin-subscriptions":
    case "admin-coupons":
    case "admin-question-bank":
    case "admin-notifications":
    case "admin-session-videos":
    case "admin-mock-exams":
    case "admin-quiz-review":
    case "admin-settings":
      return <AdminDashboard />;
    default:
      return fallback;
  }
}

/**
 * Whitelist of view keys per role — used to detect stale/illegal views
 * (e.g. an admin landing on a student-only view after a role change or a
 * previously-persisted in-memory state) so we can redirect safely instead
 * of rendering a component that will hit a forbidden API.
 */
function isViewForRole(view: string, role: string): boolean {
  // Public / auth / enrollment pages are valid before/after login.
  if (view === "landing" || view === "login" || view === "register" || view === "enroll") {
    return true;
  }
  const VIEWS_BY_ROLE: Record<string, string[]> = {
    STUDENT: [
      "student-dashboard",
      "student-course",
      "student-lesson",
      "student-quiz",
      "student-homework",
      "student-notifications",
      "student-progress",
      "student-exam",
      "student-session-videos",
      "student-bookmarks",
      "student-scheduler",
      "student-referral",
      "student-leaderboard",
      "student-achievements",
      "student-certificate",
    ],
    PARENT: ["parent-dashboard", "parent-report"],
    TEACHER: [
      "teacher-dashboard",
      "teacher-attendance",
      "teacher-quizzes",
      "teacher-homework",
      "teacher-templates",
      "teacher-analytics",
    ],
    ADMIN: [
      "admin-overview",
      "admin-students",
      "admin-teachers",
      "admin-groups",
      "admin-courses",
      "admin-payments",
      "admin-subscriptions",
      "admin-coupons",
      "admin-question-bank",
      "admin-notifications",
      "admin-session-videos",
      "admin-mock-exams",
      "admin-quiz-review",
      "admin-settings",
    ],
  };
  return (VIEWS_BY_ROLE[role] || []).includes(view);
}
