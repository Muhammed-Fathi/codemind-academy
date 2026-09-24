// GET /api/registration/options — PUBLIC registration offerings (Phase K2).
//
// Returns the VALID Level × Track OFFERINGS the registration form may show:
//
//   { offerings: [ { academicLevel: "SECOND_SECONDARY", tracks: ["ARABIC","LANGUAGE"] }, … ] }
//
// NOT `{ levels, tracks }` — a level may not have every track operationally
// available, so tracks are only ever advertised UNDER a level. A pair is
// offered iff at least one ACTIVE, CLASSIFIED group exists on a course of
// that level (the same population the group picker can serve). Enum values
// only: no course names, no counts, no PII. The client list is display-only;
// the registration POST recomputes the same set and rejects any pair that
// is not in it.
import { ok } from "@/lib/api";
import { loadRegistrationOfferings } from "@/lib/academic-level";

export const dynamic = "force-dynamic";

export async function GET() {
  const offerings = await loadRegistrationOfferings();
  return ok({ offerings });
}
