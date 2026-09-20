# Phase H — Canonical Progression Engine — Manual QA Matrix

## Overview
Phase H consolidates ONE server-authoritative progression authority (`src/lib/progression-engine.ts`) that decides LOCKED / UNLOCKED / COMPLETED, hold boundary, override overlay, Arabic reasons, structured unmet, and evidence. All readers (course tree, lesson page, dashboard, homework list, parent view) consume it.

## Invariants
- Video >=95% required, server-tracked monotonic heartbeat, no client spoof
- Quiz must PASS (published only, `passed=true`), not merely attempted
- Homework SUBMITTED satisfies (grading not required), DRAFT not required, CLOSED still required
- Attendance never completes lesson; EXCUSED does not block; UNEXCUSED ACTIVE hold blocks NEXT only
- Catch-up uses existing Phase F authority, idempotent, preserves history
- Admin override: admin-only, reason mandatory (5-1000 chars), actor/time recorded, optional expiry, revocable, auditable, does not fabricate facts
- Track isolation (SHARED / ARABIC / LANGUAGE), lifecycle-safe (PUBLISHED only), enrollment via evaluateAccessDecision

## Manual QA Matrix

| # | Scenario | Steps | Expected | Status |
|---|----------|-------|----------|--------|
| 1 | First lesson unlocked | New student, no progress | L1 UNLOCKED, current = L1 | |
| 2 | Video 0% blocks | Watch 0% | L2 LOCKED, reason "أكمل الفيديو المطلوب" | |
| 3 | Video 94% blocks | Heartbeat 94% | L2 LOCKED | |
| 4 | Video 95% unlocks | Heartbeat 95% | L2 UNLOCKED if no other req | |
| 5 | VideoCompleted flag monotonic | Complete once, then seek back | Stays completed | |
| 6 | Quiz attempted but not passed blocks | Submit failing attempt | Next LOCKED, unmet QUIZ_NOT_PASSED, Arabic "لازم تنجح في الـQuiz" | |
| 7 | Quiz passed unlocks | Pass quiz | Next UNLOCKED | |
| 8 | DRAFT quiz not required | Create DRAFT quiz on lesson | Lesson completes without it | |
| 9 | Multiple quizzes all must pass | 2 quizzes, pass 1 | Blocked | |
| 10 | Homework not submitted blocks | No submission | Blocked, reason "سلّم الـHomework المطلوب" | |
| 11 | Homework submitted unlocks | Submit | Unlocks, even if not graded | |
| 12 | DRAFT homework not required | DRAFT homework | Not required | |
| 13 | CLOSED homework still required | CLOSED homework, no submission | Blocked (closing stops new submissions, not obligation) | |
| 14 | Empty lesson auto-completes | Lesson with no video/quiz/hw | COMPLETED, next unlocks | |
| 15 | Combined: video+quiz fail | Video 100% + quiz fail | Blocked | |
| 16 | Combined: all done | Video 100% + quiz pass + hw submit | COMPLETED | |
| 17 | EXCUSED absence does not block | Mark EXCUSED | No active hold, progression normal | |
| 18 | UNEXCUSED ACTIVE hold blocks NEXT only | Mark UNEXCUSED, hold ACTIVE on L1 | L1 UNLOCKED, L2 LOCKED with HOLD_ACTIVE, reason "عندك غياب محتاج تعويض" | |
| 19 | Hold does NOT block current | Try open L1 with hold | Allowed | |
| 20 | Hold does NOT block previous | L1 has hold, try open L0 | Allowed | |
| 21 | Catch-up allowed despite hold | L1 has hold, complete its requirements again | Allowed, tryResolveHoldForCatchUp called | |
| 22 | After catch-up hold resolved | Complete catch-up | Hold status RESOLVED, L2 unlocks | |
| 23 | Hold resolution idempotent | Call catch-up twice | Second call resolves 0, no error | |
| 24 | Override unlocks blocked lesson | Admin creates override for L2 with reason | L2 UNLOCKED, unlockedByOverride true, completed still false | |
| 25 | Override does NOT fabricate facts | Override active, check evidence | evidence still shows incomplete, completed false | |
| 26 | Expired override does NOT unlock | Create override expired yesterday | Still LOCKED | |
| 27 | Revoked override does NOT unlock | Revoke override | LOCKED | |
| 28 | Override reason mandatory | POST without reason | 400 "السبب مطلوب" | |
| 29 | Override reason too short | Reason "abc" | 400 | |
| 30 | Admin-only override | STUDENT tries POST /api/admin/progression-overrides | 403 | |
| 31 | Track isolation ARABIC | ARABIC student, LANGUAGE lesson | LESSON_NOT_FOUND (404) | |
| 32 | SHARED visible to both | SHARED lesson | Both ARABIC and LANGUAGE can access | |
| 33 | Direct URL bypass prevented | Student tries /api/lessons/[id] for locked lesson | 403 PREVIOUS_SESSION_INCOMPLETE or HOLD_ACTIVE | |
| 34 | Quiz bypass prevented | POST /api/quizzes/[id]/submit for locked lesson | 403 via canAccessQuiz | |
| 35 | Homework bypass prevented | POST /api/students/me/homework for locked lesson | 403 via canAccessHomework | |
| 36 | Course tree redacts locked | GET /api/courses/[slug] as student | Locked lessons have videoUrl null, pdfUrl null, requirements null, but progressionState LOCKED and reason Arabic | |
| 37 | Dashboard gated | GET /api/students/me/dashboard | continueLesson is unlocked only, unlockedLessonIds respects hold/override | |
| 38 | One canonical authority | Grep src/lib/session-progress.ts imports progression-engine, and all canAccess* delegate | Single source | |

## API Checks
- `GET /api/courses/[slug]` → includes `progressionState`, `reason` (Arabic), `unmet[]`, `blockedByHold`, `unlockedByOverride`, `activeHold`, `activeOverride`, `progress.activeHold`, `boundaryLessonId`
- `GET /api/lessons/[id]` → `requirements` includes state, reason, unmet, hold, override
- `POST /api/lessons/[id]/video-progress` → after completion calls `tryResolveHoldForCatchUp`
- `POST /api/quizzes/[id]/submit` → after pass calls `tryResolveHoldForCatchUp`
- `POST /api/students/me/homework` → after submit calls `tryResolveHoldForCatchUp`
- `POST /api/admin/progression-overrides` → admin-only, reason mandatory, idempotent, auditLog
- `DELETE /api/admin/progression-overrides` → soft revoke, auditLog
- `GET /api/admin/progression-overrides` → list with filters, includes student/lesson/creator

## UI Arabic-First RTL
- Locked badge shows Arabic reason: "عندك غياب محتاج تعويض", "أكمل الدرس السابق أولاً", "أكمل الفيديو المطلوب", "لازم تنجح في الـQuiz", "سلّم الـHomework المطلوب"
- Unmet list renders structured codes with Arabic labels
- Hold banner: "عندك غياب محتاج تعويض" with catch-up CTA
- Override banner: "مفتوح بصلاحية إدارية" (if implemented)
- Loading / empty / error / locked / completed / unmet states all present

## Security
- No client claims trusted for video/quiz/homework/absence/progression/override
- Auth, role, ownership, course scope, track scope, progression boundary enforced server-side
- Direct URL probing returns LESSON_NOT_FOUND (404) for foreign track/lifecycle, not 403 leak

## Regression Suites (offline)
- `node tests/progression-engine.test.js` → 94 passed (38 scenarios + invariants)
- `node tests/session-progression.test.js` → 167 passed
- `node tests/track-architecture-phase12.test.js` → 310 passed
- `node tests/migration-providers.test.js` → 122 passed
- `node tests/authorization-invariants.test.js` → 94 passed

## Deployment Notes
- Do NOT deploy until authorized
- Do NOT mutate prod/Neon
- Do NOT merge or open PR until authorized
- Additive migrations only: SQLite 16, PG 6, both include ProgressionOverride
