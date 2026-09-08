# Architecture

This document describes the architecture of CodeMind Academy at the
level needed to navigate and extend the codebase. For command-level
setup see [`DEVELOPMENT_GUIDE.md`](DEVELOPMENT_GUIDE.md); for the data
model see [`DATABASE_GUIDE.md`](DATABASE_GUIDE.md).

---

## 1. High-Level Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Browser (RTL Arabic UI)                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  src/app/page.tsx → <AppShell/>                               │  │
│  │     └── Zustand store (src/lib/store.ts) drives `view` state  │  │
│  │          ├── landing   (10 marketing sections)                │  │
│  │          ├── login / register / enroll                        │  │
│  │          └── DashboardShell → renderView(view)                 │  │
│  │                ├── StudentDashboard / QuizRunner / MockExam…  │  │
│  │                ├── ParentDashboard / MonthlyReport / …         │  │
│  │                ├── TeacherDashboard                            │  │
│  │                └── AdminDashboard                              │  │
│  └────────────────────────────────────────────────────────────────┘  │
│              ▲                                            ▲           │
│              │ TanStack Query (server state)              │           │
│              │ Framer Motion (animations)                 │           │
└──────────────┼────────────────────────────────────────────┼──────────┘
               │ fetch('/api/...') — relative paths only   │
               ▼                                            │
┌──────────────────────────────────────────────────────────────────────┐
│              Next.js 16 API Routes (63 endpoints)                    │
│   /api/auth/[action]   /api/admin/*          /api/enroll             │
│   /api/admin/*          /api/teacher/*       /api/students/me/*       │
│   /api/parents/me/*     /api/courses/*       /api/quizzes/*           │
│   /api/lessons/*        /api/exams/mock      /api/notifications/*     │
│   /api/coupons/validate /api/groups          /api/subscription-plans  │
│   /api/settings/public                                                 │
│                                                                       │
│   Helpers (src/lib/api.ts):                                           │
│     ok(data)              → 200 JSON                                  │
│     err(msg, status)      → JSON {error}                              │
│     requireUser()         → SessionUser | null                        │
│     requireRole(...roles) → { user, error }                           │
└──────────────┬──────────────────────────────────────────────────────┘
               │ Prisma Client (singleton, src/lib/db.ts)
               ▼
┌──────────────────────────────────────────────────────────────────────┐
│              Prisma ORM 6  →  SQLite (db/custom.db)                   │
│              36 models · 11 enums                                     │
│              Sessions persisted in `Setting` table (key: session:<t>)│
└──────────────────────────────────────────────────────────────────────┘
```

---

## 2. Frontend

### 2.1 Next.js 16 App Router
- Single page entry: `src/app/page.tsx` renders `<AppShell/>`. There are
  **no other routes** — the browser only ever sees `/`.
- Root layout (`src/app/layout.tsx`) configures:
  - HTML `dir="rtl"` and `lang="ar"` for Arabic-first rendering.
  - **Cairo** Arabic font via `next/font/google`.
  - `<ThemeProvider>` (next-themes) for light/dark mode.
  - `<AppProviders>` wrapping TanStack QueryClientProvider.
  - `<ErrorBoundary>` for graceful Arabic fallback UI.

### 2.2 React 19 + Zustand state
- React 19 server components are NOT used for the dashboard (everything
  is client-rendered for interactivity).
- Client state is managed by **Zustand** (`src/lib/store.ts`):
  - `view: ViewKey` — current dashboard view (e.g.
    `student-dashboard`, `admin-payments`, `parent-report`).
  - `navParam: string | null` — optional context (e.g. lesson ID).
  - `user: SessionUser | null` — restored on mount via `/api/auth/me`.
  - `theme`, `sidebarOpen` — UI state.
  - Persisted via `persist` middleware (only `theme` is persisted).
- Server state is fetched with **TanStack Query** 5 (`useQuery` /
  `useMutation`) in the role-specific dashboards.
- The 40 valid `ViewKey` values are defined in `src/lib/store.ts` and
  cover all 4 portals + landing + auth + enroll.

### 2.3 View routing (single-page app)
Routing is **not URL-based** for dashboards — `src/components/app-shell.tsx`
hosts a single `switch (view)` block that renders the matching
component. The dashboard chrome (sidebar, header, notifications bell,
theme toggle) is provided by `src/components/dashboard/shell.tsx`.

Why? The platform was designed as a focused EdTech workspace where
deeplinkable URLs are not valuable; instead the Zustand store makes
view transitions instant and animated via Framer Motion.

To add a new view, see [`ADDING_FEATURES.md`](ADDING_FEATURES.md).

### 2.4 Styling
- **Tailwind CSS 4** (CSS-first, no `tailwind.config.js` needed for
  theme tokens). Custom tokens are defined in `src/app/globals.css`
  using `@theme`.
- **shadcn/ui** New York style — 53 components in
  `src/components/ui/`. Configured via `components.json`.
- **Brand palette**: emerald (primary), teal (accent), amber
  (secondary). **No indigo or blue** is used anywhere in the platform.
- **Brand tokens**: `bg-mesh`, `glass`, `glass-strong`, `text-gradient`,
  `card-hover`, `card-lift`, `shine-on-hover`, `gradient-border`,
  `glow-pulse` and 25+ other custom utilities in `globals.css`.
- **Framer Motion 12** powers page transitions
  (`AnimatePresence mode="wait"`), entrance animations and hover lifts.
- **Recharts** 2.15 renders all dashboards' charts (BarChart,
  LineChart, RadialBarChart). Charts wrap content in `dir="ltr"` for
  correct axis layout while staying inside an RTL page.
- **Cairo** font for Arabic, applied via `next/font/google`.

### 2.5 shadcn/ui components
The full component set is in `src/components/ui/`:
accordion, alert, alert-dialog, aspect-ratio, avatar, badge, breadcrumb,
button, calendar, card, carousel, chart, checkbox, collapsible,
command, context-menu, dialog, drawer, dropdown-menu, form,
hover-card, input, input-otp, label, menubar, navigation-menu,
pagination, popover, progress, radio-group, resizable, scroll-area,
select, separator, sheet, sidebar, skeleton, slider, sonner, switch,
table, tabs, textarea, toast, toaster, toggle, toggle-group, tooltip.

---

## 3. Backend

### 3.1 Next.js API Routes (64 total)
All backend logic lives under `src/app/api/`. Routes are organized by
concern:

| Prefix                 | Audience            | Examples                                            |
| ---------------------- | ------------------- | --------------------------------------------------- |
| `/api/auth/[action]`   | Public              | `login`, `register`, `logout`, `me`                 |
| `/api/admin/*`         | ADMIN only          | overview, students, teachers, payments, coupons…   |
| `/api/teacher/*`       | TEACHER only        | dashboard, attendance, homework, templates         |
| `/api/students/me/*`   | STUDENT (self)      | dashboard, gamification, bookmarks, study-plan…    |
| `/api/parents/me/*`    | PARENT (self)       | dashboard, analytics, weekly-report, link-student  |
| `/api/courses/*`       | Public + auth       | catalog + course-by-slug                            |
| `/api/quizzes/*`       | STUDENT             | quiz fetch + submit                                 |
| `/api/lessons/*`       | STUDENT             | lesson content + progress update                   |
| `/api/exams/mock`      | STUDENT             | randomized mock exam engine                         |
| `/api/notifications/*` | Any authed user     | list + unread-count                                 |
| `/api/enroll`          | STUDENT             | Course→Group→Plan→Payment wizard POST              |
| `/api/coupons/validate`| STUDENT             | Coupon validation before enrollment                |
| `/api/groups`          | Public              | Group capacity + teacher info                      |
| `/api/subscription-plans` | Public           | Available subscription tiers                       |
| `/api/settings/public` | Public              | Brand + whatsapp + prices                          |

Every route returns JSON via the `ok()` / `err()` helpers in
`src/lib/api.ts`.

### 3.2 Auth — cookie sessions
Implemented in `src/lib/auth.ts`:

- **Password hashing**: `scrypt` with 16-byte random salt, 64-byte
  hash, stored as `salt:hash`. Verification uses `timingSafeEqual` to
  prevent timing attacks.
- **Session lifecycle**:
  1. On login, `createSession(userId)` generates a 32-byte random
     token, persists it in the `Setting` table as
     `key=session:<token>` → `value=<userId>|<expiresISO>`, and sets
     the `cm_session` cookie (httpOnly, sameSite=lax, 7-day TTL).
  2. On every request, `getCurrentUser()` reads the cookie, looks up
     the session row, validates expiry, and returns the `User` (or
     `null`).
  3. On logout, `destroySession()` deletes the `Setting` row and
     clears the cookie.
- **No JWT** is used. The `Setting` table doubles as a session store,
  keeping the dependency footprint minimal.

### 3.3 Authorization — RBAC helpers
`src/lib/api.ts` exposes:

```ts
requireUser(): Promise<SessionUser | null>
requireRole(...roles: Role[]): Promise<{ user, error }>
```

Usage pattern in any protected route:

```ts
export async function GET() {
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  // … DB queries using user.id …
  return ok({ data });
}
```

Role values come from the Prisma `Role` enum: `STUDENT`, `PARENT`,
`TEACHER`, `ADMIN`.

### 3.4 Profile helpers
The same `src/lib/api.ts` exports convenience helpers that eager-load
the role profile:

- `getStudentProfile(userId)` — includes user, group (with course +
  teacher), subscription (with plan + payments).
- `getParentProfile(userId)` — includes user + linked children (with
  their user + group + course).
- `getTeacherProfile(userId)` — includes user + groups (with course +
  students).

---

## 4. Database — Prisma ORM

- **Provider**: SQLite (file-based at `db/custom.db`). Designed to be
  swappable to PostgreSQL by changing one line in
  `prisma/schema.prisma` and the `DATABASE_URL` env var.
- **Schema**: 36 models + 11 enums. Full reference in
  [`DATABASE_GUIDE.md`](DATABASE_GUIDE.md).
- **Client**: singleton in `src/lib/db.ts` — `import { db } from
  '@/lib/db'`.
- **Logging**: `['error', 'warn']` only (query-level logging was
  disabled to reduce memory pressure in the 4 GB sandbox).

### Key model groups

| Group                | Models                                                                 |
| -------------------- | ---------------------------------------------------------------------- |
| Users & RBAC         | User, Student, Parent, ParentStudentLink, Teacher                      |
| Gamification         | StudentBadge                                                           |
| Curriculum           | Course, Part, Unit, Topic, Lesson                                     |
| Groups & Sessions    | Group, LiveSession, Attendance                                         |
| Assessments          | Quiz, Question, QuizAttempt, QuizAnswer, Homework, HomeworkSubmission, ExamQuestion, ExamAttempt, LessonProgress, TeacherNote |
| Subscriptions        | SubscriptionPlan, Subscription, Payment                                |
| Notifications        | Notification, NotificationPreference, AuditLog, Setting                 |
| Bookmarks & Notes    | LessonBookmark, LessonNote                                             |
| Coupons & Referrals  | Coupon, CouponRedemption, Referral                                     |
| Study Planner        | StudyTask                                                              |
| Teacher tools        | LessonPlanTemplate                                                     |

### Key relationships (FKs)

- `User` 1—1 `Student` / `Parent` / `Teacher` (cascade delete).
- `Course` 1—n `Part` 1—n `Unit` 1—n `Topic` 1—n `Lesson`.
- `Group` n—1 `Course`, n—1 `Teacher`, n—n `Student`.
- `LiveSession` n—1 `Group`, n—1 `Teacher`, n—1 `Lesson` (optional).
- `Quiz` 1—n `Question` 1—n `QuizAnswer` (via `QuizAttempt`).
- `Subscription` 1—1 `Student`, n—1 `SubscriptionPlan`, 1—n `Payment`.
- `Student` n—n `Parent` via `ParentStudentLink`.
- `Student` 1—n `Referral` (referrer), 1—n `Referral` (referred).
- `User` 1—n `Notification`, `AuditLog`, `Payment`.

---

## 5. AI Integration

**Kodgy (the visual assistant) is NOT connected to an external AI.** Since
Phase 10 it is a fully client-side, deterministic, scripted assistant:

```text
Kodgy UI (src/components/kodgy/)
      ↓
Kodgy Assistant Controller (use-kodgy-chat.ts)
      ↓
Scripted Response Engine (src/lib/kodgy/response-engine.ts)
      ↓
Matched Response ({ intent, answer: { ar, en } })
```

There is no `/api/ai/*` route, no AI SDK import, no network call and no
database dependency in the Kodgy flow. Real external AI/LLM integration is
intentionally deferred; the engine is the clean replacement boundary.

The only live LLM consumer on the platform is
**`src/app/api/admin/ai-generate-quiz/route.ts`** — teacher/admin quiz
generation. It accepts `lessonId`, `count` (1-10), `difficulty`, builds
context from the lesson's hierarchy (course → part → unit → topic →
lesson), asks the LLM for JSON questions in Egyptian Arabic, parses +
validates, then persists `Quiz` + `Question` rows. LLM calls take ~30s;
the admin UI surfaces a loading state for that.

---

## 6. Data Flow

A canonical flow — a student opening the dashboard — looks like:

1. Browser loads `/`, Next.js runs `src/app/page.tsx` → `<AppShell/>`.
2. `AppShell` `useEffect` fires `GET /api/auth/me` → cookie is sent,
   `getCurrentUser()` resolves to a `SessionUser`, returned as JSON.
3. Zustand `setUser(u)` updates the store; `setView(homeViewForRole(role))`
   switches to `student-dashboard`.
4. `<DashboardShell>` mounts, `<StudentDashboard>` mounts.
5. `useQuery({ queryKey: ['student-dashboard'], queryFn: () =>
   fetch('/api/students/me/dashboard').then(r => r.json()) })` fires.
6. `GET /api/students/me/dashboard` route:
   - `requireRole("STUDENT")` checks the cookie session.
   - `getStudentProfile(user.id)` eager-loads group + subscription.
   - Parallel `Promise.all` of `db.lessonProgress.findMany`,
     `db.quizAttempt.findMany`, `db.attendance.findMany`,
     `db.liveSession.findMany`, `db.homeworkSubmission.findMany`.
   - Returns a single aggregated JSON payload.
7. TanStack Query caches the result; the component re-renders with
   real data and skeleton fallbacks.
8. Sub-actions (quiz submit, bookmark toggle, etc.) fire `useMutation`
   which invalidates the relevant query keys.

---

## 7. Folder Structure (described)

| Path                                  | Purpose                                                     |
| ------------------------------------- | ----------------------------------------------------------- |
| `prisma/schema.prisma`                | Source of truth for the data model                          |
| `scripts/seed.ts`                     | Demo data seeder (admin/teacher/student/parent + curriculum)|
| `src/app/api/**/route.ts`             | 64 API route handlers (one file per route)                  |
| `src/app/globals.css`                 | Tailwind 4 + brand tokens + 35+ custom utilities           |
| `src/app/layout.tsx`                  | Root layout: RTL, Cairo font, ThemeProvider, ErrorBoundary  |
| `src/app/page.tsx`                    | Single entry — `<AppShell/>`                                |
| `src/components/admin/`               | Admin portal (single `admin-dashboard.tsx`, 3576 lines)     |
| `src/components/ai/`                   | Floating AI assistant chatbot                               |
| `src/components/auth/`                | Login/register + enrollment wizard                          |
| `src/components/course/`              | Student course tree, lesson view, quiz runner               |
| `src/components/dashboard/shell.tsx`  | Sidebar + header + notifications bell + theme toggle         |
| `src/components/landing/`             | Hero + 9 marketing sections                                 |
| `src/components/parent/`              | Parent dashboard + monthly/weekly reports + analytics       |
| `src/components/student/`             | 9 student views (dashboard, mock-exam, certificate, …)      |
| `src/components/teacher/`             | Teacher dashboard (single `teacher-dashboard.tsx`, 3241 lines)|
| `src/components/ui/`                   | 53 shadcn/ui components (New York style)                    |
| `src/components/app-shell.tsx`        | The view router (Zustand `view` → component switch)         |
| `src/components/app-providers.tsx`    | TanStack QueryClient + theme provider wiring                |
| `src/components/error-boundary.tsx`   | React class ErrorBoundary + Arabic fallback UI              |
| `src/components/logo.tsx`             | CodeMind logo (svg + wordmark)                              |
| `src/hooks/use-toast.ts`              | shadcn/ui toast hook                                        |
| `src/hooks/use-mobile.ts`             | Responsive breakpoint hook                                  |
| `src/lib/api.ts`                      | `ok` / `err` / `requireUser` / `requireRole` + profile helpers|
| `src/lib/auth.ts`                     | scrypt hashing + cookie sessions                            |
| `src/lib/brand.ts`                    | Centralized brand config (name, colors, whatsapp, plans)   |
| `src/lib/curriculum.ts`               | Part 1 + Part 2 seed curriculum                             |
| `src/lib/db.ts`                       | Prisma client singleton                                    |
| `src/lib/gamification.ts`             | XP rules, 6 levels, 9 badges, stats builder                |
| `src/lib/notify.ts`                   | Notification preference enforcement (per-type + quiet hours)|
| `src/lib/store.ts`                    | Zustand store (view, user, theme, sidebar)                 |
| `src/lib/utils.ts`                    | `cn()` className merge + helpers                           |
| `db/custom.db`                        | SQLite database file (gitignored)                          |
| `public/`                             | Static assets, manifest.json, robots.txt, sitemap.xml       |
| `docs/`                               | This documentation set                                      |
| `agent-ctx/`                          | Per-task agent work records                                 |
| `mini-services/`                      | Optional sidecar services                                   |
| `Caddyfile`                           | Gateway config (`XTransformPort` proxy to other ports)     |

---

## 8. Build & Deployment Topology

- **Single Next.js deployment** — frontend and API are bundled together.
- `next.config.ts` sets `output: "standalone"`, producing
  `.next/standalone/server.js` that can run on any Node host.
- `bun run build` runs `next build` then copies static + public assets
  into the standalone tree.
- `bun run start` runs `NODE_ENV=production bun
  .next/standalone/server.js`, logging to `server.log`.
- The sandbox uses Caddy as a gateway (see `Caddyfile`). Only port
  3000 is exposed externally; other ports (e.g. for mini-services)
  are reached via the `?XTransformPort=<port>` query parameter.

See [`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md) for Vercel / VPS /
Docker deployment recipes.

---

## 9. Cross-Cutting Concerns

### 9.1 Notifications
- Created by various API routes via `createNotificationIfAllowed()`
  from `src/lib/notify.ts`.
- Before inserting a notification row, the helper:
  1. Looks up the recipient's `NotificationPreference` (creates defaults
     if missing).
  2. Checks the per-type toggle (e.g. `newLesson`, `monthlyReport`).
  3. Checks `quietHoursStart` / `quietHoursEnd` (handles overnight wrap).
  4. Skips creation entirely if either gate fails.
- The notifications bell in the dashboard header polls
  `/api/notifications/unread-count` every 30 s.

### 9.2 Gamification
- `src/lib/gamification.ts` is the engine:
  - `XP_RULES` — XP granted per action (lesson=50, quiz passed=30,
    perfect bonus=50, homework=20, attendance=10, daily login=5).
  - `LEVELS` — 6 levels from `مبتدئ` (0 XP) to `أسطورة` (1500 XP).
  - `BADGES` — 9 badges with Arabic + English titles, gradient colors,
    and `check(stats)` predicates.
  - `buildStats(studentId)` — single DB pass that aggregates lessons,
    quizzes, homework, attendance, computes currentStreak +
    longestStreak over the last 60 days.
  - `computeXp(stats)` and `computeLevel(xp)` — pure functions.
  - `awardBadges(studentId, stats)` — upserts earned badges and
    returns newly-earned ones for toast feedback.
- The `/api/students/me/gamification` endpoint exposes all of this to
  the student dashboard's gamification panel.

### 9.3 Error handling
- Every page is wrapped in `<ErrorBoundary>` (React class component)
  that catches render errors and shows a friendly Egyptian Arabic
  fallback ("حصلت مشكلة. حاول تاني.") with retry + home buttons.
- API routes use try/catch and return `err(message, status)` JSON.
- Toasts (sonner) surface success and error feedback on mutations.

### 9.4 RTL + i18n
- The HTML root sets `dir="rtl"` and `lang="ar"`.
- All UI copy is Egyptian Arabic with English technical terms kept
  as-is (Lesson, Quiz, Session, Mock Exam, Certificate, XP, …).
- Charts wrap their content in `dir="ltr"` to keep axis labels
  correctly oriented.
- The Cairo font is loaded via `next/font/google` for proper Arabic
  shaping.

### 9.5 Theming
- `next-themes` provides light/dark with `class` strategy.
- Tailwind 4 tokens (`--background`, `--primary`, `--sidebar`, …) are
  defined in `globals.css` and overridden under `.dark`.
- The Zustand store persists only the `theme` field across reloads.

---

## 10. Extending the Architecture

To add a new feature end-to-end, follow the 8 steps in
[`ADDING_FEATURES.md`](ADDING_FEATURES.md):

1. Add a Prisma model + `bun run db:push`.
2. Create an API route in `src/app/api/<path>/route.ts`.
3. Use `requireUser()` / `requireRole(...)` for auth.
4. Create a component in `src/components/<role>/`.
5. Add a new `ViewKey` to `src/lib/store.ts`.
6. Add a `case` to the `renderView` switch in
   `src/components/app-shell.tsx`.
7. Add a sidebar nav item in `src/components/dashboard/shell.tsx`.
8. Run `bun run dev`, test in browser, then `bun run lint`.
