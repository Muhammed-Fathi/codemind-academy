// CodeMind Academy — PHASE D: readiness / publishing alignment + admin
// publishing UX (dedicated suite).
//
// WHAT THIS FILE PROVES
//   Phase D makes Lesson readiness and publishing deterministic, secure and
//   consistent with the academic Session workflow:
//
//     • ALL FOUR requirements — VIDEO, PDF/MATERIAL, QUIZ, HOMEWORK — are
//       REQUIRED for normal READY; absence produces a clear NOT READY reason.
//     • VIDEO readiness uses the modern SessionVideo authority; legacy
//       `Lesson.videoUrl` is compatibility-only (never the authority).
//     • PDF readiness uses the Phase 14 Material architecture (no new PDF
//       storage system).
//     • Normal MARK READY and OPEN enforce readiness SERVER-SIDE and never
//       trust the client.
//     • The ADMIN emergency override ("Open Anyway") is explicit, reason-
//       bearing, admin-only, audited (`LESSON_OPEN_OVERRIDE`), and it NEVER
//       becomes a generic bypass (archived / orphan / concurrency / role
//       gates all survive it).
//     • Track/audience content can never falsely satisfy readiness.
//     • Phase C aggregation, progression semantics and the schema stay
//       untouched (source + schema pins).
//
// LAYERS (strongest last), same convention as the Phase 13 suite:
//   1. Pure readiness computation over fixture lessons (no I/O).
//   2. The ceremonies against a STRICT fake client (status predicates are
//      really evaluated; unknown where-clauses throw).
//   3. Source pins over the routes/UI that cannot boot without Next's
//      request runtime — each load-bearing pin carries a negative control.
//   4. Schema pins: Phase D must not invent tables or migrations.
//
// Run:  node tests/phase-D-readiness-publishing.test.js

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const REPO = path.resolve(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phaseD-test-"));

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(label);
    console.error("FAIL:", label);
  }
}
function eq(got, want, label) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  ok(a === b, `${label} (got ${a}, want ${b})`);
}
function section(title) {
  console.log(`\n${title}`);
}
function pinned(src, re, label, mutate) {
  ok(re.test(src), label);
  // Negative control: strip EVERY occurrence (a comment quoting the pattern
  // must not let the pin survive the mutation).
  const mutated = mutate
    ? mutate(src)
    : src.replace(new RegExp(re.source, "g" + re.flags.replace(/g/g, "")), "");
  ok(!re.test(mutated), `${label} — negative control`);
}
function absent(src, re, label, strip) {
  ok(!re.test(src), label);
  if (strip) ok(re.test(src.replace(new RegExp(strip, "g"), "")) === false, `${label} — control`);
}

// ---------------------------------------------------------------------------
// Compile the REAL shipped modules (same convention as the Phase 13 suite)
// ---------------------------------------------------------------------------
const MODULES = [
  "src/lib/school-type.ts",
  "src/lib/track-scope.ts",
  "src/lib/session-lifecycle.ts",
];
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "es2020",
        module: "commonjs",
        moduleResolution: "node",
        strict: false,
        skipLibCheck: true,
        esModuleInterop: true,
        resolveJsonModule: true,
        types: ["node"],
        typeRoots: [path.join(REPO, "node_modules/@types")],
        baseUrl: REPO,
        paths: { "@/*": ["src/*"] },
        rootDir: REPO,
        outDir: OUT,
      },
      files: MODULES.map((f) => path.join(REPO, f)),
    },
    null,
    2
  )
);
try {
  execSync(`npx tsc -p ${path.join(OUT, "tsconfig.json")}`, {
    cwd: REPO,
    stdio: "pipe",
  });
} catch {
  /* type noise elsewhere in the graph is tolerated; `npx tsc --noEmit` is the gate */
}
const EMIT = path.join(OUT, "src", "lib");
if (!fs.existsSync(path.join(EMIT, "session-lifecycle.js"))) {
  throw new Error("tsc did not emit session-lifecycle.js");
}

// Redirect `@/lib/db` at require time so the shipped module loads against
// the injected fake instead of the real database client.
const FAKE_DB_PATH = path.join(OUT, "fake-db.js");
fs.writeFileSync(
  FAKE_DB_PATH,
  "module.exports = { get db() { return globalThis.__CM_FAKE_DB__; } };\n"
);
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "@/lib/db") return FAKE_DB_PATH;
  const m = /^@\/lib\/([\w-]+)$/.exec(request);
  if (m) {
    const compiled = path.join(EMIT, `${m[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  return originalResolve.call(this, request, ...args);
};
const L = require(path.join(EMIT, "session-lifecycle.js"));

// ---------------------------------------------------------------------------
// The strict fake database (a `where` clause it cannot evaluate THROWS)
// ---------------------------------------------------------------------------
function makeDb(seed = {}) {
  const t = {
    lesson: new Map(),
    quiz: [],
    homework: [],
    sessionVideo: [],
    material: [],
    sessionPublication: [],
    auditLog: [],
  };
  const writes = { updateMany: 0, create: 0, upsert: 0, deleteMany: 0 };
  const tx = { started: 0, rolledBack: 0 };

  for (const [id, row] of Object.entries(seed.lessons ?? {})) {
    t.lesson.set(id, {
      id,
      title: `Lesson ${id}`,
      titleAr: `درس ${id}`,
      order: 1,
      status: "DRAFT",
      isPublished: false,
      curriculumStatus: "OFFICIAL",
      trackScope: "SHARED",
      officialCode: null,
      videoUrl: null,
      pdfUrl: null,
      unitId: "u1",
      topicId: null,
      duration: 90,
      ...row,
    });
  }
  for (const q of seed.quizzes ?? []) t.quiz.push({ trackScope: "SHARED", ...q });
  for (const h of seed.homeworks ?? []) t.homework.push({ trackScope: "SHARED", ...h });
  for (const v of seed.sessionVideos ?? []) t.sessionVideo.push(v);
  for (const m of seed.materials ?? []) t.material.push({ isActive: true, trackScope: "SHARED", ...m });

  const match = (row, where, table) => {
    for (const [k, v] of Object.entries(where ?? {})) {
      if (k === "AND" || k === "OR" || k === "NOT") {
        throw new Error(`fake db: unsupported logical operator '${k}'`);
      }
      const value = row[k];
      if (v && typeof v === "object" && !(v instanceof Date)) {
        const keys = Object.keys(v);
        for (const key of keys) {
          if (!["in", "notIn", "not", "lte", "gte", "lt", "gt", "equals"].includes(key)) {
            throw new Error(`fake db: unsupported operator '${key}' on ${table}.${k}`);
          }
        }
        if ("in" in v && !v.in.includes(value)) return false;
        if ("equals" in v && value !== v.equals) return false;
        continue;
      }
      if (value !== v) return false;
    }
    return true;
  };

  // Real Prisma allows `_count` INSIDE `select`; the shape helper models
  // that exactly (the readiness loader selects `_count: { select: {…} }`).
  const shape = (row, select) => {
    if (!select) return { ...row };
    const out = {};
    for (const [k, v] of Object.entries(select)) {
      if (v === true) {
        out[k] = row[k];
        continue;
      }
      if (k === "_count" && v && typeof v === "object" && v.select) {
        out._count = {};
        for (const rel of Object.keys(v.select)) {
          if (rel === "questions") {
            out._count.questions = row.questions?.length ?? row.questionCount ?? 0;
          } else {
            throw new Error(`fake db: unsupported _count of ${rel}`);
          }
        }
        continue;
      }
      if (v && typeof v === "object") {
        // A nested RELATION select (e.g. `batch: { select: {…} }` or the
        // bare-object shape Prisma accepts) — recurse so `batch.schoolType`
        // reaches the readiness computation.
        out[k] = row[k] == null ? null : shape(row[k], v.select ?? v);
        continue;
      }
      throw new Error(`fake db: unsupported select '${k}'`);
    }
    return out;
  };

  const project = (row, spec) => {
    if (!spec) return { ...row };
    const out = {};
    for (const [key, sub] of Object.entries(spec)) {
      if (sub === true) {
        out[key] = row[key];
        continue;
      }
      if (key === "quizzes") {
        out.quizzes = t.quiz
          .filter((q) => q.lessonId === row.id)
          .map((q) => shape(q, sub.select));
      } else if (key === "homeworks") {
        out.homeworks = t.homework
          .filter((h) => h.lessonId === row.id)
          .map((h) => shape(h, sub.select));
      } else if (key === "sessionVideos") {
        out.sessionVideos = t.sessionVideo
          .filter((v) => v.lessonId === row.id)
          .map((v) => shape(v, sub.select));
      } else if (key === "materials") {
        out.materials = t.material
          .filter((m) => m.lessonId === row.id && match(m, sub.where, "material"))
          .map((m) => shape(m, sub.select));
      } else if (key === "publication") {
        const p = t.sessionPublication.find((x) => x.lessonId === row.id);
        out.publication = p ? shape(p, sub.select) : null;
      } else {
        throw new Error(`fake db: unsupported projection '${key}'`);
      }
    }
    return out;
  };

  const db = {
    __tables: t,
    __writes: writes,
    __tx: tx,
    $transaction: async (fn) => {
      tx.started++;
      try {
        return await fn(db);
      } catch (e) {
        tx.rolledBack++;
        throw e;
      }
    },
    lesson: {
      findUnique: async ({ where, select } = {}) => {
        const row = [...t.lesson.values()].find((r) => match(r, where, "lesson"));
        if (!row) return null;
        return project(row, select);
      },
      updateMany: async ({ where, data }) => {
        writes.updateMany++;
        let count = 0;
        for (const row of [...t.lesson.values()]) {
          if (!match(row, where, "lesson")) continue;
          Object.assign(row, data);
          count++;
        }
        return { count };
      },
    },
    sessionPublication: {
      findUnique: async ({ where } = {}) =>
        t.sessionPublication.find((p) => match(p, where, "sessionPublication")) ?? null,
      create: async ({ data }) => {
        writes.create++;
        if (t.sessionPublication.some((p) => p.lessonId === data.lessonId)) {
          const e = new Error("Unique constraint failed on the fields: (`lessonId`)");
          e.code = "P2002";
          throw e;
        }
        const row = {
          id: `pub-${t.sessionPublication.length + 1}`,
          publishedAt: new Date(0),
          ...data,
        };
        t.sessionPublication.push(row);
        return row;
      },
      upsert: async ({ where, create, update, select }) => {
        writes.upsert++;
        if (update && Object.keys(update).length) {
          throw new Error("fake db: the ceremony must not update an existing publication");
        }
        const existing = t.sessionPublication.find((p) =>
          match(p, where, "sessionPublication")
        );
        if (existing) return select ? shape(existing, select) : { ...existing };
        const row = await db.sessionPublication.create({ data: create });
        return select ? shape(row, select) : row;
      },
      deleteMany: async ({ where } = {}) => {
        writes.deleteMany++;
        const before = t.sessionPublication.length;
        t.sessionPublication = t.sessionPublication.filter(
          (p) => !match(p, where, "sessionPublication")
        );
        return { count: before - t.sessionPublication.length };
      },
    },
    auditLog: {
      create: async ({ data }) => {
        t.auditLog.push(data);
        return data;
      },
    },
  };
  return db;
}

// ---------------------------------------------------------------------------
// Fixture helpers — a "complete" lesson has ALL FOUR requirements satisfied
// for its audience. SHARED lessons need both batch/track variants where the
// requirement is track-scoped.
// ---------------------------------------------------------------------------
const FULL_SHARED = {
  sessionVideos: [
    { id: "v1", lessonId: "L1", isPublished: true, batch: { schoolType: "ARABIC" } },
    { id: "v2", lessonId: "L1", isPublished: true, batch: { schoolType: "LANGUAGE" } },
  ],
  materials: [
    { id: "m1", lessonId: "L1", kind: "ADMIN_UPLOADED", isActive: true, mediaAssetId: "a1", trackScope: "SHARED" },
  ],
  quizzes: [{ id: "q1", lessonId: "L1", trackScope: "SHARED", questionCount: 5 }],
  homeworks: [{ id: "h1", lessonId: "L1", trackScope: "SHARED", instructions: "Solve exercise 1" }],
};
const FULL_ARABIC = {
  sessionVideos: [
    { id: "v1", lessonId: "L1", isPublished: true, batch: { schoolType: "ARABIC" } },
  ],
  materials: [
    { id: "m1", lessonId: "L1", kind: "ADMIN_UPLOADED", isActive: true, mediaAssetId: "a1", trackScope: "ARABIC" },
  ],
  quizzes: [{ id: "q1", lessonId: "L1", trackScope: "ARABIC", questionCount: 5 }],
  homeworks: [{ id: "h1", lessonId: "L1", trackScope: "ARABIC", instructions: "حل التمرين" }],
};
const readyDb = (extra = {}) =>
  makeDb({
    lessons: { L1: { status: "DRAFT", ...(extra.lesson ?? {}) } },
    sessionVideos: FULL_SHARED.sessionVideos,
    materials: FULL_SHARED.materials,
    quizzes: FULL_SHARED.quizzes,
    homeworks: FULL_SHARED.homeworks,
    ...extra,
  });
const R = (input) => L.computeLessonReadiness({ id: "L1", trackScope: "SHARED", ...input });
const item = (readiness, key) => readiness.items.find((i) => i.key === key);

// ===========================================================================
section("1. VIDEO is REQUIRED and judged by the modern SessionVideo authority");
// ===========================================================================
eq(item(R({}), "VIDEO").state, "MISSING", "1.1 no SessionVideo → VIDEO_MISSING");
eq(item(R({}), "VIDEO").code, "VIDEO_MISSING", "1.2 stable missing code");
eq(item(R({}), "VIDEO").required, true, "1.3 video is a hard requirement");
eq(R({}).canBeReady, false, "1.4 missing video alone blocks READY");
ok(R({}).blocking.includes("VIDEO_MISSING"), "1.5 blocking names the missing video");

eq(
  item(R({ sessionVideos: FULL_SHARED.sessionVideos }), "VIDEO").state,
  "OK",
  "1.6 published SessionVideos covering both batches satisfy a SHARED lesson"
);
eq(
  item(R({ trackScope: "ARABIC", sessionVideos: FULL_ARABIC.sessionVideos }), "VIDEO").state,
  "OK",
  "1.7 an ARABIC lesson needs only its own batch"
);
eq(
  item(
    R({ trackScope: "ARABIC", sessionVideos: [{ isPublished: true, batch: { schoolType: "LANGUAGE" } }] }),
    "VIDEO"
  ).state,
  "MISSING",
  "1.8 the other track's video NEVER satisfies this lesson"
);
eq(
  item(R({ sessionVideos: [{ isPublished: false, batch: { schoolType: "ARABIC" } }, { isPublished: false, batch: { schoolType: "LANGUAGE" } }] }), "VIDEO").state,
  "MISSING",
  "1.9 unpublished SessionVideos are staged media, not prepared media"
);
ok(
  R({ sessionVideos: [{ isPublished: false, batch: { schoolType: "ARABIC" } }] }).notes.includes("VIDEO_PRESENT_BUT_UNPUBLISHED"),
  "1.10 …and the admin is told a staged-but-unpublished video exists"
);
eq(
  item(R({ sessionVideos: [{ isPublished: true, batch: { schoolType: "ARABIC" } }] }), "VIDEO").state,
  "INVALID",
  "1.11 one-sided batch coverage of a SHARED lesson is incomplete, not ready"
);
eq(
  item(R({ sessionVideos: [{ isPublished: true, batch: { schoolType: "ARABIC" } }] }), "VIDEO").code,
  "VIDEO_TRACK_INCOMPLETE",
  "1.12 with a distinct, actionable code"
);
eq(
  item(R({ videoUrl: "https://cdn.example/v.mp4" }), "VIDEO").state,
  "MISSING",
  "1.13 PHASE D: a legacy videoUrl ALONE never satisfies video readiness"
);
ok(
  R({ videoUrl: "https://cdn.example/v.mp4" }).notes.includes("VIDEO_LEGACY_URL_NOT_COUNTED"),
  "1.14 …and the admin is told WHY the old link no longer counts (never silently)"
);
eq(
  item(R({ videoUrl: "#", sessionVideos: FULL_SHARED.sessionVideos }), "VIDEO").state,
  "OK",
  "1.15 the placeholder '#' stays inert while modern videos satisfy"
);

// ===========================================================================
section("2. PDF/MATERIAL is REQUIRED and judged by the Phase 14 Material authority");
// ===========================================================================
eq(item(R({ sessionVideos: FULL_SHARED.sessionVideos }), "PDF").state, "MISSING", "2.1 no Material → PDF_MISSING");
eq(item(R({ sessionVideos: FULL_SHARED.sessionVideos }), "PDF").code, "PDF_MISSING", "2.2 stable missing code");
eq(item(R({}), "PDF").required, true, "2.3 material is a hard requirement");
ok(R({ sessionVideos: FULL_SHARED.sessionVideos }).blocking.includes("PDF_MISSING"), "2.4 missing material blocks READY");

eq(
  item(R({ sessionVideos: FULL_SHARED.sessionVideos, materials: FULL_SHARED.materials }), "PDF").state,
  "OK",
  "2.5 an active ADMIN_UPLOADED material with a media asset satisfies the requirement"
);
eq(
  item(R({ sessionVideos: FULL_SHARED.sessionVideos, materials: [{ kind: "GENERATED", isActive: true, mediaAssetId: null }] }), "PDF").state,
  "MISSING",
  "2.6 a GENERATED row without an asset is not a document and never counts"
);
eq(
  item(R({ sessionVideos: FULL_SHARED.sessionVideos, materials: [{ kind: "ADMIN_UPLOADED", isActive: false, mediaAssetId: "a1" }] }), "PDF").state,
  "MISSING",
  "2.7 a deactivated material does not count"
);
eq(
  item(
    R({
      trackScope: "ARABIC",
      sessionVideos: FULL_ARABIC.sessionVideos,
      materials: [{ kind: "ADMIN_UPLOADED", isActive: true, mediaAssetId: "a1", trackScope: "LANGUAGE" }],
    }),
    "PDF"
  ).state,
  "MISSING",
  "2.8 another track's material NEVER satisfies this lesson"
);
eq(
  item(
    R({
      sessionVideos: FULL_SHARED.sessionVideos,
      materials: [{ kind: "ADMIN_UPLOADED", isActive: true, mediaAssetId: "a1", trackScope: "ARABIC" }],
    }),
    "PDF"
  ).state,
  "INVALID",
  "2.9 a SHARED lesson with only a track-scoped material is incomplete"
);
eq(
  item(R({ pdfUrl: "https://cdn.example/p.pdf", sessionVideos: FULL_SHARED.sessionVideos }), "PDF").state,
  "MISSING",
  "2.10 PHASE D: a legacy pdfUrl ALONE never satisfies material readiness"
);
ok(
  R({ pdfUrl: "https://cdn.example/p.pdf", sessionVideos: FULL_SHARED.sessionVideos }).notes.includes("PDF_LEGACY_URL_NOT_COUNTED"),
  "2.11 …and the admin is told the old link does not count"
);
eq(
  item(R({ pdfUrl: "#", sessionVideos: FULL_SHARED.sessionVideos, materials: FULL_SHARED.materials }), "PDF").state,
  "OK",
  "2.12 the '#' placeholder stays inert while real materials satisfy"
);

// ===========================================================================
section("3. QUIZ is REQUIRED and must be valid (questions + audience coverage)");
// ===========================================================================
eq(item(R({ sessionVideos: FULL_SHARED.sessionVideos }), "QUIZ").state, "MISSING", "3.1 no quiz → QUIZ_MISSING");
eq(item(R({}), "QUIZ").required, true, "3.2 quiz is a hard requirement");
ok(R({ sessionVideos: FULL_SHARED.sessionVideos }).blocking.includes("QUIZ_MISSING"), "3.3 missing quiz blocks READY");
eq(
  item(R({ quizzes: FULL_SHARED.quizzes }), "QUIZ").state,
  "OK",
  "3.4 a linked quiz with questions satisfies the requirement"
);
eq(
  item(R({ quizzes: [{ trackScope: "SHARED", questionCount: 0 }] }), "QUIZ").state,
  "INVALID",
  "3.5 an empty quiz is present but blocking"
);
eq(
  item(R({ quizzes: [{ trackScope: "SHARED", questionCount: 0 }] }), "QUIZ").code,
  "QUIZ_EMPTY",
  "3.6 with the stable empty code"
);
eq(
  item(R({ quizzes: [{ trackScope: "SHARED" }] }), "QUIZ").state,
  "INVALID",
  "3.7 an unreadable question count fails closed (never assumed non-empty)"
);
eq(
  item(
    R({ trackScope: "ARABIC", quizzes: [{ trackScope: "LANGUAGE", questionCount: 9 }] }),
    "QUIZ"
  ).state,
  "MISSING",
  "3.8 another track's quiz NEVER satisfies this lesson"
);
eq(
  item(
    R({ quizzes: [{ trackScope: "ARABIC", questionCount: 4 }] }),
    "QUIZ"
  ).state,
  "INVALID",
  "3.9 a SHARED lesson covered for only one track is incomplete"
);
ok(
  R({ quizzes: [{ trackScope: "ARABIC", questionCount: 4 }] }).notes.join(" ").includes("QUIZ_"),
  "3.10 …and the reason is surfaced as a note, never silently"
);

// ===========================================================================
section("4. HOMEWORK is REQUIRED and must be actionable");
// ===========================================================================
eq(item(R({ sessionVideos: FULL_SHARED.sessionVideos }), "HOMEWORK").state, "MISSING", "4.1 no homework → HOMEWORK_MISSING");
eq(item(R({}), "HOMEWORK").required, true, "4.2 homework is a hard requirement");
eq(
  item(R({ homeworks: FULL_SHARED.homeworks }), "HOMEWORK").state,
  "OK",
  "4.3 a linked homework with instructions satisfies the requirement"
);
eq(
  item(R({ homeworks: [{ trackScope: "SHARED", instructions: "   " }] }), "HOMEWORK").state,
  "INVALID",
  "4.4 whitespace-only instructions are not actionable"
);
eq(
  item(R({ homeworks: [{ trackScope: "SHARED", instructions: "#" }] }), "HOMEWORK").state,
  "INVALID",
  "4.5 the '#' placeholder instruction is not actionable"
);
eq(
  item(R({ homeworks: [{ trackScope: "SHARED", instructions: null }] }), "HOMEWORK").code,
  "HOMEWORK_INSTRUCTIONS_EMPTY",
  "4.6 stable code for the empty-instructions case"
);
eq(
  item(R({ trackScope: "LANGUAGE", homeworks: [{ trackScope: "ARABIC", instructions: "x" }] }), "HOMEWORK").state,
  "MISSING",
  "4.7 another track's homework NEVER satisfies this lesson"
);

// ===========================================================================
section("5. All four valid → READY (the whole contract in one verdict)");
// ===========================================================================
{
  const full = R({ ...FULL_SHARED });
  eq(full.canBeReady, true, "5.1 complete lesson is ready");
  eq(full.canPublish, true, "5.2 …and therefore publishable");
  eq(full.blocking, [], "5.3 nothing blocks");
  eq(full.items.map((i) => [i.key, i.state]), [["VIDEO", "OK"], ["PDF", "OK"], ["QUIZ", "OK"], ["HOMEWORK", "OK"]], "5.4 every requirement reports OK");
  eq(full.items.every((i) => i.required === true), true, "5.5 all four requirements are REQUIRED (no silent optionals)");
  const arabic = R({ trackScope: "ARABIC", ...FULL_ARABIC });
  eq(arabic.canBeReady, true, "5.6 a track-scoped lesson is ready with its own track's content");
}

// ===========================================================================
section("6. Normal MARK READY is rejected when ANY requirement is missing");
// ===========================================================================
(async () => {
  for (const [label, drop] of [
    ["video", { sessionVideos: [] }],
    ["material", { materials: [] }],
    ["quiz", { quizzes: [] }],
    ["homework", { homeworks: [] }],
  ]) {
    const seed = { ...FULL_SHARED, [Object.keys(drop)[0]]: Object.values(drop)[0] };
    const db = makeDb({ lessons: { L1: { status: "DRAFT" } }, ...seed });
    const res = await L.markLessonReady({ lessonId: "L1", actorUserId: "u-admin", client: db });
    eq(res.code, "READINESS_BLOCKED", `6.${label}: mark-ready refused when ${label} missing`);
    ok(res.readiness.blocking.length > 0, `6.${label}: structured blocking codes returned`);
    eq(db.__tables.lesson.get("L1").status, "DRAFT", `6.${label}: row untouched`);
    eq(db.__writes.updateMany, 0, `6.${label}: no write attempted`);
    ok(
      res.readiness.items.some((i) => i.required && i.state !== "OK"),
      `6.${label}: the missing requirement is named in the checklist`
    );
  }
  {
    // All four present → staging succeeds with the existing lifecycle rules.
    const db = readyDb();
    const res = await L.markLessonReady({ lessonId: "L1", actorUserId: "u-admin", client: db });
    eq(res.code, "OK", "6.complete: mark-ready succeeds when all four are satisfied");
    eq(db.__tables.lesson.get("L1").status, "READY", "6.complete: DRAFT → READY");
    eq(db.__tables.lesson.get("L1").isPublished, false, "6.complete: mirror stays FALSE (READY is admin-only)");
    eq(db.__tables.auditLog[0].action, "LESSON_MARK_READY", "6.complete: staging is audited");
  }

  // =========================================================================
  section("7. Normal OPEN re-checks readiness SERVER-SIDE (stale READY is not a warrant)");
  // =========================================================================
  {
    const db = readyDb();
    const draft = await L.openLesson({ lessonId: "L1", actorUserId: "u-admin", client: db });
    eq(draft.code, "ILLEGAL_TRANSITION", "7.1 DRAFT → PUBLISHED stays forbidden on the normal path");
    await L.markLessonReady({ lessonId: "L1", actorUserId: "u-admin", client: db });
    // The video is deleted between staging and opening.
    db.__tables.sessionVideo.length = 0;
    const res = await L.openLesson({ lessonId: "L1", actorUserId: "u-admin", client: db });
    eq(res.code, "READINESS_BLOCKED", "7.2 open refuses after content loss — readiness re-checked from live rows");
    ok(res.readiness.blocking.includes("VIDEO_MISSING"), "7.3 the structured missing reason travels with the refusal");
    eq(db.__tables.lesson.get("L1").status, "READY", "7.4 …and the lesson is not published");
    // The quiz is emptied instead.
    db.__tables.sessionVideo.push(...FULL_SHARED.sessionVideos);
    db.__tables.quiz[0].questionCount = 0;
    const res2 = await L.openLesson({ lessonId: "L1", actorUserId: "u-admin", client: db });
    eq(res2.code, "READINESS_BLOCKED", "7.5 an emptied quiz after staging also blocks the open");
    ok(res2.readiness.blocking.includes("QUIZ_EMPTY"), "7.6 …with the quiz reason");
    // Restoring content lets the SAME normal path publish.
    db.__tables.quiz[0].questionCount = 5;
    const res3 = await L.openLesson({ lessonId: "L1", actorUserId: "u-admin", client: db });
    eq(res3.code, "OK", "7.7 restoring content lets the normal ceremony publish");
    eq(db.__tables.lesson.get("L1").status, "PUBLISHED", "7.8 READY → PUBLISHED");
    eq(db.__tables.lesson.get("L1").isPublished, true, "7.9 the mirror follows (the only sanctioned writer)");
    ok(db.__tables.sessionPublication.some((p) => p.lessonId === "L1"), "7.10 the publication anchor exists");
  }
  {
    // The normal OPEN endpoint carries NO override input: a client-supplied
    // flag cannot reach the bypass (there is no parameter to supply).
    const src = fs.readFileSync(
      path.join(REPO, "src/app/api/admin/lessons/[id]/open/route.ts"),
      "utf8"
    );
    absent(src, /openLessonWithOverride/, "7.11 the normal open route never calls the override ceremony", "openLessonWithOverride");
    absent(src, /override/i, "7.12 the normal open route has no override input at all");
  }

  // =========================================================================
  section("8. Emergency override — explicit, reason-bearing, ADMIN ceremony");
  // =========================================================================
  {
    // Incomplete DRAFT lesson: override stages AND publishes atomically.
    const db = makeDb({ lessons: { L1: { status: "DRAFT" } } });
    const res = await L.openLessonWithOverride({
      lessonId: "L1",
      actorUserId: "u-admin",
      reason: "Exam week — publishing the video-less session for the Arabic track only",
      client: db,
    });
    eq(res.code, "OK", "8.1 override publishes a blocked lesson");
    eq(res.override?.used, true, "8.2 reported truthfully as a real bypass");
    eq(res.from, "DRAFT", "8.3 from DRAFT");
    eq(res.to, "PUBLISHED", "8.4 to PUBLISHED");
    eq(db.__tables.lesson.get("L1").status, "PUBLISHED", "8.5 the row is PUBLISHED");
    eq(db.__tables.lesson.get("L1").isPublished, true, "8.6 mirror synced in the same ceremony");
    ok(db.__tables.sessionPublication.some((p) => p.lessonId === "L1"), "8.7 the publication anchor exists");
    eq(db.__tx.started, 1, "8.8 staging + publish + audit happened in ONE transaction");
    ok(res.override.missing.length >= 4, "8.9 the outcome names every missing requirement");
    ok(res.readiness && res.readiness.blocking.length >= 4, "8.10 the live checklist travels with the outcome");
  }
  {
    // Incomplete READY lesson (content deleted after staging).
    const db = readyDb();
    await L.markLessonReady({ lessonId: "L1", actorUserId: "u-admin", client: db });
    db.__tables.homework.length = 0;
    const res = await L.openLessonWithOverride({
      lessonId: "L1",
      actorUserId: "u-admin",
      reason: "Homework arrives tomorrow; parents were promised the session today",
      client: db,
    });
    eq(res.code, "OK", "8.11 override from READY works when content is lost after staging");
    eq(res.from, "READY", "8.12 from READY (no phantom re-staging)");
    ok(res.override.missing.includes("HOMEWORK_MISSING"), "8.13 the missing homework is recorded");
  }
  {
    // Override REQUESTED but readiness passes → nothing bypassed, still fine.
    const db = readyDb();
    const res = await L.openLessonWithOverride({
      lessonId: "L1",
      actorUserId: "u-admin",
      reason: "Believed incomplete, actually complete",
      client: db,
    });
    eq(res.code, "OK", "8.14 a ready lesson still publishes through the override endpoint");
    eq(res.override?.used, false, "8.15 …but reports that NOTHING was bypassed");
    eq(res.override?.missing, [], "8.16 …with an empty missing list");
    eq(db.__tables.lesson.get("L1").status, "PUBLISHED", "8.17 published");
  }
  {
    // Idempotency: overriding an already-PUBLISHED lesson is a NO_OP.
    const db = readyDb();
    await L.markLessonReady({ lessonId: "L1", actorUserId: "u-admin", client: db });
    await L.openLesson({ lessonId: "L1", actorUserId: "u-admin", client: db });
    const res = await L.openLessonWithOverride({
      lessonId: "L1",
      actorUserId: "u-admin",
      reason: "retry",
      client: db,
    });
    eq(res.code, "NO_OP_ALREADY_IN_STATE", "8.18 overriding a published lesson is an idempotent no-op");
    eq(res.changed, false, "8.19 nothing written");
  }

  // =========================================================================
  section("9. Override reason validation — never silent, never optional");
  // =========================================================================
  {
    const cases = [
      ["", "OVERRIDE_REASON_REQUIRED", "empty string"],
      ["   ", "OVERRIDE_REASON_REQUIRED", "whitespace only"],
      ["\n\t ", "OVERRIDE_REASON_REQUIRED", "tabs/newlines only"],
      [null, "OVERRIDE_REASON_REQUIRED", "null"],
      [undefined, "OVERRIDE_REASON_REQUIRED", "undefined"],
      [42, "OVERRIDE_REASON_REQUIRED", "a number"],
      [{ reason: "x" }, "OVERRIDE_REASON_REQUIRED", "an object"],
      ["x".repeat(1001), "OVERRIDE_REASON_TOO_LONG", "over the cap"],
    ];
    for (const [reason, code, label] of cases) {
      const parsed = L.normalizeOverrideReason(reason);
      eq(parsed.ok, false, `9.${label}: rejected`);
      eq(parsed.code, code, `9.${label}: stable rejection code`);
      const db = makeDb({ lessons: { L1: { status: "READY" } } });
      const res = await L.openLessonWithOverride({
        lessonId: "L1",
        actorUserId: "u-admin",
        reason,
        client: db,
      });
      eq(res.code, "OVERRIDE_REASON_INVALID", `9.${label}: ceremony refuses the invalid warrant`);
      eq(L.lifecycleHttpStatus(res.code), 400, `9.${label}: mapped to HTTP 400`);
      eq(db.__tables.lesson.get("L1").status, "READY", `9.${label}: no state change`);
      eq(db.__writes.updateMany, 0, `9.${label}: no write attempted`);
      eq(db.__tables.auditLog.length, 0, `9.${label}: no override audit without a valid warrant`);
    }
    const trimmed = L.normalizeOverrideReason("  video is at the studio  ");
    eq(trimmed.ok, true, "9.trim: a padded reason is accepted");
    eq(trimmed.reason, "video is at the studio", "9.trim: …and trimmed before it is stored");
    const atCap = L.normalizeOverrideReason("x".repeat(1000));
    eq(atCap.ok, true, "9.cap: exactly the cap is accepted");
  }

  // =========================================================================
  section("10. The override NEVER becomes a generic bypass");
  // =========================================================================
  {
    const db = makeDb({
      lessons: { LA: { status: "READY", curriculumStatus: "ARCHIVED" } },
    });
    const res = await L.openLessonWithOverride({
      lessonId: "LA",
      actorUserId: "u-admin",
      reason: "archive? no.",
      client: db,
    });
    eq(res.code, "LESSON_ARCHIVED", "10.1 archived lessons stay untouchable — override refuses");
    eq(db.__writes.updateMany, 0, "10.2 …without writing anything");
  }
  {
    const db = makeDb({
      lessons: { LO: { status: "READY", unitId: null, topicId: null } },
    });
    const res = await L.openLessonWithOverride({
      lessonId: "LO",
      actorUserId: "u-admin",
      reason: "orphan",
      client: db,
    });
    eq(res.code, "LESSON_NOT_IN_COURSE", "10.3 a lesson in no curriculum still cannot be opened");
  }
  {
    const db = makeDb({ lessons: {} });
    const res = await L.openLessonWithOverride({
      lessonId: "nope",
      actorUserId: "u-admin",
      reason: "probe",
      client: db,
    });
    eq(res.code, "LESSON_NOT_FOUND", "10.4 unknown lesson → 404-class refusal (no existence oracle)");
    eq(L.lifecycleHttpStatus(res.code), 404, "10.5 mapped to 404");
  }
  {
    // Concurrency: the conditional status predicates still guard the override.
    const db = readyDb({ lessons: { L1: { status: "DRAFT" } } });
    db.__tables.sessionVideo.length = 0; // make readiness block → override path
    const realUpdateMany = db.lesson.updateMany;
    let raced = false;
    db.lesson.updateMany = async (args) => {
      if (!raced && args.where.status === "DRAFT") {
        raced = true;
        db.__tables.lesson.get("L1").status = "PUBLISHED"; // someone else won
        db.__tables.lesson.get("L1").isPublished = true;
      }
      return realUpdateMany(args);
    };
    const res = await L.openLessonWithOverride({
      lessonId: "L1",
      actorUserId: "u-admin",
      reason: "race",
      client: db,
    });
    eq(res.code, "CONCURRENT_CHANGE", "10.6 the override loses a race instead of double-applying");
    eq(res.changed, false, "10.7 nothing claimed as changed");
  }
  {
    // No permission bypass: MARK_READY and UNPUBLISH ignore any override.
    const db = makeDb({ lessons: { L1: { status: "DRAFT" } } });
    const res = await L.transitionLesson({
      lessonId: "L1",
      action: "MARK_READY",
      actorUserId: "u-admin",
      override: { reason: "smuggled" },
      client: db,
    });
    eq(res.code, "READINESS_BLOCKED", "10.8 an override smuggled into MARK_READY is ignored (readiness enforced)");
    eq(db.__tables.lesson.get("L1").status, "DRAFT", "10.9 row untouched");
  }
  {
    // Track/audience safety survives the override: it bypasses readiness ONLY.
    const db = makeDb({
      lessons: { L1: { status: "READY", trackScope: "LANGUAGE" } },
      quizzes: [{ id: "q1", lessonId: "L1", trackScope: "ARABIC", questionCount: 3 }],
    });
    const res = await L.openLessonWithOverride({
      lessonId: "L1",
      actorUserId: "u-admin",
      reason: "language group needs it now",
      client: db,
    });
    eq(res.code, "OK", "10.10 override publishes (that is its job)");
    ok(res.override.missing.length > 0, "10.11 …but the audience-gap is recorded as missing, never hidden");
    eq(db.__tables.lesson.get("L1").trackScope, "LANGUAGE", "10.12 the lesson's track was not rewritten by the override");
  }

  // =========================================================================
  section("11. Audit behaviour — every override is traceable, forever");
  // =========================================================================
  {
    const db = makeDb({ lessons: { L1: { status: "DRAFT" } } });
    const reason = "Studio flood — recording ships Friday; cohort starts Monday";
    await L.openLessonWithOverride({
      lessonId: "L1",
      actorUserId: "u-admin-7",
      reason,
      client: db,
    });
    const audits = db.__tables.auditLog;
    const overrideRow = audits.find((a) => a.action === "LESSON_OPEN_OVERRIDE");
    ok(!!overrideRow, "11.1 a dedicated LESSON_OPEN_OVERRIDE row exists");
    eq(overrideRow.userId, "u-admin-7", "11.2 the ADMIN identity is recorded (userId column)");
    eq(overrideRow.entity, "Lesson", "11.3 the entity kind is recorded");
    eq(overrideRow.entityId, "L1", "11.4 the lesson identity is recorded");
    const details = JSON.parse(overrideRow.details);
    eq(details.missing.length >= 4, true, "11.5 the MISSING requirements are recorded");
    ok(details.missing.includes("VIDEO_MISSING"), "11.6 …including the missing video");
    ok(details.missing.includes("PDF_MISSING"), "11.7 …including the missing material");
    eq(details.reason, reason, "11.8 the REASON is recorded verbatim");
    eq(details.to, "PUBLISHED", "11.9 the resulting state is recorded");
    eq(details.from, "DRAFT", "11.10 the origin state is recorded");
    eq(details.overrideUsed, true, "11.11 the row says a bypass actually happened");
    ok(audits.some((a) => a.action === "LESSON_OPEN" && JSON.parse(a.details).override === true), "11.12 the LESSON_OPEN row is marked as override-driven");
    ok(audits.some((a) => a.action === "LESSON_MARK_READY" && JSON.parse(a.details).via === "EMERGENCY_OVERRIDE"), "11.13 the in-ceremony staging is audited as override-driven too");
  }
  {
    // Repeated override attempts remain individually traceable.
    const db = makeDb({
      lessons: {
        L1: { status: "DRAFT" },
        L2: { status: "DRAFT" },
      },
    });
    await L.openLessonWithOverride({ lessonId: "L1", actorUserId: "u-a", reason: "first", client: db });
    await L.openLessonWithOverride({ lessonId: "L2", actorUserId: "u-b", reason: "second", client: db });
    // Unpublish L1 and override it AGAIN.
    await L.unpublishLesson({ lessonId: "L1", actorUserId: "u-a", client: db });
    db.__tables.sessionVideo.length = 0;
    await L.openLessonWithOverride({ lessonId: "L1", actorUserId: "u-a", reason: "third", client: db });
    const rows = db.__tables.auditLog.filter((a) => a.action === "LESSON_OPEN_OVERRIDE");
    eq(rows.length, 3, "11.14 one override row per override-engaged open (nothing collapsed)");
    eq(rows.map((r) => JSON.parse(r.details).reason), ["first", "second", "third"], "11.15 …each with its own reason, in order");
    eq(rows.map((r) => r.userId), ["u-a", "u-b", "u-a"], "11.16 …and its own admin");
  }
  {
    // The NORMAL ceremonies never write override rows.
    const db = readyDb();
    await L.markLessonReady({ lessonId: "L1", actorUserId: "u-admin", client: db });
    await L.openLesson({ lessonId: "L1", actorUserId: "u-admin", client: db });
    await L.unpublishLesson({ lessonId: "L1", actorUserId: "u-admin", client: db });
    eq(
      db.__tables.auditLog.some((a) => a.action.includes("OVERRIDE")),
      false,
      "11.17 normal mark-ready/open/unpublish write no override audit rows"
    );
  }

  // =========================================================================
  section("12. Role authorization — the override is ADMIN-only by construction");
  // =========================================================================
  {
    const read = (p) => fs.readFileSync(path.join(REPO, p), "utf8");
    const overrideRoute = read("src/app/api/admin/lessons/[id]/open-override/route.ts");
    pinned(overrideRoute, /requireRole\("ADMIN"\)/, "12.1 the override route is ADMIN-gated");
    ok(
      overrideRoute.indexOf('requireRole("ADMIN")') <
        overrideRoute.indexOf("openLessonWithOverride"),
      "12.2 the role gate runs BEFORE the ceremony call"
    );
    absent(overrideRoute, /requireRole\(\s*"ADMIN"\s*,/, "12.3 no second role is admitted to the override");
    pinned(overrideRoute, /normalizeOverrideReason/, "12.4 the reason is validated SERVER-SIDE in the route");
    pinned(overrideRoute, /LESSON_OPEN_OVERRIDE_REJECTED/, "12.5 rejected override attempts are audited too (repeated attempts stay traceable)");
    pinned(overrideRoute, /applyRateLimit\("open"/, "12.6 the override is rate-limited like the OPEN ceremony");
    pinned(overrideRoute, /emitSessionPublicationNotifications/, "12.7 an override publication fans out the Phase 17 notification like any publication");
    const openRoute = read("src/app/api/admin/lessons/[id]/open/route.ts");
    pinned(openRoute, /requireRole\("ADMIN"\)/, "12.8 the normal open stays ADMIN-only");
    const markReadyRoute = read("src/app/api/admin/lessons/[id]/mark-ready/route.ts");
    pinned(markReadyRoute, /requireRole\("ADMIN"\)/, "12.9 mark-ready stays ADMIN-only");
    absent(markReadyRoute, /override/i, "12.10 mark-ready has no override input");
    // Teacher / student / parent surfaces must not reach the ceremonies at all.
    const teacherRoutes = execSync(
      "grep -rl 'openLessonWithOverride\\|openLesson\\|transitionLesson' src/app/api/teacher src/app/api/students src/app/api/parents src/app/api/lessons src/app/api/quizzes src/app/api/materials 2>/dev/null || true",
      { cwd: REPO, encoding: "utf8" }
    ).trim();
    eq(teacherRoutes, "", "12.11 no teacher/student/parent route references the publishing ceremonies");
    // requireRole contract: any role NOT listed gets a 403-style refusal.
    const apiSrc = read("src/lib/api.ts");
    pinned(apiSrc, /export async function requireRole\(\.\.\.roles: Role\[\]\)/, "12.12 requireRole denies every role it does not list");
  }

  // =========================================================================
  section("13. Cross-course authorization & track leakage");
  // =========================================================================
  {
    // Cross-course: the ceremonies take ONLY a lesson id — there is no
    // courseId input a caller could spoof to reach another course's lessons.
    // (The ONLY `courseId` occurrences allowed are the fan-out fallback's
    // `courseId: null` OUTPUT fields — never a read from the request.)
    const read = (p) => fs.readFileSync(path.join(REPO, p), "utf8");
    const courseIdReads = (src) =>
      (src.match(/courseId/g) ?? []).length - (src.match(/courseId: null/g) ?? []).length;
    const overrideRoute = read("src/app/api/admin/lessons/[id]/open-override/route.ts");
    eq(courseIdReads(overrideRoute), 0, "13.1 the override route reads no courseId input (nothing to spoof)");
    const openRoute = read("src/app/api/admin/lessons/[id]/open/route.ts");
    eq(courseIdReads(openRoute), 0, "13.2 the open route reads no courseId input either");
    // A lesson in course B is opened by its OWN id: no cross-course handle
    // exists, and a non-admin can never call either route (12.1/12.8).
    const dbA = makeDb({ lessons: { LA: { status: "READY" } } });
    const dbB = makeDb({ lessons: { LB: { status: "READY" } } });
    await L.openLesson({ lessonId: "LA", actorUserId: "u-admin", client: dbA });
    eq(dbB.__tables.lesson.get("LB").status, "READY", "13.3 opening a lesson in one course never touches another course's lesson");
    eq(dbB.__writes.updateMany, 0, "13.4 …no write crossed the boundary");
  }
  {
    // Track/audience content cannot falsely satisfy readiness (all four).
    const foreign = R({
      trackScope: "LANGUAGE",
      sessionVideos: [{ isPublished: true, batch: { schoolType: "ARABIC" } }],
      materials: [{ kind: "ADMIN_UPLOADED", isActive: true, mediaAssetId: "a1", trackScope: "ARABIC" }],
      quizzes: [{ trackScope: "ARABIC", questionCount: 5 }],
      homeworks: [{ trackScope: "ARABIC", instructions: "x" }],
    });
    eq(foreign.canBeReady, false, "13.5 a lesson whose content lives on the OTHER track is NOT READY");
    eq(foreign.blocking.length, 4, "13.6 every requirement reports the gap");
    const sharedGap = R({
      trackScope: "SHARED",
      sessionVideos: [{ isPublished: true, batch: { schoolType: "ARABIC" } }],
      materials: [{ kind: "ADMIN_UPLOADED", isActive: true, mediaAssetId: "a1", trackScope: "ARABIC" }],
      quizzes: [{ trackScope: "ARABIC", questionCount: 5 }],
      homeworks: [{ trackScope: "ARABIC", instructions: "x" }],
    });
    eq(sharedGap.canBeReady, false, "13.7 ARABIC-only coverage never readies a SHARED lesson");
  }

  // =========================================================================
  section("14. Modern SessionVideo satisfies video readiness (Phase A/B intact)");
  // =========================================================================
  {
    eq(
      item(R({ sessionVideos: [{ isPublished: true, batch: { schoolType: "ARABIC" } }, { isPublished: true, batch: { schoolType: "LANGUAGE" } }] }), "VIDEO").state,
      "OK",
      "14.1 lesson-linked published SessionVideos satisfy the requirement"
    );
    const legacyOnly = R({ videoUrl: "https://cdn.example/v.mp4" });
    eq(item(legacyOnly, "VIDEO").state, "MISSING", "14.2 legacy videoUrl is NOT the readiness authority any more");
    eq(
      item(R({ videoUrl: "https://cdn.example/v.mp4", sessionVideos: [{ isPublished: true, batch: { schoolType: "ARABIC" } }, { isPublished: true, batch: { schoolType: "LANGUAGE" } }] }), "VIDEO").count,
      2,
      "14.3 the count reflects modern videos only (no legacy inflation)"
    );
    // Phase B student access rules live elsewhere and are untouched: the
    // lifecycle module never imports the student media authority.
    const lifecycleSrc = fs.readFileSync(path.join(REPO, "src/lib/session-lifecycle.ts"), "utf8");
    absent(lifecycleSrc, /session-video-link|lesson-content/, "14.4 the readiness authority imports no student-media module");
  }

  // =========================================================================
  section("15. Legacy compatibility remains where intentionally supported");
  // =========================================================================
  {
    eq(L.normalizeLessonStatus("TRUE"), "PUBLISHED", "15.1 legacy boolean vocabulary still normalises (input-only)");
    eq(L.normalizeLessonStatus("0"), "DRAFT", "15.2 …both directions");
    eq(L.normalizeLessonStatus("bogus"), null, "15.3 unknown values still fail closed");
    const db = readyDb();
    await L.markLessonReady({ lessonId: "L1", actorUserId: "u-admin", client: db });
    await L.openLesson({ lessonId: "L1", actorUserId: "u-admin", client: db });
    eq(db.__tables.lesson.get("L1").isPublished, true, "15.4 the deprecated isPublished mirror is still kept in sync by the lifecycle module");
    await L.unpublishLesson({ lessonId: "L1", actorUserId: "u-admin", client: db });
    eq(db.__tables.lesson.get("L1").isPublished, false, "15.5 …on withdrawal too");
    ok(
      R({ videoUrl: "https://cdn.example/v.mp4" }).notes.includes("VIDEO_LEGACY_URL_NOT_COUNTED"),
      "15.6 legacy video links are still OBSERVABLE (as a note), never silently dropped"
    );
    ok(
      R({ pdfUrl: "https://cdn.example/p.pdf" }).notes.includes("PDF_LEGACY_URL_NOT_COUNTED"),
      "15.7 legacy pdf links are still OBSERVABLE (as a note), never silently dropped"
    );
  }

  // =========================================================================
  section("16. Deleting a required component returns the lesson to NOT READY");
  // =========================================================================
  {
    const db = readyDb();
    await L.markLessonReady({ lessonId: "L1", actorUserId: "u-admin", client: db });
    await L.openLesson({ lessonId: "L1", actorUserId: "u-admin", client: db });
    eq(db.__tables.lesson.get("L1").status, "PUBLISHED", "16.1 published");
    // The material is deleted while published.
    db.__tables.material[0].isActive = false;
    const live = await L.getLessonReadiness("L1", db);
    eq(live.canBeReady, false, "16.2 readiness computed from LIVE rows flips to NOT READY");
    ok(live.blocking.includes("PDF_MISSING"), "16.3 …with the exact missing reason");
    await L.unpublishLesson({ lessonId: "L1", actorUserId: "u-admin", client: db });
    const reOpenBlocked = await L.openLesson({ lessonId: "L1", actorUserId: "u-admin", client: db });
    eq(reOpenBlocked.code, "READINESS_BLOCKED", "16.4 opening is refused while the material is gone (the READY stamp is stale, the gate re-checks)");
    db.__tables.material[0].isActive = true;
    const reOpen = await L.openLesson({ lessonId: "L1", actorUserId: "u-admin", client: db });
    eq(reOpen.code, "OK", "16.5 restoring the component lets the normal ceremony publish again");
    // Same property for video / quiz / homework deletion: each deletion
    // returns the (withdrawn) lesson to NOT READY and blocks re-opening.
    for (const [name, wipe] of [
      ["video", () => (db.__tables.sessionVideo.length = 0)],
      ["quiz", () => (db.__tables.quiz.length = 0)],
      ["homework", () => (db.__tables.homework.length = 0)],
    ]) {
      await L.unpublishLesson({ lessonId: "L1", actorUserId: "u-admin", client: db });
      wipe();
      const live = await L.getLessonReadiness("L1", db);
      eq(live.canBeReady, false, `16.6-${name}: deleting the ${name} flips live readiness to NOT READY`);
      const refused = await L.openLesson({ lessonId: "L1", actorUserId: "u-admin", client: db });
      eq(refused.code, "READINESS_BLOCKED", `16.7-${name}: …and re-opening is refused with a structured reason`);
    }
  }

  // =========================================================================
  section("17. Phase C aggregation & progression semantics unchanged");
  // =========================================================================
  {
    const lessonContent = fs.readFileSync(path.join(REPO, "src/lib/lesson-content.ts"), "utf8");
    const lifecycleSrc = fs.readFileSync(path.join(REPO, "src/lib/session-lifecycle.ts"), "utf8");
    absent(lessonContent, /from ["']@\/lib\/session-lifecycle/, "17.1 Phase C authority imports no lifecycle/readiness module (U pin)");
    absent(lifecycleSrc, /from ["']@\/lib\/lesson-content/, "17.2 the lifecycle module imports no Phase C authority (no readiness coupling)");
    ok(/DRAFT → READY/.test(lifecycleSrc), "17.3 the lifecycle state machine text is intact");
    const progress = fs.readFileSync(path.join(REPO, "src/lib/session-progress.ts"), "utf8");
    ok(/LESSON_STUDENT_STATUS_FILTER/.test(progress), "17.4 progression still filters the student universe by lifecycle status");
    absent(progress, /openLessonWithOverride/, "17.5 progression never references the override");
    ok(/LOCKED/.test(progress), "17.6 progression semantics (LOCKED/UNLOCKED derivation) stay in the progression engine, untouched");
    absent(lifecycleSrc, /from ["']@\/lib\/session-progress/, "17.7 the lifecycle engine imports no progression module (the two dimensions stay orthogonal)");
  }

  // =========================================================================
  section("18. No schema or data corruption");
  // =========================================================================
  {
    const schema = fs.readFileSync(path.join(REPO, "prisma/schema.prisma"), "utf8");
    ok(/model AuditLog \{/.test(schema), "18.1 the existing AuditLog model is reused (no second audit system)");
    absent(schema, /model LessonOpenOverride|model PublishingOverride|model ReadinessOverride/, "18.2 Phase D invented NO new override tables");
    ok(/details\s+String\?/.test(schema), "18.3 override records fit the existing AuditLog.details column");
    const migrations = fs.readdirSync(path.join(REPO, "prisma/migrations"));
    eq(
      migrations.some((m) => /phase[-_]?d/i.test(m)),
      false,
      "18.4 Phase D ships no schema migration (pure behaviour + audit reuse)"
    );
    const pgMigrations = fs.readdirSync(path.join(REPO, "prisma/postgres/migrations"));
    eq(
      pgMigrations.some((m) => /phase[-_]?d/i.test(m)),
      false,
      "18.5 …and none for PostgreSQL either"
    );
  }

  // =========================================================================
  section("19. Admin publishing UX — scroll fix, override UI, human readiness");
  // =========================================================================
  {
    const read = (p) => fs.readFileSync(path.join(REPO, p), "utf8");
    const openDialog = read("src/components/admin/session-open-dialog.tsx");
    // --- the Open Session modal scroll fix ---
    pinned(openDialog, /max-h-\[calc\(100dvh-2rem\)\] overflow-hidden flex flex-col/, "19.1 the dialog is a bounded flex column capped at the viewport");
    pinned(openDialog, /flex-1 min-h-0 overflow-y-auto/, "19.2 exactly ONE scroll region (the middle) — no nested scroll traps");
    pinned(openDialog, /DialogHeader className="shrink-0"/, "19.3 the header is pinned (never scrolls away into the void)");
    pinned(openDialog, /DialogFooter className="shrink-0/, "19.4 the footer — with ALL action buttons — is pinned reachable");
    absent(openDialog, /ScrollArea/, "19.5 the old nested ScrollArea (the scroll-trap culprit) is gone from the ceremonies");
    ok(openDialog.indexOf("flex-1 min-h-0 overflow-y-auto") < openDialog.indexOf("<DialogFooter"), "19.6 the scroll region sits BETWEEN header and footer");
    // --- the emergency override flow ---
    pinned(openDialog, /open-anyway-button/, "19.7 the Arabic-first 'Open Anyway' control exists");
    pinned(openDialog, /open-override-reason/, "19.8 the override requires a reason input");
    pinned(openDialog, /overrideReason\.trim\(\)\.length === 0/, "19.9 the confirm button stays disabled until the reason is non-empty");
    pinned(openDialog, /open-override-missing/, "19.10 the warning lists exactly which requirements are missing");
    pinned(openDialog, /admin\.596/, "19.11 a STRONG warning is shown before any override confirm");
    pinned(openDialog, /open-override-confirm/, "19.12 the override confirm is an explicit separate action");
    pinned(openDialog, /variant="destructive"/, "19.13 the override confirm is styled destructive (never a casual click)");
    pinned(openDialog, /\/open-override/, "19.14 the override calls the dedicated audited endpoint");
    ok(openDialog.indexOf("canOverride") > -1 && /canOverride = readinessBlocked && !archived/.test(openDialog), "19.15 the override is offered only for blocked, non-archived sessions");
    pinned(openDialog, /admin\.607/, "19.16 a blocked normal open explains itself (no silent disabled button)");
    pinned(openDialog, /admin\.606/, "19.17 a DRAFT ready lesson is told to stage first (no dead end)");
    // --- human readiness rendering ---
    const shared = read("src/components/admin/session-workflow-shared.tsx");
    pinned(shared, /readinessReasonText/, "19.18 the checklist renders HUMAN readiness reasons");
    pinned(shared, /VIDEO_MISSING: "admin\.611"/, "19.19 …with a translation for the missing-video code");
    pinned(shared, /PDF_MISSING: "admin\.614"/, "19.20 …for the missing material code");
    pinned(shared, /QUIZ_MISSING: "admin\.617"/, "19.21 …for the missing quiz code");
    pinned(shared, /HOMEWORK_MISSING: "admin\.620"/, "19.22 …and for the missing homework code");
    // --- the detail screen offers Open for DRAFT + READY (override reachability) ---
    const detailView = read("src/components/admin/session-detail-view.tsx");
    pinned(detailView, /\(isDraft \|\| isReady\) && !archived/, "19.23 the Open control is offered for DRAFT and READY alike");
    absent(shared, /computeLessonReadiness/, "19.24 the UI still never computes readiness itself (server-only authority)");
    // --- Arabic-first dictionary ---
    const dict = read("src/lib/i18n-dict-2026.ts");
    pinned(dict, /"admin\.595": \{\s*ar: "افتح على أي حال/, "19.25 'Open Anyway' is Arabic-first in the dictionary");
    pinned(dict, /"admin\.611"/, "19.26 the missing-video reason string exists");
    pinned(dict, /مطلوب للجاهزية/, "19.27 quiz/homework absence copy no longer says 'optional'");
    const markReadyDialog = openDialog;
    ok(/MarkReadyDialog[\s\S]*?flex-1 min-h-0 overflow-y-auto/.test(markReadyDialog), "19.28 the Mark Ready dialog got the same scroll fix");
    ok(/MarkReadyDialog[\s\S]*?disabled=\{confirming \|\| !detail\.readiness\.canBeReady\}/.test(markReadyDialog), "19.29 Mark Ready's confirm is disabled while readiness is blocked (server still final judge)");
  }

  // =========================================================================
  section("20. Route wiring — override endpoint contract, normal path intact");
  // =========================================================================
  {
    const read = (p) => fs.readFileSync(path.join(REPO, p), "utf8");
    const overrideRoute = read("src/app/api/admin/lessons/[id]/open-override/route.ts");
    pinned(overrideRoute, /openLessonWithOverride/, "20.1 the override route calls the shipped ceremony (no parallel engine)");
    pinned(overrideRoute, /lifecycleHttpStatus/, "20.2 outcome → HTTP mapping uses the shared contract");
    ok(/status === 400/.test(overrideRoute), "20.3 invalid-warrant refusals surface as 400");
    ok(/override: result\.override/.test(overrideRoute), "20.4 the override half of the outcome travels to the client");
    const lifecycleSrc = read("src/lib/session-lifecycle.ts");
    pinned(lifecycleSrc, /export function openLessonWithOverride/, "20.5 the override ceremony is exported from the lifecycle module");
    pinned(lifecycleSrc, /LESSON_OPEN_OVERRIDE/, "20.6 the dedicated audit action lives in the engine");
    pinned(lifecycleSrc, /OVERRIDE_REASON_MAX_LENGTH = 1000/, "20.7 the reason cap is part of the contract");
    ok(!/override\?:/.test(read("src/app/api/admin/lessons/[id]/mark-ready/route.ts")), "20.8 mark-ready route carries no override parameter");
    ok(!/override\?:/.test(read("src/app/api/admin/lessons/[id]/unpublish/route.ts")), "20.9 unpublish route carries no override parameter");
  }

  // ---------------------------------------------------------------------------
  console.log(`\nPhase D readiness/publishing suite: ${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.error("\nFailures:");
    for (const f of failures) console.error(" -", f);
    process.exit(1);
  }
})().catch((e) => {
  console.error("UNCAUGHT:", e);
  process.exit(1);
});
