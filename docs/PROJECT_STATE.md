# CodeMind Academy — Project State (NEW MVP Cycle)

> **Persistent state file for the new MVP implementation cycle.**
> This file replaces the previous `docs/PROJECT_STATE.md` (written during the
> abandoned 44-phase plan). The old plan is no longer authoritative.

**Last updated:** 2026-09-07 (baseline audit session)

---

## Baseline

- **Approved baseline commit: `635de56`** — "Merge pull request #11 … feat(auth): email-only password reset via Gmail SMTP".
- Baseline branch in the owner's environment: `stable-base-635de56`.
- **Work merged to `main` AFTER `635de56` (PRs #12–#14: curriculum reference PDFs,
  Phase-2 knowledge model, Phase-3 domain-foundation schema) is experimental and
  NOT part of the approved implementation cycle.** No new phase may build on it.
- Current `main` at audit time: `02db012` (baseline + the additive-only post-baseline
  delta; no runtime code differs from the baseline).

### Decision — post-baseline Phase-3 schema (Track / Enrollment / Material)

- The Phase-3 migration (`20260907100000_phase3_domain_foundation`) is **additive-only**
  and nothing in the runtime references it. It stays **dormant** on main.
- Do NOT create features using `Track`, `Enrollment`, `Material`,
  `Lesson.unitId/officialCode/curriculumStatus` until a future phase explicitly
  adopts or removes them.
- The curriculum PDFs and `docs/curriculum/knowledge-model.json` are reference
  material only — **not** the runtime curriculum.

## Current Audit Status

- ✅ Fresh baseline audit completed 2026-09-07 → **`docs/MVP_BASELINE_AUDIT.md`** (read it first).
- Verification snapshot at audit time (clean install, `npm ci`):
  - 7/7 offline test suites green — **337 checks, 0 failures**
  - `tsc --noEmit`: 21 errors (mostly artifacts of a sandbox-blocked `prisma generate`;
    ≥1 genuine: duplicate `status` key in `api/admin/payments/import/route.ts`)
  - `eslint .`: 77 errors (38 in `tests/*.js` config issue; 37 `react-hooks/set-state-in-effect`)
  - Known security findings: 1 CRITICAL (open role registration), 3 HIGH (groups
    password-hash leak, quiz answer leakage, quiz routes without enrollment checks)
    — full table in the audit doc. **Not yet fixed.**

## Current MVP Scope

**Goal:** the minimum practical feature set for a solid first usable version —
*security-closed, admin-operable, complete student session flow.*

- **In scope:** auth/registration fixes, assessment integrity, content-access
  consistency, admin curriculum CRUD, lesson materials (PDF) + video management,
  homework loop completion, quiz/question lifecycle, portal verification passes,
  test tooling and quality gates, lightweight production readiness.
- **Deferred (Category B):** unit exams, question-bank content population,
  official-curriculum runtime transition, Kodgy intelligence, payment enforcement,
  URL routing/PWA, PostgreSQL.
- **Not needed now (Category C):** Track/Enrollment/Material runtime, advanced AI,
  multi-course commerce, deployment automation.
- **Explicitly NOT in this cycle:** question-bank content generation, curriculum
  PDF generation, advanced Kodgy, deployment implementation.

## Phase Roadmap (approved plan of record)

| # | Phase | Risk | Depends on |
| --- | --- | --- | --- |
| 1 | Baseline Reconciliation & Test Tooling | LOW | — |
| 2 | Critical Auth & Registration Security | MEDIUM | 1 |
| 3 | Assessment Integrity (quiz answers, time limits, enrollment checks) | MEDIUM | 1 (2 recommended) |
| 4 | Lesson & Course Content Access Consistency | LOW | 1 |
| 5 | Admin Curriculum Content Management | MED-HIGH | 2–4 |
| 6 | Session Materials (PDF) & Lesson Video Management | MEDIUM | 5 |
| 7 | Assignment (Homework) Loop | MEDIUM | 5, 6 |
| 8 | Quiz Authoring Completeness & Question Bank MVP | MEDIUM | 3, 5 |
| 9 | Student Experience E2E Verification & Polish | LOW-MED | 6–8 |
| 10 | Parent & Teacher Portals Verification | LOW | 7, 9 |
| 11 | Hardening & Quality Gates | LOW-MED | 9–10 |
| 12 | Production Readiness (lightweight) | LOW | 11 |

Full phase specs (objectives, features, exclusions, acceptance criteria) live in
`docs/MVP_BASELINE_AUDIT.md` → *New MVP Phase Roadmap*.

**Workflow per phase:** implement ONE phase → run tests → validate → commit →
push → open PR → **STOP**. The user reviews and merges manually; the next phase
starts in a new chat. Each phase must leave the repo stable.

**Next phase to implement:** Phase 1 (then Phase 2).

## Important Decisions

1. Baseline = `635de56`; post-baseline work is unapproved and stays dormant.
2. Seed curriculum (`src/lib/curriculum.ts`) remains the runtime curriculum for MVP;
   official-PDF transition is a later, tooling-dependent phase.
3. Enrollment stays group-based (`Student.groupId → Group.courseId`); subscription
   status remains a non-gate (documented business decision, revisit post-MVP).
4. `MediaAsset` + private storage + authorized `/api/media/[id]` is the single media
   path; lesson PDFs reuse it (no new schema beyond an additive enum value).
5. Mock exams: keep as-is. Unit exams: defer. Question bank: current `Question`
   model is sufficient for MVP; content population postponed.
6. Kodgy MVP = existing scoped chat assistant + rate limit; advanced intelligence deferred.
7. Quiz deletion must become archive-not-delete before it is exposed (attempt history).
8. `next-auth` dependency is unused and may be removed in Phase 1.

## Known Risks

- Security holes S-1/S-2 are exploitable on any deployed instance → do not deploy before Phase 2.
- Quiz-runner UI currently expects pre-submission answers → Phase 3 includes client changes.
- Admin dashboard monolith (3,994 lines) → refactor incrementally, only where phases touch it.
- Homework gating deadlock is latent until Phase 7 (avoid seeding homework meanwhile).
- All current tests are static/offline; runtime coverage arrives with Phases 9–11.
- SQLite + local media storage: accepted MVP trade-off.

## Implementation Log

| Date | Phase | Status | Notes |
| --- | --- | --- | --- |
| 2026-09-07 | Audit | ✅ done | Baseline audit + this state file + `docs/MVP_BASELINE_AUDIT.md`. No app code changed. |

*(Add one row per completed phase. Do not claim work that has not happened.)*
