# CodeMind Academy — Project State (NEW MVP Cycle)

> Persistent state file for the implementation cycle that starts at baseline `635de56`.
> This file **replaces** the previous-cycle state doc (which described the non-approved
> post-baseline "phase 2/3 curriculum/domain-foundation" experiment). Update it after
> every merged phase. Keep it factual: record what is true in the code, not what is planned.

## Cycle identity

- **Approved baseline commit:** `635de56c3b2884407fe22195205659075e0bfc90`
  (`Merge PR #11 — feat(auth): email-only password reset via Gmail SMTP`, 2026-09-07).
- **Previous experimental work after `635de56` is NOT part of the approved
  implementation cycle.** Commits `e9b3771` (curriculum/Kodgy reference docs + PDFs),
  `829a1d8` (phase-2 knowledge model), `719d49a` (phase-3 domain foundation: `Track`/
  `Enrollment`/`Material` models + migration) and their merges (`6bbfd00`, `02db012`)
  exist on `main` but are outside this cycle until the owner explicitly accepts them
  (see Open decisions D1).
- Old 44-phase plan: **abandoned** as a mandate. New plan = 15 phases (below).

## Current status (audit cycle)

- **Audit: COMPLETE** — 2026-09-07, documented in
  [`MVP_BASELINE_AUDIT.md`](./MVP_BASELINE_AUDIT.md).
- **Implementation of MVP phases: NOT STARTED.** No application code, schema, UI,
  migration, content generation, or deployment change was made by this audit. The only
  files this cycle has added are the two documents in `docs/`.
- Audit method: source-verified inspection of the extracted `635de56` tree;
  6/7 offline test suites executed green in-sandbox (319 checks); full build/tests
  partially blocked in the agent sandbox (Prisma engine binary download) — see audit
  appendix.

## Current MVP scope (agreed from audit)

**Must-have (A):** role-registration security fix; unauthenticated `/api/groups` leak fix;
answer-leak removal (quizzes/lessons/mock); quiz content access checks; parent-linking
consent; enrollment/payment access policy; admin curriculum authoring (parts/units/topics/
lessons/homework + course edit/delete); lesson media + PDF materials via the existing
private `MediaAsset` pipeline (fixes the lesson-video gating deadlock); LiveSession
scheduling pipeline (create/attend/notify); teacher group-scoping; question-bank
edit/delete + evidence retention sweeper; minimal Kodgy (branded, persisted, ownership +
rate limits, refusal rules); initial schema snapshot migration; tests/typecheck in CI.

**Postpone (B):** unit/monthly/final exam UIs (server plumbing already exists); bank CSV
import; certificate PDF rendering; notification email/SMS delivery; gamification
expansion; teacher access to camera evidence; parent subscription alerts; offline PWA SW;
referral/coupon campaign polish; "reset user password" admin flow.

**Not now (C):** NextAuth/JWT rewrite; App Router page redesign of the SPA shell;
payment gateway; Postgres/S3; microservices; `@mdxeditor` editor; real-time chat;
voice; AI curriculum RAG / knowledge-graph runtime (the post-baseline direction);
new locales; heavy proctoring.

## Proposed phase roadmap (15 × stable increments)

Ordered by technical dependency. Each phase: implement → tests → commit → push → PR →
human review/merge → next chat. Details/acceptance criteria in the audit doc.

1. **Account security hardening** — registration role policy, login/register rate
   limits, password policy unify (min 8), self change-password, `SECURITY_HASH_SECRET`
   made real, multi-device suspension → warn mode (config). *(LOW-MED risk)*
2. **API authorization & content protection** — lock `GET /api/groups`; strip
   `answer/explanation/correctIndex` from quiz/lesson/mock reads (client flows updated in
   same PR); enrollment checks on quiz start/submit/evidence; ai-chat GET/DELETE
   ownership; ai-generate-quiz scoping; admin settings write guard. *(MED)*
3. **Parent linking consent** — remove email-only link; student-generated share code;
   admin parent-link management. *(LOW-MED)*
4. **Enrollment & access lifecycle** — approval-gated group access (flagged),
   subscription expiry inside `getEnrollment`, capacity-race transaction, status banners,
   schoolType backfill admin action. *(HIGH — business change, needs D2 sign-off)*
5. **Curriculum authoring (admin)** — course edit/delete; Part/Unit/Topic/Lesson CRUD +
   reorder/publish/lock; homework creation; tree editor UI; remove rickroll placeholder.
   *(MED)*
6. **Media & materials unification** — lesson video via `MediaAsset` HTML5 + heartbeats
   (reuse batch-video path), PDF/DOCUMENT upload+attach+serve through `media/[id]`,
   SSRF list hardening. *(MED-HIGH — core learning loop)*
7. **Scheduling & attendance pipeline** — LiveSession CRUD + meetingUrl + status,
   student calendar/join view, cancel+notify. *(LOW-MED)*
8. **Assessment operations** — question update/delete, retake limits, soft server time
   budget, homework late status, evidence retention sweeper. *(LOW)*
9. **Teacher scope + loop closure** — group-level scoping (grade/analytics/quizzes),
   batch-video progress read, generate-quiz under teacher namespace, attendance CSV.
   *(LOW-MED)*
10. **Kodgy MVP** — `ChatSession/ChatMessage` (additive migration), ownership, windows,
    rate limits, structured system prompt, live-quiz refusal, read-only personal context,
    graceful degrade without z-ai credentials. *(MED)*
11. **DB hygiene & migrations baseline** — initial snapshot migration for pre-2026
    schema; retire `db:push --accept-data-loss` workflow; delete legacy Setting-session
    fallback. *(LOW)*
12. **Portal code refactor** — split 152 KB admin + 105 KB teacher god-components into
    modules, zero behavior change. *(LOW, mechanical)*
13. **Quality gates & CI** — workflow (install → generate → 7 suites → `tsc --noEmit` →
    eslint → build), remove `ignoreBuildErrors`, runtime authz test harness, `npm test`,
    drop unused deps (`next-auth`, `next-intl`, `@mdxeditor`, `@sparticuz/chromium`,
    `sharp`, `@tanstack/react-table`, `date-fns`, `@reactuses/core`, `@dnd-kit/*`).
    *(LOW)*
14. **i18n/RTL completion pass** — regenerate catalogs for all new strings; audit
    evidence on changed surfaces. *(LOW)*
15. **Launch stabilization & runbook** — prod setup gate, admin runbook, fresh-DB E2E
    checklist, controlled 23-lesson data import decision (content per D3). *(LOW)*

## Important decisions (log)

- **D1 (OPEN — owner):** What happens to the 4 post-baseline commits on `main`
  (schema migration + curriculum docs)? Options: revert them on `main`, or accept them
  as part of the baseline for Phase 1 onward. Phases 1–3 are schema-agnostic and safe
  under either choice; **Phase 4+ must not start before D1 is resolved** (P11 and any
  additive migration depend on a single agreed schema history).
- **D2 (OPEN — owner):** Enrollment access policy (audit S6): recommend
  *payment-approval-gated* group assignment with a feature flag for rollout (Phase 4).
  Current code deliberately grants access before payment; that is a business
  concession, not a technical constraint.
- **D3 (OPEN):** Official curriculum transition: keep DB tree as runtime; PDFs stay in
  `docs/` as reference until Phase 5 authoring exists and the owner supplies the
  lesson-content decision. No PDF→runtime import before Phase 5; no content generation
  in this cycle.
- **D4 (AGREED in audit):** No `Question`-schema redesign for the central bank —
  existing `Question.schoolType` tagging + shared pool IS the bank for MVP; Phase 8
  completes its CRUD; mass content population explicitly out of scope.
- **D5 (AGREED in audit):** Kodgy = branded assistant with persistence/guardrails
  (Phase 10); no advanced intelligence in this cycle.
- **D6 (AGREED in audit):** Keep custom cookie sessions (`cm_session` + `UserSession`);
  do not adopt NextAuth (unused dep to remove in P13).
- **D7 (AGREED in audit):** SQLite stays for MVP; PostgreSQL deferred (C). Schema work in
  P10/P11 must stay portable (no SQLite-specific SQL in migrations).

## Known risks (summary — details in audit §Risks)

1. Two CRITICAL security holes exist on the baseline and stay open until P1–P2 merge
   (admin self-registration; unauthenticated teacher-credential leak on `/api/groups`).
2. Quiz/mock answers currently visible to students (assessment integrity is zero until
   P2) — do not onboard real students to graded cohorts before P2.
3. P4 is a behavior change on paying/active students — needs flag + staged rollout.
4. `z-ai-web-dev-sdk` production viability unverified (affects Kodgy + quiz-gen only).
5. No CI yet: each phase must run the offline suites + typecheck locally before PR.
6. Shallow-clone/baseline-drift hazard: always diff against `635de56`, not `main`, when
   judging what is "existing" (this file lists why).
7. Main branch currently contains PDFs ~18 MB — if D1 accepts them, add a
   large-file/LFS note; if reverted, re-verify nothing references `docs/curriculum/*`
   (nothing at baseline does; the phase-3 validation script was added post-baseline).

## Working agreements per phase

- One phase = one PR against `main`; after push → open PR → **STOP** (owner merges).
- Never modify application behavior during planning/audit sessions.
- Schema: additive-only changes inside a phase that declares them; migrations created
  only in that phase (never `db push --accept-data-loss` against shared DBs).
- Every phase ends with: `node tests/*.test.js` (all runnable suites), `tsc --noEmit`
  if deps installable, and an updated `docs/PROJECT_STATE.md` section below.

## Phase log (update after each merged phase)

| Phase | Status | PR | Merged | Notes |
|-------|--------|----|--------|-------|
| 0 — Baseline audit (this doc + MVP_BASELINE_AUDIT.md) | ✅ complete, PR pending | — | — | Docs only; no behavior change |
| 1 — Account security hardening | ⏸ not started | — | — | |
| 2 — API authorization & content protection | ⏸ not started | — | — | |
| 3 — Parent linking consent | ⏸ not started | — | — | |
| 4 — Enrollment & access lifecycle | ⏸ not started | — | — | blocked by D2 |
| 5 — Curriculum authoring | ⏸ not started | — | — | blocked by D1+D3 |
| 6 — Media & materials unification | ⏸ not started | — | — | |
| 7 — Scheduling & attendance | ⏸ not started | — | — | |
| 8 — Assessment operations | ⏸ not started | — | — | |
| 9 — Teacher scope | ⏸ not started | — | — | |
| 10 — Kodgy MVP | ⏸ not started | — | — | additive migration |
| 11 — DB hygiene & baseline migration | ⏸ not started | — | — | blocked by D1 |
| 12 — Portal refactor | ⏸ not started | — | — | |
| 13 — Quality gates & CI | ⏸ not started | — | — | |
| 14 — i18n completion | ⏸ not started | — | — | |
| 15 — Launch stabilization | ⏸ not started | — | — | |

*Next expected edit to this file: when Phase 1 is opened, mark its row and record the
D1/D2 decisions the moment the owner states them.*
