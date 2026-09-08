# Development Guide

This guide walks a new contributor from a fresh clone to making code
changes. For architecture details see
[`ARCHITECTURE.md`](ARCHITECTURE.md); for adding new features see
[`ADDING_FEATURES.md`](ADDING_FEATURES.md).

---

## 1. Clone & Install

```bash
# 1. Clone
git clone <repo-url> codemind-academy
cd codemind-academy

# 2. Install dependencies (Bun is the package manager)
bun install
```

Bun is required. Install from <https://bun.sh> if you don't have it.

---

## 2. Configure `.env`

```bash
cp .env.example .env
```

Edit `.env` — only one variable is required:

```bash
DATABASE_URL="file:./db/custom.db"
```

Optional:

```bash
NEXT_PUBLIC_URL="http://localhost:3000"
```

> No `JWT_SECRET` is required. Auth uses cookie sessions persisted in
> the `Setting` table with scrypt-hashed passwords. See
> [`DATABASE_GUIDE.md`](DATABASE_GUIDE.md) for the full schema.

---

## 3. Initialize the Database

```bash
# Push the Prisma schema to SQLite (creates db/custom.db)
bun run db:push

# Seed demo accounts + curriculum + sample quizzes/homework
bun run scripts/seed.ts
```

After seeding you have 4 demo accounts ready to log in:

| Role    | Email                          | Password      |
| ------- | ------------------------------ | ------------- |
| Admin   | `admin@codemind.academy`      | `admin123`    |
| Teacher | `teacher@codemind.academy`     | `teacher123`  |
| Student | `student@codemind.academy`     | `student123`  |
| Parent  | `parent@codemind.academy`      | `parent123`   |

---

## 4. Start the Dev Server

```bash
bun run dev
```

This runs `next dev -p 3000` and tees output to `dev.log`. The app
boots on `http://localhost:3000`.

> In the cloud sandbox the dev server is started automatically by the
> host. Do NOT start it manually there — just check `dev.log`.

---

## 5. Where Things Live

### Frontend code

| Concern               | Path                                                |
| --------------------- | --------------------------------------------------- |
| Single page entry     | `src/app/page.tsx`                                  |
| Root layout (RTL/Cairo/theme) | `src/app/layout.tsx`                          |
| Global styles         | `src/app/globals.css`                               |
| Landing sections      | `src/components/landing/hero.tsx`, `sections.tsx`  |
| Auth + Enrollment     | `src/components/auth/auth-view.tsx`, `enroll-view.tsx` |
| View router           | `src/components/app-shell.tsx`                      |
| Dashboard chrome      | `src/components/dashboard/shell.tsx`               |
| Student portal        | `src/components/student/`                            |
| Parent portal         | `src/components/parent/`                              |
| Teacher portal        | `src/components/teacher/teacher-dashboard.tsx`     |
| Admin portal          | `src/components/admin/admin-dashboard.tsx`          |
| Kodgy AI assistant   | `src/components/kodgy/` + `src/lib/kodgy/`        |
| shadcn/ui components  | `src/components/ui/`                                 |
| Error boundary        | `src/components/error-boundary.tsx`                 |
| App providers         | `src/components/app-providers.tsx`                  |

### API routes

All backend logic lives under `src/app/api/`. There are **64 route
files** organized by audience:

| Path prefix                       | Audience        | Examples                                        |
| --------------------------------- | --------------- | ----------------------------------------------- |
| `src/app/api/auth/[action]/`     | Public          | login, register, logout, me                     |
| `src/app/api/admin/`              | ADMIN           | overview, students, teachers, groups, payments, coupons, question-bank, notifications, notifications-center, settings, revenue-analytics, revenue-forecast, ai-generate-quiz, export-progress |
| `src/app/api/teacher/`           | TEACHER         | dashboard, attendance, homework, quizzes, templates, analytics, lessons |
| `src/app/api/students/me/`        | STUDENT         | dashboard, gamification, bookmarks, notes, study-plan, referral, certificate, leaderboard, homework, notification-prefs, export-progress |
| `src/app/api/parents/me/`         | PARENT          | dashboard, analytics, weekly-report, link-student, notification-prefs |
| `src/app/api/courses/`            | Public + auth   | list + by-slug                                  |
| `src/app/api/quizzes/[id]/`       | STUDENT         | fetch + submit                                  |
| `src/app/api/lessons/[id]/`       | STUDENT         | lesson content + progress update                |
| `src/app/api/exams/mock/`         | STUDENT         | randomized mock exam engine                    |
| `src/app/api/notifications/`      | Any authed      | list + unread-count                             |
| `src/app/api/enroll/`             | STUDENT         | Course→Group→Plan→Payment POST                 |
| `src/app/api/coupons/validate/`   | STUDENT         | Coupon validation                              |
| `src/app/api/groups/`             | Public          | Group capacity + teacher info                  |
| `src/app/api/subscription-plans/` | Public          | Subscription tiers                             |
| `src/app/api/settings/public/`    | Public          | Brand + whatsapp + prices                      |

### Database logic

| Concern               | Path                                                |
| --------------------- | --------------------------------------------------- |
| Prisma schema         | `prisma/schema.prisma` (36 models, 11 enums)       |
| Prisma client         | `src/lib/db.ts` (singleton, `import { db }`)       |
| SQLite file           | `db/custom.db` (gitignored)                         |
| Seeder                | `scripts/seed.ts`                                   |
| Optional seeder       | `scripts/seed-parent-demo.ts`                       |

### Auth

| Concern               | Path                                                |
| --------------------- | --------------------------------------------------- |
| Hashing + sessions    | `src/lib/auth.ts` (scrypt, cookie sessions, 7-day TTL) |
| Auth route            | `src/app/api/auth/[action]/route.ts` (login/register/logout/me) |

### Authorization

| Concern               | Path                                                |
| --------------------- | --------------------------------------------------- |
| `ok()` / `err()` helpers | `src/lib/api.ts`                                 |
| `requireUser()`       | `src/lib/api.ts`                                    |
| `requireRole(...roles)` | `src/lib/api.ts`                                  |
| `getStudentProfile()` | `src/lib/api.ts`                                    |
| `getParentProfile()`  | `src/lib/api.ts`                                    |
| `getTeacherProfile()` | `src/lib/api.ts`                                    |

### Other lib modules

| Module                | Path                                                | Purpose                                       |
| --------------------- | --------------------------------------------------- | --------------------------------------------- |
| Brand config          | `src/lib/brand.ts`                                  | Name, colors, whatsapp, plans, academic year |
| Curriculum seed       | `src/lib/curriculum.ts`                             | Part 1 + Part 2 lesson tree                   |
| Gamification engine   | `src/lib/gamification.ts`                           | XP rules, 6 levels, 9 badges, stats builder   |
| Notification helper   | `src/lib/notify.ts`                                 | Preference + quiet-hours enforcement           |
| Zustand store         | `src/lib/store.ts`                                  | View state, user, theme, sidebar               |
| Utils                 | `src/lib/utils.ts`                                  | `cn()` className merge + helpers               |

---

## 6. How to Modify Existing Features

### 6.1 Change brand colors / whatsapp numbers / prices

1. **Defaults**: edit `src/lib/brand.ts`.
2. **Runtime overrides**: log in as Admin → Settings → edit the
   corresponding `Setting` row (e.g. `brand_name`,
   `whatsapp_teacher`, `price_monthly`).
3. The Settings API persists to the `Setting` table; the public
   endpoint `/api/settings/public` is consumed by the landing page.

### 6.2 Add a new lesson / quiz / question

1. Either write a one-off script that calls `db.lesson.create({...})`
   (see `scripts/seed.ts` for the pattern), or
2. Use the Admin → Question Bank → "AI Generate" button to
   auto-generate quiz questions from lesson content.
3. Manual questions can be added via Admin → Question Bank → "Add
   Question".

### 6.3 Change an API response shape

1. Open the route file (e.g.
   `src/app/api/students/me/dashboard/route.ts`).
2. Edit the JSON returned by `ok({...})`.
3. Update the consuming component's TypeScript type if needed (most
   components use `useQuery` + inline types — find the consumer with
   a project-wide grep).
4. Run `bun run lint` to catch type errors.

### 6.4 Add a sidebar nav item

1. Add the new `ViewKey` to the `ViewKey` union in `src/lib/store.ts`.
2. Add a `case "your-new-view"` to the `renderView` switch in
   `src/components/app-shell.tsx` returning your new component.
3. Add a nav item to `NAV_BY_ROLE[role]` in
   `src/components/dashboard/shell.tsx` with the right Lucide icon.

### 6.5 Change the landing page copy

All marketing copy lives in `src/components/landing/hero.tsx` and
`src/components/landing/sections.tsx`. Edit JSX strings directly.

### 6.6 Add a new CSS utility

Append a new utility class to `src/app/globals.css`. The file uses
Tailwind 4 `@theme` for tokens and plain CSS for custom utilities.
Existing patterns: `card-hover`, `card-lift`, `shine-on-hover`,
`gradient-border`, `glow-pulse`, `bg-mesh`, `glass`, `glass-strong`,
`text-gradient`, `press-effect`, `pulse-ring`, etc.

---

## 7. Common Workflows

### 7.1 Restart the dev server cleanly

```bash
# Find and kill anything on port 3000
lsof -i :3000 -t | xargs kill -9 2>/dev/null
# Restart
bun run dev
```

### 7.2 Reset the database from scratch

```bash
rm -f db/custom.db db/custom.db-journal
bun run db:push
bun run scripts/seed.ts
```

### 7.3 Regenerate the Prisma client (after editing schema.prisma)

```bash
bun run db:generate
```

### 7.4 Lint before committing

```bash
bun run lint
```

ESLint is configured via `eslint.config.mjs` with the Next.js preset.
Aim for **0 errors, 0 warnings** before pushing.

### 7.5 Check the dev log

```bash
tail -f dev.log
```

Look for: API route compilation, request logs, errors, OOM kill
messages (the 4 GB sandbox may OOM after compiling 3-4 routes in
succession — see [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md)).

---

## 8. How to Add a New View (full walkthrough)

To add a brand-new dashboard view end-to-end:

1. **Database** (optional): if the feature needs persistence, add a
   model to `prisma/schema.prisma` and run `bun run db:push`.
2. **API**: create `src/app/api/<role>/<feature>/route.ts` exporting
   `GET` / `POST` handlers. Use `requireRole(...)` for auth.
3. **Component**: create `src/components/<role>/<feature>.tsx`.
   Fetch data via `useQuery`, post mutations via `useMutation`,
   surface feedback with `sonner` toasts.
4. **State**: add a new `ViewKey` (e.g. `"student-foo"`) to the union
   in `src/lib/store.ts`.
5. **Router**: add `case "student-foo": return <StudentFoo/>;` to the
   `renderView` switch in `src/components/app-shell.tsx`.
6. **Sidebar**: add an entry to `NAV_BY_ROLE.STUDENT` (or whichever
   role) in `src/components/dashboard/shell.tsx` with a Lucide icon.
7. **Test**: run `bun run dev`, log in with the matching demo account,
   click the new sidebar item, verify the component renders and the
   API returns the expected JSON.
8. **Lint**: `bun run lint` should be clean.

See [`ADDING_FEATURES.md`](ADDING_FEATURES.md) for a fully worked
example.

---

## 9. Production Build

```bash
# Build the standalone Next.js bundle
bun run build
# (internally: next build → cp -r .next/static .next/standalone/.next/
#  → cp -r public .next/standalone/)

# Run the production server
bun run start
# (internally: NODE_ENV=production bun .next/standalone/server.js)
```

`next.config.ts` sets `output: "standalone"` and
`typescript.ignoreBuildErrors: false` (TS errors fail the build).
`reactStrictMode` is **off** to avoid double-effect quirks in dev.

---

## 10. Git Workflow

### 10.1 Branch

```bash
git checkout main
git pull
git checkout -b feat/<short-description>
```

### 10.2 Commit

Use Conventional Commits prefixes:

```
feat: add student daily streak bonus
fix: prevent dashboard crash when subscription is null
docs: add deployment guide
chore: bump prisma to 6.11
refactor: extract quiz grading logic
```

Keep commits small and focused. One feature per PR.

### 10.3 Open a PR

1. `git push -u origin feat/<short-description>`
2. Open a Pull Request against `main`.
3. CI must pass `bun run lint`.
4. Request review from a maintainer.
5. Squash-merge on approval.

### 10.4 Worklog convention

Every agent that works on this project appends a `Task ID: N` section
to `worklog.md` describing what was done, what was verified, and what
risks remain. Per-task summaries also live in
`agent-ctx/<task-id>-<name>.md`. Read the worklog before starting any
new work.

---

## 11. Where to Get Help

- **`worklog.md`** — chronological history of every change, 16 rounds.
- **`agent-ctx/`** — per-task summaries (e.g. `2-student-dashboard.md`,
  `5-admin.md`).
- **`docs/ARCHITECTURE.md`** — high-level architecture.
- **`docs/DATABASE_GUIDE.md`** — full Prisma model reference.
- **`docs/TROUBLESHOOTING.md`** — common errors and fixes.
- **`docs/ADDING_FEATURES.md`** — step-by-step recipe for new features.
- **`dev.log`** — most recent dev server output.
