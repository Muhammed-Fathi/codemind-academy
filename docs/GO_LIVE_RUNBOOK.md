# CodeMind Academy — Go-Live Runbook (Phase 22)

> **Version:** 1.0.0 — Phase 22 Final Integration & Deployment
> **Date:** 2026-09-11
> **Environment:** Production (PostgreSQL + durable media volume + Caddy/Nginx TLS)
> **Branch:** `arena/01a09019-codemind-academy` (PR for review, not yet merged)

This runbook is the single operator checklist for the production go-live. It assumes
Phases 11–21 are merged and the Pre-P21 Security Audit Gate is `CONDITIONAL GO` with
zero open Critical/High findings.

---

## 1. Preflight

- [ ] Repository is on the tagged release commit; `git status` clean
- [ ] `.env` not committed; `SECURITY_HASH_SECRET` is set (64-hex, `openssl rand -hex 32`)
- [ ] `DATABASE_URL` points at the production PostgreSQL (not SQLite); `NEXT_PUBLIC_URL` is the public origin (https)
- [ ] `MEDIA_STORAGE_PATH` is a persistent volume (survives redeploys, not served by proxy)
- [ ] Caddy/Nginx terminates TLS and sets `X-Real-IP` unconditionally; `:81` plain-HTTP listener is redirect-only or removed
- [ ] Node 22+, `postgresql-client` (`pg_dump`, `psql`, `pg_restore`) and `openssl` are available on the deploy host
- [ ] DNS and TLS certificate are valid for the public origin

```bash
node --version        # v22+
psql --version
pg_dump --version
openssl version
```

---

## 2. Backup (before any mutation)

**PostgreSQL:**

```bash
# Full custom-format dump + sha256 + manifest + retention (Phase 21)
scripts/db/backup-postgres.sh --out-dir /var/backups/codemind --label pre-go-live

# Verify the artifact
ls -lh /var/backups/codemind/*.dump /var/backups/codemind/*.sha256
cat /var/backups/codemind/*.manifest.json | jq
sha256sum -c /var/backups/codemind/*.dump.sha256
```

**SQLite (if still on file DB before cutover):**

```bash
sqlite3 db/custom.db ".backup backups/pre-go-live-$(date -u +%Y%m%dT%H%M%SZ).db"
sha256sum backups/*.db > backups/pre-go-live.sha256
```

**Media:**

```bash
node scripts/media/migrate-media.mjs --source ./storage/media --dest /var/lib/codemind/media --manifest /var/backups/codemind/media-$(date -u +%F).json
# Verify
node scripts/media/migrate-media.mjs --source ./storage/media --dest /var/lib/codemind/media --check
```

Record in the deployment log:

```text
backup timestamp: 2026-09-11T...Z
backup sha256: <hex>
manifest: /var/backups/codemind/...
pre-cleanup row counts: (see §4)
```

Never proceed without a verified, restorable backup.

---

## 3. Database Migration

**SQLite → PostgreSQL cutover (if not already on PG):**

Authoritative: `docs/POSTGRES_CUTOVER_RUNBOOK.md`.

```bash
# 1. Derive artifacts (never hand-edit)
node scripts/db/make-postgres-schema.mjs
node scripts/db/make-postgres-schema.mjs --check

# 2. Apply baseline on empty PG
psql "$DATABASE_URL" -f scripts/db/postgres-baseline.sql

# 3. Load data (one transaction, count+hash verified)
node scripts/db/migrate-sqlite-to-postgres.mjs --source db/custom.db --target "$DATABASE_URL" --manifest /var/backups/codemind/pg-load.json

# 4. Verify
node scripts/db/verify-postgres.mjs --target "$DATABASE_URL"  # must end VERIFY_POSTGRES_OK
```

**Already on PostgreSQL — apply pending migrations:**

```bash
npx prisma migrate deploy
npx prisma migrate status   # must report "Database schema is up to date"
```

No `prisma migrate reset`, `prisma db push --accept-data-loss`, `DROP DATABASE`, or `TRUNCATE ALL`.

---

## 4. Data Cleanup (safe, selective, auditable)

> See `scripts/phase22-final-integration.mjs` for the reference implementation and `backups/phase22-final-artifact.json` for evidence.

### 4.1 Inventory (before)

```bash
node scripts/phase22-final-integration.mjs  # reports pre-cleanup counts
# or manually:
node -e "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.env.DATABASE_URL.replace('file:','')); console.log(db.prepare('SELECT role,COUNT(*) FROM User GROUP BY role').all())"
```

Inventory must capture:

```text
users by role, students, parents, teacher applications (by status), user-owned rows,
courses, parts, units, lessons, quizzes, homework, question bank, mock exams,
groups, batches, materials, media, videos, notifications, publications, security/audit records
```

### 4.2 Allowlist

```text
KEEP:
  mudiifathii@gmail.com                ADMIN
  abdelrahmanmohamedhafez7@gmail.com   ADMIN (Abdelrahman Mohamed)
  muhammedfathi2005@gmail.com          TEACHER

REMOVE: every other normal application-user account (demo/test accounts) after proving they are obsolete.
PRESERVE: system/service identities only if proven necessary.
```

### 4.3 Plan (dry-run/preview)

Produce an explicit deletion plan:

```text
KEEP: allowlist users + their TeacherApplication (ACTIVATED)
REMOVE: admin@, teacher@, student@, parent@, test.*@codemind.test and their Student/Parent/Teacher rows + LessonProgress/QuizAttempt/etc + Notifications/UserSession etc
PRESERVE-BUT-ORPHANED: none
```

User-owned demo data that may be removed (only after FK check):

```text
Student, Parent, ParentStudentLink, LessonProgress, QuizAttempt, QuizAnswer,
QuizAttemptEvidence, HomeworkSubmission, LessonBookmark, LessonNote, StudyTask,
StudentBadge, Referral, Notification, NotificationPreference, UserSession,
PasswordResetToken, etc.
```

**Never delete generically:**

```text
Course, Part, Unit, official Lessons (23), officialCode, curriculumStatus,
Track config, SubscriptionPlans, Settings, Groups/Batches (if required),
Question Bank, MockExams, MediaAsset, SessionVideo, Material, publications,
security/audit records, migration history
```

Media/Material/Video: delete only if demonstrably test/demo-only, not required by curriculum, no FK.

Groups/Batches: delete only if clearly obsolete demo/test.

Teacher Applications: never delete all; preserve approved/activated provenance. Delete only demonstrably test/demo-only rows with no FK.

### 4.4 Backup before cleanup

Already done in §2. Record pre-cleanup row counts and exact deletion set.

### 4.5 Execute

```bash
# The script does it selectively and audibly:
node scripts/phase22-final-integration.mjs
# It reports: Before, After, Deleted, Preserved per category
```

Order respects FKs (children first, `Restrict` last). Verify:

```bash
node -e "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync('db/custom.db'); console.log(db.prepare('PRAGMA foreign_key_check').all())"  # must be []
```

### 4.6 Verify after

```text
application users = 3, ADMIN = 2, TEACHER = 1, STUDENT = 0, PARENT = 0
Course = 1, Parts = 2, Units = 7, Official Lessons = 23
No broken FKs, no orphaned required content
```

---

## 5. Curriculum Reconciliation (official, idempotent)

The production curriculum is provisioned **only** through the Phase 11 reconciliation mechanism. Never use the retired R1 seed.

```bash
npx tsx scripts/reconcile-curriculum.ts
# Run twice; second run must report zero semantic changes
npx tsx scripts/reconcile-curriculum.ts

# Verify
node scripts/phase22-reconcile.mjs  # reports 2 Parts / 7 Units / 23 Lessons 1-1…7-3, second run zero writes
```

Expected:

```text
run #1 → 23 official lessons (all DRAFT or as per lifecycle), 0 archived warnings
run #2 → 0 created, 0 updated, 0 archived (idempotent)
```

Each lesson has `officialCode` unique, valid `unitId`, correct hierarchy, correct titles/order, `curriculumStatus=OFFICIAL`, no archived lesson in active universe.

---

## 6. Media Verification

```bash
# Check storage volume is mounted and writable
ls -lh "$MEDIA_STORAGE_PATH"
df -h "$MEDIA_STORAGE_PATH"

# Quota
echo "$MEDIA_QUOTA_BYTES"  # should be ~80% of volume, or unset (unlimited)

# Verify no orphaned MediaAsset rows
node -e "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync('db/custom.db'); console.log('MediaAsset', db.prepare('SELECT COUNT(*) as c FROM MediaAsset').get().c, 'SessionVideo', db.prepare('SELECT COUNT(*) as c FROM SessionVideo').get().c, 'Material', db.prepare('SELECT COUNT(*) as c FROM Material').get().c)"

# Upload a test PDF via admin UI and verify it is served only through /api/materials/[id] (authorized)
```

---

## 7. Application Deploy

```bash
bun install
npx prisma generate   # or bunx prisma generate (requires network; where unreachable use committed postgres-baseline.sql)
SKIP_PRODUCTION_ENV_CHECK=1 bun run build   # typechecks; on the prod host the real SECRET is present so omit the skip flag
# Standalone server behind Caddy
bun run start
# or: node .next/standalone/server.js
```

Health checks:

```bash
curl -i https://codemind.academy/api/health 2>&1 | head -20   # if health route exists
curl -i https://codemind.academy/api 2>&1 | head -20
# Expect: 200 on public, 401 on protected without session (proxy defense-in-depth)
curl -s https://codemind.academy/ | head -c 500 | grep -i codemind
```

Logs:

```bash
tail -f server.log
# Slow queries, error logging, DB health, backup status, media health, notification metrics
```

---

## 8. Admin Activation / Provisioning

### 8.1 First Admin (mudiifathii@gmail.com)

Provisioned via `scripts/setup-production.ts` (interactive, no hardcoded password):

```bash
DATABASE_URL=... npx tsx scripts/setup-production.ts
# Prompts:
#   Email: mudiifathii@gmail.com
#   Password: <operator types 8+ chars, never committed, never logged>
#   Name: System Administrator
# Verify:
#   sqlite3 db/custom.db "SELECT email,role,isActive FROM User WHERE email='mudiifathii@gmail.com'"
```

### 8.2 Second Admin (abdelrahmanmohamedhafez7@gmail.com)

**Never create with a known plaintext password. Never re-enable public ADMIN registration (Phase 1 protection stays).**

Provision via the safest supported mechanism — password-reset activation (same architecture as teacher activation: SHA-256 stored, single-use, expiring):

```bash
# 1. Create the user row with a random placeholder password (operator does NOT choose it)
#    The user is created by an existing admin via an admin-only script or direct DB with a hashed random value.

# 2. Trigger password reset (the admin sets own password via email link)
curl -X POST https://codemind.academy/api/auth/password-reset/request \
  -H "Content-Type: application/json" -d '{"email":"abdelrahmanmohamedhafez7@gmail.com"}'
# Generic 200 response (no enumeration)

# 3. Admin receives email with single-use link (valid 15 min), opens it, sets own 8+ char password
#    POST /api/auth/password-reset/confirm { token, password }

# 4. Verify login
curl -X POST https://codemind.academy/api/auth/login \
  -H "Content-Type: application/json" -d '{"email":"abdelrahmanmohamedhafez7@gmail.com","password":"<own password>"}'
```

No password appears in source, migration, seed, logs, docs, PR description, or plain-text DB field.

---

## 9. Teacher Application / Approval / Activation (Secure Phase 20 Flow)

> **This is the ONLY way the final production Teacher is created. Never create an active Teacher directly from public registration, via plaintext password, via hardcoded password, via DB role mutation, or via manual bypass.**

The exact implementation in the repository is:

```text
Teacher Application
  → PENDING
  → Admin Approval (requireRole ADMIN)
  → Secure Activation (TeacherActivationToken, SHA-256, single-use, 72h)
  → Applicant Sets Own Password (hashPassword, length >=8)
  → Active TEACHER (User.role=TEACHER + Teacher row)
```

Production setup MUST be:

```text
Teacher Application
→ Admin Approval
→ Secure Activation
→ Applicant Password Setup
→ Teacher Login
```

### Production Rehearsal (11 steps)

```bash
# 1. Public submits application (no account created)
curl -X POST https://codemind.academy/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"muhammedfathi2005@gmail.com","name":"Muhammed Fathi","phone":"010...","role":"TEACHER"}'
# → 200 { applied: true } ; DB: TeacherApplication status=PENDING, no User, no session

# 2. Confirm PENDING
# 3. Confirm no active Teacher account exists yet
# 4. Admin logs in
# 5. Admin reviews queue
curl https://codemind.academy/api/admin/teacher-applications?status=PENDING \
  -H "Cookie: cm_session=<admin token>"

# 6. Approve
curl -X POST https://codemind.academy/api/admin/teacher-applications/<id>/approve \
  -H "Cookie: cm_session=<admin token>"
# → 200 { alreadyApproved: false } ; email sent with activation link ; Token row with tokenHash=sha256(secret)

# 7. Activation link issued (email)
# 8. Applicant opens link, sets own password
curl -X POST https://codemind.academy/api/auth/teacher-activate \
  -H "Content-Type: application/json" -d '{"token":"<secret from email>","password":"<applicant chooses 8+ chars>"}'
# → 200 { ok: true } ; DB: User(role TEACHER) + Teacher + TeacherApplication ACTIVATED, token usedAt set

# 9. Applicant creates own password (done in step 8)
# 10. Confirm Teacher account active
# 11. Teacher logs in
curl -X POST https://codemind.academy/api/auth/login \
  -H "Content-Type: application/json" -d '{"email":"muhammedfathi2005@gmail.com","password":"<same as step 8>"}'
# → 200 with cm_session cookie; GET /api/auth/me → role TEACHER
```

### Negative cases (must remain blocked)

```text
rejection → status REJECTED, live token rescinded
duplicate application → 409 APPLICATION_EXISTS (or 409 EMAIL_TAKEN)
unauthorized approval (student/teacher/parent/anon) → 401/403
self-approval → 401 (applicant is anonymous pre-activation)
activation replay → 400 INVALID_TOKEN (single-use)
expired activation (72h window) → 400 and token consumed
wrong-application activation → 400 (token bound to applicationId)
activation before approval → no token exists → 400
activation after rejection → no live token → 400
public role escalation (POST /api/auth/register role=ADMIN/TEACHER with forged status) → remains blocked (code invariant)
```

Never expose a real password or activation token in logs, docs, tests, or reports.

---

## 10. First Session Publish (Rehearsal)

```text
create/stage → material readiness → READY → OPEN/PUBLISH → targeted notification → student deep link → track validation → progression
```

```bash
# As ADMIN: create/stage a DRAFT lesson (or use 1-1)
curl -X POST https://codemind.academy/api/admin/lessons \
  -H "Content-Type: application/json" -H "Cookie: cm_session=<admin>" \
  -d '{"title":"New Session","titleAr":"حصة جديدة","unitId":"<unit>","order":99}'

# Check readiness
curl https://codemind.academy/api/admin/lessons/<id>/readiness -H "Cookie: cm_session=<admin>"
# → blocking: [] when video+quiz ready; else VIDEO_MISSING etc.

# Mark READY (validated)
curl -X POST https://codemind.academy/api/admin/lessons/<id>/mark-ready -H "Cookie: cm_session=<admin>"

# OPEN/PUBLISH (validated, idempotent, creates SessionPublication)
curl -X POST https://codemind.academy/api/admin/lessons/<id>/open -H "Cookie: cm_session=<admin>"
# Second OPEN → 200 NO_OP_ALREADY_IN_STATE, no duplicate notification

# Verify student visibility
# STUDENT DRAFT/READY → not in course tree, 404 on /api/lessons/[id]
# STUDENT PUBLISHED locked → in tree but content redacted (hasQuiz/hasAssignment only)
# STUDENT PUBLISHED unlocked → full content when prerequisites met

# Deep link: notification link is validated server-side (notification-links.ts) and client navigates via deep-link.ts
```

Wrong-track, wrong-course, locked, draft, ready, archived, wrong-parent-child must remain denied (see security matrix).

---

## 11. Notification Rehearsal (Fan-out)

The notification fan-out is preference-aware, deep-linked, idempotent, chunked (500/recipient batch).

```bash
# Load rehearsal (infrastructure permitting)
# Simulate 100, 500, 1000, 5000 recipients
node scripts/phase22-final-integration.mjs  # measures duration, chunking, memory, DB behavior
# Or via route: POST /api/admin/notifications (ADMIN only, rate-limited) fans out to batch-track-filtered recipients
```

Measure: duration, chunking, memory, DB behavior, failures/retries/duplicates. Never invent results.

---

## 12. Monitoring

Verify:

```text
GET /api              health checks
error logging         server.log / structured logs
slow queries          Prisma logging (['error','warn'] in prod) + DB logs
database health       SELECT 1 + verify-postgres.mjs
backup status         /var/backups/codemind/*.manifest.json age < 25h
media health          df -h $MEDIA_STORAGE_PATH + HEAD /api/media/[id]
notification metrics  Notification count, preference distribution, publication→notification linkage
storage usage         df -h, du -sh $MEDIA_STORAGE_PATH
quota alerts          MEDIA_QUOTA_BYTES ~80% of volume; upload returns 413 QUOTA_EXCEEDED before write
Teacher Application / activation signals   SecurityEvent counts for TEACHER_APPLICATION_* / TEACHER_ACTIVATION_*
```

Use repository-compatible monitoring (logs + simple probes + cron). Do not add a large platform.

```bash
# Example crontab
0 3 * * * /usr/local/bin/backup-postgres.sh --out-dir /var/backups/codemind --label nightly
0 4 * * * npx tsx scripts/media/purge-expired-evidence.ts --target "$DATABASE_URL" --live --yes --metrics /var/backups/codemind/purge-$(date +\%F).json
*/5 * * * * curl -fsS https://codemind.academy/api >/dev/null || echo "$(date) health fail" | logger
```

---

## 13. Rollback

### 13.1 Database

```bash
# Inside the freeze window (before switch): rollback is a re-point
systemctl stop codemind
# Restore DATABASE_URL to SQLite file or previous PG, restart, smoke-test
systemctl start codemind
curl -f https://codemind.academy/api

# Post-go-live disaster recovery: restore into empty DB + re-point (RPO = last backup)
createdb codemind_restored
scripts/db/restore-postgres.sh --backup /var/backups/codemind/codemind-nightly-*.dump --target postgresql://.../codemind_restored
node scripts/db/verify-postgres.mjs --target postgresql://.../codemind_restored  # must be VERIFY_POSTGRES_OK
# Then switch DATABASE_URL
```

### 13.2 Media

```bash
# Media volume is restored from filesystem backup or object-storage snapshot
rsync -a /var/backups/media/ /var/lib/codemind/media/
node scripts/media/migrate-media.mjs --source /var/backups/media --dest /var/lib/codemind/media --check
```

### 13.3 Application

```bash
git checkout <previous tag>
bun run build
systemctl restart codemind
```

Preserve forensics (logs, manifests, DB snapshot) before any destructive restore.

---

## 14. Support Contacts / Process

| Channel | Contact | SLA |
|---|---|---|
| Technical on-call | whatsapp_technical (+201147422177) — also in Settings | 1h |
| Teacher support | whatsapp_teacher (+201147422177) | 4h |
| Subscription/billing | whatsapp_subscription (+201147422177) | 24h |
| Security incident | security@codemind.academy (create SecurityEvent, revoke sessions, rotate SECRET) | immediate |

Incident communication templates: see §15.

---

## 15. Communication Templates

### New session notification (in-app + optional email)

> **AR:** تم نشر حصة جديدة: {lessonTitleAr} — ابدأ الآن من لوحة التحكم.
> **EN:** New session published: {lessonTitle} — start now from your dashboard.
> Link: deep link to `course → lesson` (validated, track-scoped).

### System maintenance

> We will perform scheduled maintenance on {date} {window} UTC. The platform may be briefly unavailable. Your progress is safe.

### Incident communication

> We are investigating an issue affecting {scope}. Updates every {interval}. Workaround: {workaround}. No data loss expected.

### Rollback communication

> We have restored the platform to the last healthy backup ({timestamp}). If you made changes after {timestamp}, please re-apply them. We apologize for the inconvenience.

### Teacher application / approval

> **To applicant (after submit):** Your application for {email} is pending review. You will receive an activation email if approved.
> **To applicant (after approval):** Your application is approved. Use the activation link (valid 72 hours, single-use) to set your own password and activate your Teacher account.
> **To admin:** New Teacher application from {name} <{email}> — review at Admin → Teacher Applications.

### Teacher activation

> Your Teacher account is ready. Click the link to set your password (8+ characters). The link expires in 72 hours and can be used only once. If it expired, request a new link from the admin.

Do not include secrets or private data in any template.

---

## 16. Go / No-Go Checklist

- [ ] database healthy (`verify-postgres.mjs` OK)
- [ ] backup healthy (age < 25h, sha256 OK, manifest OK)
- [ ] restore verified (quarterly drill on staging)
- [ ] media healthy (volume mounted, quota OK, sample download OK)
- [ ] curriculum correct (2 Parts, 7 Units, 23 Lessons 1-1…7-3, OFFICIAL, unit-linked)
- [ ] accounts correct (2 ADMIN + 1 TEACHER, no students/parents, no demo users)
- [ ] Teacher provisioning secure (application → approval → activation → login, all negative cases blocked)
- [ ] track isolation correct (ARABIC → SHARED+ARABIC, LANGUAGE → SHARED+LANGUAGE, cross denied)
- [ ] lifecycle correct (DRAFT→READY→PUBLISHED, idempotent open, no DRAFT→PUBLISHED bypass)
- [ ] notifications correct (preference-aware, deep-linked, idempotent, chunked)
- [ ] security matrix green (10-check contract, all IDOR/bypass cases denied)
- [ ] four-role browser pass green (Student/Parent/Teacher/Admin, AR/EN, RTL/LTR, mobile/desktop)
- [ ] monitoring green (health, logs, DB, backup, media, notification metrics)
- [ ] rollback green (DB snapshot, media backup, app rollback rehearsed)
- [ ] documentation complete (this runbook, architecture, deployment guide)

No production deployment if any Critical blocker remains.

---

## 17. Post-Go-Live

- Keep the pre-cleanup snapshot for 30 days.
- Retain SecurityEvent/AuditLog per policy (do not purge before review).
- Purge expired quiz camera evidence nightly (retention job, dry-run first).
- Monitor storage quota and notification fan-out metrics weekly.

