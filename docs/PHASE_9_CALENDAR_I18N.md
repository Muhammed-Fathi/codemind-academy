# Phase 9 — Calendar / I18n

**Status:** completed (2026-09-08)  
**Branch:** `arena/01a081e8-codemind-academy`  
**Baseline:** `e08f9e6` (Phase 8 merge on `main`)

---

## Objective

Review, identify the root cause of, correct, harden, and fully verify Calendar and internationalization behavior — especially the known raw-key leak of `student.198`…`student.204` — without creating a second i18n or calendar system and without redesigning Phases 4–8.

---

## Baseline

| Item | Value |
|---|---|
| `main` HEAD at start | `e08f9e6563bbf0a52d4edae1d9b8da7702c2b1a3` |
| Working tree | clean |
| Branch | `arena/01a081e8-codemind-academy` |
| Prior phase | Phase 8 Mock Exam (merged PR #25) |

---

## Existing I18n Architecture

Kept as-is (no redesign):

| Layer | File | Role |
|---|---|---|
| Generated dictionary | `src/lib/i18n-dict.ts` | Flat `key → { ar, en }` (auto-generated) |
| Hand-maintained additions | `src/lib/i18n-dict-2026.ts` | Keys that must survive dict regeneration |
| Isomorphic core | `src/lib/i18n-core.ts` | `translate`, `fmtDate*`, `pickL10n`, `applyLocale` |
| Client hooks | `src/lib/i18n.ts` (`"use client"`) | `useT()`, `useLocale()`, `pickAuto` |
| Server helpers | `src/lib/i18n-server.ts` | `serverLocale()` (cookie), `getServerT()` |
| Locale state | zustand `useApp.locale` + `cm-locale` cookie + `localStorage` | AR default; toggle writes all three |
| Direction | `document.documentElement.dir/lang` via `applyLocale` / `setLocale` | `ar → rtl`, `en → ltr` |
| Date formatting | `fmtDate` / `fmtDateTime` with `ar-EG` / `en-GB` | Presentation only |

Calendar surface:

- Student **Study Scheduler** (`src/components/student/study-scheduler.tsx`) — primary month grid calendar.
- Shared shadcn `Calendar` (`src/components/ui/calendar.tsx`, `react-day-picker`) — date-picker primitive.
- Dashboard / teacher / parent views use `Intl.DateTimeFormat` via local `dtLocale()` helpers (already locale-aware).

No second translation system and no second calendar system were introduced.

---

## Root Cause

### Symptom

Weekday headers in the Study Scheduler rendered literal keys:

```text
student.198  student.199  student.200  student.201  student.202  student.203  student.204
```

### Trace (source → lookup → dictionary → component → rendered value)

1. **Source constants** in `study-scheduler.tsx`:

   ```ts
   const DAY_NAMES = ["student.198", …, "student.204"];
   ```

2. **Dictionary** — keys **exist** and are correct:

   ```ts
   "student.198": { ar: "الأحد", en: "Sunday" },
   …
   "student.204": { ar: "السبت", en: "Saturday" },
   ```

3. **Lookup helper** — `useT()` → `translate(locale, key)` would have resolved them.

4. **Component bug** — weekday headers **bypassed** the translator:

   ```tsx
   {DAY_NAMES.map((d) => (
     <div key={d}>…{d}…</div>   // ← rendered the key string itself
   ))}
   ```

5. **Rendered value** — the raw key string appeared in the UI in both locales.

Month names and the selected-day title already called `tr(DAY_NAMES[…])` / `tr(MONTH_NAMES[…])` correctly. Only the **header row** omitted `tr()`.

### Why this is the failure mode (not missing keys)

- The keys were present in the dictionary with both `ar` and `en`.
- `translate()` was healthy.
- The component simply never called it for the header cells.
- Blindly renaming keys would not have fixed the leak.

### Secondary related issues found during the audit

| Issue | Cause | Fix |
|---|---|---|
| Hardcoded `"Study Scheduler"` title | English string, not a dict key | `tr("student.243")` |
| Shell nav bare English (`"Study Plan"`, `"Dashboard"`, …) | `tr("Study Plan")` passthrough — missing key, English-only in both locales | Dedicated `shell.027`…`shell.038` keys |
| Hardcoded `"Support"` in shell | Same | `tr("shell.038")` |
| `translate()` missing-key fallback returned the raw key | `entry ? … : key` | Empty string for dotted internal keys (`looksLikeDictKey`) |
| Parent weekly-report + certificate dates hardcoded `ar-EG` | Server ignored `cm-locale` cookie for dates | `serverLocale()` + `fmtDate` |
| `CalendarDayButton` `data-day={toLocaleDateString()}` | Locale-dependent identity attribute | ISO `YYYY-MM-DD` via `toISOString().slice(0,10)` |
| Month prev/next chevrons flipped under RTL | Logical time progression reversed visually | Month nav group forced `dir="ltr"`; prev=left, next=right |

---

## Translation Key Integrity

### Day / month keys (generated dict — kept)

| Key | ar | en |
|---|---|---|
| `student.198`…`student.204` | الأحد…السبت | Sunday…Saturday |
| `student.205`…`student.216` | يناير…ديسمبر | January…December |

Confirmed unique; not duplicated in `i18n-dict-2026.ts`.

### New Phase 9 keys (`i18n-dict-2026.ts`)

| Key | Purpose |
|---|---|
| `student.243` | Study Scheduler page title |
| `student.244` | Previous month (a11y) |
| `student.245` | Next month (a11y) |
| `student.246` | Today |
| `shell.027` | Dashboard |
| `shell.028` | Mock Exams |
| `shell.029` | Bookmarks |
| `shell.030` | Study Plan |
| `shell.031` | Referral |
| `shell.032` | Leaderboard |
| `shell.033` | Achievements |
| `shell.034` | Attendance |
| `shell.035` | Quizzes |
| `shell.036` | Overview |
| `shell.037` | Question Bank |
| `shell.038` | Support |

No duplicate keys across the merged dictionary for these additions.

---

## Arabic / English

| Surface | Arabic | English |
|---|---|---|
| Weekday headers | الأحد…السبت | Sunday…Saturday |
| Month header | يناير 2026 | January 2026 |
| Scheduler title | مخطط الدراسة | Study Scheduler |
| Nav “Study Plan” | خطة الدراسة | Study Plan |
| Missing key | `""` (no raw key) | `""` (no raw key) |
| Direction | `rtl` / `lang=ar` | `ltr` / `lang=en` |

---

## RTL / LTR

- Document direction still driven solely by `applyLocale` / `setLocale` (existing architecture).
- Calendar **month navigation** is wrapped in `dir="ltr"` so previous is always left and next is always right — calendar time progression is locale-independent.
- Weekday order remains Sun→Sat (`Date#getDay`) in both locales (labels change; order does not).
- Day cells use logical properties (`text-end`, `start-1`, `end-1`).
- Back chevron keeps `.flip-rtl`.

---

## Date / Time Localization

- Client dashboards already used `dtLocale()` → `ar-EG` / `en-GB`.
- Study Scheduler day identity uses local `YYYY-MM-DD` (`localDayKey`) — locale does not change which tasks appear on which day.
- Server routes that previously hardcoded `ar-EG` (parent weekly report, certificate completion date) now call `fmtDate(…, await serverLocale(), …)`.
- shadcn `CalendarDayButton` `data-day` is ISO date, not `toLocaleDateString()`.
- No timezone behavior change beyond presentation.

---

## Calendar Navigation

Verified by source + Phase 9 tests:

- Previous / next month (stable left/right under RTL and LTR).
- Today control jumps to current month + selects today.
- Selected day (`aria-selected` + visual ring).
- Today indicator (`aria-current="date"` + amber styling, dark-mode aware).
- Empty leading/trailing cells for month alignment.
- Month/year transitions via `new Date(year, month ± 1, 1)` (handles year rollover and end-of-month).

---

## Theme Integration

- Selected: `bg-primary/10` + `dark:bg-primary/20`.
- Today: amber borders/background with dark variants.
- Default cells: `border-border/40` + `dark:border-border/60`.
- Focus: `focus-visible:ring-2 focus-visible:ring-ring/50`.
- No hardcoded light-only colors introduced.

---

## Mobile Behavior

- Header stacks (`flex-col` → `sm:flex-row`).
- Day cells: `min-h-9` touch target, tighter gaps on small screens, truncated weekday labels with `title`.
- Task delete control always visible on mobile (`opacity-100 sm:opacity-0 sm:group-hover:opacity-100`).
- Add-task form wraps on narrow widths.

---

## Accessibility

- Month nav buttons: `aria-label` via `student.244` / `student.245`.
- Today: `aria-label` + visible label via `student.246`.
- Grid: `role="grid"`, headers `role="columnheader"`, cells `role="gridcell"`.
- Day cells: localized `aria-label` (weekday + date + month + year + today/task count).
- Selected: `aria-selected`; today: `aria-current="date"`.
- Task toggle / delete: localized `aria-label`.
- Decorative icons: `aria-hidden="true"`.

---

## Navigation

- Locale toggle still only changes `locale` + `dir`/`lang` + cookie/localStorage — does not reset view or calendar month/selection.
- Study Scheduler back control returns to `student-dashboard` via existing zustand `setView`.
- No routing architecture change (SPA view store unchanged).

---

## Regression Protection

- Phase 4 progression engine untouched.
- Phase 5 session-quiz module untouched.
- Phase 6 quiz-analytics module untouched.
- Phase 7 parent-access / isolation untouched (weekly-report date formatting only).
- Phase 8 mock-exam flow untouched.
- No schema / migration / dependency changes.
- No SQLite → PostgreSQL migration.

---

## Tests

New suite: `tests/calendar-i18n-phase9.test.js` (440 assertions).

| Layer | Coverage |
|---|---|
| A1 | Day/month keys resolve AR+EN, never raw |
| A2 | Missing-key fallback = `""` for dotted keys; human strings passthrough |
| A3 | Interpolation still works |
| A4 | Phase 9 keys AR/EN parity (Arabic script / Latin) |
| A5 | `fmtDate` presentation differs by locale; identity year stable; leap-year sample |
| A6 | No duplicate keys; dict size > 1000 |
| B1 | Root-cause: headers call `tr(key)`; no bare `{d}`; title/nav/a11y |
| B2 | Every shell nav label is a resolving dict key |
| B3 | Public i18n surface exports; core stays isomorphic |
| B4 | Weekly-report + certificate use `serverLocale`/`fmtDate` |
| B5 | Calendar day-button ISO identity |
| B6 | No second i18n/calendar system |

### Full offline suite (this sandbox)

| Suite | Result |
|---|---|
| `calendar-i18n-phase9` | **440 passed** |
| `session-progression` (P4) | 144 passed |
| `session-quiz` (P5) | 70 passed |
| `quiz-analytics` (P6) | 44 passed |
| `parent-dashboard-isolation` (P7) | 112 passed |
| `parent-monthly-report` (P7) | 67 passed |
| `mock-exam-phase8` (P8) | 135 passed |
| `mock-exam-grading-isolation` (P8) | 22 passed |
| `authorization-invariants` | 93 passed |
| `security-hardening` | 243 passed |
| `platform-upgrade-2026-migration` | 98 passed |
| `migration-sql` | 15 passed |
| `registration-validators` | 24 passed |
| `seed-idempotency` | blocked (needs `prisma generate`) — pre-existing env limit |

---

## Production Verification

| Check | Result |
|---|---|
| `tsc --noEmit` | **23 errors**, all pre-existing `@prisma/client` missing-generated-client (Prisma engines unreachable from this sandbox — same as Phases 6/7/8). **Zero errors in Phase 9 files.** |
| `eslint .` | **76 errors / 1 warning** (was 77/2 or 78 baseline in prior phases). Phase 9 files clean; no new findings. |
| `prisma generate` | **Blocked** — `binaries.prisma.sh` TLS failure (environment). |
| `next build` / production start | **Not re-run here** for the same reason; must be executed where Prisma engines are reachable. |

---

## Manual UI Verification

### What was executed in this sandbox

1. **Behavioral translation path** (real `translate` against real merged dict) — all day/month/shell keys resolve to correct AR and EN strings; missing keys return `""`.
2. **Source-level UI contract** — weekday headers must call `tr(key)`; the original bare-`{d}` pattern is asserted absent.
3. **Direction contract** — month nav `dir="ltr"`; document dir still owned by existing `applyLocale`.

### What could not be browser-verified here

Full Chromium walkthrough of the Study Scheduler against a live production server requires `prisma generate` + seeded DB + `next build`. That path is blocked by the same Prisma engine download failure documented in Phases 6–8.

**Re-verify checklist where engines are reachable:**

```bash
npx prisma generate && npm run build && npm run start
# Then:
# 1. Log in as student → Study Plan
# 2. AR: weekday headers = الأحد…السبت, dir=rtl, no raw keys
# 3. Toggle EN: headers = Sunday…Saturday, dir=ltr, same dates/tasks
# 4. Prev/next month, Today, select day, add task
# 5. Dark/light theme readability
# 6. Mobile width (~390px): no clip, usable touch targets
# 7. Browser back after locale toggle does not corrupt calendar state
```

---

## Remaining Limitations

1. **Prisma generate / production build** cannot be executed in this sandbox (network block to `binaries.prisma.sh`) — same as Phases 6–8.
2. **DB-seeded content** (notification bodies, some lesson titles without `*En` twins, group schedule strings) can still appear Arabic under EN — documented residue from the original i18n project; not a calendar chrome issue.
3. **Teacher attendance** is a session picker, not a month grid; no weekday-key leak there.
4. **Shell labels** that intentionally keep product English loanwords inside Arabic copy (e.g. “Quizzes” embedded in longer Arabic sentences in landing/parent copy) are content choices, not missing keys.
5. **Language toggle short label** still shows destination-language text (`EN` / `عربي`) by design (bilingual UX convention).

---

## Deferred Work

- Full Playwright i18n audit re-run (`tests/i18n/audit-ui.mjs`) against production build once engines are available.
- Optional: localize remaining hardcoded English chrome outside the calendar/nav scope (landing mini-stats “Attendance”, parent analytics chart formatter, etc.) — out of Phase 9 scope.
- Optional: week-start preference (Sat/Sun/Mon) — product currently uses Sun-start consistently; changing it would be a product decision, not a bugfix.
- Phase 10 and later — not started.

---

## Files changed

| Path | Change |
|---|---|
| `src/components/student/study-scheduler.tsx` | Root-cause fix + a11y/RTL/mobile/theme harden |
| `src/lib/i18n-core.ts` | Deterministic missing-key fallback; helpers |
| `src/lib/i18n.ts` | Re-export new helpers |
| `src/lib/i18n-dict-2026.ts` | Phase 9 keys (scheduler + shell) |
| `src/components/dashboard/shell.tsx` | Nav labels → dict keys; Support i18n |
| `src/components/global-controls.tsx` | Theme/lang a11y polish |
| `src/components/ui/calendar.tsx` | Locale-independent `data-day` |
| `src/app/api/parents/me/weekly-report/route.ts` | Locale-aware dates |
| `src/app/api/students/me/certificate/route.ts` | Locale-aware completion date |
| `tests/calendar-i18n-phase9.test.js` | New regression suite (440) |
| `docs/PHASE_9_CALENDAR_I18N.md` | This document |
| `docs/PROJECT_STATE.md` | Phase 9 status |

---

## Decision summary

1. **Root cause = component bypass of `tr()`**, not missing dictionary entries.
2. **Missing-key policy hardened** so the same leak class cannot reappear via `translate()` returning the key.
3. **Existing i18n + calendar architecture retained**; smallest correct fix preferred.
4. **Date identity is locale-independent**; only presentation changes with AR/EN.
5. **No academic / schema / dependency changes.**
