# CodeMind Academy

> **Learn. Build. Think.** — _اتعلم. ابنى. فكّر._

CodeMind Academy is an Arabic-first EdTech platform built for Egyptian
Baccalaureate (2nd Secondary) students studying the **Programming & AI**
subject. It delivers lessons, quizzes, homework, mock exams, gamification,
parent monitoring, teacher tooling and a full admin back-office — all in a
single Next.js application with a RTL Arabic UI and English technical terms.

---

## Table of Contents

1. [Overview](#overview)
2. [Main Features](#main-features)
3. [Technology Stack](#technology-stack)
4. [User Roles](#user-roles)
5. [Architecture Overview](#architecture-overview)
6. [Project Structure](#project-structure)
7. [Prerequisites](#prerequisites)
8. [Installation](#installation)
9. [Environment Variables](#environment-variables)
10. [Database Setup](#database-setup)
11. [Demo Accounts](#demo-accounts)
12. [Development Commands](#development-commands)
13. [Production Build](#production-build)
14. [Deployment](#deployment)
15. [Troubleshooting](#troubleshooting)
16. [Git Workflow](#git-workflow)
17. [License](#license)

---

## Overview

CodeMind Academy is a multi-role EdTech platform purpose-built for the
Egyptian _Thanaweya Amma_ — 2nd Secondary — _Programming & AI_ curriculum.
The platform exposes four portals (Student, Parent, Teacher, Admin) and
ships with the official Part 1 + Part 2 curriculum seed:

- **Part One** — Information Technology & Society, Cybersecurity, Web
  Applications, Web Design, Data Collection, Analysis & Communication
- **Part Two** — Machine Learning & Artificial Intelligence fundamentals

The UI is **Arabic-first RTL** with English technical terms kept as-is
(Lesson, Quiz, Session, Mock Exam, …) so students get used to real-world
vocabulary while still reading in their native language.

---

## Main Features

The following features are **implemented and verified** (see
`worklog.md` for the full history, 16 development rounds):

### Landing & Marketing
- Animated premium hero (gradient mesh + Cairo font)
- 9 marketing sections: Why, Journey, Curriculum, Features, Parent,
  Pricing, Testimonials, FAQ, Final CTA
- Light/dark mode toggle, sticky footer, mobile responsive
- Public brand settings API (whatsapp numbers, prices, academic year)

### Authentication & Enrollment
- Cookie-based sessions (scrypt password hashing, 7-day TTL)
- Login + Register flows with 4-role picker
- Multi-step enrollment wizard (Course → Group → Plan → Payment → Confirm)
- Coupon validation + discount application during enrollment
- Session restoration on page reload (`/api/auth/me`)

### Student Portal
- Dashboard (continue learning, next session, attendance, recent quizzes)
- Course tree view (Part → Unit → Topic → Lesson)
- Lesson view (video, PDF, summary, sticky notes, bookmarks, progress)
- Quiz Runner (timer, MCQ + True/False, instant grading, explanations)
- Mock Exams (randomized questions, shuffled options, countdown timer)
- Homework list with submission status, grades and teacher feedback
- Notifications center with type badges + read/unread state
- Progress page with CSV export of personal activity
- Gamification engine: XP rules, 6 levels, 9 badges, day streaks
- Leaderboard (top students by XP)
- Achievements gallery (earned vs locked badges)
- Course Certificate (print-to-PDF when ≥80% lessons completed)
- Study Scheduler (calendar + tasks, DONE / SKIPPED status)
- Referral program (50 XP + 10% discount coupon on completion)
- Kodgy — scripted AI assistant (animated robot + flame, AR-LT / EN-RT,
  draggable; no external AI in this phase)
- Notification Preferences (per-type toggles, quiet hours)

### Parent Portal
- Dashboard with child analytics (progress, attendance, quiz avg, homework)
- Monthly Report (print-to-PDF, branded letter, recommendations)
- Weekly Report (7-day heatmap + activity summary)
- Analytics view (quiz trend, attendance by month, strong/weak topics,
  course completion radial chart)
- Link additional students to one parent account
- Notification preferences (per-type + quiet hours)

### Teacher Portal
- Overview (groups, sessions, recent activity)
- Attendance taking (per session, PRESENT / ABSENT / LATE / EXCUSED)
- Quizzes CRUD (create quizzes + questions, attach to lessons)
- Homework grading (submissions list, grade + feedback)
- Lesson Plan Templates (create, expand to view objectives/activities,
  delete own)
- Teacher Analytics (student performance, pass rates)

### Admin Portal
- Overview (KPI cards, charts, recent activity)
- Revenue Analytics (monthly revenue, payment method breakdown, growth)
- Revenue Forecast (linear regression, 3-month projection, confidence)
- Students CRUD + CSV export + pagination
- Teachers CRUD
- Groups CRUD (capacity, schedule, teacher assignment)
- Courses (curriculum tree viewer)
- Question Bank (manual add + AI quiz generation via LLM)
- Payments (approve / reject, bulk xlsx import, template download)
- Subscriptions (status filter + pagination)
- Coupons (create, toggle active, delete, redemption tracking)
- Notification Center (broadcast + per-user list with type filter)
- Settings (brand, whatsapp numbers, subscription prices)

### Cross-cutting
- 36 Prisma models, 11 enums, 64 API routes
- Role-based authorization via `requireUser()` / `requireRole()`
- Cookie-based auth, sessions persisted in `Setting` table
- Framer Motion page transitions, hover lifts, entrance animations
- Recharts visualizations (BarChart, LineChart, RadialBarChart)
- Sonner toasts, shadcn/ui components (New York style)
- ErrorBoundary with friendly Arabic fallback
- Mobile-responsive Sheet sidebar (hamburger toggle)
- Custom CSS utilities (shine-on-hover, gradient-border, glow-pulse, etc.)
- Cairo Arabic font + next/font optimization
- Notification preference enforcement (quiet hours + per-type filters)

---

## Technology Stack

| Layer               | Choice                                              |
| ------------------- | --------------------------------------------------- |
| Framework           | **Next.js 16** (App Router, Turbopack)              |
| Language            | **TypeScript 5** (strict)                          |
| Runtime / Package   | **Bun**                                             |
| Styling             | **Tailwind CSS 4** (CSS-first variables)            |
| UI components       | **shadcn/ui** (New York style) + Lucide icons       |
| Animations          | **Framer Motion** 12                                |
| Charts              | **Recharts** 2.15                                   |
| State (client)      | **Zustand** 5 (persisted theme)                     |
| State (server)      | **TanStack Query** 5                                |
| Database            | **SQLite** via **Prisma ORM** 6                     |
| Auth                | Cookie sessions + **scrypt** hashing                |
| Forms               | React Hook Form + Zod 4                             |
| AI                  | Kodgy = scripted (offline); **z-ai-web-dev-sdk** only for admin quiz generation |
| Excel parsing       | **xlsx** 0.18 (bulk payment import + template)      |
| Markdown editor     | **@mdxeditor/editor**                               |
| Font                | **Cairo** (Arabic) via `next/font`                  |
| Theming             | **next-themes** for light/dark                      |
| Toasts              | **sonner**                                          |

---

## User Roles

The platform uses 4 roles defined in the Prisma `Role` enum:

| Role      | Home View           | Description                                              |
| --------- | ------------------- | -------------------------------------------------------- |
| `STUDENT` | `student-dashboard` | Learns lessons, takes quizzes/exams, earns XP/badges     |
| `PARENT`  | `parent-dashboard`  | Monitors one or more linked children, views reports      |
| `TEACHER` | `teacher-dashboard` | Manages groups, attendance, quizzes, homework grading    |
| `ADMIN`   | `admin-overview`    | Full back-office: users, payments, content, settings    |

Authorization is enforced server-side via `requireUser()` /
`requireRole(...roles)` helpers in `src/lib/api.ts`.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                      Browser (RTL Arabic)                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  AppShell (Zustand store view state)                  │  │
│  │   ├── Landing (10 sections)                          │  │
│  │   ├── Auth (login / register / enroll)                │  │
│  │   └── DashboardShell → role-specific view             │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────┬────────────────────────────────┘
                              │ fetch (relative paths, JSON)
                              ▼
┌──────────────────────────────────────────────────────────────┐
│           Next.js 16 API Routes (64 routes)                  │
│   /api/auth/*   /api/admin/*   /api/teacher/*                │
│   /api/students/me/*   /api/parents/me/*   /api/ai/*          │
│   /api/courses   /api/quizzes/*   /api/exams/mock   ...      │
│                                                              │
│   Helpers: requireUser() / requireRole() from src/lib/api.ts │
└─────────────────────────────┬────────────────────────────────┘
                              │ Prisma Client
                              ▼
┌──────────────────────────────────────────────────────────────┐
│           Prisma ORM 6  →  SQLite (db/custom.db)             │
│           36 models · 11 enums · cookie session store        │
└──────────────────────────────────────────────────────────────┘
```

**Single-page app routing**: dashboard views are NOT URL-routed. Instead the
Zustand `view` state (`src/lib/store.ts`) drives a switch in
`src/components/app-shell.tsx`. Only `/` is exposed to the browser.

**AI integration**: Kodgy, the built-in assistant, is a **fully
client-side scripted assistant** (no `/api/ai/*`, no external LLM).
`z-ai-web-dev-sdk` is used server-side only in one route —
`/api/admin/ai-generate-quiz` (LLM-generated quiz questions from lesson
content).

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the deep dive.

---

## Project Structure

```
my-project/
├── prisma/
│   └── schema.prisma              # 36 models, 11 enums, SQLite datasource
├── scripts/
│   ├── seed.ts                    # Main seeder (admin/teacher/student/parent + curriculum)
│   └── seed-parent-demo.ts        # Optional parent demo seeder
├── src/
│   ├── app/
│   │   ├── api/                   # 64 Next.js API routes (role-segmented)
│   │   │   ├── admin/             # Admin-only endpoints
│   │   │   ├── auth/              # Login / register / logout / me
│   │   │   ├── courses/           # Public course catalog
│   │   │   ├── exams/             # Mock exam engine
│   │   │   ├── lessons/           # Lesson content + progress
│   │   │   ├── notifications/     # User notifications
│   │   │   ├── parents/me/        # Parent-scoped endpoints
│   │   │   ├── quizzes/           # Quiz fetch + submit
│   │   │   ├── students/me/       # Student-scoped endpoints
│   │   │   ├── teacher/           # Teacher-scoped endpoints
│   │   │   └── ...                # enroll, groups, settings, coupons
│   │   ├── globals.css            # Tailwind 4 + custom CSS utilities
│   │   ├── layout.tsx             # Root layout (Cairo font, RTL, ThemeProvider)
│   │   └── page.tsx               # Single entry — renders <AppShell/>
│   ├── components/
│   │   ├── admin/                 # admin-dashboard.tsx (3576 lines)
│   │   ├── kodgy/                 # Kodgy assistant (robot + chat + state)
│   │   ├── auth/                  # auth-view.tsx + enroll-view.tsx
│   │   ├── course/                # student-course, student-lesson, quiz-runner
│   │   ├── dashboard/             # shell.tsx (sidebar + header + nav)
│   │   ├── landing/               # hero.tsx + sections.tsx (9 sections)
│   │   ├── parent/                # parent-dashboard, monthly-report, weekly-report, analytics-view
│   │   ├── shared/                # notification-preferences.tsx
│   │   ├── student/               # 9 student views (dashboard, mock-exam, etc.)
│   │   ├── teacher/               # teacher-dashboard.tsx (3241 lines)
│   │   ├── ui/                    # shadcn/ui (53 components)
│   │   ├── app-shell.tsx          # View router (Zustand → component)
│   │   ├── app-providers.tsx      # TanStack Query + theme providers
│   │   ├── error-boundary.tsx
│   │   ├── logo.tsx
│   │   └── theme-provider.tsx
│   ├── hooks/                     # use-toast, use-mobile
│   └── lib/
│       ├── api.ts                 # ok() / err() / requireUser() / requireRole()
│       ├── auth.ts                # scrypt hashing + cookie sessions
│       ├── brand.ts               # Centralized brand config
│       ├── curriculum.ts           # Part 1 + Part 2 seed curriculum
│       ├── db.ts                  # Prisma client (singleton)
│       ├── gamification.ts        # XP rules, levels, badges, stats builder
│       ├── notify.ts              # Notification preference helper
│       ├── store.ts               # Zustand store (view, user, theme, sidebar)
│       └── utils.ts               # cn() + misc helpers
├── db/
│   └── custom.db                  # SQLite database (gitignored)
├── public/
│   ├── logo.svg
│   ├── manifest.json              # PWA manifest
│   ├── robots.txt
│   └── sitemap.xml
├── docs/                           # ← This documentation set
├── agent-ctx/                      # Per-task agent work records
├── mini-services/                 # Optional sidecar services (e.g. websocket)
├── examples/                      # Reference implementations
├── .env.example                    # Environment template (committed)
├── Caddyfile                       # Gateway config (XTransformPort proxy)
├── components.json                # shadcn/ui config (New York)
├── eslint.config.mjs
├── next.config.ts                 # output: "standalone", TS ignore off
├── package.json
├── postcss.config.mjs
├── tailwind.config.ts
└── tsconfig.json
```

---

## Prerequisites

- **Node.js** 18+ (for tooling; Bun is the primary runtime)
- **Bun** runtime — install from <https://bun.sh>
- A POSIX shell (bash / zsh) for the dev scripts
- ~500 MB free disk for `node_modules` and SQLite DB

---

## Installation

```bash
# 1. Clone the repository
git clone <repo-url> codemind-academy
cd codemind-academy

# 2. Install dependencies with Bun
bun install

# 3. Copy the env template
cp .env.example .env
# Edit .env — only DATABASE_URL is required (see below)

# 4. Initialize the database schema
bun run db:push

# 5. Seed demo data (admin / teacher / student / parent + curriculum)
bun run scripts/seed.ts

# 6. Start the dev server
bun run dev
```

The app boots on **http://localhost:3000** (Next.js dev server).

---

## Environment Variables

CodeMind is intentionally minimal on env vars. Copy `.env.example` to
`.env` and configure the single required variable:

```bash
# Required — SQLite connection string (relative to project root)
DATABASE_URL="file:./db/custom.db"

# Optional — public URL of the deployed app (referral links, etc.)
NEXT_PUBLIC_URL="http://localhost:3000"
```

### Notes

- **No `JWT_SECRET` is required** — auth uses cookie-based sessions
  persisted in the `Setting` table with `scrypt`-hashed passwords.
- **`z-ai-web-dev-sdk`** (admin quiz generation only) is configured
  automatically in the sandbox environment. For production deployment,
  ensure SDK credentials are available on the host (no env var needed —
  the SDK handles auth internally). Kodgy itself needs no credentials.
- **Payment methods** (InstaPay, Vodafone Cash, e& Cash) are
  informational only — there is no payment-gateway integration. Payments
  are verified manually by the admin.
- **Branding overrides** (brand_name, whatsapp numbers, prices, academic
  year) live in the `Setting` table and are editable via the Admin →
  Settings UI. Defaults ship in `src/lib/brand.ts`.

---

## Database Setup

```bash
# Push schema (creates tables, idempotent — accepts data loss warnings)
bun run db:push

# Seed demo accounts + curriculum + sample quizzes/homework/groups
bun run scripts/seed.ts
```

To reset the database completely:

```bash
rm -f db/custom.db
bun run db:push
bun run scripts/seed.ts
```

See [`docs/DATABASE_GUIDE.md`](docs/DATABASE_GUIDE.md) for the full
model reference (36 models, 11 enums) and reset/backup commands.

---

## Demo Accounts

After running the seeder, the following accounts are available:

| Role    | Email                           | Password      |
| ------- | ------------------------------- | ------------- |
| Admin   | `admin@codemind.academy`       | `admin123`    |
| Teacher | `teacher@codemind.academy`      | `teacher123`  |
| Student | `student@codemind.academy`      | `student123`  |
| Parent  | `parent@codemind.academy`       | `parent123`   |

> The seeder also creates a linked student → parent relationship, a
> `Group A — Sat & Tue 6PM` group with one student enrolled, two live
> sessions (one upcoming, one past with attendance), 4 subscription
> plans (Monthly / 3 Months / 6 Months / Early Bird), and a 3-question
> sample quiz on the first lesson.

---

## Development Commands

```bash
bun run dev          # Start Next.js dev server (port 3000, logs to dev.log)
bun run lint         # ESLint (next + typescript-eslint)
bun run db:push      # Push schema to SQLite (--accept-data-loss)
bun run db:generate  # Regenerate Prisma Client after schema changes
bun run db:migrate   # Create + apply a Prisma migration (dev mode)
bun run db:reset     # Drop and recreate the database (destructive!)
bun run scripts/seed.ts           # Run the main seeder
bun run scripts/seed-parent-demo.ts  # Add an extra parent demo
```

> The dev server is started automatically by the sandbox host. Do NOT
> start it manually unless you are running locally. Use `bun run lint`
> to check code quality between changes.

---

## Production Build

```bash
# 1. Build the standalone Next.js bundle
bun run build
# (internally runs `next build` then copies static + public assets
#  into .next/standalone/.next and .next/standalone/public)

# 2. Run the production server
bun run start
# (runs NODE_ENV=production bun .next/standalone/server.js, logs to server.log)
```

`next.config.ts` sets `output: "standalone"`, producing a self-contained
`.next/standalone/server.js` that can be deployed to any Node-compatible
host without the full `node_modules` tree.

---

## Deployment

CodeMind ships as a single Next.js deployment. The recommended targets
are:

1. **Vercel** — native Next.js platform, zero-config. Just point at the
   repo and Vercel handles build + HTTPS + CDN.
2. **VPS with Docker / Caddy** — use the standalone server output and
   run behind a reverse proxy that terminates TLS.

For SQLite dev → PostgreSQL production migration, full step-by-step
instructions, env var checklist, log file locations, update / rollback
procedures, see **[`docs/DEPLOYMENT_GUIDE.md`](docs/DEPLOYMENT_GUIDE.md)**.

---

## Troubleshooting

Common issues and their fixes (port conflicts, Prisma sync errors,
OOM in the 4 GB sandbox, lint errors, build failures, auth/cookie
problems, API 500s) are documented in
**[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)**.

The dev server log lives at `dev.log` (project root) and the production
log at `server.log`. Read the most recent lines when diagnosing API
errors.

---

## Git Workflow

We follow a simple GitHub Flow:

1. **Branch** off `main` for every change:
   ```bash
   git checkout -b feat/<short-description>
   ```
2. **Commit** small, focused units. Use Conventional Commits prefixes
   (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`).
3. **Push** and open a Pull Request against `main`.
4. **Lint must pass**: `bun run lint` should be clean (0 errors, 0
   warnings) before requesting review.
5. **Squash-merge** the PR once approved.

> Every agent that works on this project appends a work record to
> `worklog.md` and writes a per-task summary to `agent-ctx/<id>-<name>.md`.

---

## License

Released under the **MIT License**.

```
MIT License

Copyright (c) 2024 CodeMind Academy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

_CodeMind Academy — built with Next.js 16, Prisma, Tailwind CSS 4 and
shadcn/ui. Arabic-first, Egyptian-made._
