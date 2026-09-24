// CodeMind Academy — Official curriculum reconciliation runner (Phase 11).
//
// Reconciles the per-level curriculum models under
// docs/curriculum/<level>/knowledge-model.json (the authoritative R2
// contract) into the database as the canonical curriculum and archives the
// legacy R1 lessons WITHOUT deleting any row.
//
// SAFE: idempotent (re-running converges to the same state), scoped to the
// known course slug, create-mostly (the only UPDATEs are canonical-field
// alignment + the archival flag flip). Crash-safe by re-run.
//
// Run with: npx tsx scripts/reconcile-curriculum.ts
// (or: bun run scripts/reconcile-curriculum.ts)
import { db } from "../src/lib/db";
import { reconcileAllOfficialCurricula } from "../src/lib/official-curriculum";

async function main() {
  console.log("🧭 Reconciling every registered official curriculum ...");
  // Phase L: the registry fans out over one fully-scoped run per academic
  // level (Second Secondary, then First Secondary). Each level is reconciled
  // against its own model and its own course slug, so a code that exists in
  // both curricula ("1-1" … "7-3") is never resolved by code alone.
  const summary = await reconcileAllOfficialCurricula();
  for (const report of summary.levels) {
    console.log(`\n  ── ${report.academicLevel} ──`);
    console.log(`  ✓ Course: ${report.courseSlug} (${report.courseId})${report.courseCreated ? " [created]" : ""}`);
    console.log(`  ✓ Model version: ${report.modelVersion}`);
    console.log(`  ✓ Parts reconciled: ${report.partsReconciled} (${report.partsCreated} created)`);
    console.log(`  ✓ Units reconciled: ${report.unitsReconciled} (${report.unitsCreated} created)`);
    console.log(
      `  ✓ Official lessons: ${report.officialLessonCodes.length} ` +
        `(${report.lessonsCreated} created, ${report.lessonsUpdated} updated)`
    );
    console.log(`  ✓ Legacy lessons archived (rows preserved): ${report.archivedLessonIds.length}`);
  }
  console.log(
    `\n  TOTAL: ${summary.levels.length} level(s), ` +
      `${summary.officialLessonCodes.length} official lesson code(s), ` +
      `${summary.archivedLessonIds.length} legacy lesson(s) archived`
  );
  for (const w of summary.warnings) console.log(`  ! WARNING: ${w}`);
  console.log("✅ Official curriculum reconciliation complete!");
}

main()
  .then(async () => {
    await db.$disconnect();
  })
  .catch(async (e) => {
    console.error("❌ Reconciliation failed:", e);
    await db.$disconnect();
    process.exit(1);
  });
