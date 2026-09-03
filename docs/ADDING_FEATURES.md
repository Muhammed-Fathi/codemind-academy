# Adding New Features

This guide walks you through adding a new feature to CodeMind Academy
end-to-end. It assumes you've already set up the project per
[`DEVELOPMENT_GUIDE.md`](DEVELOPMENT_GUIDE.md) and understand the
architecture in [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## The 8-Step Recipe

Every new feature in CodeMind follows this recipe:

1. **Database** — Add a model to `prisma/schema.prisma` → run
   `bun run db:push`.
2. **API** — Create a route handler in
   `src/app/api/<path>/route.ts`.
3. **Auth** — Use `requireUser()` or `requireRole(...)` from
   `src/lib/api.ts`.
4. **Frontend** — Create a component in `src/components/<role>/`.
5. **State** — Add a new `ViewKey` to `src/lib/store.ts`.
6. **Router** — Add a `case` to the `renderView` switch in
   `src/components/app-shell.tsx`.
7. **Sidebar** — Add a nav item in
   `src/components/dashboard/shell.tsx` (`NAV_BY_ROLE[role]`).
8. **Test & Lint** — `bun run dev`, verify in browser, then
   `bun run lint`.

Each step is detailed below, followed by a fully worked example.

---

## Step 1 — Database

If your feature needs persistence, add a Prisma model.

**File**: `prisma/schema.prisma`

```prisma
model Project {
  id          String   @id @default(cuid())
  studentId   String
  title       String
  description String?
  status      String   @default("PENDING")  // PENDING | DONE
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  student Student @relation(fields: [studentId], references: [id], onDelete: Cascade)

  @@index([studentId])
}
```

Then add a back-relation to the parent model (here `Student`):

```prisma
model Student {
  // ... existing fields ...
  projects Project[]   // ← add this line
}
```

Push the schema:

```bash
bun run db:push
```

This regenerates the Prisma client (`@prisma/client`) and creates the
new table in `db/custom.db`.

### Tips

- Use `String` for JSON columns (SQLite doesn't have a native JSON
  type — store with `JSON.stringify()`, read with `JSON.parse()`).
- Always add `@@index` on foreign keys to keep queries fast.
- Use `@@unique` for natural unique constraints (e.g.
  `[studentId, lessonId]` for `LessonProgress`).
- Use `onDelete: Cascade` for child rows that shouldn't survive
  parent deletion (e.g. `StudentBadge` when a `Student` is deleted).

---

## Step 2 — API Route

Create a route handler. The path determines the URL.

**File**: `src/app/api/students/me/projects/route.ts`

```ts
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";

// GET /api/students/me/projects
export async function GET() {
  const { user, error } = await requireRole("STUDENT");
  if (error) return error;

  const student = await db.student.findUnique({
    where: { userId: user!.id },
  });
  if (!student) return err("Student profile not found", 404);

  const projects = await db.project.findMany({
    where: { studentId: student.id },
    orderBy: { createdAt: "desc" },
  });

  return ok({ projects });
}

// POST /api/students/me/projects
export async function POST(req: Request) {
  const { user, error } = await requireRole("STUDENT");
  if (error) return error;

  const body = await req.json();
  const { title, description } = body;
  if (!title || title.trim().length < 3) {
    return err("Title must be at least 3 characters", 400);
  }

  const student = await db.student.findUnique({
    where: { userId: user!.id },
  });
  if (!student) return err("Student profile not found", 404);

  const project = await db.project.create({
    data: {
      studentId: student.id,
      title: title.trim(),
      description: description?.trim() || null,
    },
  });

  return ok({ project }, { status: 201 });
}
```

### Tips

- Always use `ok(data)` and `err(message, status)` from
  `src/lib/api.ts` — they wrap `NextResponse.json()` consistently.
- For dynamic routes (e.g. `/api/students/me/projects/[id]`), create
  the file at `src/app/api/students/me/projects/[id]/route.ts` and
  access the ID via the second argument:
  ```ts
  export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
  ) {
    const { id } = await params;
    // ...
  }
  ```
  > In Next.js 16, dynamic route `params` are async — always
  > `await params`.
- Use the `z-ai-web-dev-sdk` server-side for any AI calls — never
  import it in a client component.

---

## Step 3 — Auth / Authorization

Two helpers from `src/lib/api.ts`:

### `requireUser()` — any authenticated user

```ts
import { requireUser } from "@/lib/api";

export async function GET() {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  // ...
}
```

### `requireRole(...roles)` — specific roles only

```ts
import { requireRole } from "@/lib/api";

export async function GET() {
  const { user, error } = await requireRole("STUDENT");
  if (error) return error;   // 401 if not logged in, 403 if wrong role
  // user is non-null here
  // ...
}
```

Multiple roles: `requireRole("STUDENT", "PARENT")`.

### Profile helpers

For convenience, `src/lib/api.ts` exports eager-loading helpers:

```ts
import { getStudentProfile, getParentProfile, getTeacherProfile } from "@/lib/api";

const student = await getStudentProfile(user.id);
// includes: user, group (with course + teacher), subscription (with plan + payments)
```

---

## Step 4 — Frontend Component

Create the React component. Use shadcn/ui + Tailwind + Framer Motion +
TanStack Query.

**File**: `src/components/student/projects-view.tsx`

```tsx
"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { Plus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Project = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  createdAt: string;
};

export function ProjectsView() {
  const qc = useQueryClient();
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");

  const { data, isLoading } = useQuery<{ projects: Project[] }>({
    queryKey: ["student-projects"],
    queryFn: () => fetch("/api/students/me/projects").then((r) => r.json()),
  });

  const createMutation = useMutation({
    mutationFn: (body: { title: string; description?: string }) =>
      fetch("/api/students/me/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json()),
    onSuccess: () => {
      toast.success("اتضاف المشروع 🎉");
      setTitle("");
      setDescription("");
      qc.invalidateQueries({ queryKey: ["student-projects"] });
    },
    onError: () => toast.error("حصلت مشكلة. حاول تاني."),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>المشاريع</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="عنوان المشروع"
          />
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="الوصف (اختياري)"
          />
          <Button
            onClick={() => createMutation.mutate({ title, description })}
            disabled={!title.trim() || createMutation.isPending}
          >
            {createMutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
            إضافة
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-3">
        {isLoading ? (
          <div>جارٍ التحميل…</div>
        ) : (
          data?.projects.map((p, i) => (
            <motion.div
              key={p.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
            >
              <Card className="card-hover">
                <CardContent className="p-4">
                  <div className="font-bold">{p.title}</div>
                  {p.description && (
                    <div className="text-sm text-muted-foreground mt-1">
                      {p.description}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground mt-2">
                    {new Date(p.createdAt).toLocaleDateString("ar-EG")}
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))
        )}
      </div>
    </div>
  );
}
```

### Conventions

- Always add `"use client";` at the top — every dashboard view is a
  client component.
- Use the shadcn/ui components in `src/components/ui/`. Don't reinvent
  buttons, inputs, cards, dialogs.
- Use Tailwind utility classes — no inline `style={{}}` unless
  absolutely necessary.
- Use brand palette: emerald (`primary`), amber (`secondary`), teal
  (`accent`). **No indigo or blue.**
- Use Framer Motion for entrance + hover animations. Apply `card-hover`
  or `card-lift` utility classes for hover effects.
- Egyptian Arabic UI copy with English technical terms kept as-is
  (Project, Quiz, Lesson, …).
- Use `sonner` toast (`toast.success()`, `toast.error()`) for user
  feedback.
- Wrap long lists in `max-h-96 overflow-y-auto` with the custom
  scrollbar styling.

---

## Step 5 — Add the ViewKey

**File**: `src/lib/store.ts`

```ts
export type ViewKey =
  | "landing"
  | "login"
  | "register"
  | "enroll"
  | "student-dashboard"
  // ... existing keys ...
  | "student-projects"   // ← add this line
  | "parent-dashboard"
  // ...
```

The `ViewKey` union is the source of truth for navigation. TypeScript
will catch any typos when you use `setView("student-projects")`.

---

## Step 6 — Add the Router Case

**File**: `src/components/app-shell.tsx`

Find the `renderView(view)` function and add a case:

```ts
function renderView(view: string) {
  switch (view) {
    case "student-dashboard":
      return <StudentDashboard />;
    // ... existing cases ...
    case "student-projects":
      return <ProjectsView />;
    // ...
  }
}
```

Also add the import at the top of the file:

```ts
import { ProjectsView } from "@/components/student/projects-view";
```

### Tips

- For admin views, all `admin-*` keys currently route to
  `<AdminDashboard />` which internally switches on the view. To add a
  new admin sub-view, follow the pattern inside
  `src/components/admin/admin-dashboard.tsx`.
- For teacher views, all `teacher-*` keys route to
  `<TeacherDashboard />` which internally switches on the view (same
  pattern).

---

## Step 7 — Add the Sidebar Nav Item

**File**: `src/components/dashboard/shell.tsx`

Find the `NAV_BY_ROLE` constant and add an entry to the matching
role's array:

```ts
const NAV_BY_ROLE: Record<string, NavItem[]> = {
  STUDENT: [
    { key: "student-dashboard", label: "Dashboard", icon: LayoutDashboard },
    { key: "student-course", label: "الكورس", icon: BookOpen },
    // ... existing items ...
    { key: "student-projects", label: "المشاريع", icon: FolderKanban },  // ← add this
    // ...
  ],
  // ...
};
```

Don't forget to add the Lucide icon to the import statement at the top
of the file:

```ts
import {
  // ... existing imports ...
  FolderKanban,   // ← add this
} from "lucide-react";
```

### Tips

- Pick an icon that visually communicates the feature. See
  <https://lucide.dev> for the full set.
- Keep labels short (1-3 Arabic words). Use English technical terms
  where appropriate (Dashboard, Mock Exams, Bookmarks).
- Order items by frequency of use, not alphabetically.

---

## Step 8 — Test & Lint

```bash
# 1. Start the dev server (if not already running)
bun run dev

# 2. Open the app, log in with the matching demo account
#    (student@codemind.academy / student123 for the example above)

# 3. Click your new sidebar item — verify the component renders

# 4. Test the API directly with curl
curl -b cookies.txt -c cookies.txt \
  -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"student@codemind.academy","password":"student123"}'

curl -b cookies.txt http://localhost:3000/api/students/me/projects

curl -b cookies.txt -X POST http://localhost:3000/api/students/me/projects \
  -H "Content-Type: application/json" \
  -d '{"title":"My First Project","description":"A test project"}'

# 5. Lint
bun run lint
# (must be clean — 0 errors, 0 warnings)

# 6. Check the dev log for any runtime errors
tail -n 50 dev.log
```

---

## Fully Worked Example — Adding a "Study Goals" Feature

Let's say we want to add a feature where students set weekly study
goals (e.g. "Complete 5 lessons this week") and track progress.

### Step 1 — Schema

Add to `prisma/schema.prisma`:

```prisma
model StudyGoal {
  id          String   @id @default(cuid())
  studentId   String
  weekStart   DateTime
  lessonsTarget Int    @default(5)
  quizzesTarget Int    @default(2)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  student Student @relation(fields: [studentId], references: [id], onDelete: Cascade)

  @@unique([studentId, weekStart])
  @@index([studentId])
}
```

Add back-relation to `Student`:

```prisma
model Student {
  // ... existing fields ...
  studyGoals StudyGoal[]
}
```

Run:

```bash
bun run db:push
```

### Step 2 — API

Create `src/app/api/students/me/goals/route.ts`:

```ts
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";

function startOfWeek(d = new Date()) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day;
  date.setDate(diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

export async function GET() {
  const { user, error } = await requireRole("STUDENT");
  if (error) return error;

  const student = await db.student.findUnique({ where: { userId: user!.id } });
  if (!student) return err("Student profile not found", 404);

  const weekStart = startOfWeek();
  const goal = await db.studyGoal.findUnique({
    where: { studentId_weekStart: { studentId: student.id, weekStart } },
  });

  // compute progress this week
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const [lessons, quizzes] = await Promise.all([
    db.lessonProgress.count({
      where: {
        studentId: student.id,
        isCompleted: true,
        lastViewedAt: { gte: weekStart, lt: weekEnd },
      },
    }),
    db.quizAttempt.count({
      where: {
        studentId: student.id,
        finishedAt: { gte: weekStart, lt: weekEnd },
      },
    }),
  ]);

  return ok({
    goal,
    progress: { lessons, quizzes },
    weekStart,
    weekEnd,
  });
}

export async function POST(req: Request) {
  const { user, error } = await requireRole("STUDENT");
  if (error) return error;

  const body = await req.json();
  const { lessonsTarget, quizzesTarget } = body;
  if (
    typeof lessonsTarget !== "number" ||
    typeof quizzesTarget !== "number" ||
    lessonsTarget < 1 ||
    quizzesTarget < 1
  ) {
    return err("Targets must be positive numbers", 400);
  }

  const student = await db.student.findUnique({ where: { userId: user!.id } });
  if (!student) return err("Student profile not found", 404);

  const weekStart = startOfWeek();
  const goal = await db.studyGoal.upsert({
    where: { studentId_weekStart: { studentId: student.id, weekStart } },
    update: { lessonsTarget, quizzesTarget },
    create: { studentId: student.id, weekStart, lessonsTarget, quizzesTarget },
  });

  return ok({ goal });
}
```

### Step 3 — Auth (already done via `requireRole("STUDENT")`).

### Step 4 — Component

Create `src/components/student/goals-view.tsx`:

```tsx
"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { Target, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";

export function GoalsView() {
  const qc = useQueryClient();
  const [lessonsTarget, setLessonsTarget] = React.useState("5");
  const [quizzesTarget, setQuizzesTarget] = React.useState("2");

  const { data, isLoading } = useQuery({
    queryKey: ["student-goals"],
    queryFn: () => fetch("/api/students/me/goals").then((r) => r.json()),
  });

  React.useEffect(() => {
    if (data?.goal) {
      setLessonsTarget(String(data.goal.lessonsTarget));
      setQuizzesTarget(String(data.goal.quizzesTarget));
    }
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: (body: { lessonsTarget: number; quizzesTarget: number }) =>
      fetch("/api/students/me/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json()),
    onSuccess: () => {
      toast.success("اتحفظ الـGoal 🎯");
      qc.invalidateQueries({ queryKey: ["student-goals"] });
    },
    onError: () => toast.error("حصلت مشكلة. حاول تاني."),
  });

  if (isLoading) return <div>جارٍ التحميل…</div>;

  const lessonsProgress = data?.goal
    ? Math.min(100, ((data.progress.lessons || 0) / data.goal.lessonsTarget) * 100)
    : 0;
  const quizzesProgress = data?.goal
    ? Math.min(100, ((data.progress.quizzes || 0) / data.goal.quizzesTarget) * 100)
    : 0;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="w-5 h-5 text-primary" />
            أهداف الأسبوع
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">Lessons Target</label>
            <Input
              type="number"
              value={lessonsTarget}
              onChange={(e) => setLessonsTarget(e.target.value)}
              min={1}
            />
            <label className="text-sm">Quizzes Target</label>
            <Input
              type="number"
              value={quizzesTarget}
              onChange={(e) => setQuizzesTarget(e.target.value)}
              min={1}
            />
          </div>
          <Button
            onClick={() =>
              saveMutation.mutate({
                lessonsTarget: Number(lessonsTarget),
                quizzesTarget: Number(quizzesTarget),
              })
            }
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : null}
            حفظ
          </Button>
        </CardContent>
      </Card>

      {data?.goal && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="grid gap-3"
        >
          <Card>
            <CardContent className="p-4 space-y-2">
              <div className="flex justify-between">
                <span className="font-bold">Lessons</span>
                <span className="text-sm text-muted-foreground">
                  {data.progress.lessons} / {data.goal.lessonsTarget}
                </span>
              </div>
              <Progress value={lessonsProgress} />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 space-y-2">
              <div className="flex justify-between">
                <span className="font-bold">Quizzes</span>
                <span className="text-sm text-muted-foreground">
                  {data.progress.quizzes} / {data.goal.quizzesTarget}
                </span>
              </div>
              <Progress value={quizzesProgress} />
            </CardContent>
          </Card>
        </motion.div>
      )}
    </div>
  );
}
```

### Step 5 — Add ViewKey

In `src/lib/store.ts`, add `"student-goals"` to the `ViewKey` union.

### Step 6 — Add Router Case

In `src/components/app-shell.tsx`:

```ts
import { GoalsView } from "@/components/student/goals-view";
// ...
case "student-goals":
  return <GoalsView />;
```

### Step 7 — Add Sidebar Item

In `src/components/dashboard/shell.tsx`:

```ts
import { /* ..., */ Target } from "lucide-react";
// ...
STUDENT: [
  // ...
  { key: "student-goals", label: "أهدافي", icon: Target },
  // ...
],
```

### Step 8 — Test & Lint

```bash
bun run dev   # already running
# Log in as student@codemind.academy / student123
# Click "أهدافي" in the sidebar
# Set targets, click "حفظ", verify toast
# Reload page — targets should persist

bun run lint   # 0 errors
```

---

## Patterns & Conventions

### Egyptian Arabic copy

- Use Egyptian dialect, not Modern Standard Arabic.
  - "إيه" instead of "ماذا"
  - "إزاي" instead of "كيف"
  - "خلصت" instead of "أنهيت"
- Keep English technical terms as-is: Lesson, Quiz, Session, Mock
  Exam, Certificate, XP, Level, Dashboard.
- "حصلت مشكلة. حاول تاني." for generic errors.
- "جارٍ التحميل…" for loading states.

### Toast feedback

```ts
import { toast } from "sonner";

toast.success("اتضاف المشروع 🎉");
toast.error("حصلت مشكلة. حاول تاني.");
toast.loading("جارٍ التوليد...");  // returns ID for dismissal
```

### Empty states

Always render a friendly empty state — never a blank page:

```tsx
{data?.projects.length === 0 && (
  <Card>
    <CardContent className="p-8 text-center text-muted-foreground">
      <FolderKanban className="w-10 h-10 mx-auto mb-2 opacity-40" />
      مفيش مشاريع لسه. ابدأ بأول مشروع ليك!
    </CardContent>
  </Card>
)}
```

### Loading states

Use skeleton placeholders (shadcn `<Skeleton>`):

```tsx
{isLoading ? (
  <div className="space-y-2">
    <Skeleton className="h-12 w-full" />
    <Skeleton className="h-12 w-full" />
    <Skeleton className="h-12 w-full" />
  </div>
) : (
  // actual content
)}
```

### Error states

Use the `ErrorBoundary` wrapper for unexpected render crashes. For
API errors, show a retry card:

```tsx
{isError && (
  <Card>
    <CardContent className="p-8 text-center">
      <p className="text-destructive">حصلت مشكلة. حاول تاني.</p>
      <Button onClick={() => refetch()} className="mt-3">إعادة المحاولة</Button>
    </CardContent>
  </Card>
)}
```

### Mobile responsiveness

- Test at 375×812 (iPhone 13 mini width).
- Use Tailwind responsive prefixes: `sm:`, `md:`, `lg:`, `xl:`.
- Sidebar collapses to a Sheet (hamburger button) on mobile — already
  handled by `DashboardShell`.
- Touch targets ≥ 44 px (`min-h-[44px]` on buttons).

### Charts (Recharts)

Wrap chart containers in `dir="ltr"` so axis labels render correctly:

```tsx
<div dir="ltr">
  <LineChart data={data}>
    <Line dataKey="score" stroke="var(--chart-1)" strokeWidth={2} />
    <XAxis dataKey="label" />
    <YAxis />
    <Tooltip />
  </LineChart>
</div>
```

Use brand tokens: `--chart-1` (emerald), `--chart-2` (amber),
`--chart-3` (teal).

---

## Common Pitfalls

1. **Forgetting `await params`** in dynamic routes (Next.js 16 made
   `params` async). Your route will hang or fail mysteriously.
2. **Importing `z-ai-web-dev-sdk` in a client component** — it must
   only be used server-side. Move the LLM call into an API route.
3. **Forgetting the back-relation on the parent model** — Prisma
   throws "Unknown field" when you try to `include: { child: ... }`.
4. **Using `reactStrictMode: true`** — it's intentionally off in
   `next.config.ts` to avoid double-effect quirks. Don't re-enable it.
5. **Using absolute API URLs** (`fetch('http://localhost:3000/...')`)
   — always use relative paths (`fetch('/api/...')`) so Caddy /
   Vercel can route correctly.
6. **Hardcoding `localhost:<port>` for mini-services** — use
   `fetch('/api/...?XTransformPort=<port>')` instead.
7. **Forgetting to `invalidateQueries` after a mutation** — the UI
   won't refresh to show the new data.
8. **Using `bg-indigo-*` or `bg-blue-*`** — these are forbidden by
   the brand guidelines. Use `bg-primary`, `bg-secondary`, `bg-accent`
   or explicit emerald/amber/teal classes.
