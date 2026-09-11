"use client";
import { useT , pickAuto } from "@/lib/i18n";

import * as React from "react";
import { useApp } from "@/lib/store";
import { CodeMindLogo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { brand, whatsappLink } from "@/lib/brand";
import { GlobalControls } from "@/components/global-controls";
import {
  LayoutDashboard,
  BookOpen,
  Bell,
  CreditCard,
  Users,
  GraduationCap,
  Settings,
  LogOut,
  Menu,
  ChevronLeft,
  HelpCircle,
  HeartHandshake,
  Briefcase,
  ShieldCheck,
  Trophy,
  FileText,
  Timer,
  Video,
  Camera,
  Bookmark,
  Award,
  Ticket,
  Gift,
  Crown,
  Star,
  CalendarDays,
  Library,
  ClipboardList,
  Server,
  FileQuestion,
  Home,
  UserCircle,
  Rocket,
} from "lucide-react";
import Link from "next/link";

type NavItem = {
  key: string;
  label: string;
  icon: any;
};

const NAV_BY_ROLE: Record<string, NavItem[]> = {
  STUDENT: [
    { key: "student-dashboard", label: "shell.027", icon: LayoutDashboard },
    { key: "student-course", label: "shell.001", icon: BookOpen },
    { key: "student-session-videos", label: "admin.204", icon: Video },
    { key: "student-exam", label: "shell.028", icon: Timer },
    { key: "student-bookmarks", label: "shell.029", icon: Bookmark },
    { key: "student-scheduler", label: "shell.030", icon: CalendarDays },
    { key: "student-referral", label: "shell.031", icon: Gift },
    { key: "student-progress", label: "shell.002", icon: Trophy },
    { key: "student-leaderboard", label: "shell.032", icon: Crown },
    { key: "student-achievements", label: "shell.033", icon: Award },
    { key: "student-certificate", label: "shell.003", icon: Star },
    { key: "student-homework", label: "shell.004", icon: FileText },
    { key: "student-notifications", label: "shell.005", icon: Bell },
  ],
  PARENT: [
    { key: "parent-dashboard", label: "shell.027", icon: LayoutDashboard },
    { key: "parent-report", label: "shell.006", icon: FileText },
  ],
  TEACHER: [
    { key: "teacher-dashboard", label: "shell.027", icon: LayoutDashboard },
    { key: "teacher-attendance", label: "shell.034", icon: CalendarDays },
    { key: "teacher-quizzes", label: "shell.035", icon: Trophy },
    { key: "teacher-homework", label: "shell.004", icon: ClipboardList },
  ],
  ADMIN: [
    { key: "admin-overview", label: "shell.036", icon: LayoutDashboard },
    { key: "admin-students", label: "shell.007", icon: GraduationCap },
    { key: "admin-teachers", label: "shell.008", icon: Briefcase },
    { key: "admin-groups", label: "shell.009", icon: Users },
    { key: "admin-courses", label: "shell.010", icon: BookOpen },
    { key: "admin-sessions", label: "admin.323", icon: Rocket },
    { key: "admin-question-bank", label: "shell.037", icon: Library },
    { key: "admin-session-videos", label: "admin.204", icon: Video },
    { key: "admin-mock-exams", label: "admin.214", icon: Timer },
    { key: "admin-quiz-review", label: "admin.245", icon: Camera },
    { key: "admin-payments", label: "shell.011", icon: CreditCard },
    { key: "admin-subscriptions", label: "shell.012", icon: ShieldCheck },
    { key: "admin-coupons", label: "shell.013", icon: Ticket },
    { key: "admin-notifications", label: "shell.005", icon: Bell },
    { key: "admin-settings", label: "shell.015", icon: Settings },
  ],
};

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const tr = useT();
  const user = useApp((s) => s.user);
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const locale = useApp((s) => s.locale);
  const logout = useApp((s) => s.logout);
  const [mobileOpen, setMobileOpen] = React.useState(false);

  const role = user?.role || "STUDENT";
  const items = NAV_BY_ROLE[role] || [];

  // Mobile drawer should come from the same side as the desktop sidebar
  // (start side). Desktop sidebar is at start: left in LTR, right in RTL.
  // Using physical sides (right/left) avoids the logical end/start flip bug
  // that desyncs Radix's slide transform from the anchoring (see sheet.tsx).
  const mobileSide = locale === "ar" ? "right" : "left";

  const sidebarContent = (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      {/* Logo */}
      <button
        onClick={() => setView("landing")}
        className="flex items-center px-5 h-16 border-b border-sidebar-border shrink-0 w-full"
      >
        <CodeMindLogo withWordmark size={32} />
      </button>

      {/* Nav */}
      <ScrollArea className="flex-1 px-3 py-4 min-w-0">
        <nav className="space-y-1">
          {items.map((it) => {
            const active = view === it.key;
            return (
              <button
                key={it.key}
                data-view={it.key}
                onClick={() => {
                  setView(it.key as any);
                  setMobileOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 min-w-0 ${
                  active
                    ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
                    : "text-sidebar-foreground hover:bg-sidebar-accent"
                }`}
              >
                <it.icon className="w-4 h-4 shrink-0" />
                <span className="flex-1 text-start truncate min-w-0">{tr(it.label)}</span>
                {active && <ChevronLeft className="w-3.5 h-3.5 shrink-0 flip-rtl" />}
              </button>
            );
          })}
        </nav>

        {/* WhatsApp help */}
        <div className="mt-6 px-3">
          <div className="rounded-xl bg-gradient-to-br from-primary/10 to-amber-400/10 p-4 border border-primary/10 overflow-hidden">
            <div className="flex items-center gap-2 mb-2 min-w-0">
              <HeartHandshake className="w-4 h-4 text-primary shrink-0" />
              <div className="text-xs font-bold truncate">{tr("shell.016")}</div>
            </div>
            <p className="text-[11px] text-muted-foreground mb-1 leading-relaxed break-words">
              {tr("shell.017")}</p>
            <a
              href={`tel:${brand.contact.phone.replace(/[^+0-9]/g, "")}`}
              className="block text-center text-xs font-black mb-3 hover:text-primary transition-colors truncate"
              dir="ltr"
            >
              {brand.contact.phone}
            </a>
            <a
              href={whatsappLink(brand.whatsapp.technical, tr("shell.018"))}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center w-full px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-bold hover:opacity-90 transition-opacity"
            >
              <HelpCircle className="w-3.5 h-3.5 ms-1.5 shrink-0" />
              <span className="truncate">{tr("shell.038")}</span>
            </a>
          </div>
        </div>
      </ScrollArea>

      {/* User card */}
      <div className="border-t border-sidebar-border p-3 shrink-0 overflow-hidden">
        <div className="flex items-center gap-2.5 px-2 min-w-0">
          <Avatar className="w-9 h-9 shrink-0">
            <AvatarFallback className="bg-primary/10 text-primary text-xs font-bold">
              {user?.name?.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0 overflow-hidden">
            <div className="text-xs font-bold truncate">{user?.name}</div>
            <div className="text-[10px] text-muted-foreground truncate">
              {user?.email}
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="p-1.5 rounded-md hover:bg-sidebar-accent shrink-0">
                <Settings className="w-3.5 h-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuLabel>{tr("shell.019")}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setView("landing")}>
                <Home className="w-3.5 h-3.5 ms-2" />
                {tr("shell.020")}</DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  await logout();
                }}
                className="text-destructive focus:text-destructive"
              >
                <LogOut className="w-3.5 h-3.5 ms-2" />
                {tr("shell.021")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex w-full overflow-x-hidden bg-background">
      {/* Desktop sidebar — fixed width, start-anchored (left LTR, right RTL).
          border-e is logical: inner edge = end in both LTR (right) and RTL (left),
          so it stays between sidebar and main. overflow-hidden + min-w-0 prevents
          long user email/name from expanding the sidebar beyond w-64. */}
      <aside className="hidden lg:flex w-64 shrink-0 bg-sidebar border-e border-sidebar-border flex-col overflow-hidden min-w-0">
        {sidebarContent}
      </aside>

      {/* Mobile sidebar — drawer from start side (left LTR, right RTL) for
          consistency with desktop. Physical anchoring fixed in sheet.tsx. */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side={mobileSide} className="w-72 p-0 overflow-hidden">
          <SheetHeader className="sr-only">
            <SheetTitle>{tr("shell.022")}</SheetTitle>
          </SheetHeader>
          {sidebarContent}
        </SheetContent>
      </Sheet>

      {/* Main — flex-1 + min-w-0 is critical: without min-w-0, flex child with
          intrinsic wide content (tables, charts) would have min-width:auto and
          push the flex container beyond viewport, causing sidebar to appear
          outside frame / overlap. w-full + overflow-x-hidden ensures no
          horizontal overflow escapes the dashboard frame. */}
      <div className="flex-1 flex flex-col min-w-0 w-full overflow-hidden">
        {/* Header */}
        <header className="sticky top-0 z-20 h-16 border-b border-border bg-background/80 backdrop-blur-md flex items-center px-4 sm:px-6 gap-3 shrink-0 w-full min-w-0 overflow-hidden">
          <button
            className="lg:hidden p-2 -me-2 rounded-md hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 shrink-0"
            onClick={() => setMobileOpen(true)}
            aria-label={tr("shell.023")}
          >
            <Menu className="w-5 h-5" />
          </button>

          <div className="flex-1 min-w-0 overflow-hidden">
            <div className="text-xs text-muted-foreground truncate">
              {tr(roleLabel(role))} · {brand.academicYear}
            </div>
            <div className="text-sm font-bold truncate">{tr(pageTitle(view, role))}</div>
          </div>

          {/* Global theme + language — same controls as public pages */}
          <div className="shrink-0 flex items-center gap-1">
            <GlobalControls />
            <NotificationsBell />
          </div>

          <Avatar className="w-9 h-9 shrink-0">
            <AvatarFallback className="bg-primary/10 text-primary text-xs font-bold">
              {user?.name?.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 bg-muted/20 min-w-0 w-full overflow-x-hidden">{children}</main>
      </div>
    </div>
  );
}

function roleLabel(role: string) {
  switch (role) {
    case "STUDENT":
      return "shell.024";
    case "PARENT":
      return "shell.025";
    case "TEACHER":
      return "Teacher";
    case "ADMIN":
      return "Admin";
    default:
      return "shell.026";
  }
}

function pageTitle(view: string, role: string) {
  const all = NAV_BY_ROLE[role] || [];
  return all.find((i) => i.key === view)?.label || "Dashboard";
}

function NotificationsBell() {
  const tr = useT();
  const user = useApp((s) => s.user);
  const setView = useApp((s) => s.setView);
  const [count, setCount] = React.useState(0);

  const refresh = React.useCallback(() => {
    if (!user) return;
    fetch("/api/notifications/unread-count")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setCount(d?.count || 0))
      .catch(() => {});
  }, [user]);

  React.useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <button
      onClick={() => setView(user?.role === "ADMIN" ? "admin-notifications" : "student-notifications")}
      className="relative p-2 rounded-md hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      aria-label={tr("shell.005")}
    >
      <Bell className="w-4 h-4" />
      {count > 0 && (
        <span className="absolute -top-0.5 -end-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center animate-pulse-soft ring-2 ring-background">
          {count > 9 ? "9+" : count}
        </span>
      )}
    </button>
  );
}
