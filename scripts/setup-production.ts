import { PrismaClient, Role } from "@prisma/client";
import { hashPassword } from "../src/lib/auth";
import { reconcileOfficialCurriculum } from "../src/lib/official-curriculum";
import {
  OFFICIAL_COURSE_SLUG,
  EXPECTED_OFFICIAL_COUNTS,
  OFFICIAL_LESSON_CODES,
} from "../src/lib/official-curriculum";
import { DatabaseSync } from "node:sqlite";
import readline from "node:readline";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// CodeMind Academy — Production Baseline Setup (Phase 22 rework)
// ============================================================================
//
// WHAT THIS SCRIPT IS
//   A SAFE, SELECTIVE production-baseline operation. It establishes the final
//   CodeMind Academy production baseline WITHOUT wiping the platform.
//
// WHAT IT DOES (in order)
//   1. Resolves the real database target from DATABASE_URL (no assumptions).
//   2. Creates a verified, timestamped, checksummed backup BEFORE any mutation
//      (SQLite: read-only `VACUUM INTO`; PostgreSQL: the repo's pg backup
//      script). It never overwrites an existing backup.
//   3. Reconciles the official curriculum using the CANONICAL repository
//      implementation (`reconcileOfficialCurriculum`) — create-mostly and
//      idempotent. Existing curriculum is PRESERVED; missing pieces are
//      reconciled from `docs/curriculum/knowledge-model.json`.
//   4. Selectively removes ONLY non-allowlisted (demo/test) users and their
//      own dependent data, in a dependency-safe order. It NEVER deletes
//      curriculum, media, assessments, plans, settings, groups, batches, or
//      historical security/audit infrastructure.
//   5. Creates/updates EXACTLY the three required production accounts
//      (2 ADMIN + 1 TEACHER), each with an interactively-entered password
//      hashed via the repo's `hashPassword()`.
//   6. Verifies every final invariant (roles, identities, curriculum, content
//      preservation, referential integrity, unique official codes).
//
// WHAT IT DELIBERATELY DOES NOT DO (this replaces the old dangerous script)
//   * NO full reset. NO `prisma migrate reset`, `db push`, or seed.
//   * NO unscoped `deleteMany()` on ANY table.
//   * NO deletion of Course / Part / Unit / Topic / Lesson / Track.
//   * NO deletion of MediaAsset / SessionVideo / Material.
//   * NO deletion of Quiz / Question / ExamQuestion / MockExam / Homework
//     definitions.
//   * NO blanket wipe of AuditLog / SecurityEvent.
//   * NO deletion of physical media files / MEDIA_STORAGE_PATH.
//   * NO hardcoded / default / logged passwords.
//
// SAFETY MODEL
//   * `--dry-run` performs ZERO mutations (not even a backup): it only reports
//     the current state and the exact plan (including the backup path that
//     WOULD be created).
//   * A backup always exists and is verified BEFORE the first mutation.
//   * All mutations run inside a single interactive transaction, so a failure
//     mid-way rolls back — the database is never left half-configured.
//   * Role conflicts on the three required emails FAIL CLOSED (abort, zero
//     mutations) instead of silently mutating an existing user's role.
//
// RUN
//   Dry run (read-only):  npx tsx scripts/setup-production.ts --dry-run
//   Execute:              npx tsx scripts/setup-production.ts
//   (Stop the app first so the SQLite backup is a clean, consistent snapshot.)

// ---------------------------------------------------------------------------
// Required final production accounts (the ONLY normal users that must remain).
// ---------------------------------------------------------------------------
// email comparison is normalized (lowercase + trim) everywhere.
const PRODUCTION_USERS: { email: string; name: string; role: Role }[] = [
  { email: "mudiifathii@gmail.com", name: "Muhammed Fathi Kamal", role: Role.ADMIN },
  { email: "abdelrahmanmohamedhafez7@gmail.com", name: "Abdelrahman Mohamed", role: Role.ADMIN },
  { email: "muhammedfathi2005@gmail.com", name: "Muhammed Fathi", role: Role.TEACHER },
];

/** Single source of truth for the keep-list, normalized. */
const PRODUCTION_ALLOWLIST = new Set(
  PRODUCTION_USERS.map((u) => normalizeEmail(u.email))
);

/** Platform password policy (see src/app/api/**: `password.length < 8`). */
const MIN_PASSWORD_LENGTH = 8;

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function normalizeEmail(raw: unknown): string {
  // Mirrors canonicalTeacherEmail() in src/lib/teacher-applications.ts.
  return String(raw ?? "").toLowerCase().trim();
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Prompt for a secret without echoing it to the terminal. The typed value is
 * never printed, never logged, and never stored anywhere but as a hash.
 */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Mute all echo while the secret is being typed.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    rl.question("", (answer) => {
      process.stdout.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

function redactUrl(url: string | undefined): string {
  if (!url) return "(unset)";
  if (url.startsWith("file:") || url.endsWith(".db")) return url;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "(unparseable)";
  }
}

type Provider = "sqlite" | "postgresql" | "unknown";

function detectProvider(dbUrl: string): Provider {
  if (dbUrl.startsWith("postgres")) return "postgresql";
  if (dbUrl.startsWith("file:") || dbUrl.endsWith(".db")) return "sqlite";
  return "unknown";
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Resolve the ACTUAL SQLite file backing a `file:` DATABASE_URL. We do not
 * assume a location: Prisma resolves relative SQLite URLs against the schema
 * directory (`prisma/`), but historically some setups use the repo root, and
 * this repo lists BOTH `db/custom.db` and `prisma/db/custom.db` as candidates.
 * So we compute every plausible path and pick the one that actually exists.
 * Returns { file, existed }.
 */
function resolveSqliteFile(dbUrl: string): { file: string; existed: boolean } {
  const raw = dbUrl.replace(/^file:/, "");
  if (path.isAbsolute(raw)) {
    return { file: raw, existed: fs.existsSync(raw) };
  }
  const candidates = [
    path.resolve(REPO_ROOT, "prisma", raw), // Prisma's schema-relative rule
    path.resolve(REPO_ROOT, raw), // repo-root relative (.env.example convention)
    path.resolve(process.cwd(), raw), // CWD relative (defensive)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return { file: c, existed: true };
  }
  // None exist yet: prefer the repo-root convention for reporting.
  return { file: candidates[1], existed: false };
}

// ---------------------------------------------------------------------------
// Inventory (read-only counts). Every model, so the report is complete.
// ---------------------------------------------------------------------------

async function tableCounts(): Promise<{ table: string; rows: number }[]> {
  const delegates: [string, { count: () => Promise<number> }][] = [
    ["User", prisma.user],
    ["Student", prisma.student],
    ["Parent", prisma.parent],
    ["ParentStudentLink", prisma.parentStudentLink],
    ["Teacher", prisma.teacher],
    ["StudentBadge", prisma.studentBadge],
    ["Track", prisma.track],
    ["Enrollment", prisma.enrollment],
    ["Course", prisma.course],
    ["Part", prisma.part],
    ["Unit", prisma.unit],
    ["Topic", prisma.topic],
    ["Lesson", prisma.lesson],
    ["SessionPublication", prisma.sessionPublication],
    ["Group", prisma.group],
    ["Batch", prisma.batch],
    ["Material", prisma.material],
    ["LiveSession", prisma.liveSession],
    ["Attendance", prisma.attendance],
    ["Quiz", prisma.quiz],
    ["Question", prisma.question],
    ["QuizAttempt", prisma.quizAttempt],
    ["QuizAnswer", prisma.quizAnswer],
    ["QuizAttemptEvidence", prisma.quizAttemptEvidence],
    ["Homework", prisma.homework],
    ["HomeworkSubmission", prisma.homeworkSubmission],
    ["ExamQuestion", prisma.examQuestion],
    ["ExamAttempt", prisma.examAttempt],
    ["MockExam", prisma.mockExam],
    ["MockExamQuestion", prisma.mockExamQuestion],
    ["MediaAsset", prisma.mediaAsset],
    ["SessionVideo", prisma.sessionVideo],
    ["SessionVideoView", prisma.sessionVideoView],
    ["LessonProgress", prisma.lessonProgress],
    ["LessonBookmark", prisma.lessonBookmark],
    ["LessonNote", prisma.lessonNote],
    ["StudyTask", prisma.studyTask],
    ["TeacherNote", prisma.teacherNote],
    ["LessonPlanTemplate", prisma.lessonPlanTemplate],
    ["SubscriptionPlan", prisma.subscriptionPlan],
    ["Subscription", prisma.subscription],
    ["Payment", prisma.payment],
    ["Coupon", prisma.coupon],
    ["CouponRedemption", prisma.couponRedemption],
    ["Referral", prisma.referral],
    ["Notification", prisma.notification],
    ["NotificationPreference", prisma.notificationPreference],
    ["AuditLog", prisma.auditLog],
    ["Setting", prisma.setting],
    ["UserSession", prisma.userSession],
    ["PasswordResetToken", prisma.passwordResetToken],
    ["TeacherApplication", prisma.teacherApplication],
    ["TeacherActivationToken", prisma.teacherActivationToken],
    ["SecurityRateLimit", prisma.securityRateLimit],
    ["SecurityEvent", prisma.securityEvent],
  ];
  const out: { table: string; rows: number }[] = [];
  for (const [table, delegate] of delegates) {
    try {
      out.push({ table, rows: await delegate.count() });
    } catch {
      out.push({ table, rows: -1 });
    }
  }
  return out;
}

/**
 * Snapshot of tables that MUST NOT shrink. After the run we assert every one
 * of these is >= its pre-run value (curriculum/content/security preservation).
 */
async function contentSnapshot(): Promise<Record<string, number>> {
  return {
    Course: await prisma.course.count(),
    Part: await prisma.part.count(),
    Unit: await prisma.unit.count(),
    Topic: await prisma.topic.count(),
    Lesson: await prisma.lesson.count(),
    Track: await prisma.track.count(),
    Group: await prisma.group.count(),
    Batch: await prisma.batch.count(),
    SubscriptionPlan: await prisma.subscriptionPlan.count(),
    Setting: await prisma.setting.count(),
    Quiz: await prisma.quiz.count(),
    Question: await prisma.question.count(),
    ExamQuestion: await prisma.examQuestion.count(),
    MockExam: await prisma.mockExam.count(),
    Homework: await prisma.homework.count(),
    MediaAsset: await prisma.mediaAsset.count(),
    SessionVideo: await prisma.sessionVideo.count(),
    Material: await prisma.material.count(),
  };
}

// ---------------------------------------------------------------------------
// Backup (SQLite: read-only VACUUM INTO; PostgreSQL: repo pg backup script)
// ---------------------------------------------------------------------------

function backupDir(): string {
  return path.join(REPO_ROOT, "backups"); // gitignored (see .gitignore /backups/)
}

function plannedBackupPath(provider: Provider): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ext = provider === "postgresql" ? "dump" : "db";
  return path.join(backupDir(), `pre-production-setup-${stamp}.${ext}`);
}

/**
 * Take + verify a backup. SQLite uses a READ-ONLY connection and `VACUUM INTO`
 * so the live database file is never opened for writing. Never overwrites an
 * existing file. Returns the backup path, byte size and SHA-256.
 */
function createVerifiedBackup(
  provider: Provider,
  sqliteFile: string,
  outPath: string
): { path: string; size: number; sha256: string } {
  fs.mkdirSync(backupDir(), { recursive: true });
  if (fs.existsSync(outPath)) {
    throw new Error(`Backup target already exists, refusing to overwrite: ${outPath}`);
  }

  if (provider === "sqlite") {
    if (!fs.existsSync(sqliteFile)) {
      throw new Error(`Cannot back up: SQLite database not found at ${sqliteFile}`);
    }
    // Read-only open: guarantees the source is not mutated/checkpointed by us.
    const ro = new DatabaseSync(sqliteFile, { readOnly: true });
    try {
      ro.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`);
    } finally {
      ro.close();
    }
  } else if (provider === "postgresql") {
    // Reuse the repository's PostgreSQL backup mechanism — do NOT reimplement.
    const script = path.join(REPO_ROOT, "scripts", "db", "backup-postgres.sh");
    if (!fs.existsSync(script)) {
      throw new Error(`PostgreSQL backup script not found: ${script}`);
    }
    // Lazy import so SQLite runs never load child_process.
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    execFileSync("bash", [script, "--out-dir", backupDir(), "--label", "pre-production-setup"], {
      stdio: "inherit",
      cwd: REPO_ROOT,
    });
    // The pg script names its own artifact; surface the newest .dump it wrote.
    const dumps = fs
      .readdirSync(backupDir())
      .filter((f) => f.endsWith(".dump"))
      .map((f) => path.join(backupDir(), f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (dumps.length === 0) throw new Error("PostgreSQL backup produced no .dump artifact.");
    outPath = dumps[0];
  } else {
    throw new Error(`Unknown database provider — refusing to run without a backup.`);
  }

  if (!fs.existsSync(outPath)) throw new Error(`Backup verification failed: ${outPath} missing.`);
  const bytes = fs.readFileSync(outPath);
  const size = bytes.length;
  if (size === 0) throw new Error(`Backup verification failed: ${outPath} is empty.`);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  return { path: outPath, size, sha256 };
}

// ---------------------------------------------------------------------------
// Selective, dependency-safe removal of a single non-allowlisted user.
// ---------------------------------------------------------------------------
//
// Cascade analysis (from prisma/schema.prisma, verified against migrations):
//   Deleting a User row CASCADES: Student (+ all student-owned children:
//   Attendance, QuizAttempt→QuizAnswer/Evidence, HomeworkSubmission, Lesson*,
//   StudentBadge, StudyTask, Subscription, SessionVideoView, Enrollment,
//   ParentStudentLink, Referral, ExamAttempt), Parent (+ links), Teacher
//   (+ TeacherNote, LessonPlanTemplate; Group.teacherId & LiveSession.teacherId
//   are nullable → SET NULL, groups/sessions preserved), Notification,
//   UserSession, PasswordResetToken, AuditLog. SecurityEvent.userId is
//   SET NULL (rows preserved for audit).
//
//   NOT cascaded and therefore removed explicitly first:
//     * Payment      — required relation with NO cascade (RESTRICT): would
//                      block the User delete, so delete the user's payments.
//     * NotificationPreference / CouponRedemption — carry userId but have no
//                      FK relation to User (no cascade, would orphan): removed
//                      by explicit scoped delete.
async function removeUser(tx: any, userId: string): Promise<void> {
  // Explicit, scoped deletes for the non-cascading user-owned rows.
  await tx.payment.deleteMany({ where: { userId } });
  await tx.notificationPreference.deleteMany({ where: { userId } });
  await tx.couponRedemption.deleteMany({ where: { userId } });
  // The User delete cascades / SET NULLs everything else per the analysis above.
  await tx.user.delete({ where: { id: userId } });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  console.log("\n========================================");
  console.log("   CodeMind Production Baseline Setup");
  console.log("========================================\n");

  const dbUrl = process.env.DATABASE_URL || "";
  const provider = detectProvider(dbUrl);
  const sqlite = provider === "sqlite" ? resolveSqliteFile(dbUrl) : { file: "", existed: false };

  console.log(`Provider : ${provider}`);
  console.log(`Target   : ${redactUrl(dbUrl)}`);
  if (provider === "sqlite") {
    console.log(`DB file  : ${sqlite.file} ${sqlite.existed ? "(exists)" : "(NOT FOUND)"}`);
  }
  if (provider === "unknown") {
    throw new Error("DATABASE_URL is unset or not recognized (expected file:/postgres).");
  }

  // ---- Current state (read-only) ----
  const before = await tableCounts();
  const beforeByRole = {
    ADMIN: await prisma.user.count({ where: { role: Role.ADMIN } }),
    TEACHER: await prisma.user.count({ where: { role: Role.TEACHER } }),
    STUDENT: await prisma.user.count({ where: { role: Role.STUDENT } }),
    PARENT: await prisma.user.count({ where: { role: Role.PARENT } }),
  };
  const contentBefore = await contentSnapshot();

  console.log("\nCurrent non-empty tables:");
  for (const r of before) if (r.rows > 0) console.log(`  ${r.table}: ${r.rows}`);
  console.log(
    `\nUsers by role: ADMIN=${beforeByRole.ADMIN} TEACHER=${beforeByRole.TEACHER} ` +
      `STUDENT=${beforeByRole.STUDENT} PARENT=${beforeByRole.PARENT}`
  );

  // ---- Plan: who stays / who goes / conflicts ----
  const allUsers = await prisma.user.findMany({
    select: { id: true, email: true, name: true, role: true },
  });
  const keep = allUsers.filter((u) => PRODUCTION_ALLOWLIST.has(normalizeEmail(u.email)));
  const remove = allUsers.filter((u) => !PRODUCTION_ALLOWLIST.has(normalizeEmail(u.email)));

  // Role-conflict pre-flight: an allowlisted email that exists with a role
  // different from its designated role must ABORT (never silently corrupt).
  const conflicts: string[] = [];
  for (const spec of PRODUCTION_USERS) {
    const existing = allUsers.find((u) => normalizeEmail(u.email) === normalizeEmail(spec.email));
    if (existing && existing.role !== spec.role) {
      conflicts.push(
        `  ${spec.email}: exists as ${existing.role}, but must be ${spec.role}`
      );
    }
  }

  console.log("\nCurriculum (canonical reconciliation source: knowledge-model.json):");
  const course = await prisma.course.findUnique({
    where: { slug: OFFICIAL_COURSE_SLUG },
    select: { id: true },
  });
  const curParts = course
    ? await prisma.part.count({ where: { courseId: course.id } })
    : 0;
  const curUnits = course
    ? await prisma.unit.count({ where: { part: { courseId: course.id } } })
    : 0;
  const curOfficialLessons = await prisma.lesson.count({
    where: { officialCode: { not: null }, curriculumStatus: "OFFICIAL" },
  });
  console.log(
    `  Course=${course ? "present" : "MISSING"} Parts=${curParts}/${EXPECTED_OFFICIAL_COUNTS.parts} ` +
      `Units=${curUnits}/${EXPECTED_OFFICIAL_COUNTS.units} ` +
      `OfficialLessons=${curOfficialLessons}/${EXPECTED_OFFICIAL_COUNTS.lessons}`
  );

  console.log("\nUser plan:");
  console.log(`  KEEP (allowlisted, ${keep.length}): ${keep.map((u) => u.email).join(", ") || "none"}`);
  console.log(`  REMOVE (non-allowlisted, ${remove.length}): ${remove.map((u) => u.email).join(", ") || "none"}`);
  console.log("  CREATE/UPDATE to final baseline:");
  for (const s of PRODUCTION_USERS) console.log(`    ${s.role.padEnd(7)} ${s.name} <${s.email}>`);

  const plannedBackup = plannedBackupPath(provider);
  console.log(`\nPlanned backup: ${plannedBackup}`);

  if (conflicts.length) {
    console.log("\n⚠ ROLE CONFLICTS — aborting with ZERO mutations:");
    for (const c of conflicts) console.log(c);
    throw new Error("Refusing to run: allowlisted emails exist with unexpected roles.");
  }

  if (dryRun) {
    console.log("\n--dry-run: no backup was created and NOTHING was changed.");
    return;
  }

  // ---- Confirmation ----
  console.log("\nThis PRODUCTION BASELINE operation will:");
  console.log("- Create a verified backup BEFORE any change");
  console.log("- Reconcile the official curriculum (preserve existing, idempotent)");
  console.log("- Remove ONLY obsolete / non-allowlisted user data (dependency-safe)");
  console.log("- Preserve ALL curriculum / media / assessments / plans / settings");
  console.log("- Preserve historical audit/security infrastructure");
  console.log("- Create/update EXACTLY 3 accounts (2 ADMIN + 1 TEACHER)");
  console.log("- Prompt for each account password interactively (never stored in code)\n");

  const confirmation = await ask('Type "PRODUCTION" to continue: ');
  if (confirmation.trim() !== "PRODUCTION") {
    console.log("\nCancelled. Nothing was changed.");
    return;
  }

  // ---- Collect all passwords up front (so the DB transaction never waits on
  //      human input). Each is entered twice, hidden, and policy-checked. ----
  const passwordHashes = new Map<string, string>();
  for (const spec of PRODUCTION_USERS) {
    for (;;) {
      const pw = await askHidden(`\nPassword for ${spec.role} ${spec.name} <${spec.email}>: `);
      if (!pw || pw.length < MIN_PASSWORD_LENGTH) {
        console.log(`  Password must be at least ${MIN_PASSWORD_LENGTH} characters. Try again.`);
        continue;
      }
      const confirm = await askHidden(`Confirm password for ${spec.email}: `);
      if (pw !== confirm) {
        console.log("  Passwords did not match. Try again.");
        continue;
      }
      passwordHashes.set(normalizeEmail(spec.email), hashPassword(pw));
      break;
    }
  }

  // ---- Backup BEFORE the first mutation ----
  console.log("\nCreating verified backup...");
  const backup = createVerifiedBackup(provider, sqlite.file, plannedBackup);
  console.log(`✓ Backup: ${backup.path}`);
  console.log(`  size   : ${backup.size} bytes`);
  console.log(`  sha256 : ${backup.sha256}`);

  // ---- All mutations in ONE transaction (atomic; rolls back on failure) ----
  console.log("\nApplying production baseline (transactional)...");
  // Generous timeout: this transaction does NOT wait on human input (all
  // passwords were collected above). It only needs enough headroom for the
  // curriculum reconcile + scoped user deletes on a real database.
  await prisma.$transaction(
    async (tx) => {
    // 1. Curriculum: canonical, idempotent reconciliation (create-mostly).
    const report = await reconcileOfficialCurriculum(tx as any);
    console.log(
      `  ✓ Curriculum reconciled: parts +${report.partsCreated}, units +${report.unitsCreated}, ` +
        `lessons +${report.lessonsCreated} (updated ${report.lessonsUpdated}); ` +
        `official codes=${report.officialLessonCodes.length}`
    );
    for (const w of report.warnings) console.log(`    ! ${w}`);

    // 2. Selective, dependency-safe removal of non-allowlisted users.
    for (const u of remove) await removeUser(tx, u.id);
    console.log(`  ✓ Removed ${remove.length} non-allowlisted user(s) and their owned data`);

    // 3. Create/update the three required accounts.
    for (const spec of PRODUCTION_USERS) {
      const email = normalizeEmail(spec.email);
      const password = passwordHashes.get(email)!;
      const existing = await tx.user.findUnique({ where: { email } });

      if (existing && existing.role !== spec.role) {
        // Defensive: pre-flight already checked, but never corrupt a role.
        throw new Error(`Role conflict for ${email}: ${existing.role} != ${spec.role}`);
      }

      const user = existing
        ? await tx.user.update({
            where: { email },
            data: {
              name: spec.name,
              password,
              role: spec.role,
              isActive: true,
              status: "ACTIVE",
            },
          })
        : await tx.user.create({
            data: {
              email,
              name: spec.name,
              password,
              role: spec.role,
              isActive: true,
              status: "ACTIVE",
            },
          });

      // Teacher end-state must match the Phase 20 activation outcome exactly:
      // a User{role:TEACHER} PLUS a Teacher row. We reach the same end-state
      // here without a fake TeacherApplication or a fake activation token —
      // the password is still interactive + scrypt-hashed, the account is
      // active, and no plaintext or insecure shortcut is introduced. This is a
      // deliberate one-time production bootstrap of a KNOWN owner, not the
      // public application path (which remains the only way strangers become
      // teachers).
      if (spec.role === Role.TEACHER) {
        const t = await tx.teacher.findUnique({ where: { userId: user.id } });
        if (!t) await tx.teacher.create({ data: { userId: user.id } });
      }
      console.log(`  ✓ ${existing ? "Updated" : "Created"} ${spec.role} ${spec.email}`);
    }
    },
    { timeout: 120_000, maxWait: 120_000 }
  );

  // ======================================================================
  // Verification (read-only, after commit)
  // ======================================================================
  console.log("\n========================================");
  console.log("            Verification");
  console.log("========================================");

  const adminCount = await prisma.user.count({ where: { role: Role.ADMIN } });
  const teacherCount = await prisma.user.count({ where: { role: Role.TEACHER } });
  const studentCount = await prisma.user.count({ where: { role: Role.STUDENT } });
  const parentCount = await prisma.user.count({ where: { role: Role.PARENT } });
  const totalUsers = await prisma.user.count();

  console.log("\nUsers:");
  console.log(`  ADMIN   : ${adminCount} (expect 2)`);
  console.log(`  TEACHER : ${teacherCount} (expect 1)`);
  console.log(`  STUDENT : ${studentCount} (expect 0)`);
  console.log(`  PARENT  : ${parentCount} (expect 0)`);
  console.log(`  TOTAL   : ${totalUsers} (expect 3)`);

  const problems: string[] = [];
  if (adminCount !== 2) problems.push(`ADMIN=${adminCount}, expected 2`);
  if (teacherCount !== 1) problems.push(`TEACHER=${teacherCount}, expected 1`);
  if (studentCount !== 0) problems.push(`STUDENT=${studentCount}, expected 0`);
  if (parentCount !== 0) problems.push(`PARENT=${parentCount}, expected 0`);
  if (totalUsers !== 3) problems.push(`TOTAL users=${totalUsers}, expected 3`);

  // Exact identities.
  for (const spec of PRODUCTION_USERS) {
    const u = await prisma.user.findUnique({
      where: { email: normalizeEmail(spec.email) },
      select: { name: true, role: true, isActive: true, status: true },
    });
    const okId =
      u && u.name === spec.name && u.role === spec.role && u.isActive && u.status === "ACTIVE";
    console.log(
      `  ${okId ? "✓" : "✗"} ${spec.role} ${spec.email} — ${u ? `${u.name} (${u.role}, active=${u.isActive}, ${u.status})` : "MISSING"}`
    );
    if (!okId) problems.push(`identity/state mismatch for ${spec.email}`);
    if (spec.role === Role.TEACHER && u) {
      const tu = await prisma.user.findUnique({
        where: { email: normalizeEmail(spec.email) },
        select: { teacher: { select: { id: true } } },
      });
      if (!tu?.teacher) problems.push(`Teacher record missing for ${spec.email}`);
    }
  }

  // Curriculum.
  const courseAfter = await prisma.course.findUnique({
    where: { slug: OFFICIAL_COURSE_SLUG },
    select: { id: true },
  });
  const partsAfter = courseAfter ? await prisma.part.count({ where: { courseId: courseAfter.id } }) : 0;
  const unitsAfter = courseAfter
    ? await prisma.unit.count({ where: { part: { courseId: courseAfter.id } } })
    : 0;
  const officialAfter = await prisma.lesson.count({
    where: { officialCode: { not: null }, curriculumStatus: "OFFICIAL" },
  });
  console.log("\nCurriculum:");
  console.log(`  Course  : ${courseAfter ? "present" : "MISSING"}`);
  console.log(`  Parts   : ${partsAfter} (expect ${EXPECTED_OFFICIAL_COUNTS.parts})`);
  console.log(`  Units   : ${unitsAfter} (expect ${EXPECTED_OFFICIAL_COUNTS.units})`);
  console.log(`  Official lessons: ${officialAfter} (expect ${EXPECTED_OFFICIAL_COUNTS.lessons})`);
  if (!courseAfter) problems.push("official Course missing");
  if (partsAfter !== EXPECTED_OFFICIAL_COUNTS.parts) problems.push(`Parts=${partsAfter}`);
  if (unitsAfter !== EXPECTED_OFFICIAL_COUNTS.units) problems.push(`Units=${unitsAfter}`);
  if (officialAfter !== EXPECTED_OFFICIAL_COUNTS.lessons) problems.push(`OfficialLessons=${officialAfter}`);

  // Unique official codes (no duplicates), and all expected codes present.
  const grouped = await prisma.lesson.groupBy({
    by: ["officialCode"],
    where: { officialCode: { not: null } },
    _count: { officialCode: true },
  });
  const dupes = grouped.filter((g) => (g._count.officialCode ?? 0) > 1);
  if (dupes.length) problems.push(`duplicate official codes: ${dupes.map((d) => d.officialCode).join(", ")}`);
  const presentCodes = new Set(grouped.map((g) => g.officialCode));
  const missingCodes = OFFICIAL_LESSON_CODES.filter((c) => !presentCodes.has(c));
  if (missingCodes.length) problems.push(`missing official codes: ${missingCodes.join(", ")}`);
  console.log(
    `  Official codes: ${presentCodes.size} distinct, duplicates=${dupes.length}, missing=${missingCodes.length}`
  );

  // Content preservation: nothing critical shrank.
  const contentAfter = await contentSnapshot();
  console.log("\nContent preservation (before → after; must not shrink):");
  for (const k of Object.keys(contentBefore)) {
    const b = contentBefore[k];
    const a = contentAfter[k];
    const flag = a < b ? " ✗ SHRANK" : "";
    console.log(`  ${k}: ${b} → ${a}${flag}`);
    if (a < b) problems.push(`${k} shrank ${b}→${a}`);
  }

  // Referential integrity (SQLite only: read-only FK check on the file).
  if (provider === "sqlite") {
    const ro = new DatabaseSync(sqlite.file, { readOnly: true });
    try {
      const fk = ro.prepare("PRAGMA foreign_key_check").all();
      console.log(`\nForeign key check: ${fk.length === 0 ? "PASS (no violations)" : "FAIL"}`);
      if (fk.length) {
        problems.push(`FK violations: ${fk.length}`);
        console.log(JSON.stringify(fk, null, 2));
      }
    } finally {
      ro.close();
    }
  }

  console.log("\n----------------------------------------");
  console.log(`Backup preserved at: ${backup.path}`);
  console.log(`Backup sha256      : ${backup.sha256}`);

  if (problems.length) {
    console.log("\n⚠ VERIFICATION PROBLEMS:");
    for (const p of problems) console.log(`  - ${p}`);
    throw new Error("Production baseline verification FAILED (see problems above).");
  }

  console.log("\n✓ Production baseline established and verified.");
  console.log("========================================\n");
}

main()
  .catch((error) => {
    console.error("\nSetup failed:");
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
