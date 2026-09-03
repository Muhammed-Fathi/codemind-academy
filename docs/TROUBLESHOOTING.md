# Troubleshooting

Common issues encountered while developing or running CodeMind Academy,
with causes and step-by-step fixes. For deployment-specific issues see
[`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md).

---

## Table of Contents

1. [Port 3000 in Use](#1-port-3000-in-use)
2. [Database Not Found](#2-database-not-found)
3. [Prisma Client Out of Sync](#3-prisma-client-out-of-sync)
4. [Dev Server OOM (4 GB Sandbox)](#4-dev-server-oom-4-gb-sandbox)
5. [Lint Errors](#5-lint-errors)
6. [Build Fails](#6-build-fails)
7. [Auth Not Working](#7-auth-not-working)
8. [API Returns 500](#8-api-returns-500)
9. [CSS / Styling Issues](#9-css--styling-issues)
10. [Charts Rendering Incorrectly (RTL)](#10-charts-rendering-incorrectly-rtl)
11. [AI Assistant Slow / Timeout](#11-ai-assistant-slow--timeout)
12. [TypeScript Errors](#12-typescript-errors)
13. [Coupons / Referral Codes](#13-coupons--referral-codes)
14. [Excel Import Issues](#14-excel-import-issues)
15. [Mobile Sidebar Issues](#15-mobile-sidebar-issues)
16. [Production-Only Issues](#16-production-only-issues)

---

## 1. Port 3000 in Use

### Symptom

```
Error: listen EADDRINUSE: address already in use 0.0.0.0:3000
```

Or the dev server appears to start but no pages respond.

### Cause

A previous `next dev` (or another Node process) is still holding port
3000. Common in the sandbox after a crash or unexpected restart.

### Fix

```bash
# Find the PID holding port 3000
lsof -i :3000 -t
# or
fuser 3000/tcp

# Kill it
kill -9 $(lsof -i :3000 -t)

# Verify the port is free
lsof -i :3000   # should print nothing

# Restart the dev server
bun run dev
```

If `lsof` isn't available:

```bash
ps aux | grep -E "next|node" | grep -v grep
kill -9 <PID>
```

### Prevention

- Always Ctrl+C the dev server cleanly before closing the terminal.
- In the sandbox, the dev server is started automatically — do NOT
  start a second instance manually.

---

## 2. Database Not Found

### Symptom

```
Error: P1: DATABASE_URL not found
```
or
```
Error: SQLITE_CANTOPEN: unable to open database file
```
or
```
PrismaClientInitializationError: Can't reach database server at `db/custom.db`
```

### Cause

- `.env` is missing or `DATABASE_URL` is misconfigured.
- The `db/` directory doesn't exist (the SQLite file path is
  relative).
- The schema hasn't been pushed yet (fresh checkout).

### Fix

```bash
# 1. Verify .env exists and has DATABASE_URL
cat .env
# Should contain: DATABASE_URL="file:./db/custom.db"

# If missing:
cp .env.example .env

# 2. Create the db/ directory if it doesn't exist
mkdir -p db

# 3. Push the schema (creates the .db file)
bun run db:push

# 4. Seed
bun run scripts/seed.ts

# 5. Restart the dev server
bun run dev
```

### Verification

```bash
# The .db file should exist
ls -la db/custom.db

# Open the SQLite CLI to verify tables exist
sqlite3 db/custom.db ".tables"
# Should show: User, Student, Parent, Teacher, Course, Lesson, ...
```

---

## 3. Prisma Client Out of Sync

### Symptom

```
Unknown field `myNewField` for type Student
```
or
```
Type 'Student' is not assignable to type '...'. Property 'myNewField' is missing.
```
or
```
prisma.student.findMany is not a function
```

### Cause

The Prisma client (TypeScript types + runtime) is generated from
`prisma/schema.prisma`. After editing the schema, you must regenerate
the client.

### Fix

```bash
# 1. Regenerate the client
bun run db:generate
# (internally: prisma generate)

# 2. Push the schema changes to the database
bun run db:push

# 3. Restart the dev server (Next.js caches the old client)
bun run dev
```

If you've changed the database provider (e.g. SQLite → PostgreSQL):

```bash
# 1. Update prisma/schema.prisma datasource block
# 2. Update .env DATABASE_URL
# 3. Regenerate + push
bun run db:generate
bun run db:push
```

### Prevention

After every `prisma/schema.prisma` edit, always run:

```bash
bun run db:generate && bun run db:push
```

in sequence. Some IDEs (VS Code) auto-restart the TS server on file
changes; otherwise reload the window.

---

## 4. Dev Server OOM (4 GB Sandbox)

### Symptom

```
<--- Last few GCs --->
...
<--- JavaScript heap out of memory --->
```
or the dev server process simply disappears (no error message, the
port is now free), or `dev.log` shows the last log was an API route
compilation.

### Cause

The cloud sandbox has 4 GB of RAM. Turbopack (Next.js's dev compiler)
uses ~1.3 GB RSS after compiling a few API routes. With the OS, the
browser (agent-browser), and Prisma client all running, the server
gets OOM-killed after 3-4 API route compilations in succession.

This is an **environment constraint, not a code bug**. The production
build (`bun run build && bun run start`) does not have this issue —
only the dev server with hot module replacement does.

### Fix

```bash
# 1. Check if the dev server is still running
lsof -i :3000   # if empty, server is dead

# 2. Restart it
setsid bash -c 'cd /home/z/my-project && exec ./node_modules/.bin/next dev -p 3000' &
# (This detaches the process so it survives the terminal closing)

# 3. Verify it's back up
curl http://localhost:3000/api/
tail -n 50 dev.log
```

### Mitigations already in place

- **Prisma query logging disabled** (`log: ['error', 'warn']` only) —
  reduces console output memory pressure.
- **`reactStrictMode: false`** in `next.config.ts` — avoids
  double-mounting effects that double Prisma query volume in dev.
- **`typescript.ignoreBuildErrors: false`** keeps type errors visible
  early (don't change this — hiding them causes worse bugs).

### What you can do

- Avoid visiting many API routes in quick succession during a single
  dev session. Restart the server between large testing sweeps.
- For automated testing of many APIs, use `curl` against a running
  production server (`bun run build && bun run start`) instead of
  `bun run dev`.
- If you have a real production environment, do API verification there
  (the production build doesn't have the OOM problem).

### When to suspect a real memory leak

If the OOM happens consistently with a single specific API route
(every time you hit `/api/foo`), inspect that route for:

- Unbounded `db.findMany({})` without pagination.
- Recursive Prisma `include` (e.g. `include: { students: { include: {
  group: { include: { students: ... } } } } }`).
- Large JSON responses (e.g. returning all rows of a table).

---

## 5. Lint Errors

### Symptom

```bash
bun run lint
# outputs: X errors, Y warnings
```

### Common causes & fixes

#### Unused imports

```ts
// ❌
import { Card, Button } from "@/components/ui/card";
// Button isn't exported from card.tsx

// ✅
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
```

#### Undefined variables (usually typos)

```ts
// ❌
const studnet = await db.student.findUnique(...);
console.log(student.id);  // ReferenceError: student is not defined

// ✅
const student = await db.student.findUnique(...);
console.log(student.id);
```

#### `any` types

The Next.js ESLint preset warns on `any`. Either:

- Use proper types: `const user: SessionUser = ...`
- If you genuinely need `any` (e.g. parsing JSON), use `unknown` and
  narrow with `if (typeof x === 'string')`.
- Or use an `// eslint-disable-next-line @typescript-eslint/no-explicit-any`
  comment with a justification.

#### Server-only code in client components

```ts
// ❌ "use client" component importing server-only modules
"use client";
import { db } from "@/lib/db";  // Prisma client can't run in the browser

// ✅ Move the DB call into an API route, fetch from the client
"use client";
const res = await fetch("/api/...");
```

#### Missing dependency in `useEffect`

```ts
// ❌
useEffect(() => { fetch("/api/x").then(setData); }, []);  // missing setData

// ✅
useEffect(() => { fetch("/api/x").then(setData); }, [setData]);
```

#### Next.js "img" instead of "Image"

```tsx
// ❌
<img src="/logo.svg" alt="Logo" />

// ✅
import Image from "next/image";
<Image src="/logo.svg" alt="Logo" width={32} height={32} />
```

For SVGs that need raw styling, the platform often uses a custom
`<Logo/>` component — see `src/components/logo.tsx`.

### Fix workflow

```bash
bun run lint

# ESLint will auto-fix some issues:
bunx eslint . --fix

# Re-run to verify
bun run lint
```

Aim for **0 errors, 0 warnings** before any commit.

---

## 6. Build Fails

### Symptom

```bash
bun run build
# Type error: ...
# or
# Failed to compile.
```

### Cause

`next.config.ts` sets `typescript.ignoreBuildErrors: false`, so any
TypeScript error fails the build. (Do NOT change this — masking type
errors causes worse runtime bugs.)

### Fix

```bash
# 1. Run the TypeScript compiler directly to see errors
bunx tsc --noEmit

# 2. Run ESLint to catch style + import issues
bun run lint

# 3. Fix each error

# 4. Rebuild
bun run build
```

### Common build-time errors

#### "Cannot find module '@/...'"

- Check `tsconfig.json` has the `paths` mapping for `@/*` → `./src/*`.
- Check the file actually exists at the expected path.

#### "Property 'X' does not exist on type 'Y'"

- The Prisma client is out of sync — run `bun run db:generate`.

#### "Type 'null' is not assignable to type 'string'"

- Prisma nullable fields return `T | null`. Either:
  - Use `null` in your types: `name: string | null`.
  - Use a default: `name ?? ""`.
  - Use optional chaining: `user?.avatarUrl ?? null`.

#### "Module not found: Can't resolve 'xlsx'"

- You imported `xlsx` in a component that doesn't have it installed.
  Run `bun install xlsx` if needed (it's already in `package.json`).

### Tips

- Always run `bun run lint` before `bun run build`. Lint runs faster
  and catches most issues.
- The `bun run build` script also copies `.next/static` and `public/`
  into `.next/standalone/` — if you see "Cannot find /static/...",
  the post-build `cp` step failed. Run the commands manually:
  ```bash
  next build
  cp -r .next/static .next/standalone/.next/
  cp -r public .next/standalone/
  ```

---

## 7. Auth Not Working

### Symptom

- User can log in but is logged out on refresh.
- `GET /api/auth/me` returns 401 even right after login.
- "Unauthorized" on every API call.
- Cookie isn't being set.

### Cause 1 — Cookie not set (wrong domain / path)

The session cookie is set with `httpOnly: true`, `sameSite: "lax"`,
`path: "/"`, and a 7-day expiry. If you're running on a custom domain
behind a proxy, the proxy may be stripping cookies.

### Cause 2 — Database `Setting` table missing

Sessions are persisted in the `Setting` table as
`key=session:<token>`. If the table is empty (fresh DB without seed),
login will appear to work (no error) but `getCurrentUser()` will
return null on the next request.

### Cause 3 — Clock skew

If the server clock is wrong, sessions may be considered expired
immediately. Check `date` on the server.

### Fix

```bash
# 1. Verify the session row exists after login
curl -c cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@codemind.academy","password":"admin123"}'

# Should return {user: {...}} and set the cm_session cookie

# 2. Check the cookie is present
cat cookies.txt | grep cm_session

# 3. Check the session row exists in the DB
sqlite3 db/custom.db "SELECT key, value FROM Setting WHERE key LIKE 'session:%'"

# 4. Hit /api/auth/me with the cookie
curl -b cookies.txt http://localhost:3000/api/auth/me
# Should return {id, email, name, role}
```

### If the cookie isn't being set

- Check `src/lib/auth.ts` — the cookie is set via `cookies().set(...)`:
  ```ts
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    expires,
    path: "/",
  });
  ```
- `sameSite: "lax"` requires the request to come from the same origin.
  If you're testing from a different domain (e.g. browser-sync proxy),
  switch to `sameSite: "none"` + `secure: true` (HTTPS only).

### If the session row is missing

The `Setting` table didn't get created. Run:

```bash
bun run db:push
```

### If the session expires immediately

Check the server time:

```bash
date   # should be close to current real time
```

If it's wrong, sync with NTP:

```bash
sudo ntpdate pool.ntp.org
# or
sudo timedatectl set-ntp true
```

---

## 8. API Returns 500

### Symptom

```bash
curl http://localhost:3000/api/foo
# < HTTP/1.1 500 Internal Server Error
# {"error":"Internal Server Error"}
```

Or the browser shows "حصلت مشكلة" toasts repeatedly.

### Cause

- Unhandled exception in the route handler (e.g. Prisma throws
  because of a missing relation, a JSON parse error, or a null
  dereference).
- The route file has a syntax error and Next.js can't compile it.
- The dev server has been OOM-killed (see section 4).

### Fix

```bash
# 1. Check the dev log for the stack trace
tail -n 200 dev.log
```

Look for the actual error message and stack trace. Common patterns:

#### "Unknown field `X` for include statement"

You added a field to `prisma/schema.prisma` but didn't run
`bun run db:generate`. Run:

```bash
bun run db:generate
bun run db:push
```

#### "Cannot read property 'X' of null"

Your code is dereferencing a possibly-null value. Add a guard:

```ts
const user = await getCurrentUser();
if (!user) return err("Unauthorized", 401);
// now user is non-null
```

Or use optional chaining:

```ts
const name = user?.name ?? "Unknown";
```

#### "Invalid `prisma.X.findUnique()` invocation: ... Argument `where`"

You're passing the wrong shape to `where`. Check the Prisma docs for
the model. Common mistake:

```ts
// ❌
await db.user.findUnique({ where: { id } });  // missing required fields

// ✅
await db.user.findUnique({ where: { id } });  // id is the @id field
```

#### "Argument `data` is missing"

You're calling `db.X.create({})` without `data`:

```ts
// ❌
await db.user.create({});

// ✅
await db.user.create({ data: { email: "...", password: "...", name: "..." } });
```

### If the dev log shows no error

The dev server may be OOM-killed. Check:

```bash
lsof -i :3000   # empty = server is dead
# Restart per section 4
```

### Generic API debugging

Add `console.log` statements temporarily:

```ts
export async function GET() {
  console.log("[GET /api/foo] start");
  try {
    const data = await db.foo.findMany();
    console.log("[GET /api/foo] got", data.length, "rows");
    return ok({ data });
  } catch (e) {
    console.error("[GET /api/foo] ERROR:", e);
    return err("Internal Server Error", 500);
  }
}
```

Watch `dev.log` in another terminal:

```bash
tail -f dev.log
```

---

## 9. CSS / Styling Issues

### Symptom

- Colors don't match the brand palette.
- Dark mode toggle doesn't work.
- Animations don't play.
- RTL layout is broken.

### Cause 1 — Using forbidden colors

The brand guidelines say: **no indigo or blue**. If you copy-pasted
from a tutorial, you may have introduced `bg-indigo-500` or
`bg-blue-600`.

### Fix

Search the codebase:

```bash
rg "indigo|bg-blue-|text-blue-|border-blue-|bg-indigo-"
```

Replace with brand palette:

- `bg-indigo-500` → `bg-primary` (emerald)
- `text-blue-600` → `text-primary`
- `bg-blue-100` → `bg-primary/10`

### Cause 2 — Dark mode toggle not working

The toggle in `src/components/dashboard/shell.tsx` adds/removes the
`dark` class on `document.documentElement`:

```ts
document.documentElement.classList.toggle("dark", theme === "dark");
```

If it's not working:

- Check that `<html>` doesn't have `class="dark"` hardcoded.
- Check that `<ThemeProvider>` from `next-themes` is mounted in
  `src/app/layout.tsx`.
- The Zustand `theme` is persisted via `persist` middleware — clear
  localStorage if it gets stuck:
  ```js
  localStorage.removeItem("cm-app");
  ```

### Cause 3 — Animations not playing

Framer Motion requires the `motion` import and the component to be a
client component:

```tsx
"use client";  // ← required
import { motion } from "framer-motion";

<motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
  Hello
</motion.div>
```

Custom CSS animations (defined in `globals.css`) need the right class
name. Check spelling — e.g. `card-hover` (not `cardHover`).

### Cause 4 — RTL layout broken

- The HTML root sets `dir="rtl"`. If a parent element overrides with
  `dir="ltr"`, the children inherit LTR.
- Tailwind's `ml-*` and `mr-*` classes are NOT automatically flipped
  in RTL. Use `ms-*` (margin-inline-start) and `me-*`
  (margin-inline-end) for RTL-aware spacing.
- For charts (Recharts), wrap the chart container in `dir="ltr"` so
  the axis labels render correctly:
  ```tsx
  <div dir="ltr">
    <LineChart>...</LineChart>
  </div>
  ```

---

## 10. Charts Rendering Incorrectly (RTL)

### Symptom

- Recharts axis labels are reversed or overlapping.
- Tooltip appears off-screen.
- Bars are drawn right-to-left instead of left-to-right.

### Cause

Recharts (and most chart libraries) assume LTR layout. The Arabic RTL
page direction confuses the SVG layout.

### Fix

Wrap every chart in a `dir="ltr"` container:

```tsx
<div dir="ltr" className="w-full h-72">
  <ResponsiveContainer width="100%" height="100%">
    <BarChart data={data}>
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis dataKey="month" />
      <YAxis />
      <Tooltip />
      <Bar dataKey="revenue" fill="var(--chart-1)" />
    </BarChart>
  </ResponsiveContainer>
</div>
```

This is the pattern used in all CodeMind chart components (parent
dashboard, admin revenue analytics, etc.).

---

## 11. AI Assistant Slow / Timeout

### Symptom

- The AI Assistant takes 30+ seconds to respond.
- The "typing…" indicator never resolves.
- The POST returns 500.

### Cause

LLM calls via `z-ai-web-dev-sdk` are inherently slow (~30 s per
request). This is **expected** behavior. The UI surfaces a typing
indicator to make it acceptable.

### Fix

If responses are taking longer than 60 s:

1. Check the dev log for the actual error:
   ```bash
   tail -n 100 dev.log | grep -i "ai\|llm\|chat"
   ```
2. If the SDK is throwing auth errors, ensure the sandbox credentials
   are available. In production, the SDK should be configured per its
   docs (no env var needed in the sandbox).
3. If the prompt is too large (e.g. sending 12 messages of history),
   reduce the history limit in `src/app/api/ai/chat/route.ts` (it's
   currently set to 12 — drop to 6 for faster responses).
4. For the AI quiz generation endpoint (`POST
   /api/admin/ai-generate-quiz`), the response can take 30-60 s. The
   UI shows a loading spinner with the text "جارٍ التوليد... (30
   ثانية)". Be patient.

### If the AI never responds

- Check that you're not hitting the endpoint from a client component
  directly (the SDK must run server-side).
- Try the endpoint with curl to isolate the issue:
  ```bash
  curl -b cookies.txt -X POST http://localhost:3000/api/ai/chat \
    -H "Content-Type: application/json" \
    -d '{"message":"hello"}'
  ```

---

## 12. TypeScript Errors

### Symptom

```bash
bunx tsc --noEmit
# outputs many errors
```

### Common errors & fixes

#### "Property 'X' does not exist on type 'Y'"

Prisma client out of sync. Run:

```bash
bun run db:generate
```

#### "Type 'string | null' is not assignable to type 'string'"

Prisma nullable fields return `T | null`. Fix the consumer type:

```ts
type User = {
  id: string;
  email: string;
  phone: string | null;  // ← nullable
  avatarUrl: string | null;
};
```

Or use a default: `user.phone ?? ""`.

#### "Expected 0 arguments, but got 1"

You're calling a function with the wrong number of arguments. Check
the function signature.

#### "Cannot find module '@/components/ui/foo'"

The shadcn/ui component doesn't exist. List available components:

```bash
ls src/components/ui/
```

If you need a new one, add it via the shadcn CLI:

```bash
bunx shadcn@latest add <component-name>
```

#### "Type 'Timeout' is not assignable to type 'NodeJS.Timeout'"

Use the proper return type:

```ts
const timer: ReturnType<typeof setInterval> = setInterval(...);
clearInterval(timer);
```

---

## 13. Coupons / Referral Codes

### Symptom

- Coupon code validation always returns `valid: false`.
- Referral code "not found".
- "كود غير صحيح" toast on every code.

### Cause

- Coupon codes are case-sensitive in the DB but uppercased on save.
  If a user types "welcome10" (lowercase), the lookup fails.
- Coupon has `isActive = false`.
- Coupon has `usedCount >= maxUses`.
- Coupon has expired (`validUntil` is in the past).
- User has already redeemed this coupon
  (`CouponRedemption` exists for `[couponId, userId]`).

### Fix

```bash
# 1. Check the coupon in the DB
sqlite3 db/custom.db "SELECT code, isActive, usedCount, maxUses, validUntil FROM Coupon"

# 2. If isActive is 0, activate it via the admin UI (Coupons view →
#    toggle active)

# 3. If usedCount >= maxUses, increase maxUses via the admin UI

# 4. If validUntil is in the past, extend it or set to NULL

# 5. Check existing redemptions for this user
sqlite3 db/custom.db "SELECT * FROM CouponRedemption WHERE userId = '<user-id>'"

# 6. If a redemption exists, the user can't reuse the coupon. Delete
#    the redemption if you want to allow re-use (testing only):
sqlite3 db/custom.db "DELETE FROM CouponRedemption WHERE userId = '<user-id>' AND couponId = '<coupon-id>'"
```

### Referral codes

Referral codes are derived from the student's ID:

```ts
const code = `CM-${student.id.slice(-6).toUpperCase()}`;
```

If a referral code isn't working:

1. Check the student exists in the DB.
2. Check the code format matches: `CM-XXXXXX` (6 chars after the
   prefix).
3. Check the referrer's student ID length is at least 6 chars (cuid
   IDs are typically 24 chars, so this should always be true).

---

## 14. Excel Import Issues

### Symptom

- Bulk payment import returns `created: 0, failed: N`.
- "تحميل Template" button doesn't download.
- Imported payments don't appear in the table.

### Cause 1 — Wrong column headers

The import endpoint supports both English and Arabic column names:
- `userEmail` / `email` / `الإيميل`
- `amount` / `المبلغ`
- `method` / `الطريقة`
- `reference` / `المرجع`
- `status` / `الحالة`
- `notes` / `ملاحظات`

If your xlsx has different headers, all rows will fail.

### Cause 2 — Wrong method/status values

Method must be exactly: `INSTAPAY`, `VODAFONE_CASH`, or `ETISALAT_CASH`.
Status must be exactly: `PENDING`, `APPROVED`, `REJECTED`, or
`EXPIRED`.

### Cause 3 — User email not found

The import looks up users by email. If the email doesn't match a
`User.email` exactly (case-sensitive), the row fails.

### Fix

```bash
# 1. Download the template (this always works — GET endpoint)
curl -b cookies.txt -o template.xlsx \
  http://localhost:3000/api/admin/payments/import

# 2. Open template.xlsx, fill in real data:
#    - userEmail: use an existing student email (e.g. student@codemind.academy)
#    - amount: number (e.g. 200)
#    - method: INSTAPAY
#    - reference: any string (e.g. TEST-REF-001)
#    - status: PENDING
#    - notes: optional

# 3. Upload
curl -b cookies.txt -X POST http://localhost:3000/api/admin/payments/import \
  -F "file=@filled-template.xlsx"

# Should return:
# { "created": 1, "failed": 0, "total": 1, "results": [{...}] }
```

### If the upload itself fails

- Check the file is a valid `.xlsx` (not `.xls` or `.csv`).
- Check the file size isn't enormous (max ~10 MB).
- Check the dev log for parse errors:
  ```bash
  tail -n 100 dev.log | grep -i "xlsx\|import"
  ```

---

## 15. Mobile Sidebar Issues

### Symptom

- Sidebar hamburger button doesn't open the sidebar on mobile.
- Sidebar opens but doesn't close on navigation.
- Sidebar overlaps content on desktop.

### Cause

The sidebar is implemented as two pieces:
1. **Desktop**: a fixed `<aside className="hidden lg:flex w-64">` that's
   always visible on `lg+` screens.
2. **Mobile**: a shadcn `<Sheet>` (slide-in drawer) triggered by the
   hamburger button (visible only on `lg:hidden`).

If the mobile sidebar doesn't open:

- Check the `mobileOpen` state in `DashboardShell`:
  ```ts
  const [mobileOpen, setMobileOpen] = React.useState(false);
  ```
- Check the hamburger button calls `setMobileOpen(true)`.
- Check the `<Sheet open={mobileOpen} onOpenChange={setMobileOpen}>`
  wiring.
- Check that `onClick={() => { setView(...); setMobileOpen(false); }}`
  is set on each nav button (otherwise the sheet stays open after
  navigation).

### If the desktop sidebar overlaps content

- The flex layout is `<div className="min-h-screen flex">` with
  `<aside className="hidden lg:flex w-64 shrink-0">` + main content
  in `<div className="flex-1">`.
- If `shrink-0` is missing, the sidebar shrinks when content is wide.
- If `flex-1` is missing on the main column, it doesn't take
  remaining space.

---

## 16. Production-Only Issues

### Symptom

- Works in `bun run dev` but fails in `bun run start`.
- 404 on static assets.
- API routes work but the page doesn't load.

### Cause 1 — Missing `static` and `public` copies

The `bun run build` script runs:

```bash
next build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/
```

If the `cp` steps fail (e.g. disk full), the standalone server can't
find static assets.

### Fix

```bash
# Manually re-copy
cp -r .next/static .next/standalone/.next/
cp -r public .next/standalone/

# Restart
bun run start
```

### Cause 2 — `output: "standalone"` not set

Check `next.config.ts`:

```ts
const nextConfig: NextConfig = {
  output: "standalone",
  // ...
};
```

### Cause 3 — Environment variables not set in production

The production server reads `process.env.DATABASE_URL` at startup.
If it's missing, the server crashes immediately.

### Fix

```bash
# Verify env vars are set before starting
echo $DATABASE_URL
echo $NEXT_PUBLIC_URL

# If missing, export them
export DATABASE_URL="file:./db/custom.db"
export NEXT_PUBLIC_URL="https://codemind.academy"

# Or use a .env file (Next.js auto-loads .env in production too)
cat .env
```

### Cause 4 — Server can't bind to port

```bash
# Check if port 3000 is in use
lsof -i :3000

# If yes, kill or use a different port
PORT=4000 bun run start
```

---

## When All Else Fails

1. **Read the dev log**:
   ```bash
   tail -n 200 dev.log
   ```
2. **Restart everything**:
   ```bash
   # Kill all node/next processes
   pkill -f "next dev" || true
   pkill -f "node" || true
   sleep 2
   
   # Restart dev server
   bun run dev
   ```
3. **Reset the database** (loses all data!):
   ```bash
   rm -f db/custom.db
   bun run db:push
   bun run scripts/seed.ts
   ```
4. **Reinstall dependencies**:
   ```bash
   rm -rf node_modules
   bun install
   ```
5. **Check the worklog** for prior fixes:
   ```bash
   grep -i "fix\|bug" worklog.md | head -50
   ```
6. **Check the agent-ctx notes**:
   ```bash
   ls agent-ctx/
   cat agent-ctx/2-student-dashboard.md
   ```
7. **Read this troubleshooting doc again** — many issues have
   already been seen and fixed in past development rounds.

---

## Quick Diagnostic Checklist

When something is broken, run through this checklist in order:

- [ ] Is the dev server running? `lsof -i :3000`
- [ ] Are there errors in `dev.log`? `tail -n 100 dev.log`
- [ ] Does `bun run lint` pass?
- [ ] Does `bunx tsc --noEmit` pass?
- [ ] Is `db/custom.db` present? `ls -la db/`
- [ ] Does the seed data exist? `sqlite3 db/custom.db "SELECT COUNT(*) FROM User;"`
- [ ] Can you log in? `curl -c c.txt -X POST .../api/auth/login -d '{...}'`
- [ ] Does `/api/auth/me` return the user? `curl -b c.txt .../api/auth/me`
- [ ] Is the Prisma client up to date? `bun run db:generate`
- [ ] Have you restarted the dev server after schema changes?
