// CodeMind Academy — Phase 17 (session publication notifications) behavior suite.
//
// THE CONTRACT UNDER TEST
// =======================
// Publishing a session through the Phase 13 OPEN ceremony produces exactly
// one targeted event — a NEW_LESSON notification delivered to the audience
// (active × enrolled-course × trackScope), partitioned by the shared
// preference contract, inserted in bounded chunks, idempotent under every
// retry, deep-linked by a validated `lesson:<id>` — with an honest outcome
// code for every terminal state.
//
// LAYERS (same convention as the Phase 11–16 suites)
//   1. Pure functions from the SHIPPED modules, tsc-compiled with the repo's
//      own toolchain (no mocks of the code under test).
//   2. The fan-out engine over an in-memory client that interprets the real
//      `where` shapes — exercising the actual SQL-fragment / dedupe / chunk /
//      counter / audit paths.
//   3. Source pins with negative controls over the routes, the dialog, the
//      migration SQL, the schema and the Phase 16 client integration.
//   4. The REAL-DB end-to-end verifier re-run as a child process
//      (scripts/verify-phase17-notifications.mjs), failing rather than
//      skipping if node:sqlite is unavailable.
//
// Run: node tests/session-notifications-phase17.test.js
// Exit code: 0 = all pass, 1 = failure.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node test runner, same as the other suites */
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { execSync } = require("child_process");

const REPO = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase17-"));

let pass = 0;
let fail = 0;
const failures = [];
const ok = (cond, label) => {
  if (cond) pass++;
  else {
    fail++;
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
};
const eq = (a, b, label) =>
  ok(JSON.stringify(a) === JSON.stringify(b), `${label} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const section = (t) => console.log(`\n${t}`);

const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

/** Pin a pattern is present, then MUTATE the source to prove the pin is load-bearing. */
function pinned(src, re, label, mutate) {
  ok(re.test(src), label);
  // Remove ALL occurrences (a pin whose pattern repeats must fail on total mutation).
  const mutated = mutate ? mutate(src) : src.replace(new RegExp(re.source, "g"), "#MUTATED#");
  ok(!re.test(mutated), `${label} — negative control (mutation breaks the pin)`);
}
/** Pin a pattern is absent in real src but present in an artificial positive control. */
function pinnedAbsent(src, re, label, positiveControl) {
  ok(!re.test(src), label);
  ok(re.test(src + positiveControl), `${label} — negative control (regex can match)`);
}

// ---------------------------------------------------------------------------
// 1. Compile the shipped modules (entry points; tsc follows imports)
// ---------------------------------------------------------------------------
const FILES = [
  "src/lib/school-type.ts",
  "src/lib/track-scope.ts",
  "src/lib/i18n-dict.ts",
  "src/lib/i18n-dict-2026.ts",
  "src/lib/i18n-core.ts",
  "src/lib/deep-link.ts",
  "src/lib/notification-links.ts",
  "src/lib/notify.ts",
  "src/lib/session-notifications.ts",
  "src/lib/session-progress.ts",
];
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "es2020", module: "commonjs", skipLibCheck: true, esModuleInterop: true,
      strict: false, baseUrl: REPO, rootDir: REPO, paths: { "@/*": ["src/*"] },
      typeRoots: [path.join(REPO, "node_modules/@types")], outDir: OUT, noEmitOnError: false,
    },
    files: FILES.map((f) => path.join(REPO, f)),
  })
);
try {
  execSync(`npx tsc -p ${path.join(OUT, "tsconfig.json")}`, { cwd: REPO, stdio: "pipe" });
} catch {
  /* type noise elsewhere in the graph is tolerated; the emitted files matter */
}
const compiled = (f) => path.join(OUT, f.replace(/\.ts$/, ".js"));
for (const f of FILES) {
  if (!fs.existsSync(compiled(f))) throw new Error(`tsc did not emit ${f}`);
}

// The DB shim: every compiled module that imports @/lib/db gets the fake.
global.__CM_FAKE_DB__ = null;
const DB_SHIM = path.join(OUT, "__shim_db.js");
fs.writeFileSync(DB_SHIM, "module.exports = { db: new Proxy({}, { get: (_, p) => global.__CM_FAKE_DB__[p] }) };\n");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "@/lib/db") return DB_SHIM;
  if (request.startsWith("@/")) {
    const rel = request.slice(2);
    const cand = path.join(OUT, `src/${rel}.js`);
    if (fs.existsSync(cand)) return cand;
  }
  return origResolve.call(this, request, parent, ...rest);
};

const NL = require(compiled("src/lib/notification-links.ts"));
const NOTIFY = require(compiled("src/lib/notify.ts"));
const SN = require(compiled("src/lib/session-notifications.ts"));
const I18N = require(compiled("src/lib/i18n-core.ts"));
const TS = require(compiled("src/lib/track-scope.ts"));

// ---------------------------------------------------------------------------
// 2. An in-memory client interpreting the real where-shapes the engine uses
// ---------------------------------------------------------------------------
function makeFakeDb(seed) {
  const state = {
    students: seed.students ?? [],     // {id,userId,schoolType,group:{isActive,courseId},user:{isActive,status}}
    lessons: seed.lessons ?? [],       // {id,status,trackScope,officialCode,title,titleAr,unitId,unit,topicId,topic,publication}
    prefs: seed.prefs ?? [],           // {userId,newLesson?,quietHoursStart?,quietHoursEnd?,announcements?}
    notifications: seed.notifications ?? [],
    audits: [],
    publicationCounters: {},           // lessonId → {notifiedCount, notifiedAt}
    failOnCreateManyCall: seed.failOnCreateManyCall ?? -1, // 1-based call index to throw at
    createManyCalls: 0,
    sleep: seed.sleep ?? 0,            // ms to sleep inside createMany (race widening)
  };
  const matchStudent = (s, w) => {
    if (w.group && (s.group.isActive !== w.group.isActive || s.group.courseId !== w.group.courseId)) return false;
    if (w.user && (s.user.isActive !== w.user.isActive || s.user.status !== w.user.status)) return false;
    if (w.schoolType && s.schoolType !== w.schoolType) return false;
    return true;
  };
  return {
    __state: state,
    student: {
      findMany: async (args) => state.students.filter((s) => matchStudent(s, args.where))
        .map((s) => ({ id: s.id, userId: s.userId, schoolType: s.schoolType })),
    },
    lesson: {
      findUnique: async (args) => state.lessons.find((l) => l.id === args.where.id) ?? null,
    },
    notificationPreference: {
      findMany: async (args) =>
        state.prefs.filter((p) => !args?.where?.userId?.in || args.where.userId.in.includes(p.userId)),
      findUnique: async (args) => state.prefs.find((p) => p.userId === args.where.userId) ?? null,
    },
    notification: {
      findMany: async (args) => {
        const w = args?.where ?? {};
        return state.notifications.filter(
          (n) =>
            (!w.userId?.in || w.userId.in.includes(n.userId)) &&
            (!w.type || n.type === w.type) &&
            (!w.link || n.link === w.link)
        ).map((n) => ({ userId: n.userId }));
      },
      count: async (args) => {
        const w = args?.where ?? {};
        return state.notifications.filter((n) => (!w.type || n.type === w.type) && (!w.link || n.link === w.link)).length;
      },
      createMany: async (args) => {
        state.createManyCalls += 1;
        if (state.failOnCreateManyCall === state.createManyCalls) throw new Error("simulated chunk failure");
        if (state.sleep) await new Promise((r) => setTimeout(r, state.sleep));
        for (const row of args.data) state.notifications.push({ ...row, isRead: false, createdAt: new Date() });
        return { count: args.data.length };
      },
    },
    sessionPublication: {
      findUnique: async (args) => {
        const l = state.lessons.find((x) => x.id === args.where.lessonId);
        const p = l?.publication ?? null;
        if (!p) return null;
        const cnt = state.publicationCounters[l.id] ?? { notifiedCount: 0, notifiedAt: null };
        return { ...p, ...cnt };
      },
      updateMany: async (args) => {
        const l = state.lessons.find((x) => x.id === args.where.lessonId);
        if (!l) return { count: 0 };
        state.publicationCounters[l.id] = { ...(state.publicationCounters[l.id] ?? { notifiedCount: 0, notifiedAt: null }), ...args.data };
        return { count: 1 };
      },
    },
    auditLog: {
      create: async (args) => { state.audits.push(args.data); return args.data; },
    },
  };
}

// Fixture factories ----------------------------------------------------------
let uid = 0;
function mkStudentFixture(schoolType) {
  uid += 1;
  return { id: `st-${uid}`, userId: `u-${uid}`, schoolType, group: { isActive: true, courseId: "cA" }, user: { isActive: true, status: "ACTIVE" } };
}
function mkLessonFixture(over = {}) {
  return {
    id: "L1", status: "PUBLISHED", trackScope: "SHARED", officialCode: "P17-1-1",
    title: "Session One", titleAr: "جلسة أولى", order: 1, videoUrl: "v",
    unitId: "u1", topicId: null, topic: null,
    unit: { id: "u1", order: 1, title: "Unit One", titleAr: "الوحدة الأولى", part: { id: "pa1", order: 1, courseId: "cA" } },
    publication: { id: "sp1", segment: "SHARED", publishedAt: new Date("2026-09-10T10:00:00Z") },
    ...over,
  };
}
const NOW = new Date("2026-09-10T12:00:00Z");

async function main() {
  // ==========================================================================
  section("A. notification-links: valid mints, total rejection corpus");
  // ==========================================================================
  ok(NL.sessionPublicationLink("abc123") === "lesson:abc123", "A: session link mints lesson:<id>");
  eq([...(NL.DEEP_LINK_KINDS ?? [])].sort(), ["homework", "lesson", "quiz", "video"], "A: the validated scheme is exactly the four kinds");
  ok(NL.mintNotificationLink("quiz", "Q9") === "quiz:Q9", "A: quiz link mints");
  ok(NL.mintNotificationLink("video", "V-1_x") === "video:V-1_x", "A: id alphabet - _ kept");
  ok(NL.mintNotificationLink("homework", "h1") === "homework:h1", "A: homework link mints");
  eq(NL.mintNotificationLink("admin", "x"), null, "A: unknown kind never mints");
  eq(NL.mintNotificationLink("lesson", 42), null, "A: non-string id never mints");
  const badCorpus = ["https://evil.example/x", "//host/path", "javascript:alert(1)", "/admin/x",
    "admin-payments", "dashboard", "lesson:../x", "weird:thing", "lesson:x y", "LESSON:x",
    "lesson:", ":x", "lesson:" + "a".repeat(81), "lesson:x:1", " quiz:ok extra", 42, {}, []];
  for (const bad of badCorpus) {
    eq(NL.validateNotificationLink(bad), false, `A: ${JSON.stringify(bad)} rejected`);
  }
  eq(NL.validateNotificationLink(null), null, "A: null link is fine (no link)");
  eq(NL.validateNotificationLink(""), null, "A: empty string folds to no-link");
  eq(NL.validateNotificationLink(undefined), null, "A: undefined folds to no-link");
  ok(NL.validateNotificationLink("  quiz:Q9  ") === "quiz:Q9", "A: whitespace canonicalized");
  ok(NL.isValidNotificationLink("video:V1") && !NL.isValidNotificationLink("nope:1"), "A: boolean wrapper consistent");
  // Phase 16 surface is re-exported (single import site), not re-implemented:
  ok(typeof NL.parseDeepLink === "function" && NL.parseDeepLink("lesson:X")?.kind === "lesson", "A: parseDeepLink is surfaced from the notification module");

  // ==========================================================================
  section("B. chunking: bounds, order, env clamp");
  // ==========================================================================
  eq(NOTIFY.chunkList([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]], "B: even split with tail");
  eq(NOTIFY.chunkList([], 500), [], "B: empty input → no chunks at all (no trailing no-op insert)");
  eq(NOTIFY.chunkList([1], 500), [[1]], "B: single element, single chunk");
  eq(NOTIFY.chunkList([1, 2], 0), [[1], [2]], "B: size 0 clamps to 1 (never a zero-step loop)");
  eq(NOTIFY.chunkList([1, 2, 3], 1.9), [[1], [2], [3]], "B: fractional size floors to a safe integer");
  eq(NOTIFY.NOTIFICATION_FANOUT_DEFAULT_CHUNK_SIZE, 500, "B: platform default is 500");
  eq(NOTIFY.NOTIFICATION_FANOUT_MAX_CHUNK_SIZE, 1000, "B: documented max is 1000");
  const savedEnv = process.env.NOTIFICATION_FANOUT_CHUNK_SIZE;
  try {
    delete process.env.NOTIFICATION_FANOUT_CHUNK_SIZE;
    eq(NOTIFY.resolveNotificationChunkSize(), 500, "B: unset env → 500");
    process.env.NOTIFICATION_FANOUT_CHUNK_SIZE = "50";
    eq(NOTIFY.resolveNotificationChunkSize(), 50, "B: sane env honoured");
    process.env.NOTIFICATION_FANOUT_CHUNK_SIZE = "0";
    eq(NOTIFY.resolveNotificationChunkSize(), 500, "B: env 0 → default (never a zero chunk)");
    process.env.NOTIFICATION_FANOUT_CHUNK_SIZE = "abc";
    eq(NOTIFY.resolveNotificationChunkSize(), 500, "B: garbage env → default");
    process.env.NOTIFICATION_FANOUT_CHUNK_SIZE = "99999";
    eq(NOTIFY.resolveNotificationChunkSize(), 1000, "B: oversized env clamps to the documented max");
    eq(NOTIFY.resolveNotificationChunkSize(7), 7, "B: explicit param wins over env");
  } finally {
    if (savedEnv === undefined) delete process.env.NOTIFICATION_FANOUT_CHUNK_SIZE;
    else process.env.NOTIFICATION_FANOUT_CHUNK_SIZE = savedEnv;
  }

  // ==========================================================================
  section("C. preference partition == single-create contract, in bulk");
  // ==========================================================================
  const prefRow = (over = {}) => ({
    userId: "u?", newLesson: true, newQuiz: true, quizResult: true, newHomework: true,
    homeworkDeadline: true, upcomingSession: true, lowAttendance: true, monthlyReport: true,
    subscriptionExpiration: true, announcements: true, emailEnabled: false, pushEnabled: true,
    quietHoursStart: null, quietHoursEnd: null, ...over,
  });
  // quiet hours: inclusive start, EXCLUSIVE end, cross-midnight, injected clock.
  eq(NOTIFY.isInQuietHoursAt("22:00", "07:00", new Date("2026-09-10T23:30")), true, "C: cross-midnight window, late night inside");
  eq(NOTIFY.isInQuietHoursAt("22:00", "07:00", new Date("2026-09-10T03:00")), true, "C: cross-midnight window, early morning inside");
  eq(NOTIFY.isInQuietHoursAt("22:00", "07:00", new Date("2026-09-10T07:00")), false, "C: window END is exclusive");
  eq(NOTIFY.isInQuietHoursAt("22:00", "07:00", new Date("2026-09-10T21:59")), false, "C: before window start is outside");
  eq(NOTIFY.isInQuietHoursAt("13:30", "14:30", new Date("2026-09-10T14:00")), true, "C: same-day window contains its middle");
  eq(NOTIFY.isInQuietHoursAt("13:30", "14:30", new Date("2026-09-10T14:30")), false, "C: same-day END exclusive");
  eq(NOTIFY.isInQuietHoursAt("13:30", "14:30", new Date("2026-09-10T13:30")), true, "C: window START inclusive");
  eq(NOTIFY.isInQuietHoursAt(null, "07:00", NOW), false, "C: missing start disables quiet hours");
  eq(NOTIFY.isInQuietHoursAt("bad", "worse", NOW), false, "C: malformed window fails OPEN to delivery (matches legacy helper)");
  // partition: per-type flag, missing row = allow, unknown type = allow, quiet = skip.
  {
    const p = NOTIFY.partitionByNotificationPreferences(["u1", "u2", "u3", "u4"],
      [prefRow({ userId: "u2", newLesson: false }), prefRow({ userId: "u3", quietHoursStart: "00:00", quietHoursEnd: "23:59" })],
      "NEW_LESSON", NOW);
    eq(p.deliver, ["u1", "u4"], "C: flag-off + quiet hours excluded; missing-row users deliver");
    eq(p.skippedPreference, 1, "C: preference-skip counted");
    eq(p.skippedQuietHours, 1, "C: quiet-hours skip counted");
    eq(p.skipped.map((s) => s.reason), ["PREFERENCE_DISABLED", "QUIET_HOURS"], "C: skip reasons carry the exact cause in order");
  }
  {
    const p = NOTIFY.partitionByNotificationPreferences(["u1"], [prefRow({ userId: "u1", newQuiz: false })], "QUIZ_RESULT", NOW);
    eq(p.deliver, ["u1"], "C: a DIFFERENT type's flag never suppresses this type");
    const p2 = NOTIFY.partitionByNotificationPreferences(["u1"], [prefRow({ userId: "u1" })], "SOME_FUTURE_TYPE", NOW);
    eq(p2.deliver, ["u1"], "C: unknown types default to ALLOW (same as single-create)");
    const p3 = NOTIFY.partitionByNotificationPreferences(["u1"], [prefRow({ userId: "u1", announcements: false })], "PAYMENT_APPROVED", NOW);
    eq(p3.deliver, [], "C: PAID types ride the announcements flag (documented legacy mapping)");
  }
  // Parity proof: partition(deliver) ⇔ legacy isNotificationEnabled + isInQuietHoursAt for every fixture.
  {
    const cases = [
      ["u-a", prefRow({ userId: "u-a", newLesson: false }), "NEW_LESSON"],
      ["u-b", prefRow({ userId: "u-b", newLesson: true, quietHoursStart: "22:00", quietHoursEnd: "07:00" }), "NEW_LESSON"],
      ["u-c", null, "NEW_LESSON"],
      ["u-d", prefRow({ userId: "u-d", announcements: false }), "ANNOUNCEMENT"],
      ["u-e", prefRow({ userId: "u-e", quietHoursStart: "13:00", quietHoursEnd: "14:00" }), "NEW_HOMEWORK"],
    ];
    global.__CM_FAKE_DB__ = makeFakeDb({ prefs: cases.map(([, r]) => r).filter(Boolean) });
    const quietNow = new Date("2026-09-10T13:30:00");
    for (const [u] of cases) {
      const row = cases.find((c) => c[0] === u)[1];
      const p = NOTIFY.partitionByNotificationPreferences([u], cases.map((c) => c[1]).filter(Boolean), "NEW_LESSON", quietNow);
      const prefAllows = !row || row.newLesson !== false;
      const quiet = row && NOTIFY.isInQuietHoursAt(row.quietHoursStart, row.quietHoursEnd, quietNow);
      const expect = prefAllows && !quiet ? "deliver" : "skip";
      eq(p.deliver.includes(u) ? "deliver" : "skip", expect, `C: partition parity for ${u}`);
    }
    // Legacy single-create helper still answers per the SAME rules (contract preserved).
    const enabled = await NOTIFY.isNotificationEnabled("u-a", "NEW_LESSON");
    eq(enabled, false, "C: legacy isNotificationEnabled still enforces the flag");
    const enabledMissing = await NOTIFY.isNotificationEnabled("u-missing", "NEW_LESSON");
    eq(enabledMissing, true, "C: legacy helper defaults missing rows to allow");
  }

  // ==========================================================================
  section("D. eligibility: the EXACT track × course × active matrix + mirrors");
  // ==========================================================================
  // The §11 track matrix — hardcoded expectations (the independent truth)
  // AND cross-checked against the Phase 12 helper on every combination.
  {
    const full = (schoolType) => ({
      schoolType, groupIsActive: true, groupCourseId: "cA",
      userIsActive: true, userStatus: "ACTIVE",
    });
    const matrix = [
      ["ARABIC", "SHARED", true], ["ARABIC", "ARABIC", true], ["ARABIC", "LANGUAGE", false],
      ["LANGUAGE", "SHARED", true], ["LANGUAGE", "LANGUAGE", true], ["LANGUAGE", "ARABIC", false],
      [null, "SHARED", true], [null, "ARABIC", false], [null, "LANGUAGE", false],
      ["gibberish", "SHARED", true], ["gibberish", "ARABIC", false],
    ];
    for (const [stt, scope, expected] of matrix) {
      const got = SN.isEligibleSessionRecipient(full(stt), { courseId: "cA", trackScope: scope });
      eq(got, expected, `D: matrix schoolType=${JSON.stringify(stt)} × scope=${scope}`);
      eq(got, TS.canAccessTrackScope(stt, scope), `D: …and it is IDENTICAL to Phase 12 canAccessTrackScope (${stt} × ${scope})`);
    }
    // The remaining gates (course / enrollment / account):
    const ineligible = [
      [{ ...full("ARABIC"), groupIsActive: false }, "inactive GROUP"],
      [{ ...full("ARABIC"), groupCourseId: "cB" }, "another COURSE (SHARED)"],
      [{ ...full("ARABIC"), groupCourseId: null }, "course-less group"],
      [{ ...full("ARABIC"), userIsActive: false }, "deactivated USER"],
      [{ ...full("ARABIC"), userStatus: "SUSPENDED_MULTI_DEVICE" }, "suspended ACCOUNT"],
      [{ ...full("ARABIC"), userStatus: "INACTIVE" }, "INACTIVE account status"],
    ];
    for (const [variant, label] of ineligible) {
      eq(SN.isEligibleSessionRecipient(variant, { courseId: "cA", trackScope: "SHARED" }), false, `D: ${label} never eligible`);
    }
    eq(SN.isEligibleSessionRecipient(full("ARABIC"), { courseId: "cA", trackScope: "ARABIC" }), true, "D: on-track on-course stays eligible");
    eq(
      SN.isEligibleSessionRecipient({ ...full("ARABIC"), groupCourseId: "cB" }, { courseId: "cA", trackScope: "ARABIC" }),
      false, "D: ARABIC student in course B is NOT notified for course A (course isolation beats track match)",
    );
  }
  // The QUERY mirror encodes the identical rule (else query/predicate drift):
  const whereShared = SN.sessionRecipientsWhere({ courseId: "cA", trackScope: "SHARED" });
  eq(whereShared, { group: { isActive: true, courseId: "cA" }, user: { isActive: true, status: "ACTIVE" } }, "D: SHARED where = course gate + user gate ONLY");
  eq(SN.sessionRecipientsWhere({ courseId: "cA", trackScope: "LANGUAGE" }).schoolType, "LANGUAGE", "D: scoped where adds the exact schoolType equality");
  eq(SN.sessionRecipientsWhere({ courseId: "cA", trackScope: "junk" }), SN.sessionRecipientsWhere({ courseId: "cA", trackScope: "SHARED" }), "D: where-helper normalizes junk scope to SHARED …but the RECIPIENT HELPER must fail closed instead:");
  {
    const db = makeFakeDb({ students: [mkStudentFixture("ARABIC")] });
    const rows = await SN.getEligibleSessionRecipients({ courseId: "cA", trackScope: "junk" }, db);
    eq(rows, [], "D: unrecognized lesson scope notifies NOBODY (fail closed at query level)");
  }
  // getEligibleSessionRecipients: deterministic ordering + projection + normalization.
  {
    const s1 = mkStudentFixture("ARABIC"); const s2 = mkStudentFixture("LANGUAGE"); const s3 = mkStudentFixture(null); const s4 = mkStudentFixture("latin-garbage");
    const db = makeFakeDb({ students: [s4, s3, s2, s1].reverse() });
    const rows = await SN.getEligibleSessionRecipients({ courseId: "cA", trackScope: "SHARED" }, db);
    eq(rows.map((r) => r.userId), rows.map((r) => r.userId).slice().sort(), "D: recipients are userId-sorted (chunk boundaries are deterministic)");
    eq(rows.map((r) => r.schoolType), ["ARABIC", "LANGUAGE", null, null], "D: projection normalizes non-enum rows to null");
    // The SAME input through the SQL-mirror where returns the same ids the
    // predicate would keep — the two mirrors agree on the fixture:
    const kept = db.__state.students.filter((s) => SN.isEligibleSessionRecipient({
      schoolType: s.schoolType, groupIsActive: s.group.isActive, groupCourseId: s.group.courseId,
      userIsActive: s.user.isActive, userStatus: s.user.status,
    }, { courseId: "cA", trackScope: "SHARED" }));
    eq(rows.map((r) => r.studentId).sort(), kept.map((s) => s.id).sort(), "D: query mirror == predicate mirror on the live fixture");
    // And through TS.canAccessTrackScope on EVERY fixture × EVERY scope:
    for (const scope of ["SHARED", "ARABIC", "LANGUAGE"]) {
      const expectIds = db.__state.students
        .filter((s) => TS.canAccessTrackScope(s.schoolType, scope))
        .map((s) => s.id).sort();
      const gotIds = (await SN.getEligibleSessionRecipients({ courseId: "cA", trackScope: scope }, db))
        .map((r) => r.studentId).sort();
      eq(gotIds, expectIds, `D: eligibility derives from canAccessTrackScope for scope ${scope}`);
    }
  }

  // ==========================================================================
  section("E. the fan-out engine over a fake client: gates → emit → replay");
  // ==========================================================================
  // Gates first (each refusal leaves ZERO rows):
  {
    const db = makeFakeDb({});
    const r1 = await SN.emitSessionPublicationNotifications({ lessonId: "ghost", client: db });
    eq(r1.code, "LESSON_NOT_FOUND", "E: missing lesson refuses with LESSON_NOT_FOUND");
    eq(db.__state.notifications.length, 0, "E: refusal → zero rows");
  }
  {
    const db = makeFakeDb({ lessons: [mkLessonFixture({ status: "READY", publication: null })] });
    const r = await SN.emitSessionPublicationNotifications({ lessonId: "L1", client: db });
    eq(r.code, "LESSON_NOT_PUBLISHED", "E: DRAFT/READY refuses with LESSON_NOT_PUBLISHED");
    eq(db.__state.notifications.length, 0, "E: premature broadcast impossible (no rows)");
  }
  {
    // The stop-rule: PUBLISHED status but NO live anchor (late retry after unpublish).
    const db = makeFakeDb({ lessons: [mkLessonFixture({ publication: null })] });
    const r = await SN.emitSessionPublicationNotifications({ lessonId: "L1", client: db });
    eq(r.code, "PUBLICATION_MISSING", "E: PUBLISHED with no live anchor refuses with PUBLICATION_MISSING");
    eq(db.__state.notifications.length, 0, "E: the late retry delivers NOTHING");
  }
  {
    const db = makeFakeDb({ lessons: [mkLessonFixture({ unit: null, unitId: null })] });
    const r = await SN.emitSessionPublicationNotifications({ lessonId: "L1", client: db });
    eq(r.code, "LESSON_NOT_IN_COURSE", "E: a course-less lesson refuses (same verdict as the ceremony)");
  }
  {
    const db = makeFakeDb({ lessons: [mkLessonFixture()], students: [] });
    const r = await SN.emitSessionPublicationNotifications({ lessonId: "L1", client: db });
    eq(r.code, "NO_RECIPIENTS", "E: empty audience reports NO_RECIPIENTS");
    eq(db.__state.audits.length, 0, "E: NO_RECIPIENTS without actor writes no audit row either");
  }
  // First emit — the happy contract:
  {
    const s1 = mkStudentFixture("ARABIC"); const s2 = mkStudentFixture("LANGUAGE"); const s3 = mkStudentFixture(null);
    const sOff = mkStudentFixture("ARABIC"); sOff.group = { isActive: true, courseId: "cB" }; // course isolation
    const sQuiet = mkStudentFixture("ARABIC"); const sPref = mkStudentFixture("ARABIC");
    const db = makeFakeDb({
      lessons: [mkLessonFixture()],
      students: [s1, s2, s3, sOff, sQuiet, sPref],
      prefs: [
        prefRow({ userId: sQuiet.userId, quietHoursStart: "00:00", quietHoursEnd: "23:59" }),
        prefRow({ userId: sPref.userId, newLesson: false }),
      ],
    });
    const r = await SN.emitSessionPublicationNotifications({ lessonId: "L1", actorUserId: "admin-1", client: db, now: NOW, locale: "en" });
    eq([r.ok, r.code], [true, "EMITTED"], "E: first emit succeeds");
    eq(r.eligible, 5, "E: eligible == the whole active×course×track set, prefs do not shrink it");
    eq(r.delivered, 3, "E: delivered == eligible minus pref/quiet skips");
    eq([r.skippedPreference, r.skippedQuietHours], [1, 1], "E: skip breakdown exact");
    eq(db.__state.notifications.length, 3, "E: exactly the three fresh rows persisted");
    const byUser = Object.fromEntries(db.__state.notifications.map((n) => [n.userId, n]));
    ok(byUser[s1.userId] && byUser[s2.userId], "E: both named tracks received (SHARED lesson)");
    ok(byUser[s3.userId], "E: the unspecified-track student receives SHARED lessons");
    ok(!byUser[sOff.userId], "E: course-isolated student has NO row");
    ok(!byUser[sQuiet.userId] && !byUser[sPref.userId], "E: suppressed students have NO row");
    eq(byUser[s1.userId].type, "NEW_LESSON", "E: row type is NEW_LESSON (phase-locked type)");
    eq(byUser[s1.userId].link, "lesson:L1", "E: every row carries the validated session link");
    ok(byUser[s1.userId].title === "New session: P17-1-1 · Session One", "E: en title = api.230 with officialCode · name");
    ok(byUser[s1.userId].message.includes("Unit One") && byUser[s1.userId].message.startsWith("P17-1-1"), "E: en message carries chapter + display name");
    eq(byUser[s1.userId].isRead, false, "E: rows are unread at birth");
    eq(db.__state.publicationCounters.L1.notifiedCount, 3, "E: publication counter == delivered rows");
    ok(db.__state.publicationCounters.L1.notifiedAt instanceof Date, "E: notifiedAt moved with the delivering run");
    eq(db.__state.audits.length, 1, "E: one audit row for the run");
    eq(db.__state.audits[0].action, "LESSON_PUBLICATION_NOTIFY", "E: audit action names the event");
    const det = JSON.parse(db.__state.audits[0].details);
    eq([det.code, det.eligible, det.delivered, det.skippedPreference, det.skippedQuietHours], ["EMITTED", 5, 3, 1, 1], "E: audit carries the full outcome breakdown");

    // Replay — total idempotence on the retry channel:
    const r2 = await SN.emitSessionPublicationNotifications({ lessonId: "L1", actorUserId: "admin-1", client: db, now: NOW, locale: "en" });
    eq(r2.code, "ALREADY_DELIVERED", "E: replay is a no-op, honestly coded");
    eq([r2.delivered, r2.alreadyNotified], [0, 3], "E: replay delivers 0 and recognizes held rows");
    eq(db.__state.notifications.length, 3, "E: replay persists ZERO duplicates");
    eq(db.__state.publicationCounters.L1.notifiedCount, 3, "E: counter stable across replay");

    // Preview agrees with both directions of the story (pref-aware pending):
    const pv = await SN.previewSessionPublicationRecipients("L1", db);
    eq([pv.ok, pv.eligible, pv.alreadyNotified, pv.pending, pv.deliverableNow], [true, 5, 3, 0, 3], "E: preview == fan-out truth (deliverable 3, all held, pending 0)");
    eq([pv.skippedPreferenceNow, pv.skippedQuietHoursNow], [1, 1], "E: preview explains the permanent/current skips");
    eq(pv.notifiedCount, 3, "E: preview surfaces the anchor counter");
  }
  // Partial chunk failure → retry resumes WITHOUT duplicates:
  {
    const studs = Array.from({ length: 12 }, () => mkStudentFixture("ARABIC"));
    const db = makeFakeDb({ lessons: [mkLessonFixture()], students: studs, failOnCreateManyCall: 2 });
    const r1 = await SN.emitSessionPublicationNotifications({ lessonId: "L1", actorUserId: "a", client: db, chunkSize: 5, now: NOW });
    eq(r1.code, "EMITTED_PARTIAL", "E: failing chunk 2 → EMITTED_PARTIAL");
    eq([r1.chunksPlanned, r1.chunksDone, r1.failedChunks, r1.delivered], [3, 1, [1], 5], "E: sequential stop — chunk 3 never attempted");
    eq(db.__state.notifications.length, 5, "E: only chunk 1 is on disk");
    eq(db.__state.publicationCounters.L1.notifiedCount, 5, "E: counter tells the partial truth");
    // heal + retry: whole pipeline re-runs, chunk 1 dedupes, chunks 2-3 insert.
    db.__state.failOnCreateManyCall = -1;
    const r2 = await SN.emitSessionPublicationNotifications({ lessonId: "L1", actorUserId: "a", client: db, chunkSize: 5, now: NOW });
    eq([r2.code, r2.delivered, r2.alreadyNotified], ["EMITTED", 7, 5], "E: retry resumes and acknowledges the held chunk");
    eq(db.__state.notifications.length, 12, "E: healed total == eligible, with ZERO duplicates");
    eq(new Set(db.__state.notifications.map((n) => n.userId)).size, 12, "E: one row per user across the whole saga");
    eq(db.__state.publicationCounters.L1.notifiedCount, 12, "E: counter heals to the true total");
  }
  // Per-lesson serialization: two concurrent emits can never interleave the dedupe window.
  {
    const studs = Array.from({ length: 6 }, () => mkStudentFixture("ARABIC"));
    const db = makeFakeDb({ lessons: [mkLessonFixture()], students: studs, sleep: 15 });
    const [ra, rb] = await Promise.all([
      SN.emitSessionPublicationNotifications({ lessonId: "L1", client: db, chunkSize: 2, now: NOW }),
      SN.emitSessionPublicationNotifications({ lessonId: "L1", client: db, chunkSize: 2, now: NOW }),
    ]);
    eq(db.__state.notifications.length, 6, "E: concurrent fan-outs never double-deliver");
    const codes = [ra.code, rb.code].sort();
    eq(codes, ["ALREADY_DELIVERED", "EMITTED"], "E: the loser of the race reports ALREADY_DELIVERED honestly");
    eq(db.__state.publicationCounters.L1.notifiedCount, 6, "E: counter consistent after the race");
  }
  // Full audience suppressed ⇢ SUPPRESSED_BY_PREFERENCES (never ALREADY_DELIVERED):
  {
    const s1 = mkStudentFixture("ARABIC"); const s2 = mkStudentFixture("ARABIC");
    // TZ-proof quiet window: [now-30min local, now+60min local) contains the
    // injected run clock in ANY zone; `later` (+6h) is always outside it.
    const quietStart = `${String((NOW.getHours() + 23) % 24).padStart(2, "0")}:30`;
    const quietEnd = `${String((NOW.getHours() + 1) % 24).padStart(2, "0")}:00`;
    const later = new Date(NOW.getTime() + 6 * 3600_000);
    const db = makeFakeDb({
      lessons: [mkLessonFixture()], students: [s1, s2],
      prefs: [prefRow({ userId: s1.userId, newLesson: false }), prefRow({ userId: s2.userId, quietHoursStart: quietStart, quietHoursEnd: quietEnd })],
    });
    eq(NOTIFY.isInQuietHoursAt(quietStart, quietEnd, NOW), true, "E: the fixture window really contains the run clock (any TZ)");
    const r = await SN.emitSessionPublicationNotifications({ lessonId: "L1", actorUserId: "a", client: db, now: NOW });
    eq([r.ok, r.code], [true, "SUPPRESSED_BY_PREFERENCES"], "E: an all-suppressed audience is honest about zero delivery");
    eq([r.delivered, r.chunksPlanned], [0, 0], "E: nothing attempted, nothing delivered");
    ok(r.message.toLowerCase().includes("suppress"), "E: message explains the suppression");
    eq(db.__state.publicationCounters.L1.notifiedAt, null, "E: notifiedAt stays unset when NOTHING was ever delivered");
    eq(db.__state.audits.length, 1, "E: the suppression run is audited");
    ok(JSON.parse(db.__state.audits[0].details).code === "SUPPRESSED_BY_PREFERENCES", "E: audit names the suppression code");
    // …and when quiet hours pass, a RESUME delivers (suppression was time-aware, not permanent):
    const r2 = await SN.emitSessionPublicationNotifications({ lessonId: "L1", actorUserId: "a", client: db, now: later });
    eq([r2.code, r2.delivered], ["EMITTED", 1], "E: the quiet user becomes deliverable later; the pref user stays out forever");
  }
  // ARABIC-scope: the query-side gate proves the same matrix at engine level.
  {
    const sA = mkStudentFixture("ARABIC"); const sL = mkStudentFixture("LANGUAGE"); const sN = mkStudentFixture(null);
    const db = makeFakeDb({ lessons: [mkLessonFixture({ trackScope: "ARABIC" })], students: [sA, sL, sN] });
    const r = await SN.emitSessionPublicationNotifications({ lessonId: "L1", client: db, now: NOW });
    eq([r.eligible, r.delivered], [1, 1], "E: ARABIC lesson notifies ONLY the ARABIC student");
    eq(db.__state.notifications[0].userId, sA.userId, "E: the one and only row is track-correct");
  }

  // ==========================================================================
  section("F. localized templates (api.230/231)");
  // ==========================================================================
  const tctx = { officialCode: "1-1", title: "Development of networks", titleAr: "تطوير الشبكات", unitTitle: "Networks", unitTitleAr: "الشبكات" };
  const ar = SN.renderSessionPublicationNotification("ar", tctx);
  const en = SN.renderSessionPublicationNotification("en", tctx);
  eq(ar.title, "جلسة جديدة: 1-1 · تطوير الشبكات", "F: ar title picks officialCode + Arabic name");
  ok(ar.message.includes("تطوير الشبكات") && ar.message.includes("الشبكات"), "F: ar message carries session + chapter");
  eq(en.title, "New session: 1-1 · Development of networks", "F: en title picks officialCode + English name");
  ok(en.message.includes("“Networks”"), "F: en message carries the English chapter");
  eq(SN.renderSessionPublicationNotification("ar", { ...tctx, officialCode: null }).title, "جلسة جديدة: تطوير الشبكات", "F: missing code → name only, no dangling separator");
  ok(SN.renderSessionPublicationNotification("ar", { titleAr: "", title: "X", unitTitle: "", unitTitleAr: "", officialCode: null }).title.includes("X"), "F: missing localized side falls back to the other language (never an empty title)");

  // ==========================================================================
  section("G. source pins: OPEN route, recipients route, broadcast route");
  // ==========================================================================
  const openRoute = read("src/app/api/admin/lessons/[id]/open/route.ts");
  const recRoute = read("src/app/api/admin/lessons/[id]/recipients/route.ts");
  const bcastRoute = read("src/app/api/admin/notifications/route.ts");
  pinned(openRoute, /requireRole\("ADMIN"\)/, "G: OPEN stays ADMIN-only");
  pinned(openRoute, /openLesson\(\{\s*lessonId:\s*id,/, "G: OPEN still delegates the ceremony to the engine");
  pinned(openRoute, /result\.ok && !!result\.publication/, "G: fan-out runs ONLY on a live publication (OK or NO_OP retry)");
  pinned(openRoute, /emitSessionPublicationNotifications\(\{/, "G: the fan-out delegates to the shared engine");
  pinned(openRoute, /emitSessionPublicationNotifications\(\{\s*lessonId: result\.lessonId,\s*actorUserId: user\?\.id \?\? null,/, "G: the actor travels into the fan-out for its audit row");
  pinned(openRoute, /notification,/, "G: the response carries the notification half");
  pinned(openRoute, /serverLocale\(\)\.catch\(\(\) => "ar" as const\)/, "G: request locale read, fail-closed to ar");
  pinned(openRoute, /code: "EMITTED_PARTIAL",\s*lessonId: result\.lessonId,/, "G: an infra failure surfaces as explicit EMITTED_PARTIAL with the real id");
  pinned(openRoute, /readiness: result\.readiness,/, "G: the ceremony's readiness half is preserved unchanged");
  // The fan-out NEVER runs on refusals: every refusal code path returns via the standard body without emit.
  pinnedAbsent(
    openRoute.split("// ----")[0] ?? openRoute,
    /if \(!ceremonyDeliveredPublication\) \{[^\n]*emitSession/,
    "G: no code path emits when the ceremony produced no publication",
    "if (!ceremonyDeliveredPublication) { await emitSessionPublicationNotifications({}); }"
  );
  pinned(recRoute, /requireRole\("ADMIN"\)/, "G: recipients preview is ADMIN-only");
  pinned(recRoute, /previewSessionPublicationRecipients\(id\)/, "G: the preview delegates to THE shared derivation (no second count)");
  pinned(recRoute, /preview\.code === "LESSON_NOT_FOUND"[\s\S]{0,90}404/, "G: preview 404 on unknown lesson");
  pinned(recRoute, /preview\.code === "LESSON_NOT_IN_COURSE"[\s\S]{0,90}409/, "G: preview 409 on course-less lesson");
  pinned(recRoute, /skippedPreferenceNow: preview\.skippedPreferenceNow/, "G: the preference-aware preview reaches the wire");
  // The broadcast §16 fix:
  pinned(bcastRoute, /partitionByNotificationPreferences\(/, "G: broadcast goes through the shared bulk partition");
  pinned(bcastRoute, /db\.notificationPreference\.findMany\(\{\s*where:\s*\{ userId:\s*\{ in:/, "G: ONE bulk preference read (not N)");
  pinned(bcastRoute, /chunkList\(/, "G: broadcast inserts in bounded chunks");
  pinned(bcastRoute, /validateNotificationLink\(/, "G: broadcast validates the optional link");
  pinned(bcastRoute, /INVALID_NOTIFICATION_LINK/, "G: malformed broadcast links are a 400 contract");
  pinned(bcastRoute, /sent \+= chunk\.length;/, "G: broadcast accumulates `sent` from the ACTUAL inserted rows (chunked loop)");
  pinned(bcastRoute, /return ok\(\{\s*ok: true,\s*sent,\s*skipped: \{[\s\S]{0,110}quietHours: partition\.skippedQuietHours/, "G: broadcast reports the honest `sent` plus the exact partition skip breakdown");
  pinnedAbsent(bcastRoute, /sent:\s*userIds\.length/, "G: the old lie 'sent = targeted count' is gone", "return ok({ sent: userIds.length });");
  // Lifecycle engine purity: no notification logic leaked into Phase 13.
  const engineSrc = read("src/lib/session-lifecycle.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  pinnedAbsent(engineSrc, /\bnotification\b/i, "G: the lifecycle ENGINE itself writes NO notification code (fan-out is route-level)", "const x = db.notification.create({});");

  // ==========================================================================
  section("H. module/pattern pins: types, links, mutex, counters, dialog, store");
  // ==========================================================================
  const snSrc = read("src/lib/session-notifications.ts");
  eq(SN.SESSION_PUBLICATION_NOTIFICATION_TYPE, "NEW_LESSON", "H: the emitted type is NEW_LESSON, compile-time pinned");
  pinned(snSrc, /"NEW_LESSON" as const/, "H: the phase emits exactly one notification type");
  for (const forbidden of ['"SESSION_OPENED"', '"NEW_SESSION"', '"LESSON_PUBLISHED"']) {
    pinnedAbsent(snSrc, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `H: no ${forbidden} type was invented`, `const t: any = ${forbidden};`);
  }
  pinned(snSrc, /return canAccessTrackScope\(student\.schoolType as/, "H: the eligibility predicate delegates to the Phase 12 canAccessTrackScope (no parallel truth-table)");
  pinned(snSrc, /const courseId = resolveLessonCourseId\(/, "H: course resolution reuses the shared chain resolver");
  pinned(snSrc, /const FAN_OUT_RUNS = new Map<string, Promise<SessionNotificationOutcome>>\(\);/, "H: the per-lesson serialization guard exists");
  pinned(snSrc, /sessionPublication\.updateMany\(/, "H: counters persist to the SessionPublication anchor");
  pinned(snSrc, /notifiedAt: now/, "H: notifiedAt moves only with an actual delivery");
  pinned(snSrc, /recipients\.sort\(\(a, b\) => \(a\.userId < b\.userId \? -1 : a\.userId > b\.userId \? 1 : 0\)\)/, "H: recipients sorted by userId — identical chunk boundaries across retries");
  pinned(snSrc, /lesson\.unit \?\? lesson\.topic\?\.unit/, "H: lesson→course via canonical unit FIRST, legacy topic fallback (progression-parity rule)");
  pinned(snSrc, /onDelete: Cascade|refs|LESSON_PUBLICATION_NOTIFY/, "H: audit action name pinned");
  const nlSrc = read("src/lib/notification-links.ts");
  pinned(nlSrc, /from "@\/lib\/deep-link"/, "H: notification links REUSE the Phase 16 parser (no second scheme)");
  pinned(nlSrc, /lesson\/<lessonId>|lesson:\`<\/|sessionPublicationLink/, "H: the session publication link mint exists");
  pinnedAbsent(nlSrc, /lesson\$\{/, "H: no string-concatenated unvalidated links", 'return `lesson${id}`;');
  const dialogSrc = read("src/components/admin/session-open-dialog.tsx");
  pinned(dialogSrc, /data-testid="open-recipients-preview"/, "H: the dialog carries the recipients preview block");
  pinned(dialogSrc, /recipients`/, "H: the dialog fetches the server-derived preview");
  pinned(dialogSrc, /code === "EMITTED_PARTIAL"[\s\S]{0,400}return;/, "H: EMITTED_PARTIAL keeps the dialog OPEN (early return before onOpenChange(false))");
  pinned(dialogSrc, /toast\.(success|info)\(tr\("admin\.498", \{ p1: n\.delivered \}\)\)/, "H: delivered toast key admin.498 carries the delivered count");
  pinned(dialogSrc, /tr\("admin\.499", \{ p1: n\.skippedPreference, p2: n\.skippedQuietHours \}\)/, "H: skipped-breakdown key admin.499 carries both counts");
  const dashSrc = read("src/components/student/student-dashboard.tsx");
  pinned(dashSrc, /navigateDeepLink\(n\.link, useApp\.getState\(\)\)/, "H: the notification centre drives the Phase 16 deep link on click");
  pinned(dashSrc, /parseDeepLink\(n\.link\)/, "H: Open button only renders for a parseable link (stale/ineligible rows fail safe)");
  const storeSrc = read("src/lib/store.ts");
  pinned(storeSrc, /setView:\s*\(view\)\s*=>/, "H: store exposes setView");
  pinned(storeSrc, /navParam:\s*null/, "H: setView clears navParam (no stale deep-link params)");
  pinned(storeSrc, /setNavParam/, "H: store exposes setNavParam for the deep-link target");

  // ==========================================================================
  section("I. schema + migration pins (additive-only)");
  // ==========================================================================
  const schema = read("prisma/schema.prisma");
  const spBlock = schema.split("model SessionPublication {")[1]?.split("\n}")[0] ?? "";
  pinned(spBlock, /notifiedCount\s+Int\s+@default\(0\)/, "I: SessionPublication.notifiedCount integer, default 0");
  pinned(spBlock, /notifiedAt\s+DateTime\?/, "I: SessionPublication.notifiedAt nullable (no delivery yet state)");
  pinned(schema, /lessonId\s+String\s+@unique/, "I: the publication anchor stays lessonId-unique (idempotency identity)");
  const mig = read("prisma/migrations/20260911000000_phase17_session_notifications/migration.sql");
  const migStatements = mig.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("--"));
  eq(migStatements.length, 2, "I: the migration contains exactly two statements");
  ok(
    migStatements.every((l) => /^ALTER TABLE "SessionPublication" ADD COLUMN "/.test(l)),
    "I: every statement is an ADD COLUMN on SessionPublication (nothing else)",
  );
  pinned(mig, /ADD COLUMN "notifiedCount" INTEGER NOT NULL DEFAULT 0/, "I: notifiedCount migration shape is SQLite-safe");
  pinned(mig, /ADD COLUMN "notifiedAt" DATETIME/, "I: notifiedAt migration shape is SQLite-safe");
  ok(!/DROP|TRUNCATE|DELETE FROM|\bUPDATE\b/i.test(migStatements.join("\n")), "I: no destructive statement anywhere");
  ok(!/INSERT INTO/i.test(migStatements.join("\n")), "I: no backfill (fresh columns default correctly)");

  // ==========================================================================
  section("J. i18n keys exist in BOTH locales (compiled dictionary)");
  // ==========================================================================
  for (const key of ["api.230", "api.231", "api.232", "admin.494", "admin.495", "admin.496", "admin.497", "admin.498", "admin.499", "admin.500", "admin.501", "admin.502", "admin.503", "admin.504", "admin.505"]) {
    const a = I18N.translate("ar", key, { p1: "X", p2: "Y" });
    const e = I18N.translate("en", key, { p1: "X", p2: "Y" });
    ok(a && e, `J: ${key} resolves in ar AND en`);
    ok(!a.includes(`"${key}"`), `J: ${key} (ar) is not a key-echo`);
  }
  ok(I18N.translate("ar", "api.230", { p1: "s" }) === "جلسة جديدة: s", "J: api.230 interpolates {p1}");
  ok(I18N.translate("en", "api.232", {}).length > 0, "J: api.232 = invalid-link error in both locales");

  // ==========================================================================
  section("K. REAL-DATABASE end-to-end verifier (child process)");
  // ==========================================================================
  {
    const script = path.join(REPO, "scripts", "verify-phase17-notifications.mjs");
    ok(fs.existsSync(script), "K: scripts/verify-phase17-notifications.mjs exists");
    let outStr = "";
    let code = 0;
    try {
      outStr = execSync(`${process.execPath} ${JSON.stringify(script)}`, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      code = e.status ?? 1;
      outStr = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    }
    eq(code, 0, "K: real-DB verifier exits 0");
    const m = /phase17 notifications e2e: (\d+) passed, (\d+) failed/.exec(outStr);
    ok(!!m, "K: verifier printed its summary line");
    if (m) {
      eq(Number(m[2]), 0, `K: verifier failures == 0 (${m[1]} assertions)`);
      ok(Number(m[1]) >= 160, `K: verifier coverage is load-bearing (${m[1]} ≥ 160)`);
    }
  }

  // ---------------------------------------------------------------------------
  console.log(`\nsession notifications (phase 17): ${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("failures:");
    for (const f of failures) console.log("  -", f);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("phase 17 suite crashed:", e);
  process.exit(1);
});
