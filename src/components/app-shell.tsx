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
import { AiAssistant } from "@/components/ai/ai-assistant";
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
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => {
        if (u) {
          useApp.getState().setUser(u);
          if (useApp.getState().view === "landing") {
            useApp.getState().setView(homeViewForRole(u.role));
          }
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
            {renderView(view)}
          </motion.div>
        </AnimatePresence>
      </DashboardShell>
      <AiAssistant />
    </>
  );
}

function renderView(view: string) {
  switch (view) {
    case "student-dashboard":
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
      return <ParentDashboard />;
    case "parent-report":
      return <ParentDashboard />;
    case "teacher-dashboard":
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
    case "admin-settings":
      return <AdminDashboard />;
    // teacher sub-pages fall back to teacher dashboard
    case "teacher-attendance":
    case "teacher-quizzes":
    case "teacher-homework":
    case "teacher-templates":
    case "teacher-analytics":
      return <TeacherDashboard />;
    case "student-homework":
    case "student-notifications":
    case "student-progress":
      return <StudentDashboard />;
    default:
      return <StudentDashboard />;
  }
}
