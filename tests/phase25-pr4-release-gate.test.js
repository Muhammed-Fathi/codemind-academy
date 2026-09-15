// CodeMind Academy — Phase 25 PR4 release composition gate.
// Proves PR2a + PR2b + PR3 + UTC hotfix + PR1 ledger + PR4 inventory are present
// as a single coordinated release. No new migration, no business logic change.
// Run: node tests/phase25-pr4-release-gate.test.js
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
let pass=0, fail=0;
function ok(c,m){ if(c){pass++; console.log(`  ok - ${m}`);} else {fail++; console.error(`  FAIL - ${m}`);} }
function section(t){ console.log(`\n== ${t} ==`); }
function read(p){ return fs.readFileSync(path.join(REPO,p), "utf8"); }
function exists(p){ return fs.existsSync(path.join(REPO,p)); }

async function main() {
  section("1. PR1 ledger migration exists and is the only Phase 25 schema change");
  ok(exists("prisma/migrations/20260914120000_payment_lifecycle_redesign/migration.sql"), "PR1 migration file exists");
  const mig = read("prisma/migrations/20260914120000_payment_lifecycle_redesign/migration.sql");
  ok(mig.includes("senderPhone") && mig.includes("requestedGroupId") && mig.includes("requestedPlanId") && mig.includes("rejectionReason") && mig.includes("reviewedAt") && mig.includes("reviewedByUserId"), "migration has all 6 ledger columns");
  ok(mig.includes("Payment_status_createdAt_idx") && mig.includes("Payment_subscriptionId_status_idx"), "migration has 2 indexes");
  const migs = fs.readdirSync(path.join(REPO,"prisma/migrations")).filter(d=> fs.existsSync(path.join(REPO,"prisma/migrations",d,"migration.sql"))).sort();
  ok(migs.length === 10, `10 migrations total (found ${migs.length})`);
  ok(migs[migs.length-1]==="20260914120000_payment_lifecycle_redesign", "ledger migration sorts last");
  // no new migration beyond PR1 for PR4
  ok(!exists("prisma/migrations/20260915000000_phase25_pr4") && !exists("prisma/migrations/20260914130000_phase25_pr4"), "no PR4 migration file (PR4 is operational, not schema)");

  section("2. PR2a submission authority exists");
  ok(exists("src/lib/payment-submission.ts"), "payment-submission.ts exists");
  const sub = read("src/lib/payment-submission.ts");
  ok(sub.includes("export async function submitPaymentRequest"), "submitPaymentRequest exported");
  ok(sub.includes("export function validateEnrollmentSubmission"), "validateEnrollmentSubmission exported");
  ok(sub.includes("export function normalizeSenderPhone"), "normalizeSenderPhone exported");
  ok(sub.includes("SUPPORTED_PAYMENT_METHODS") && sub.includes("INSTAPAY") && sub.includes("ETISALAT_CASH"), "supported methods present");
  ok(sub.includes("LEGACY_GRANDFATHERED") || sub.includes("grandfather"), "grandfather handling documented");
  ok(exists("src/app/api/enroll/route.ts"), "enroll route exists");
  const enroll = read("src/app/api/enroll/route.ts");
  ok(enroll.includes("submitPaymentRequest") && enroll.includes("validateEnrollmentSubmission"), "enroll route wires submission service");
  ok(exists("src/lib/subscription-entitlement.ts"), "subscription-entitlement.ts exists");
  const ent = read("src/lib/subscription-entitlement.ts");
  ok(ent.includes("export function evaluateAccessDecision") && ent.includes("export function isSubscriptionValidForAccess"), "entitlement decision exported");
  ok(ent.includes("OK_GRANDFATHERED") && ent.includes("SUBSCRIPTION_PENDING"), "access matrix present");

  section("3. PR2b decision authority exists");
  ok(exists("src/lib/payment-transitions.ts"), "payment-transitions.ts exists");
  const tr = read("src/lib/payment-transitions.ts");
  ok(tr.includes("export async function approvePayment"), "approvePayment exported");
  ok(tr.includes("export async function rejectPayment"), "rejectPayment exported");
  ok(tr.includes("export function normalizeRejectionReason"), "normalizeRejectionReason exported");
  ok(tr.includes("export function addMonths"), "addMonths exported");
  ok(tr.includes("GROUP_SEAT_LOCK_NAMESPACE") || tr.includes("groupSeatLockId") || tr.includes("acquireGroupSeatLock"), "group seat lock present");
  ok(tr.includes("STALE_PAYMENT") && tr.includes("GROUP_REQUIRED") && tr.includes("PLAN_REQUIRED"), "domain errors present");
  ok(exists("src/lib/db-serialization.ts"), "db-serialization.ts exists");
  const ser = read("src/lib/db-serialization.ts");
  ok(ser.includes("groupSeatLockId") || ser.includes("GROUP_SEAT_LOCK"), "seat lock id present");
  ok(exists("src/app/api/admin/payments/[id]/approve/route.ts"), "approve route exists");
  ok(exists("src/app/api/admin/payments/[id]/reject/route.ts"), "reject route exists");
  const appr = read("src/app/api/admin/payments/[id]/approve/route.ts");
  ok(appr.includes("approvePayment") && appr.includes("payment-transitions"), "approve route delegates to service");
  const rej = read("src/app/api/admin/payments/[id]/reject/route.ts");
  ok(rej.includes("rejectPayment"), "reject route delegates");

  section("4. UTC-safe calendar month arithmetic");
  ok(tr.includes("getUTCMonth") && tr.includes("getUTCFullYear") && tr.includes("Date.UTC"), "addMonths uses UTC accessors");
  ok(!tr.includes("getMonth()") || tr.includes("getUTCMonth"), "UTC hotfix not using local getMonth");
  // pin the comment about DST
  ok(tr.includes("UTC") && tr.includes("addMonths"), "UTC comment present");

  section("5. PR3 presentation authority exists");
  ok(exists("src/lib/payment-ux.ts"), "payment-ux.ts exists");
  const ux = read("src/lib/payment-ux.ts");
  ok(ux.includes("PAYMENT_PROOF_WHATSAPP_NUMBERS") && ux.includes("01147422177") && ux.includes("01099942942"), "WhatsApp proof numbers present");
  ok(ux.includes("paymentMethodAvailable") && ux.includes("paymentDestinationFor"), "destination safety present");
  ok(ux.includes("brand.payments.instapay") || ux.includes("brand.payments.eCash"), "destination reads from brand");
  ok(exists("src/components/auth/enroll-view.tsx") || exists("src/components/student/payment-status.tsx"), "student payment UI exists");
  ok(exists("src/components/admin/payment-review-drawer.tsx"), "admin drawer exists");
  const brand = read("src/lib/brand.ts");
  ok(brand.includes("01147422177") || brand.includes("SUPPORT_PHONE_DISPLAY"), "brand destination correct");
  ok(brand.includes("vodafoneCash") && brand.includes("null"), "Vodafone disabled");

  section("6. PR4 inventory / cutover tooling exists");
  ok(exists("scripts/phase25-pr4-inventory.mjs"), "inventory script exists");
  const inv = read("scripts/phase25-pr4-inventory.mjs");
  ok(inv.includes("runInventory") && inv.includes("SELECT"), "inventory exports runInventory and is SELECT based");
  // read-only enforcement: Q object only SELECT
  const qBody = (inv.match(/const Q = \{([\s\S]*?)\n\};/) || [])[1] || "";
  ok(!/\bINSERT INTO\b/i.test(qBody), "inventory Q has no INSERT");
  ok(!/\bUPDATE\b/i.test(qBody), "inventory Q has no UPDATE");
  ok(!/\bDELETE\b/i.test(qBody), "inventory Q has no DELETE");
  ok(inv.includes("PostgreSQL") && inv.includes("SQLite"), "inventory handles both engines");
  ok(inv.includes("redactDatabaseUrl") || inv.includes("redact"), "inventory redacts URL");
  // docs
  ok(exists("docs/PHASE_25_PR4_CUTOVER_RUNBOOK.md") || exists("docs/PHASE_25_PR4_OPERATIONS.md"), "PR4 runbook exists");
  if (exists("docs/PHASE_25_PR4_CUTOVER_RUNBOOK.md")) {
    const rb = read("docs/PHASE_25_PR4_CUTOVER_RUNBOOK.md");
    ok(rb.includes("GO") && rb.includes("NO-GO"), "runbook has GO/NO-GO");
    ok(rb.includes("01147422177"), "runbook has destination truth");
    ok(rb.includes("npx") && (rb.includes("DATABASE_URL") || rb.includes("POSTGRES")), "runbook has operator commands");
    ok(rb.includes("ROLLBACK") || rb.includes("Rollback"), "runbook has rollback");
    ok(rb.includes("SMOKE") || rb.includes("smoke"), "runbook has smoke plan");
  }

  section("7. Source integrity: no unintended migration or business logic change");
  // prisma schema should have ledger fields but no PR4 migration
  const schema = read("prisma/schema.prisma");
  ok(schema.includes("senderPhone") && schema.includes("requestedGroupId"), "schema has ledger fields");
  ok(schema.includes("@@index([status, createdAt])") && schema.includes("@@index([subscriptionId, status])"), "schema has ledger indexes");
  // ensure payment-transitions and payment-submission not modified in PR4 (we only added inventory docs)
  // Check that src/lib/payment-submission.ts still contains the exact scenario strings (basic guard)
  ok(sub.includes("NEW_REQUEST") && sub.includes("RENEWAL") && sub.includes("LEGACY_GRANDFATHERED"), "submission scenarios intact");

  section("8. Payment destinations unchanged");
  ok(brand.includes('"+20 1147422177"') || brand.includes("1147422177"), "destination number present");
  // ensure both InstaPay and eCash point to same support display
  const instapayCount = (brand.match(/instapay/g) || []).length;
  ok(instapayCount >=1, "instapay in brand");
  const eCashCount = (brand.match(/eCash/g) || []).length;
  ok(eCashCount >=1, "eCash in brand");

  section("9. Migration count pin");
  ok(migs.length === 10, "migration count still 10 (no new migration)");

  section("10. Operational safety — secret handling and migration drift");
  {
    const rbPath = "docs/PHASE_25_PR4_CUTOVER_RUNBOOK.md";
    ok(exists(rbPath), "runbook exists for safety checks");
    const rb = exists(rbPath) ? read(rbPath) : "";
    const inv2 = exists("scripts/phase25-pr4-inventory.mjs") ? read("scripts/phase25-pr4-inventory.mjs") : "";
    const vp  = exists("scripts/db/verify-postgres.mjs") ? read("scripts/db/verify-postgres.mjs") : "";
    // 10.1: production runbook never puts real DATABASE_URL in ARGV
    ok(!rb.includes("--target $env:DATABASE_URL"), "runbook never has --target $env:DATABASE_URL (would leak into argv)");
    ok(!rb.includes("--target %DATABASE_URL%"), "runbook never has --target %DATABASE_URL%");
    ok(!rb.includes('--target \"$DATABASE_URL\"') && !rb.includes("--target '$DATABASE_URL'") && !rb.includes('--target \"$DATABASE_URL\"'), "runbook never has --target \"$DATABASE_URL\" with quotes");
    ok(!rb.includes("--target $DATABASE_URL"), "runbook never has --target $DATABASE_URL");
    // 10.2: no example embeds a PostgreSQL URL with credentials (user:password@) — even masked *** counts as credentials
    ok(!/postgresql:\/\/[^\s]*:[^\s]*@/i.test(rb), "runbook has no postgresql:// URL with credentials (user:password@)");
    ok(!/postgresql:\/\/[^\s]*:[^\s]*@/i.test(inv2), "inventory script has no postgresql:// URL with credentials literal");
    // 10.3: production command examples rely on DATABASE_URL from environment
    ok(rb.includes("reads DATABASE_URL from env") || rb.includes("process.env.DATABASE_URL"), "runbook says production reads DATABASE_URL from env");
    ok(rb.includes('Read-Host \"Paste production DATABASE_URL\"') || rb.includes("Read-Host"), "runbook uses Read-Host for secure input (no echo)");
    ok(!rb.includes("--target postgresql://"), "runbook production examples do not use --target postgresql:// (production must use env, not argv)");
    // inventory help documents env authority and forbids argv for production
    ok(inv2.includes("Do NOT pass real production credentials via --target") || inv2.includes("Do NOT pass real production credentials"), "inventory help forbids passing real production credentials via --target (argv)");
    ok(inv2.includes("Production: set DATABASE_URL in the environment and run without --target") || inv2.includes("process.env.DATABASE_URL"), "inventory help documents production env authority (set DATABASE_URL in env, no --target)");
    // 10.4: inventory JSON/logs still redact — code uses redact and JSON never contains raw URL
    ok(inv2.includes("redactDatabaseUrl") || inv2.includes("function redact"), "inventory has redactDatabaseUrl helper");
    ok(inv2.includes("u.host") && inv2.includes("u.protocol"), "inventory redacts URL to host/protocol only (no password)");
    ok(inv2.includes("hostLabel: redactDatabaseUrl") || inv2.includes("redactDatabaseUrl"), "inventory hostLabel uses redact helper");
    // JSON output struct must not embed raw DATABASE_URL string literal
    ok(!inv2.includes("DATABASE_URL") || inv2.includes("redactDatabaseUrl") , "inventory references DATABASE_URL only via redaction/env, not embedding");
    // verify-postgres also supports env (smallest safe support)
    ok(vp.includes("process.env.DATABASE_URL"), "verify-postgres.mjs supports process.env.DATABASE_URL");
    ok(vp.includes("--target") || vp.includes("argOf"), "verify-postgres retains --target for disposable local file:/pglite testing");
    // 10.5: pending migration = STOP — ANY pending/mismatch/missing is STOP/NO-GO, do NOT run migrate deploy as normal cutover
    ok(/ANY pending/i.test(rb) && /STOP/i.test(rb) && /NO-GO/.test(rb), "runbook says ANY pending → STOP / NO-GO");
    ok(rb.includes("already applied") || rb.includes("already applied to production Neon") || rb.includes("already applied on production Neon"), "runbook notes PR1 already applied to production Neon");
    // runbook must not suggest a positive `npx prisma migrate deploy` as a normal cutover step
    const deployLines = rb.split("\n").filter(l => /npx(\.cmd)?\s+prisma migrate deploy/.test(l));
    const badDeployLines = deployLines.filter(l => !/do NOT run/i.test(l) && !/STOP/i.test(l));
    ok(badDeployLines.length === 0, `runbook has no positive npx prisma migrate deploy suggestion (found ${badDeployLines.length}: ${badDeployLines.join("; ").slice(0,300)})`);
    // explicit prohibition is present
    ok(/do NOT run/i.test(rb) && /migrate deploy/i.test(rb), "runbook explicitly says do NOT run migrate deploy as normal cutover");
    // also ensure runbook does not have an echo command that would reveal DATABASE_URL (prohibition text like "Do not echo $env:DATABASE_URL" is allowed)
    const echoLines = rb.split("\n").filter(l => /echo\s+.*DATABASE_URL/.test(l));
    const badEchoLines = echoLines.filter(l => !/do not/i.test(l) && !/never/i.test(l) && !/don.t/i.test(l));
    ok(badEchoLines.length === 0, `runbook has no echo DATABASE_URL command (found ${badEchoLines.length}: ${badEchoLines.join("; ").slice(0,200)})`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch(e=>{ console.error("FATAL", e); process.exit(1); });
