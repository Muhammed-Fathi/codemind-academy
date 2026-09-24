// GET /api/admin/level-mismatches — Phase K2 academic-level diagnostics.
//
// ADMIN-only, READ-ONLY. Runs the ONE shared audit (`auditLevelIntegrity` in
// src/lib/academic-level.ts — the same function the K1/K3 gates use) and
// reports:
//   * students assigned to a group whose course level differs (I1),
//   * lessons whose stored derived level differs from their chain (I2),
//   * NULL-level counts (legacy state; K3 tightens the columns).
// Nothing is repaired at read time: every fix is an explicit admin write
// that is re-validated by the corresponding gate.
import { ok, requireRole } from "@/lib/api";
import { auditLevelIntegrity } from "@/lib/academic-level";

export const dynamic = "force-dynamic";

export async function GET() {
  const { error } = await requireRole("ADMIN");
  if (error) return error;
  const report = await auditLevelIntegrity();
  return ok({
    ...report,
    summary: {
      studentGroupMismatches: report.studentGroupMismatches.length,
      lessonMismatches: report.lessonMismatches.length,
      ...report.nullCounts,
    },
  });
}
