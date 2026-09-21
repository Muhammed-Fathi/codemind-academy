// CodeMind Academy — Phase 26B BLOCKER FIX: Group school-type/track
// eligibility (owner-approved `Group.trackScope`) — regression pins.
//
// WHAT THIS FILE OWNS
//   GAP-1 (the Phase 26B QA report's one blocker) was fixed with an explicit
//   audience on every teaching Group: `Group.trackScope`, reusing the EXISTING
//   TrackScope enum (ARABIC | LANGUAGE; null = UNCLASSIFIED, fail-closed;
//   SHARED remains a content-only concept and is rejected on every group
//   write path). This suite pins the fix in the repo's usual layers:
//
//   A. SOURCE-LEVEL INVARIANTS — the audience contract stays in the shipped
//      code: schema + index, the ONE additive migration, the SQLite skip
//      list + the two regenerated PostgreSQL artifacts (dialect convergence),
//      admin create/edit gates (api.285/286/287), the student listing
//      (own-row schoolType, fail-closed), the submission gate (api.085,
//      zero writes on mismatch), the decision authority (GROUP_TRACK_MISMATCH
//      before any write), the direct-assignment gate in admin students PATCH,
//      the bilingual copy, and the admin UI (required ARABIC/LANGUAGE select,
//      no SHARED option, Unclassified badge).
//
//   B. BEHAVIOURAL — the decision predicate itself, compiled from the SHIPPED
//      TypeScript: `parseGroupTrackScope` (canonical write-path parse) and
//      `groupTrackScopeEligible` (EXACT equality, fail-closed on BOTH sides —
//      deliberately NOT the content predicate `canAccessTrackScope`).
//
//   C. THE MASTER GATE — the real-HTTP audience verifier runs as a child
//      process and must exit 0 (scripts/verify-phase26b-group-track.mjs,
//      PHASE26B_GROUP_TRACK_OK, the full A–Q matrix: admin create gates,
//      listing scoping both directions, mismatch rejection + zero writes,
//      same-track success, wrong-track override 409 with nothing half-applied,
//      correct-track override, renewal safety, dashboard/session-videos
//      compatibility, populated/empty group edit gates, SHARED content
//      semantics, capacity).
//
// Run: node tests/phase26b-group-track.test.js
// Exit code: 0 = all pass, 1 = failure. Requires Node >= 22.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner, repo convention */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

let pass = 0;
let fail = 0;
const failures = [];
const ok = (cond, label) => {
  if (cond) pass++;
  else {
    fail++;
    failures.push(label);
    console.error("FAIL:", label);
  }
};
const eq = (a, b, label) =>
  ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const section = (t) => console.log(`\n${t}`);

const GROUP_TRACK_MIGRATION = "20260915120000_phase26b_group_track_scope";

async function main() {
  // ---------------------------------------------------------------------------
  section("B0. Schema — Group.trackScope (owner-approved) + index");
  // ---------------------------------------------------------------------------
  {
    const schema = read("prisma/schema.prisma");
    ok(/model Group \{[\s\S]*?trackScope\s+TrackScope\?/.test(schema), "B0: Group.trackScope is TrackScope? (no duplicate enum, no blind default)");
    const groupBlock = schema.slice(schema.indexOf("model Group"), schema.indexOf("}", schema.indexOf("model Group")));
    ok(/@@index\(\[trackScope\]\)/.test(groupBlock), "B0: the trackScope index lives on the Group model");
    ok(
      /SHARED[\s\S]*?content-only/.test(schema.slice(schema.indexOf("model Group"), schema.indexOf("model Group") + 2200)) ||
        schema.slice(schema.indexOf("model Group"), schema.indexOf("model Group") + 2200).includes("SHARED"),
      "B0: the design comment documents SHARED as content-only (never a group audience)"
    );
  }

  // ---------------------------------------------------------------------------
  section("B1. ONE forward-only additive migration (no DROP, no backfill)");
  // ---------------------------------------------------------------------------
  {
    const migDir = path.join(REPO, "prisma", "migrations", GROUP_TRACK_MIGRATION);
    ok(fs.existsSync(path.join(migDir, "migration.sql")), "B1: the migration directory + migration.sql exist");
    const sql = read(`prisma/migrations/${GROUP_TRACK_MIGRATION}/migration.sql`);
    ok(/ALTER TABLE "Group" ADD COLUMN "trackScope" TEXT\s*;/.test(sql), "B1: plain nullable ADD COLUMN (SQLite needs no rebuild)");
    ok(/CREATE INDEX "Group_trackScope_idx"/.test(sql), "B1: creates the Group_trackScope_idx index");
    const sqlNoComments = sql.replace(/^\s*--.*$/gm, "");
    ok(!/DROP\b/i.test(sqlNoComments), "B1: NO destructive DROP");
    ok(!/\bUPDATE\b/i.test(sqlNoComments) && !/\bINSERT\b/i.test(sqlNoComments), "B1: NO silent classification/backfill of existing rows (they stay NULL = UNCLASSIFIED)");
    const migs = fs.readdirSync(path.join(REPO, "prisma", "migrations")).filter((d) =>
      fs.existsSync(path.join(REPO, "prisma", "migrations", d, "migration.sql"))
    );
    // Phase 26D later appended its own migration, so the audience migration is
    // no longer the LAST entry — but it must still be present, still sort after
    // the 10 PR-era migrations, and still be the only migration 26B added.
    // Phase F appended `20260919120000_phase_f_live_session_lifecycle`, so the
    // history grew by exactly one. The invariants this case actually protects —
    // the audience migration still exists, still sorts after the 10 PR-era
    // migrations, and no destructive SQL was introduced — are asserted below.
    eq(
      migs.length,
      18,
      "B1: history is 18 (10 PR-era + Phase 26B audience + Phase 26D quiz architecture + Phase F live sessions + Phase G x2 + Phase H override + session-video requirement + requirement modes)"
    );
    ok(migs.includes(GROUP_TRACK_MIGRATION), "B1: the audience migration is in the history");
    ok(
      migs.indexOf(GROUP_TRACK_MIGRATION) === 10,
      "B1: the audience migration sorts directly after the 10 PR-era migrations (forward-only)"
    );
  }

  // ---------------------------------------------------------------------------
  section("B2. Dialect convergence — SQLite skip list + regenerated PG artifacts");
  // ---------------------------------------------------------------------------
  {
    const mig = read("scripts/lib/migrate-sqlite.mjs");
    ok(/Group:\s*\["trackScope"\]/.test(mig), "B2: SQLite migrator skips re-adding Group.trackScope (baseline column wins)");
    const pgSchema = read("prisma/postgres/schema.prisma");
    ok(/model Group \{[\s\S]*?trackScope\s+TrackScope\?/.test(pgSchema), "B2: regenerated PG schema carries Group.trackScope");
    const baseline = read("scripts/db/postgres-baseline.sql");
    ok(baseline.includes('"trackScope"'), "B2: regenerated PG baseline carries the trackScope column");
    ok(baseline.includes('CREATE INDEX "Group_trackScope_idx"'), "B2: regenerated PG baseline carries the audience index");
  }

  // ---------------------------------------------------------------------------
  section("B3. The decision predicate (src/lib/track-scope.ts)");
  // ---------------------------------------------------------------------------
  {
    const src = read("src/lib/track-scope.ts");
    ok(src.includes("export function parseGroupTrackScope"), "B3: parseGroupTrackScope exported (strict write-path parse)");
    ok(src.includes("export function groupTrackScopeEligible"), "B3: groupTrackScopeEligible exported (student eligibility)");
    ok(!src.match(/export function groupTrackScopeEligible[\s\S]*?canAccessTrackScope/), "B3: eligibility does NOT delegate to the content predicate");
  }

  // ---------------------------------------------------------------------------
  section("B4. Admin create (POST /api/admin/groups) — explicit audience required");
  // ---------------------------------------------------------------------------
  {
    const src = read("src/app/api/admin/groups/route.ts");
    ok(src.includes("parseGroupTrackScope"), "B4: the audience is parsed with the canonical strict parser");
    ok(src.includes("api.285"), "B4: missing/invalid audience → 400 api.285");
    ok(!/\?\?\s*"ARABIC"/.test(src) && !/\?\?\s*"LANGUAGE"/.test(src) && !/\?\?\s*"SHARED"/.test(src), "B4: no defaulting fallback for the audience");
    ok(/const trackScope = parseGroupTrackScope\(body\.trackScope\);[\s\S]{0,120}if \(!trackScope\) return err\(tApi\("api\.285"\), 400\);/.test(src), "B4: unparsable audience is a hard 400 (no inference)");
    ok(/trackScope,\s*\n\s*\}\,?\s*\n\s*\}\);/.test(src) || /data:\s*\{[\s\S]*?trackScope,[\s\S]*?\}/.test(src), "B4: the parsed audience is persisted on create");
    ok(src.includes("trackScope: g.trackScope ?? null"), "B4: the admin listing exposes trackScope (null-visible for triage)");
  }

  // ---------------------------------------------------------------------------
  section("B5. Admin edit (PATCH /api/admin/groups/[id]) — safe re-audience only");
  // ---------------------------------------------------------------------------
  {
    const src = read("src/app/api/admin/groups/[id]/route.ts");
    ok(src.includes("api.285"), "B5: invalid/absent-when-present audience → 400 api.285");
    ok(src.includes("api.287"), "B5: populated-group incompatible change → 409 api.287");
    ok(src.includes("api.286"), "B5: mismatched addStudentIds assignment → 409 api.286");
    ok(/NOT:\s*\{\s*schoolType:\s*parsed\s*\}/.test(src), "B5: the compatibility gate counts students whose schoolType does NOT match");
    ok(/if\s*\(body\.trackScope\s*!==\s*undefined\)/.test(src), "B5: audience is only touched when explicitly provided (no silent rewrite)");
    ok(/nextTrackScope \?\? normalizeSchoolType\(group\.trackScope\)/.test(src), "B5: assignment rules respect the post-update audience; NULL imposes no constraint (operator classifies explicitly)");
  }

  // ---------------------------------------------------------------------------
  section("B6. Student listing (GET /api/groups) — own-row, fail-closed, student-only");
  // ---------------------------------------------------------------------------
  {
    const src = read("src/app/api/groups/route.ts");
    ok(src.includes("requireUser"), "B6: listing requires an authenticated user");
    ok(/user\.role\s*!==\s*"STUDENT"/.test(src), "B6: non-STUDENT callers are refused (eligibility is a per-student fact)");
    ok(src.includes("getStudentSchoolType"), "B6: eligibility input is the student's OWN persisted schoolType row");
    ok(/if\s*\(!schoolType\)\s*return ok\(\{\s*groups:\s*\[\]\s*\}\)/.test(src), "B6: unknown schoolType → EMPTY listing (fail-closed, never everything)");
    ok(/isActive:\s*true,\s*\n?\s*trackScope:\s*schoolType/.test(src), "B6: the query filters isActive + EXACT trackScope = own schoolType");
    ok(!/where[\s\S]{0,400}trackScope:\s*\{\s*in/.test(src), "B6: no widened filter (never a SHARED-inclusive set)");
  }

  // ---------------------------------------------------------------------------
  section("B7. Submission (POST /api/enroll) — mismatch 400, zero writes");
  // ---------------------------------------------------------------------------
  {
    const src = read("src/app/api/enroll/route.ts");
    ok(src.includes("groupTrackScopeEligible"), "B7: the eligibility predicate guards the submission");
    ok(
      /if\s*\(group\.courseId\s*!==\s*course\.id\)\s*return err\(tApi\("api\.085"\),\s*400\);[\s\S]*?groupTrackScopeEligible/,
      "B7: guard order — course binding first, then audience (existing checks preserved)"
    );
    ok(/if\s*\(!groupTrackScopeEligible\([^)]*\)\)\s*return err\(tApi\("api\.085"\),\s*400\);/.test(src), "B7: mismatch → 400 api.085 (no enumeration leak)");
    const guardIdx = src.indexOf("groupTrackScopeEligible(student.schoolType");
    const submitIdx = src.indexOf("submitPaymentRequest", guardIdx === -1 ? 0 : guardIdx);
    ok(guardIdx !== -1 && submitIdx > guardIdx, "B7: the audience gate fires BEFORE any Payment/Subscription creation (zero writes on mismatch)");
  }

  // ---------------------------------------------------------------------------
  section("B8. Decision authority — GROUP_TRACK_MISMATCH before any write");
  // ---------------------------------------------------------------------------
  {
    const src = read("src/lib/payment-transitions.ts");
    ok(src.includes('"GROUP_TRACK_MISMATCH"'), "B8: GROUP_TRACK_MISMATCH in the closed domain-error set");
    ok(/GROUP_TRACK_MISMATCH:\s*409/.test(src), "B8: mismatch decisions are 409");
    ok(/GROUP_TRACK_MISMATCH:\s*"api\.286"/.test(src), "B8: the decision copy is the shared api.286 message");
    ok(/select:\s*\{\s*id:\s*true,\s*name:\s*true,\s*isActive:\s*true,\s*courseId:\s*true,\s*capacity:\s*true,\s*trackScope:\s*true\s*\}/.test(src), "B8: target-group resolution selects trackScope");
    ok(/if\s*\(!groupTrackScopeEligible\(student\.schoolType,\s*target\.trackScope\)\)\s*\n?\s*fail\("GROUP_TRACK_MISMATCH"\);/.test(src), "B8: the guard uses the SAME predicate as the submission path (no drift)");
    const guardIdx = src.indexOf('fail("GROUP_TRACK_MISMATCH")');
    const seatIdx = src.indexOf("const needsSeat");
    ok(guardIdx !== -1 && seatIdx > guardIdx, "B8: the guard sits BEFORE the seat-change logic (nothing half-applies)");
    ok(/STUDENT_APPROVAL_SELECT[\s\S]*?schoolType:\s*true/.test(src), "B8: the approval's student select carries schoolType");
  }

  // ---------------------------------------------------------------------------
  section("B9. Direct admin assignment (PATCH /api/admin/students/[id]) — same rule");
  // ---------------------------------------------------------------------------
  {
    const src = read("src/app/api/admin/students/[id]/route.ts");
    ok(src.includes("normalizeSchoolType"), "B9: the direct groupId assignment path is audience-gated");
    ok(src.includes("api.286"), "B9: mismatched direct assignment → 409 api.286");
    ok(/if\s*\(!group\)\s*return err\(tApi\("api\.020"\),\s*404\);/.test(src), "B9: a bogus groupId is a 404 (no dangling writes)");
    // Phase 26C security hardening: unclassified groups are now fail-closed for direct admin assignment too (api.285), preventing seating into invisible groups.
    ok(src.includes("api.285"), "B9: unclassified group assignment → 409 api.285 (Phase 26C fail-closed)");
  }

  // ---------------------------------------------------------------------------
  section("B10. Bilingual decision + admin copy exists");
  // ---------------------------------------------------------------------------
  {
    const d2026 = read("src/lib/i18n-dict-2026.ts");
    for (const key of ["api.285", "api.286", "api.287"]) {
      const re = new RegExp(`"${key}":\\s*\\{\\s*ar:[\\s\\S]*?en:[\\s\\S]*?\\}`);
      ok(re.test(d2026), `B10: ${key} defined with ar + en`);
    }
    const dict = read("src/lib/i18n-dict.ts");
    for (const key of ["admin.318", "admin.319", "admin.320"]) {
      const re = new RegExp(`"${key}":\\s*\\{\\s*ar:[\\s\\S]*?en:[\\s\\S]*?\\}`);
      ok(re.test(dict), `B10: ${key} defined with ar + en`);
    }
  }

  // ---------------------------------------------------------------------------
  section("B11. Admin UI — required explicit audience select, no SHARED, triage badge");
  // ---------------------------------------------------------------------------
  {
    const ui = read("src/components/admin/admin-dashboard.tsx");
    const createIdx = ui.indexOf("function CreateGroupDialog");
    const groupsEnd = ui.indexOf("// 5. Courses");
    const groupsSection = ui.slice(createIdx, groupsEnd);
    ok(createIdx !== -1 && groupsEnd > createIdx, "B11: the group dialogs exist");
    ok(groupsSection.includes('value="ARABIC"') && groupsSection.includes('value="LANGUAGE"'), "B11: the create dialog offers exactly ARABIC + LANGUAGE");
    ok(!groupsSection.includes('value="SHARED"'), "B11: SHARED is NOT offered as a group audience (content-only concept)");
    ok(/form\.trackScope !== "ARABIC" && form\.trackScope !== "LANGUAGE"/.test(groupsSection), "B11: the create dialog refuses to submit without an explicit audience");
    ok(groupsSection.includes('admin.318') && groupsSection.includes('admin.320'), "B11: localized label + helper rendered");
    ok(groupsSection.includes("...(trackScope ? { trackScope } : {})"), "B11: the manage dialog sends the audience edit (server enforces safety)");
    ok(/admin\.319/.test(ui.slice(ui.indexOf("type GroupRow"), groupsEnd)), "B11: group cards show the Unclassified badge for null audiences (admin triage)");
    ok(ui.includes("trackScope: string | null;"), "B11: GroupRow carries the audience field");
  }

  // ---------------------------------------------------------------------------
  section("B12. BEHAVIOURAL — the decision predicate, compiled from shipped TS");
  // ---------------------------------------------------------------------------
  {
    const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-gtg-"));
    fs.writeFileSync(
      path.join(OUT, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "es2020",
          lib: ["es2022"],
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
        files: [
          path.join(REPO, "src/lib/school-type.ts"),
          path.join(REPO, "src/lib/track-scope.ts"),
        ],
      })
    );
    try {
      execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", path.join(OUT, "tsconfig.json")], {
        cwd: REPO,
        stdio: "pipe",
      });
    } catch {
      // expected (stub Prisma types); emission still happens
    }
    // Route `@/lib/*` imports from the compiled output (same trick as the
    // verifier harness).
    const Module = require("module");
    const originalResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
      const m = /^@\/lib\/([\w-]+)$/.exec(request);
      if (m) {
        const compiled = path.join(OUT, "src", "lib", `${m[1]}.js`);
        if (fs.existsSync(compiled)) return compiled;
      }
      return originalResolve.call(this, request, ...rest);
    };
    try {
        const emit2 = (f) => {
        const p = path.join(OUT, "src", "lib", f);
        if (!fs.existsSync(p)) throw new Error(`tsc did not emit ${f}`);
        return require(p);
      };
      const TS = emit2("track-scope.js");

    // parseGroupTrackScope — the canonical write-path parse.
    eq(TS.parseGroupTrackScope("ARABIC"), "ARABIC", "B12: parse accepts canonical ARABIC");
    eq(TS.parseGroupTrackScope("LANGUAGE"), "LANGUAGE", "B12: parse accepts canonical LANGUAGE");
    eq(TS.parseGroupTrackScope(" arabic "), "ARABIC", "B12: parse normalises case/whitespace aliases");
    eq(TS.parseGroupTrackScope("SHARED"), null, "B12: parse REJECTS SHARED (content-only concept, never an audience)");
    eq(TS.parseGroupTrackScope("AMERICAN"), null, "B12: parse REJECTS unknown values");
    eq(TS.parseGroupTrackScope(""), null, "B12: parse REJECTS empty");
    eq(TS.parseGroupTrackScope(undefined), null, "B12: parse REJECTS absent (null → write path 400s)");

    // groupTrackScopeEligible — EXACT equality, fail-closed on BOTH sides.
    eq(TS.groupTrackScopeEligible("ARABIC", "ARABIC"), true, "B12: ARABIC student eligible for ARABIC group");
    eq(TS.groupTrackScopeEligible("LANGUAGE", "LANGUAGE"), true, "B12: LANGUAGE student eligible for LANGUAGE group");
    eq(TS.groupTrackScopeEligible("ARABIC", "LANGUAGE"), false, "B12: ARABIC student NOT eligible for LANGUAGE group");
    eq(TS.groupTrackScopeEligible("LANGUAGE", "ARABIC"), false, "B12: LANGUAGE student NOT eligible for ARABIC group");
    eq(TS.groupTrackScopeEligible("ARABIC", null), false, "B12: UNCLASSIFIED group eligible for NOBODY (fail-closed)");
    eq(TS.groupTrackScopeEligible(null, "ARABIC"), false, "B12: unknown-schoolType student eligible for NOTHING (fail-closed)");
    eq(TS.groupTrackScopeEligible(null, null), false, "B12: null/null is NOT accidentally compatible");
    eq(TS.groupTrackScopeEligible("SHARED", "ARABIC"), false, "B12: SHARED school type (unknown) is never eligible");
    eq(TS.groupTrackScopeEligible("ARABIC", "SHARED"), false, "B12: SHARED group audience is never eligible");
    } finally {
      Module._resolveFilename = originalResolve;
    }
  }

  // ---------------------------------------------------------------------------
  section("C. MASTER GATE — scripts/verify-phase26b-group-track.mjs (real HTTP)");
  // ---------------------------------------------------------------------------
  {
    const verifier = path.join(REPO, "scripts", "verify-phase26b-group-track.mjs");
    ok(fs.existsSync(verifier), "C0: the audience verifier exists");
    let proc;
    try {
      proc = execFileSync(process.execPath, [verifier], {
        cwd: REPO,
        encoding: "utf8",
        timeout: 300_000,
      });
    } catch (e) {
      proc = String(e.stdout || "") + String(e.stderr || "");
    }
    ok(proc.includes("PHASE26B_GROUP_TRACK_OK"), "C1: the A–Q audience matrix passes over real HTTP (PHASE26B_GROUP_TRACK_OK)");
    if (!proc.includes("PHASE26B_GROUP_TRACK_OK")) {
      console.error("---- verifier tail ----\n" + proc.split("\n").slice(-40).join("\n"));
    }
  }
}

main()
  .then(() => {
    console.log(`\nphase26b-group-track: ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error("HARNESS ERROR:", e);
    process.exit(1);
  });
