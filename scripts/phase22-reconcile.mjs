#!/usr/bin/env node
// Phase 22: Run curriculum reconciliation twice via real lib + sqlite adapter
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = path.join(REPO, "db/custom.db");
const db = new DatabaseSync(dbPath);

// Setup sqlite-prisma-lite adapter
const { createSqlitePrisma } = await import(path.join(REPO, "scripts/lib/sqlite-prisma-lite.mjs"));
const client = createSqlitePrisma({ db, schemaPath: path.join(REPO, "prisma/schema.prisma") });

// Compile official-curriculum.ts
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase22-reconcile-"));
fs.writeFileSync(path.join(OUT, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    target: "es2020",
    module: "commonjs",
    strict: false,
    skipLibCheck: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    types: ["node"],
    baseUrl: REPO,
    paths: { "@/*": ["src/*"] },
    rootDir: REPO,
    outDir: OUT,
  },
  files: [path.join(REPO, "src/lib/official-curriculum.ts"), path.join(REPO, "src/lib/session-lifecycle.ts"), path.join(REPO, "src/lib/track-scope.ts"), path.join(REPO, "src/lib/school-type.ts"), path.join(REPO, "src/lib/enrollment.ts"), path.join(REPO, "src/lib/session-progress.ts"), path.join(REPO, "src/lib/progress.ts")],
}));
try {
  execSync(`npx tsc -p ${path.join(OUT, "tsconfig.json")}`, { cwd: REPO, stdio: "pipe" });
} catch(e) {
  // ignore, check emitted
}
const EMIT = path.join(OUT, "src/lib");
const origResolve = (await import("node:module")).default._resolveFilename;
import Module from "node:module";
Module._resolveFilename = function(req, ...rest) {
  if (req === "@/lib/db") {
    const shim = path.join(OUT, "__db-shim.js");
    if (!fs.existsSync(shim)) fs.writeFileSync(shim, "module.exports = { db: globalThis.__CM_CLIENT__ };");
    return shim;
  }
  const alias = /^@\/lib\/([\w-]+)$/.exec(req);
  if (alias) {
    const compiled = path.join(EMIT, `${alias[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  if (req.endsWith("knowledge-model.json")) return path.join(REPO, "docs/curriculum/knowledge-model.json");
  return origResolve.call(this, req, ...rest);
};
globalThis.__CM_CLIENT__ = client;
const reconciler = (await import(path.join(EMIT, "official-curriculum.js")));

console.log("=== RECONCILE RUN #1 ===");
const report1 = await reconciler.reconcileOfficialCurriculum(client);
console.log(JSON.stringify(report1, null, 2));
console.log(`Run #1: partsCreated=${report1.partsCreated} unitsCreated=${report1.unitsCreated} lessonsCreated=${report1.lessonsCreated} lessonsUpdated=${report1.lessonsUpdated} archived=${report1.archivedLessonIds.length} warnings=${report1.warnings.length}`);

console.log("\n=== RECONCILE RUN #2 (idempotency) ===");
const report2 = await reconciler.reconcileOfficialCurriculum(client);
console.log(JSON.stringify(report2, null, 2));
const zeroSemantic = report2.partsCreated===0 && report2.unitsCreated===0 && report2.lessonsCreated===0 && report2.lessonsUpdated===0 && report2.archivedLessonIds.length===0;
console.log(`Run #2 zero semantic changes: ${zeroSemantic ? "PASS" : "FAIL"}`);

// Verification
const course = db.prepare("SELECT * FROM Course WHERE slug='programming-ai-2nd-sec'").get();
console.log(`\nCourse: ${course ? course.name : "MISSING"}`);
console.log(`Parts: ${db.prepare("SELECT COUNT(*) as c FROM Part WHERE courseId=?").get(course.id).c} (expect 2)`);
console.log(`Units: ${db.prepare("SELECT COUNT(*) as c FROM Unit WHERE partId IN (SELECT id FROM Part WHERE courseId=?)").get(course.id).c} (expect 7)`);
const lessons = db.prepare("SELECT officialCode, title, curriculumStatus, status FROM Lesson WHERE officialCode IS NOT NULL ORDER BY officialCode").all();
console.log(`Official lessons: ${lessons.length} (expect 23)`);
console.log(`Codes: ${lessons.map(l=>l.officialCode).join(", ")}`);
const allOfficial = db.prepare("SELECT COUNT(*) as c FROM Lesson WHERE officialCode IS NOT NULL AND curriculumStatus='OFFICIAL'").get().c;
console.log(`OFFICIAL count: ${allOfficial}`);
const archived = db.prepare("SELECT COUNT(*) as c FROM Lesson WHERE curriculumStatus='ARCHIVED'").get().c;
console.log(`ARCHIVED count: ${archived}`);
const draft = db.prepare("SELECT COUNT(*) as c FROM Lesson WHERE status='DRAFT'").get().c;
const published = db.prepare("SELECT COUNT(*) as c FROM Lesson WHERE status='PUBLISHED'").get().c;
console.log(`Lesson status DRAFT=${draft} PUBLISHED=${published}`);

if (lessons.length !== 23) {
  console.error("FAIL: expected 23 official lessons");
  process.exit(1);
}
if (!zeroSemantic) {
  console.error("FAIL: second run not idempotent");
  process.exit(1);
}
console.log("\nCURRICULUM_RECONCILE_OK");
db.close();
