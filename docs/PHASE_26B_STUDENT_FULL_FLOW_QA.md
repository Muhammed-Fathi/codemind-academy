# Phase 26B — STUDENT FULL FLOW QA (report)

**Scope:** the complete student experience — registration → track → groups → plan →
payment → pending → approval → consumption → progression → notifications → expiry →
renewal → recovery. No deployment, no production Neon, no R2, no SMTP, no real
payments, no commit/push/PR.

**Verdict:** the student lifecycle is real and works end-to-end. Three defects were
found and fixed (each with regression coverage). One business-flow blocker is
reported and deliberately NOT fixed (it requires a schema migration — owner sign-off
needed). The full-lifecycle proof runs as a repeatable verifier:
`node scripts/verify-phase26b-student.mjs` → `PHASE26B_STUDENT_OK` (216 assertions),
pinned by `node tests/phase26b-student-flow.test.js` (39 assertions).

---

## 1. Environment safety

| Item | Value |
|---|---|
| Branch | `arena/01a0a3a2-codemind-academy` |
| HEAD | `585bc0d6f085b8f7d8f361744b0a1253359d701a` (merge of PR #72; identical to `main`) |
| Working tree at start | clean |
| `DATABASE_URL` engine | **SQLite** (`schema.prisma` provider `sqlite`; no `.env` existed — `.env.example` carries the local `file:` URL). Nothing pointed at PostgreSQL/Neon. |
| Production systems touched | **none** (no Neon, no Vercel, no R2, no SMTP, no real payments) |

All QA ran against a real in-memory SQLite database built from the real base DDL +
every real migration, driven through the **shipped, compiled route handlers over
real HTTP** (`scripts/verify-phase26b-student.mjs`, the Phase 26A discipline —
`binaries.prisma.sh` is unreachable in this sandbox, so `prisma generate` cannot
produce engines and `next dev` cannot serve `/api/*`; only the data source, mail
transport and Next request plumbing are substituted, exactly like
`scripts/verify-phase26a-auth.mjs`). Fixtures are clearly labelled `qa26b-*`.

## 2. Student identity / track

Canonical values (single source of truth, `src/lib/school-type.ts`):

- **SchoolType:** `ARABIC` | `LANGUAGE` (aliases عربي/لغates normalised; write paths
  reject anything else — registration, admin create/update).
- **TrackScope:** `SHARED` | `ARABIC` | `LANGUAGE` — the CONTENT eligibility
  dimension (`Lesson/Quiz/Homework/Material.trackScope`; questions use the
  equivalent nullable `schoolType` where NULL = SHARED).

Verified at registration (real `/api/auth/register`):

- name (three-part Arabic enforced), email, phone (student + parent, Egyptian
  validation), national ID (14 digits, unique), school name, **school type
  (required, canonical, unknown values → 400)**, `CM-XXXXXX` student code minted.
- Persistence verified: `Student.schoolType/nationalId/parentPhone/studentCode` all
  stored; `groupId = null`; **0 Subscription rows, 0 Payment rows**.
- Identity fields are immutable through student surfaces (no student API mutates
  schoolType/nationalId; only admin write paths can, and they reuse the same
  strict parser). Localised display: registration UI uses canonical select values
  with localized labels; `SCHOOL_TYPE_LABELS`/`TRACK_SCOPE_LABELS` are the only
  label sources.
- The ARABIC school type ⇒ ARABIC track mapping is derived server-side from the
  student's own row (`getStudentSchoolType` + `trackScopeWhere`) — never from
  locale, request params or UI language. Fail-closed: an unknown/NULL school type
  sees SHARED content only.

## 3. Group eligibility — **RESOLVED (owner-approved blocker fix, GAP-1 closed)**

The owner requires admin-created groups to carry an explicit `ARABIC`/`LANGUAGE`
audience, with `SHARED` only if the domain explicitly supports it, and students
must never infer group type from the name.

**Original finding (audit record):** `Group` had NO track/audience column at all
(`courseId`, `teacherId`, `capacity`, `schedule`, `isActive` only; `Course.trackId`
is documented DEAD schema). `/api/groups` filtered only `isActive` (both school
types saw the same list — STUDENT-03/04 FAIL), `/api/enroll` had no track to check
against, and a wrong-track group's live sessions would appear on the student
dashboard (content itself stayed correctly gated — STUDENT-25 PASS).

**Resolution (implemented in this same phase after explicit owner approval):**
`Group.trackScope` — reusing the EXISTING `TrackScope` enum, no duplicate concept:

- **Model**: `Group.trackScope TrackScope?` + `@@index([trackScope])`. Only
  `ARABIC | LANGUAGE` are legal audiences — they are the student-facing school
  types. `NULL` = **UNCLASSIFIED** (transitional value for existing rows):
  fail-closed on every student surface (never listed, never enrollable, never
  approvable) until an admin classifies the group explicitly. `SHARED` is
  **rejected on every group write path** — it stays a CONTENT-only concept
  (Lesson/Quiz/Homework/Material.trackScope), exactly as before.
- **Migration**: exactly ONE forward-only additive migration
  (`20260915120000_phase26b_group_track_scope`): `ALTER TABLE "Group" ADD COLUMN
  "trackScope" TEXT;` + `CREATE INDEX "Group_trackScope_idx";`. No DROP, no
  rebuild, **no backfill** — existing groups are silently NOTHING; they become
  sellable only after explicit classification. SQLite needs no table rebuild for
  a nullable ADD COLUMN; the PostgreSQL artifacts
  (`prisma/schema.postgresql.prisma`, `scripts/db/postgres-baseline.sql`) were
  regenerated from the shared schema so both dialects converge (history 10 → 11).
- **Decision predicate**: `groupTrackScopeEligible(studentSchoolType,
  groupTrackScope)` in `src/lib/track-scope.ts` — EXACT canonical equality after
  `normalizeSchoolType`, fail-closed on BOTH sides (unknown student type or
  unclassified group → false). Deliberately NOT the wider content predicate
  (`canAccessTrackScope`), so the audience rule cannot drift into accepting
  SHARED.
- **Admin authoring (server)**: `POST /api/admin/groups` REQUIRES an explicit
  audience (absent/SHARED/unknown → `400 api.285`; no default, no inference from
  the group name — the "Arabic-looking name" trap is covered by a test).
  `PATCH /api/admin/groups/[id]` validates an explicit audience change and
  refuses (`409 api.287`) any change that would strand members (incompatible =
  any assigned student whose `schoolType` does not match the new audience);
  mismatched `addStudentIds` assignments are refused (`409 api.286`); an
  UNCLASSIFIED group imposes no assignment constraint (classification is the
  operator's explicit step; its student surfaces stay closed regardless).
  `PATCH /api/admin/students/[id]` (the direct `groupId` assignment) enforces the
  SAME rule — no admin surface can bypass eligibility.
- **Admin authoring (UI)**: the create dialog has a REQUIRED localized
  audience select offering exactly ARABIC ("مدارس عربي" / Arabic school) and
  LANGUAGE ("مدارس لغات" / Language school) — never SHARED; the manage dialog
  supports editing the audience (the server remains the safety authority);
  group cards render the audience badge, with a distinct amber **"غير مصنفة" /
  Unclassified** badge for NULL audiences so unclassified groups are visually
  obvious for triage. (Full admin visual QA stays Phase 26C.)
- **Student listing**: `GET /api/groups` now requires an authenticated STUDENT
  session and derives eligibility ONLY from the viewer's own persisted
  `schoolType` row (never a client parameter): ARABIC student → ARABIC groups,
  LANGUAGE student → LANGUAGE groups, unknown → `{groups: []}` (fail-closed).
  Unclassified groups are never listed. The payload does not expose
  `trackScope` (the picker never renders it).
- **Submission**: `/api/enroll` rejects a wrong-track group in BOTH directions
  (`400`, reusing api.085 — no enumeration leak) AFTER the existing
  course-binding check and BEFORE any Payment/Subscription/assignment write —
  a mismatch leaves **zero** rows. The student's `schoolType` is never accepted
  from the client.
- **Decision authority (PR2b safety preserved)**:
  `resolveTargetGroupForApproval` selects `trackScope` and enforces the same
  predicate BEFORE the seat lock and BEFORE any write — a wrong-track approval
  override (`groupId` body field) is a `409 GROUP_TRACK_MISMATCH` with the
  payment still PENDING and no seat consumed; a correct-track override still
  works; resolution order is unchanged (override → requested group →
  Student.groupId). Advisory locking, capacity, renewal stacking, grandfather
  semantics and atomicity are untouched (the PR2b family re-ran green).
- **Renewal**: a renewal pointed at a wrong-track group is refused at submission
  (`400`) with the current entitlement byte-for-byte unchanged (same singleton,
  same endDate, same group, zero new Payment rows). On the approval side the
  same GROUP_TRACK_MISMATCH guard covers renewal overrides (same shared
  resolution function); a same-group renewal re-checks its own (already
  assigned) group and stays compatible.
- **Sessions/dashboard**: audience-correct for both tracks; session-video gating
  continues to key off `batch.schoolType` (content concept) — unchanged, and
  re-proven for both audiences.
- **Existing groups**: remain visible in the admin groups list with the amber
  "Unclassified" badge and are invisible/unenrollable/unapprovable for students
  until classified. No row is classified automatically; the operator decides
  each group's audience explicitly (evidence-based), which is exactly the
  transitional behavior the owner specified.

**Verdict: STUDENT-03 PASS, STUDENT-04 PASS, GAP-1 CLOSED** — verified end-to-end
by the new real-HTTP audience matrix (scripts/verify-phase26b-group-track.mjs,
A–Q, 78 assertions) + `tests/phase26b-group-track.test.js` (82 pins incl. the
master gate) + the extended student verifier (238 assertions incl. a full
reciprocal LANGUAGE chain). Severity: was **launch blocker** — now resolved.

## 4. Plan / Early Bird availability

- `SubscriptionPlan.isActive` exists (plus `isPromo` for Early Bird).
- Listing (`/api/subscription-plans`) serves active plans only — a closed Early
  Bird disappears from the student catalog.
- **Defect fixed (BUG-1):** `POST /api/enroll` did NOT check `plan.isActive` — a
  closed plan could still be purchased by direct API tampering while the approval
  layer (correctly) refused it (`PLAN_NOT_FOUND`), stranding the request. The
  route now refuses an inactive plan with the shared decision-layer copy
  (`api.276`, 400). Verified: close Early Bird → not listed + not purchasable;
  re-open → purchasable again.
- Students on an already-active entitlement are **not** affected by a later plan
  closure — the entitlement policy never reads `plan.isActive` (verified: closing
  the plan of an ACTIVE student leaves access + subscription untouched).
- Admin open/close of the Early Bird plan is a generic plan toggle that already
  exists in the admin plans surface; full admin-side UX review belongs to Phase
  26C.

## 5. Payment flow (Phase 25)

The real flow was driven end-to-end over the shipped handlers:

- Validations at submission: method (INSTAPAY / ETISALAT_CASH only; VODAFONE_CASH
  visible-but-disabled → 400), Egyptian sender phone, reference (3–64, deliberately
  loose), group existence/activity/course-binding (foreign course → 400), full
  group (400), nonexistent plan/group (404), malformed ids (404), inactive plan
  (400 — BUG-1 fix).
- Submission contract: Payment PENDING with `senderPhone`, `reference`,
  `requestedGroupId`, `requestedPlanId`, `amount` (coupon-adjusted); Subscription
  singleton PENDING; **`Student.groupId` stays NULL**; paid content stays locked
  (lesson/video/quiz all 403; enrollment read `isEnrolled=false`).
- Destinations (from brand config, never invented): InstaPay `+20 1147422177`,
  e& Cash `+20 1147422177`; WhatsApp proof numbers exactly `01147422177` +
  `01099942942` (one-number-only rule stated in copy); **no screenshot upload
  anywhere** — the student attaches it manually in WhatsApp.
- Pending UX truth: `pay.pendingTitle` = "طلب الدفع تحت المراجعة"; pending copy
  never claims activation; prefilled WhatsApp message carries ONLY the five
  approved facts (name, amount, method, reference, sender phone) — **no
  `CM-XXXXXX` student code, no internal ids** (pinned by test B2); review window
  copy = up to 24h.

## 6. Subscription / renewal / expiry

- **Approval contract** (`POST /api/admin/payments/[id]/approve`): Payment →
  APPROVED; singleton Subscription → ACTIVE with startDate/endDate;
  `Student.groupId` assigned; capacity enforced under the per-group advisory lock;
  batch reconciled; truthful notification (ACTIVATED/RENEWED/CONFIRMED wording).
- **Dashboard truth:** statuses NONE/PENDING/ACTIVE/EXPIRING/EXPIRED come from the
  single entitlement policy (`subscription-entitlement.ts`); a PENDING request is
  never rendered as ACTIVE; `endDate` and `daysToExpiry` ARE exposed (expiry date
  visible in the entitlement card).
- **Renewal warning (≤7 days):** `EXPIRING_WINDOW_DAYS = 7`; at endDate − 3d the
  dashboard reports `EXPIRING` + `daysToExpiry` + endDate and the UI renders the
  amber "بينتهي بعد N يوم · جدد" badge that navigates to the payment flow; >7 days
  renders plain ACTIVE (no intrusive warning). STUDENT-19 PASS.
- **Renewal pending preserves access:** renewal submission → scenario `RENEWAL`,
  new PENDING Payment, the live Subscription stays byte-identical (same row,
  status, startDate, endDate), lesson access unchanged, dashboard still ACTIVE with
  the renewal surfaced as "under review… current subscription stays active until
  its end date" (`pay.pendingRenewal`). STUDENT-20 PASS.
- **Renewal approval stacks endDate:** SAME singleton id; startDate preserved;
  endDate = previous endDate + plan duration (verified to the second with exact
  dates). STUDENT-21 PASS.
- **Expired subscription:** stored ACTIVE with past endDate → lazily EXPIRED
  (nothing writes EXPIRED); dashboard says EXPIRED, `accessAllowed=false`, content
  403; the student can submit a NEW payment immediately (scenario NEW_REQUEST,
  truthful no-access read-back) and approval reactivates the SAME singleton with a
  fresh future endDate. No dead end. STUDENT-22 PASS.
- **Grandfathered student:** group + no Subscription row ⇒ access allowed
  (`grandfathered=true`, dashboard shows NONE — never a fake paid state);
  submitting payment does NOT create a Subscription row (`subscriptionId=null`) and
  does NOT revoke access; approval BORNs the singleton ACTIVE with the group
  intact; access never dropped. STUDENT-23 PASS.

## 7. Dashboard

Verified via the real `GET /api/students/me/dashboard` at every lifecycle stage:
identity (name/email/grade/school type/student code), truthful subscription block
(status/rawStatus/accessAllowed/grandfathered/hasSubscription/endDate/daysToExpiry/
planName), group + teacher, course progress over the track-sliced PUBLISHED
curriculum, continue-lesson (unlocked-only, media URL guarded), next live session,
attendance %, latest quiz result, pending homework (unlocked-only, track-sliced),
recent activity timeline, pending/rejected REQUEST state kept separate from the
entitlement, and no stale PENDING shown as ACTIVE after approval (pending cleared).
RTL: Arabic-first copy resolves in both locales (pinned).

## 8. Curriculum / lesson access

- The official curriculum reconciled by the shipped reconciler into the QA DB:
  **exactly 23 official lessons, 2 parts, 7 units** (codes `1-1`…`7-3`).
- Archived legacy lesson (no officialCode, `curriculumStatus=ARCHIVED`) and the
  other course's lesson never leak into the course tree or progression.
- Locking: lesson 1 open (200), lesson 2 locked (403 `PREVIOUS_SESSION_INCOMPLETE`)
  until lesson 1's video+quiz+homework are done; marking a locked lesson complete
  is refused (403); a lesson with no components is complete by design ("a component
  that does not exist is NOT required").
- Wrong-track: a LANGUAGE student cannot open an ARABIC-scope lesson (403/404); the
  gate derives the student's track from their OWN row server-side.

## 9. Video / materials

- Lesson video: heartbeats credit **real wall-clock only** (first beat credits 0 —
  a forged `positionSec=duration` gains nothing), capped at 60s/beat, monotonic,
  capped by duration; 95% rule completes the video; watch-time can never exceed
  the duration (tamper gives nothing). Locked/pending students are refused (403).
- Session videos (batch recordings): the listing is batch-authorized +
  published-only + track-narrowed — the ARABIC student sees only their batch's
  recording and never the LANGUAGE batch's; an unentitled student gets
  `isEnrolled=false` and zero videos.
- Materials: private PDF (LOCAL_PRIVATE bytes outside the web root) downloads only
  through the authorized route (`/api/materials/[id]`, 10-check contract); the
  material of a lesson the student can't open is refused; no raw storage URL is
  ever exposed; descriptors carry `/api/materials/<id>` download paths.

## 10. Quiz authority + student quiz flow

Answers to the owner's six questions (from the shipped code, no redesign):

1. **How is a lesson quiz created today?** A TEACHER creates a `Quiz` bound to a
   Lesson via `POST /api/teacher/quizzes` (quiz + its questions in one call,
   questions validated by the shared `validateQuestionDraft`). Admin-side tooling
   exists separately (question bank, AI-generate).
2. **Who can create it?** An authenticated TEACHER — and only on a lesson of their
   OWN courses (ownership resolved from `Group.courseId`, canonical unit chain
   first; verified: a foreign lesson is refused). Admins author via admin routes.
   Students can never create quizzes.
3. **Where do its questions come from?** `Question.quizId` ownership IS the
   configuration — there is no sampling for session quizzes. Every question gets an
   explicit school type at creation (explicit value → owning quiz's scope →
   SHARED).
4. **Tied to Lesson / Session / Unit?** To the LESSON (`Quiz.lessonId`); unit/part
   placement derives through the lesson chain. `trackScope` containment is
   enforced at authoring (a quiz can never be wider than / disjoint from its
   lesson).
5. **Difference from Mock Exam?** MockExam samples the shared Question Bank at
   attempt time into `MockExamQuestion`, grades into `ExamAttempt`, has no lesson
   binding, and shares no state with session-quiz attempts (pinned by
   `tests/mock-exam-phase8.test.js` / `mock-exam-grading-isolation.test.js`).
6. **Is the student flow complete?** Yes — gate (`canAccessQuiz`: lesson access +
   track) → start (idempotent open attempt; question set FROZEN as QuizAnswer
   rows; server deadline for timed quizzes) → GET serves questions with answers
   hidden → submit (server-graded from stored answers; track-eligible questions
   only) → result (score/percentage/passed) → historical attempts retained.

Student flow verified live: unentitled student refused; entitled student starts,
fetches (2 questions, answers hidden), submits, gets a server-graded result; a
question added mid-attempt cannot join a frozen attempt (Phase 5 contract, pinned
by existing suites).

## 11. Homework authority + student flow

- **Who creates it:** a TEACHER, on a lesson of their own courses
  (`POST /api/teacher/homework`, instructions required, deadline parsed, track
  scope contained in the lesson's). Admin readiness ceremony requires homework
  before publishing a session.
- **Linked to:** the LESSON (`Homework.lessonId`) — the same lesson the
  progression engine reads, so "assignment submitted" is a first-class progression
  requirement. Not connected to Quiz or MockExam. No orphan homework path was
  found (creation requires a valid owned lesson).
- **Student side verified live:** the lesson-1 homework is listed
  (`/api/students/me/homework`), submission records SUBMITTED, and the submission
  is exactly what completes lesson 1 for progression. Locked lessons' homework
  never appears as a pending to-do (dashboard post-filters by the unlocked set).
- Grading is a teacher flow (Phase 18 suites); student sees status/grade/feedback
  via the same read model.

## 12. Progression

The canonical chain (video ≥95% AND every quiz attempted AND every homework
submitted → next lesson unlocked) was driven end-to-end:

- lesson 1: video completed via real heartbeats → quiz attempted → homework
  submitted → lesson 2 unlocked;
- a quiz added to lesson 3 kept lesson 4 locked (403) until the quiz was ATTEMPTED
  (wrong answer — "passed-or-attempted" is the rule; `passed=false` in the result);
- direct API bypass (marking a locked lesson complete) → 403;
- the dashboard's continue-lesson uses the same engine (`getUnlockedLessonIds` +
  `orderCourseLessons`), so "what the UI offers next" and "what the gate unlocks"
  cannot drift.

## 13. Notifications

- Approval → exactly one `PAYMENT_APPROVED` per decision (1:1 across three
  approvals — no spam); rejection → `PAYMENT_REJECTED` carrying the reason;
  unread-count endpoint works; the list renders both.
- **Defect fixed (BUG-2):** decision notifications stored the literal
  `link: "dashboard"` — the Phase 16/17 scheme allows only NULL or a validated
  `lesson:/video:/quiz:/homework:` deep link (Phase 17's own rejection corpus lists
  `"dashboard"`), and the client correctly suppressed the action button for it.
  Both decision routes now store `link: null` (honest no-link; the message already
  tells the student what happened and the dashboard panel shows the state).
- Deep links elsewhere (session publication) mint/validate through the single
  notification-links module; "a link is never authorization" holds (destinations
  re-check access server-side).
- Expiry: see §15 below (read-time warning exists; no automatic expiry
  notification sender).

## 14. Other student features

| Feature | Status | Notes |
|---|---|---|
| Bookmarks | PASS | create + list; strict ownership (another student's list never returns them) |
| Notes | PASS | create + list per lesson; ownership by construction (me-routes) |
| Study plan | PASS | me-scoped read (own tasks only; no studentId parameter exists to spoof) |
| Gamification | PASS | readable; XP/badges driven by real activity |
| Leaderboard | PASS | readable; payload bounded (asserted < 200 KB) |
| Certificate | PASS | endpoint refuses eligibility before course completion (not `eligible:true` while lessons remain) |
| Export progress | PASS after fix | see BUG-3; CSV contains only the caller's data |
| Referral | present | reward keys + redemption path exist (Phase 19 suites); not re-driven in 26B beyond history reads |
| Mock exam | present | separate flow; suites pin isolation (not repurposed) |

## 15. Responsive / RTL

- Source invariants on the student surfaces: no physical `pl-/pr-` in the
  dashboard, no `ml-/mr-` in the payment panel (logical `ps-/pe-/ms-/me-` only),
  directional icons use `flip-rtl`; renewal badge/CTA and payment-panel copy
  resolve in BOTH locales (raw translation keys never reach the UI).
- The Phase 16 suite's dedicated RTL + mobile section (366 assertions) and the
  Phase 26A browser harness (real responsive checks at 1440/834/390 in both
  directions) remain green.
- Residual risk: a browser-measure pass over the STUDENT dashboard specifically
  (real width overflow at 390px) was not re-run in 26B — Phase 26A's harness
  covers the shell + public/auth views; the dashboard blocks themselves are
  covered by Phase 16's layout-invariant suite. Recommended: fold the student
  dashboard into the browser bridge in a visual phase.

## 16. Bugs found / fixed

| # | Where | What | Fix | Regression coverage |
|---|---|---|---|---|
| BUG-1 (HIGH) | `POST /api/enroll` | An INACTIVE (closed-for-sale) plan — e.g. a closed Early Bird — could still be purchased via direct API tampering (the approval layer refused it, stranding PENDING requests) | `if (!plan.isActive) return err(tApi("api.276"), 400)` — the same refusal copy the decision layer uses | `tests/phase26b-student-flow.test.js` A1 + harness STUDENT-06 + live close/re-open drill |
| BUG-2 (LOW) | `approve/reject` payment routes | Decision notifications stored the dead literal `link: "dashboard"` (not a validated deep link; client suppressed the button) | store `link: null` per the validated scheme | A2 + harness assertion (link NULL or valid) |
| BUG-3 (HIGH for the feature) | `GET /api/students/me/export-progress` | `Content-Disposition` embedded the student's raw ARABIC name; Node rejects non-latin1 header values → the endpoint 500'd for every real student | ASCII-safe fallback `filename` + RFC 5987 `filename*=UTF-8''` preserving the real name | A3 + harness downloads a CSV as an Arabic-named student |
| INFRA (test-only) | `scripts/lib/sqlite-prisma-lite.mjs` | The SQLite test adapter implemented `increment` but not `decrement` (PR2b's coupon release uses it) | symmetric `decrement` support | B1 round-trip test |
| GAP-1 FIX (BLOCKER, owner-approved schema change) | `Group` + every group write/read/decision path | Groups had no audience: both school types saw every active group; enroll/approval could not check eligibility | `Group.trackScope TrackScope?` (ARABIC/LANGUAGE; NULL=UNCLASSIFIED fail-closed; SHARED rejected on group paths) + ONE additive migration + required admin authoring (api.285/286/287) + own-row student listing + enroll/decision-authority eligibility (`groupTrackScopeEligible`) — full design in §3 | `tests/phase26b-group-track.test.js` (82) + `scripts/verify-phase26b-group-track.mjs` (A–Q, 78) + STUDENT-03/04/§15b in the student verifier |

The pre-blocker fixes are minimal and schema-free; the GAP-1 fix is the single
owner-approved schema change. The full battery re-ran green (§19).

## 17. Missing / incomplete student business flows

| Gap | Current behavior | Expected | Severity | Launch blocker? | Recommended phase |
|---|---|---|---|---|---|
| **GAP-1: Group has no track/audience — ✅ RESOLVED (owner-approved, same phase)** | *(was)* no ARABIC/LANGUAGE field; the picker showed all active groups to everyone; enroll could not check group track | `Group.trackScope TrackScope?` + admin authoring + own-row listing + enroll/approval/renewal eligibility — implemented exactly as the owner specified (see §3) | HIGH (owner requirement) | **Was Yes — now closed** | Done in this phase; operator must still CLASSIFY existing (NULL) groups before they become sellable |
| GAP-2: no automatic pre-expiry NOTIFICATION | The ≤7-day warning is read-time only (dashboard EXPIRING badge + renewal CTA); `SUBSCRIPTION_EXPIRATION` exists as a type/pref but only the admin broadcast can send it | A student is warned even if they never open the dashboard | MEDIUM | No (dashboard warning satisfies the required UX) | Later phase via a LAZY/read-time notification (e.g. when the dashboard read first observes ≤7 days, mint the notification once) — **no second cron** (Phase 24's evidence-retention cron stays the only one) |
| GAP-3: payment notifications have no deep link | `link: null` (honest, but no one-tap jump to the payment panel) | Optionally a `payment:` deep-link kind | LOW | No | When deep-link kinds are next extended |
| GAP-4: student profile editing | Identity + school type are read-only for students (by design); no self-service profile editor beyond account basics | Owner decision whether students may edit e.g. parent phone | LOW | No | Product decision → admin routes already cover corrections |

Deliberately NOT counted as gaps: quiz↔lesson binding (complete, §10), homework↔
lesson binding (complete, §11), mock-exam separation (by design), subscription
history (singleton Subscription + full Payment history is sufficient and truthful
for launch; STUDENT-24 PASS).

## 18. Files changed

```
src/app/api/enroll/route.ts                                   | BUG-1 fix (isActive guard) + GAP-1 audience gate
prisma/schema.prisma                                          | GAP-1: Group.trackScope TrackScope? + @@index([trackScope]) (owner-approved)
prisma/migrations/20260915120000_phase26b_group_track_scope/  | NEW — ONE additive migration (ADD COLUMN + index, no backfill)
scripts/lib/migrate-sqlite.mjs                                | GAP-1: Group skip column for the SQLite baseline
prisma/schema.postgresql.prisma                               | REGENERATED (dialect convergence)
scripts/db/postgres-baseline.sql                              | REGENERATED (dialect convergence)
src/lib/track-scope.ts                                        | NEW helpers: parseGroupTrackScope + groupTrackScopeEligible
src/lib/i18n-dict-2026.ts                                     | api.285/286/287 (audience required / mismatch / unsafe change)
src/lib/i18n-dict.ts                                          | admin.318/319/320 (audience label / Unclassified / helper)
src/app/api/admin/groups/route.ts                             | GAP-1: required explicit audience on create (400 api.285)
src/app/api/admin/groups/[id]/route.ts                        | GAP-1: audience edit gates (409 api.287 populated-incompatible, 409 api.286 assignment)
src/app/api/groups/route.ts                                   | GAP-1: STUDENT-auth + own-row schoolType listing (fail-closed)
src/app/api/admin/students/[id]/route.ts                      | GAP-1: direct groupId assignment eligibility gate
src/lib/payment-transitions.ts                                | GAP-1: GROUP_TRACK_MISMATCH decision guard (pre-seat-lock)
src/components/admin/admin-dashboard.tsx                      | GAP-1: required audience select (create+edit), badges, Unclassified triage
scripts/verify-phase26b-group-track.mjs                       | NEW — A–Q real-HTTP audience verifier (78 assertions)
tests/phase26b-group-track.test.js                            | NEW — audience regression pins + master gate (82)
scripts/verify-phase26b-student.mjs                           | audience-aware fixtures; STUDENT-03/04 → PASS; §15b reciprocal chain (238)
tests/phase26b-student-flow.test.js                           | master-gate reruns over the extended verifier
tests/payment-lifecycle-phase25-pr2b*.test.js                 | faithful fixtures for the new select/view shapes (4 suites)
tests/payment-lifecycle-phase25-pr2a.test.js                  | migration-history pin 10 → 11
tests/payment-lifecycle-phase25-ledger.test.js                | migration-history pin 10 → 11
tests/phase25-pr4-release-gate.test.js                        | migration-history pins → 11
tests/production-storage-phase21.test.js                      | baseline statement pin 145 → 146 + audience index pin
scripts/verify-security-audit-gate.mjs                        | seeded group audience (LANGUAGE)
scripts/verify-phase13-db.mjs / verify-phase14-db.mjs         | base-schema derivation skips Group.trackScope
src/app/api/admin/payments/[id]/approve/route.ts              | BUG-2 fix (link: null)
src/app/api/admin/payments/[id]/reject/route.ts               | BUG-2 fix (link: null)
src/app/api/students/me/export-progress/route.ts              | BUG-3 fix (latin1-safe disposition)
scripts/lib/sqlite-prisma-lite.mjs                            | decrement operator (test adapter)
scripts/verify-phase26b-student.mjs                           | NEW — full-lifecycle real-HTTP verifier
tests/phase26b-student-flow.test.js                           | NEW — regression pins + master gate
docs/PHASE_26B_STUDENT_FULL_FLOW_QA.md                        | NEW — this report
```

## 19. Tests (exact commands + counts)

Full battery re-run after the fixes AND the owner-approved GAP-1 blocker fix —
**all green except one pre-existing sandbox condition**:

```
node tests/payment-lifecycle-phase25-pr2a.test.js            169 passed, 0 failed
node tests/payment-lifecycle-phase25-pr2a-grandfather.test    32 passed, 0 failed
node tests/payment-lifecycle-phase25-pr2b.test               252 passed, 0 failed
node tests/payment-lifecycle-phase25-pr2b-fullchain.test     135 passed, 0 failed
node tests/payment-lifecycle-phase25-pr2b-concurrency.test   114 passed, 0 failed
node tests/payment-lifecycle-phase25-pr2b-utc-tz.test        863 passed, 0 failed (10 timezones)
node tests/payment-lifecycle-phase25-ledger.test             139 passed, 0 failed
node tests/payment-experience-phase25-pr3.test               128 passed, 0 failed
node tests/phase25-pr4-inventory.test                        203 passed, 0 failed
node tests/phase25-pr4-release-gate.test                      92 passed, 0 failed
node tests/phase26a-public-auth.test                         121 passed, 0 failed
node tests/phase26b-student-flow.test                         39 passed, 0 failed   (NEW)
node scripts/verify-phase26b-student.mjs                     238 passed, 0 failed   (NEW; STUDENT-03/04 now PASS + §15b reciprocal chain)
node tests/phase26b-group-track.test.js                       82 passed, 0 failed   (NEW — GAP-1 pins + master gate)
node scripts/verify-phase26b-group-track.mjs                  78 passed, 0 failed   (NEW — A–Q real-HTTP audience matrix)
node tests/track-architecture-phase12.test                   304 passed, 0 failed
node tests/session-progression.test                          162 passed, 0 failed
node tests/session-quiz.test                                  70 passed, 0 failed
node tests/session-materials-phase14.test                    127 passed, 0 failed
node tests/session-notifications-phase17.test                319 passed, 0 failed
node tests/session-lifecycle-phase13.test                    299 passed, 0 failed
node tests/student-locked-curriculum-phase16.test            366 passed, 0 failed
node tests/curriculum-reconciliation-phase11.test             56 passed, 0 failed
node tests/authorization-invariants.test                      93 passed, 0 failed
node tests/security-audit-gate.test                          116 passed, 0 failed
node tests/security-hardening.test                           279 passed, 0 failed
node tests/security-hardening-phase20.test                   192 passed, 0 failed
node tests/registration-validators.test                       24 passed, 0 failed
node tests/quiz-analytics.test                                44 passed, 0 failed
node tests/mock-exam-phase8.test                             135 passed, 0 failed
node tests/mock-exam-grading-isolation.test                   22 passed, 0 failed
node tests/teacher-workflow-phase18.test                     365 passed, 0 failed
node tests/teacher-application-phase20.test                   75 passed, 0 failed
node tests/parent-dashboard-isolation.test                   112 passed, 0 failed
node tests/parent-analytics-alignment-phase19.test           176 passed, 0 failed
node tests/parent-monthly-report.test                         67 passed, 0 failed
node tests/admin-publishing-phase15.test                     384 passed, 0 failed
node tests/kodgy-phase10.test                                231 passed, 0 failed
node tests/calendar-i18n-phase9.test                         444 passed, 0 failed
node tests/media-storage-wiring.test                         318 passed, 0 failed
node tests/s3-storage-r2.test                                184 passed, 0 failed
node tests/production-storage-phase21.test                   180 passed, 0 failed
node tests/presigned-uploads-phase23.test                    327 passed, 0 failed
node tests/vercel-cron-retention-phase24.test                161 passed, 0 failed
node tests/platform-upgrade-2026-migration.test               98 passed, 0 failed
node tests/migration-sql.test                                 15 passed, 0 failed
node tests/seed-idempotency.test                              18 passed, 0 failed
```

Count changes vs the pre-fix run are the new audience assertions/pins themselves
(STUDENT-03/04 flipped FAIL→PASS, §15b added, A–Q matrix added, migration-count
pins 10→11, PG-baseline statement pin 145→146).

Pre-existing, NOT a 26B regression (verified byte-identical at pristine HEAD):
`tests/final-integration-phase22.test.js` expects git-ignored `/backups/`
artifacts produced by `scripts/phase22-final-integration.mjs` (the Phase 22
cutover runbook); they do not exist in a fresh clone. Same failure at HEAD
without any 26B change.

## 20. Prisma / typecheck / build

| Gate | Result |
|---|---|
| `npx prisma generate --schema prisma/schema.prisma` | **Blocked by the sandbox** (documented since Phase 6 / Phase 22 / Phase 26A): `binaries.prisma.sh` is unreachable, so engine download fails. NOT a code condition. |
| `npx tsc --noEmit` | 10 errors, **all** `@prisma/client has no exported member …` — the stub generated client from the same sandbox limitation. Output is **byte-identical to pristine HEAD** (verified via a clean worktree) — zero new type errors from 26B. |
| `npx next build` | With a local `SECURITY_HASH_SECRET`: **"✓ Compiled successfully"** (full Turbopack compile of the app), then fails at the type-check stage on the exact same 10 stub-client errors. No structural/build issue. |

## 21. Remaining risks

1. **GAP-1 (Group track) — RESOLVED** (owner-approved `Group.trackScope` shipped
   in this phase; full design in §3). Operational follow-ups, not code gaps:
   (a) existing groups stay UNCLASSIFIED (fail-closed) until the operator
   classifies each one explicitly in the admin UI — expect zero student-visible
   groups immediately after deploy until that pass is done; (b) the migration
   must still be applied to production Neon via the controlled workflow AFTER
   merge + Windows verification (NOT from this sandbox).
2. Browser-measured responsive pass of the student dashboard specifically (390px
   overflow probe) is inherited from Phase 16/26A coverage rather than re-measured
   here (§15).
3. `final-integration-phase22` and the Prisma-engine gates remain
   sandbox/artifact-conditioned (documented above) — they must be re-run in an
   environment where `prisma generate` works before cutover (per the existing
   runbooks).
4. Expired-PAYMENT sweep: payments left PENDING forever are resolved by the
   decision layer's stale-payment rule, but there is no automatic PENDING-payment
   expiry job (consistent with the no-second-cron constraint) — admin review is
   the closer.

## 22. Git status

No commit, no push, no PR (per instructions). Working tree (35 paths = 29
modified + 6 new/untracked) carries exactly the files listed in §18:

```
 M prisma/schema.prisma                        M src/app/api/groups/route.ts
 M prisma/schema.postgresql.prisma             M src/app/api/admin/students/[id]/route.ts
 M scripts/db/postgres-baseline.sql            M src/components/admin/admin-dashboard.tsx
 M scripts/lib/migrate-sqlite.mjs              M src/lib/i18n-dict-2026.ts
 M scripts/lib/sqlite-prisma-lite.mjs          M src/lib/i18n-dict.ts
 M scripts/verify-phase13-db.mjs               M src/lib/payment-transitions.ts
 M scripts/verify-phase14-db.mjs               M src/lib/track-scope.ts
 M scripts/verify-security-audit-gate.mjs      M tests/payment-lifecycle-phase25-ledger.test.js
 M src/app/api/admin/groups/[id]/route.ts      M tests/payment-lifecycle-phase25-pr2a.test.js
 M src/app/api/admin/groups/route.ts           M tests/payment-lifecycle-phase25-pr2b*.test.js (4)
 M src/app/api/admin/payments/[id]/approve/…   M tests/phase25-pr4-release-gate.test.js
 M src/app/api/admin/payments/[id]/reject/…    M tests/production-storage-phase21.test.js
 M src/app/api/enroll/route.ts                 M src/app/api/students/me/export-progress/…
?? docs/PHASE_26B_STUDENT_FULL_FLOW_QA.md
?? prisma/migrations/20260915120000_phase26b_group_track_scope/
?? scripts/verify-phase26b-group-track.mjs
?? scripts/verify-phase26b-student.mjs
?? tests/phase26b-group-track.test.js
?? tests/phase26b-student-flow.test.js
```

No Neon (or any production) mutation, no deployment, no Phase 26C work. All QA
ran on in-memory/local SQLite with explicit env vars; the git-ignored local
`.env` (if present) was never read for tests.
