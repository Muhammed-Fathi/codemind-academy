// CodeMind Academy — Phase 25 PR2b: the FULL CHAIN over real HTTP.
//
// THE CONTRACT (spec §46–§55): the complete journey a payment takes —
// PR2a submission (POST /api/enroll) → admin decision (POST
// /api/admin/payments/[id]/approve | reject) → entitlement — is exercised
// END-TO-END with:
//   * a REAL `node:http` server + REAL `fetch` requests (the only
//     substitution is transport: `next/server` + `next/headers` shims, the
//     same contract every verify-phase script in this repo uses);
//   * a REAL node:sqlite database built from the REAL migration history
//     (scripts/lib/migrate-sqlite.mjs + sqlite-prisma-lite — real SQL, real
//     rows, real UNIQUE constraints);
//   * the SHIPPED route handlers + SHIPPED services compiled byte-for-byte
//     (enroll, import, approve, reject, the queue read, payment-submission,
//     payment-transitions, subscription-entitlement, notify, enrollment,
//     auth, api, i18n).
//
// Chains proven over the wire:
//   A. new student: enroll → PENDING request (no group assignment) →
//      approve → payment APPROVED + reviewer fields, Subscription ACTIVE
//      with correct dates, Student.groupId assigned, audit + truthful
//      "activated" notification; re-approve → 409 INVALID_TRANSITION.
//   B. rejection: missing/blank reason → 400 INVALID_REJECTION_REASON;
//      valid reason → stored normalized, entitlement byte-for-byte
//      untouched, "rejected" notification; re-decide → 409.
//   C. grandfathered: legacy seated student enrolls (LEGACY_GRANDFATHERED,
//      no Subscription row) → approve → the row is BORN ACTIVE + linked,
//      group preserved, truthful "confirmed" notification.
//   D. stale pair: two submissions; the older one is 409 STALE_PAYMENT
//      (nothing mutated); the newest approves.
//   E. security: 401 anonymous, 403 non-admin, client body spoofing
//      (userId/studentId/subscriptionId/reviewedByUserId/groupId) is
//      IGNORED — the decision derives everything from the Payment row +
//      the authenticated session; error bodies never leak DB internals.
//   F. legacy context failures over HTTP: GROUP_REQUIRED (with the admin
//      override recovery succeeding) and PLAN_REQUIRED.
//   G. capacity: group fills to capacity after two submissions → both
//      approvals are GROUP_FULL (payments stay PENDING, zero review
//      fields); the seated member's same-group renewal at capacity still
//      APPROVES (RENEWAL, no seat consumed).
//   H. import: an xlsx that REQUESTS decision statuses (APPROVED /
//      REJECTED) creates ONLY PENDING rows (`importedAs: "PENDING"`),
//      never mints a decided state, never touches entitlements.
//   + the queue read (GET /api/admin/payments) reflects the post-decision
//     state and is admin-only.
//
// Run: node tests/payment-lifecycle-phase25-pr2b-fullchain.test.js
// Exit: 0 = all pass, 1 = failure. Requires Node >= 22.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner, repo convention */
const crypto = require("crypto");
const http = require("http");
const { execFileSync } = require("child_process");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const REPO = path.join(__dirname, "..");

process.env.SECURITY_HASH_SECRET =
  process.env.SECURITY_HASH_SECRET || "pr2b-fullchain-verifier-secret-0123456789abcdef";
process.env.DATABASE_URL = "file:./db/pr2b-fullchain.db"; // sqlite → advisory lock is a deliberate no-op

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
  ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)} want ${JSON.stringify(b)})`);
const section = (t) => console.log(`\n${t}`);

const mig = require(path.join(REPO, "scripts/lib/migrate-sqlite.mjs"));
const { createSqlitePrisma } = require(path.join(REPO, "scripts/lib/sqlite-prisma-lite.mjs"));
const XLSX = require(path.join(REPO, "node_modules/xlsx"));

// ---------------------------------------------------------------------------
// Real database: base DDL + every real migration.
// ---------------------------------------------------------------------------
const rawDb = new DatabaseSync(":memory:");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "pr2b-fullchain: " });
const client = createSqlitePrisma({
  db: rawDb,
  schemaPath: path.join(REPO, "prisma", "schema.prisma"),
});
globalThis.__CM_DB_CLIENT__ = client;

// ---------------------------------------------------------------------------
// Compile the shipped modules.
// ---------------------------------------------------------------------------
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p25pr2b-chain-"));
const MODULES = [
  "src/lib/env.ts",
  "src/lib/security.ts",
  "src/lib/rate-limit.ts",
  "src/lib/i18n-dict.ts",
  "src/lib/i18n-dict-2026.ts",
  "src/lib/i18n-core.ts",
  "src/lib/i18n-server.ts",
  "src/lib/registration.ts",
  "src/lib/school-type.ts",
  "src/lib/enrollment.ts",
  "src/lib/api.ts",
  "src/lib/auth.ts",
  "src/lib/notify.ts",
  "src/lib/db-serialization.ts",
  "src/lib/payment-submission.ts",
  "src/lib/payment-transitions.ts",
  "src/lib/subscription-entitlement.ts",
  "src/app/api/enroll/route.ts",
  "src/app/api/admin/payments/import/route.ts",
  "src/app/api/admin/payments/[id]/approve/route.ts",
  "src/app/api/admin/payments/[id]/reject/route.ts",
  "src/app/api/admin/payments/route.ts",
];
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
    files: MODULES.map((f) => path.join(REPO, f)),
  })
);
try {
  execFileSync(
    process.execPath,
    [require.resolve("typescript/bin/tsc"), "-p", path.join(OUT, "tsconfig.json")],
    { cwd: REPO, stdio: "pipe" }
  );
} catch (e) {
  console.error(String(e.stdout || ""));
  console.error(String(e.stderr || e.message || e));
}
const EMIT = path.join(OUT, "src");
for (const f of MODULES) {
  if (!fs.existsSync(path.join(OUT, f.replace(/\.ts$/, ".js")))) throw new Error(`tsc did not emit ${f}`);
}

// ---------------------------------------------------------------------------
// Shims (transport only — everything under test runs byte-for-byte).
// ---------------------------------------------------------------------------
const dbShim = path.join(OUT, "__db-shim.js");
fs.writeFileSync(dbShim, 'module.exports = { get db() { return globalThis.__CM_DB_CLIENT__; } };\n');
fs.writeFileSync(
  path.join(OUT, "__next-server-shim.js"),
  [
    "class NextResponse {",
    "  constructor(body, init = {}) {",
    "    this.status = init.status ?? 200;",
    "    this._headers = new Map();",
    "    for (const [k, v] of Object.entries(init.headers || {})) this._headers.set(String(k).toLowerCase(), String(v));",
    "    this._body = body; this._json = undefined;",
    "  }",
    "  static json(data, init = {}) {",
    "    const merged = Object.assign({ 'content-type': 'application/json' }, init.headers || {});",
    "    const r = new NextResponse(JSON.stringify(data), { status: init.status ?? 200, headers: merged });",
    "    r._json = data; return r;",
    "  }",
    "  get headers() { const m = this._headers; return { get: (k) => m.get(String(k).toLowerCase()) ?? null, forEach: (fn) => m.forEach((v, k) => fn(v, k)) }; }",
    "  async json() { return this._json !== undefined ? this._json : JSON.parse(Buffer.from(this._body || []).toString('utf8')); }",
    "}",
    "class NextRequest {}",
    "module.exports = { NextResponse, NextRequest };",
  ].join("\n")
);
fs.writeFileSync(
  path.join(OUT, "__next-headers-shim.js"),
  [
    "const parse = () => {",
    "  const ctx = globalThis.__CM_REQ_CTX__ || { cookie: {}, headers: {} };",
    "  const store = {",
    "    get(name) { const v = ctx.cookie ? ctx.cookie[name] : undefined; return v === undefined ? undefined : { value: v }; },",
    "    set(name, value, opts = {}) {",
    "      const jar = globalThis.__CM_RESP_COOKIES__ || (globalThis.__CM_RESP_COOKIES__ = []);",
    "      const parts = [`${name}=${value}`, 'Path=' + (opts.path || '/')];",
    "      if (opts.httpOnly) parts.push('HttpOnly');",
    "      if (opts.sameSite) parts.push('SameSite=' + String(opts.sameSite).charAt(0).toUpperCase() + String(opts.sameSite).slice(1));",
    "      if (opts.secure) parts.push('Secure');",
    "      if (opts.expires) parts.push('Expires=' + new Date(opts.expires).toUTCString());",
    "      jar.push(parts.join('; '));",
    "      if (ctx.cookie) ctx.cookie[name] = value;",
    "    },",
    "    delete(name) {",
    "      const jar = globalThis.__CM_RESP_COOKIES__ || (globalThis.__CM_RESP_COOKIES__ = []);",
    "      jar.push(`${name}=; Path=/; Max-Age=0`);",
    "      if (ctx.cookie) delete ctx.cookie[name];",
    "    },",
    "  };",
    "  return { cookies: () => store, headers: () => new Headers(ctx.headers || {}) };",
    "};",
    "module.exports = { cookies: async () => parse().cookies(), headers: async () => parse().headers() };",
  ].join("\n")
);
const originalResolve = Module._resolveFilename;
const repoRequire = require("module").createRequire(path.join(REPO, "package.json"));
const xlsxPath = repoRequire.resolve("xlsx");
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/db") return dbShim;
  if (request === "next/server") return path.join(OUT, "__next-server-shim.js");
  if (request === "next/headers") return path.join(OUT, "__next-headers-shim.js");
  if (request === "xlsx") return xlsxPath;
  const m = /^@\/lib\/([\w-]+)$/.exec(request);
  if (m) {
    const compiled = path.join(EMIT, "lib", `${m[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  return originalResolve.call(this, request, ...rest);
};
const route = (p) => require(path.join(EMIT, "app", "api", p));

// ---------------------------------------------------------------------------
// Seed real identities + real sessions.
// ---------------------------------------------------------------------------
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const now = Date.now();
const db = rawDb;
function seedUser(id, email, role) {
  db.prepare(
    `INSERT INTO "User" ("id","email","password","name","role","isActive","status","createdAt","updatedAt") VALUES (?,?,?,?,?,1,'ACTIVE',?,?)`
  ).run(id, email, "x", `${role} ${id}`, role, now, now);
}
function seedSession(sessionId, userId, token) {
  db.prepare(
    `INSERT INTO "UserSession" ("id","userId","tokenHash","deviceHash","createdAt","lastSeenAt","expiresAt") VALUES (?,?,?,?,?,?,?)`
  ).run(sessionId, userId, sha256(token), "device-verifier", now, now, now + 86400000);
}
function seedStudent(id, userId, groupId) {
  db.prepare(
    `INSERT INTO "Student" ("id","userId","grade","schoolType","groupId","createdAt","updatedAt") VALUES (?,?,?,?,?, ?,?)`
  ).run(id, userId, "2nd Secondary", "LANGUAGE", groupId ?? null, now, now);
}
function seedGroup(id, name, courseId, capacity) {
  // Phase 26B — fixture groups carry the LANGUAGE audience: every seeded
  // student's schoolType is LANGUAGE, so the exact-match eligibility rule
  // behaves exactly as before for this suite.
  db.prepare(
    `INSERT INTO "Group" ("id","name","courseId","capacity","isActive","trackScope","createdAt","updatedAt") VALUES (?,?,?,?,1,'LANGUAGE',?,?)`
  ).run(id, name, courseId, capacity, now, now);
}

seedUser("u-admin", "admin@codemind.academy", "ADMIN");
seedSession("sess-admin", "u-admin", "admin-token");
for (const who of ["norm", "rej", "grand", "stale", "full1", "full2", "seat1", "fill2", "spoof", "leg1", "leg2", "imp"]) {
  seedUser(`u-${who}`, `${who}@students.test`, "STUDENT");
  seedSession(`sess-${who}`, `u-${who}`, `${who}-token`);
}
seedStudent("s-norm", "u-norm", null);
seedStudent("s-rej", "u-rej", null);
seedStudent("s-grand", "u-grand", "g-main"); // legacy seated, NO Subscription row
seedStudent("s-stale", "u-stale", null);
seedStudent("s-full1", "u-full1", null);
seedStudent("s-full2", "u-full2", null);
seedStudent("s-seat1", "u-seat1", "g-full"); // seated member with a live sub
seedStudent("s-fill2", "u-fill2", null); // the filler that completes g-full
seedStudent("s-spoof", "u-spoof", null);
seedStudent("s-leg1", "u-leg1", null);
seedStudent("s-leg2", "u-leg2", "g-main"); // legacy seated, no row
seedStudent("s-imp", "u-imp", null);

seedGroup("g-main", "Main Group", "c-one", 20);
seedGroup("g-full", "Full Group", "c-one", 2);
db.prepare(
  `INSERT INTO "Course" ("id","slug","name","nameAr","description","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?)`
).run("c-one", "course-one", "Course One", "كورس واحد", "d", now, now);
db.prepare(
  `INSERT INTO "SubscriptionPlan" ("id","name","nameAr","durationMonths","price","isPromo","createdAt") VALUES (?,?,?,?,?,0,?)`
).run("p-monthly", "Monthly", "شهري", 1, 200, now);

// s-seat1's live entitlement (valid at decision time): an ACTIVE subscription.
const seatSubId = "sub-seat1";
db.prepare(
  `INSERT INTO "Subscription" ("id","studentId","planId","status","startDate","endDate","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?)`
).run(seatSubId, "s-seat1", "p-monthly", "ACTIVE", now - 200 * 86400000, now + 11 * 86400000, now, now);

// ---------------------------------------------------------------------------
// Real HTTP server (gate harness pattern).
// ---------------------------------------------------------------------------
const parseCookies = (header) => {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
};

const handlers = {
  "POST /api/enroll": (req) => route("enroll/route.js").POST(req),
  "GET /api/admin/payments": (req) => route("admin/payments/route.js").GET(req),
  "POST /api/admin/payments/[id]/approve": (req, url) =>
    route("admin/payments/[id]/approve/route.js").POST(req, {
      params: Promise.resolve({ id: url.pathname.match(/^\/api\/admin\/payments\/([^/]+)\/approve$/)[1] }),
    }),
  "POST /api/admin/payments/[id]/reject": (req, url) =>
    route("admin/payments/[id]/reject/route.js").POST(req, {
      params: Promise.resolve({ id: url.pathname.match(/^\/api\/admin\/payments\/([^/]+)\/reject$/)[1] }),
    }),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  globalThis.__CM_RESP_COOKIES__ = [];
  globalThis.__CM_REQ_CTX__ = {
    cookie: parseCookies(req.headers.cookie),
    headers: { "user-agent": "pr2b-fullchain" },
  };
  let body = {};
  if (req.method !== "GET") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
  }
  const request = {
    url: `http://127.0.0.1${req.url}`,
    method: req.method,
    headers: new Headers(Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === "string"))),
    json: async () => body,
    formData: async () => new Map(),
  };
  const idMatch = url.pathname.match(/^\/api\/admin\/payments\/([^/]+)\/(approve|reject)$/);
  const key = idMatch
    ? `${req.method} /api/admin/payments/[id]/${idMatch[2]}`
    : `${req.method} ${url.pathname}`;
  const handler = handlers[key];
  if (!handler) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  try {
    const out = await handler(request, url);
    res.statusCode = out.status ?? 200;
    if (out && out.headers && typeof out.headers.forEach === "function") {
      out.headers.forEach((value, key2) => {
        if (String(key2).toLowerCase() === "set-cookie") return;
        res.setHeader(key2, value);
      });
    }
    const payload =
      typeof out._body === "string" || Buffer.isBuffer(out._body) ? out._body : JSON.stringify(out._body ?? null);
    res.end(payload);
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
  }
});

async function main() {
const BASE = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
});
const call = async (method, p, { body, cookie, headers } = {}) => {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await r.json();
  } catch {
    json = null;
  }
  return { status: r.status, json };
};

// Raw-DB readers (the source of truth for the assertions).
const q1 = (sql, ...v) => db.prepare(sql).get(...v);
const qAll = (sql, ...v) => db.prepare(sql).all(...v);
const paymentRow = (id) => q1(`SELECT * FROM "Payment" WHERE "id" = ?`, id);
const studentRow = (id) => q1(`SELECT * FROM "Student" WHERE "id" = ?`, id);
const subRow = (id) => q1(`SELECT * FROM "Subscription" WHERE "id" = ?`, id);

const enroll = (cookie, extra = {}) =>
  call("POST", "/api/enroll", {
    cookie,
    body: {
      courseId: "c-one",
      groupId: "g-main",
      planId: "p-monthly",
      method: "INSTAPAY",
      senderPhone: "01012345678",
      reference: `FULLCHAIN-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      ...extra,
    },
  });
const approve = (paymentId, cookie, body) => call("POST", `/api/admin/payments/${paymentId}/approve`, { cookie, body });
const reject = (paymentId, cookie, body) => call("POST", `/api/admin/payments/${paymentId}/reject`, { cookie, body });

// ---------------------------------------------------------------------------
// Direct handler drive (import) — same transport stub, real handler.
// ---------------------------------------------------------------------------
const driveImport = async (cookie, file) => {
  globalThis.__CM_RESP_COOKIES__ = [];
  globalThis.__CM_REQ_CTX__ = { cookie: parseCookies(cookie), headers: { "user-agent": "pr2b-fullchain" } };
  const req = {
    url: "/api/admin/payments/import",
    method: "POST",
    headers: new Headers({ "content-type": "multipart/form-data" }),
    json: async () => ({}),
    formData: async () => new Map([["file", file]]),
  };
  const out = await route("admin/payments/import/route.js").POST(req);
  return { status: out.status ?? 200, json: out._json !== undefined ? out._json : JSON.parse(out._body) };
};

// ===========================================================================
try {
  // =========================================================================
  section("A. New student: submit → approve (the full happy chain)");
  // =========================================================================
  {
    const t0 = Date.now();
    const sub = await enroll("cm_session=norm-token");
    eq(sub.status, 200, "submission is accepted");
    eq(sub.json.scenario, "NEW_REQUEST", "submission scenario is NEW_REQUEST");
    eq(sub.json.payment.status, "PENDING", "the request is PENDING");
    const payId = sub.json.payment.id;
    ok(payId, "the submission returns the payment id");
    eq(studentRow("s-norm").groupId, null, "submission does NOT assign the group (PR2a contract)");
    eq(q1(`SELECT "status" FROM "Subscription" WHERE "id" = ?`, sub.json.subscription.id).status, "PENDING", "the singleton is PENDING (not ACTIVE)");

    const queue1 = await call("GET", "/api/admin/payments", { cookie: "cm_session=admin-token" });
    ok(queue1.status === 200, "admin queue read is 200");
    ok(JSON.stringify(queue1.json).includes(payId), "the queue contains the new PENDING request");

    const ap = await approve(payId, "cm_session=admin-token", {});
    eq(ap.status, 200, "approval is 200");
    ok(ap.json && ap.json.ok === true, "approval body is ok:true");
    eq(ap.json.scenario, "FIRST_ACTIVATION", "scenario is FIRST_ACTIVATION over the wire");
    eq(ap.json.accessNotification, "ACTIVATED", "truthful notification kind: ACTIVATED");
    eq(ap.json.payment.reviewedByUserId, "u-admin", "reviewer is the SESSION admin (not the body)");

    const p = paymentRow(payId);
    eq(p.status, "APPROVED", "payment is APPROVED in the DB");
    eq(p.reviewedByUserId, "u-admin", "reviewedByUserId persisted");
    ok(p.reviewedAt, "reviewedAt persisted");
    eq(p.rejectionReason, null, "rejectionReason is null");
    const s = subRow(p.subscriptionId);
    eq(s.status, "ACTIVE", "the SAME subscription row is now ACTIVE");
    eq(s.planId, "p-monthly", "the requested plan is authoritative");
    const endMs = new Date(s.endDate).getTime();
    ok(endMs > t0 + 27 * 86400000 && endMs < t0 + 33 * 86400000, `endDate ≈ now + 1 plan month (got offset ${Math.round((endMs - t0) / 86400000)}d)`);
    eq(studentRow("s-norm").groupId, "g-main", "Student.groupId was assigned to the requested (same-course) group");
    const audit = q1(
      `SELECT * FROM "AuditLog" WHERE "entityId" = ? AND "action" = 'PAYMENT_APPROVED'`,
      payId
    );
    ok(audit, "a PAYMENT_APPROVED audit row exists (inside the transaction)");
    eq(audit.userId, "u-admin", "audit carries the deciding admin");
    ok(JSON.parse(audit.details).scenario === "FIRST_ACTIVATION", "audit captures the scenario");
    const notif = q1(
      `SELECT * FROM "Notification" WHERE "userId" = 'u-norm' AND "type" = 'PAYMENT_APPROVED'`
    );
    ok(notif, "a PAYMENT_APPROVED notification reached the student");
    ok(!/renew|renewed/i.test(notif.message), "the notification is the 'activated' text, never 'renewed'");

    // Entitlement is now real: the student's access reads ACTIVE.
    const q2 = await call("GET", "/api/admin/payments", { cookie: "cm_session=admin-token" });
    ok(q2.status === 200, "the queue read is 200 after the decision");
    const decided = (Array.isArray(q2.json?.payments) ? q2.json.payments : []).find((x) => x.id === payId);
    ok(decided, "the queue still lists the decided payment");
    if (decided) eq(decided.status, "APPROVED", "the queue read reflects APPROVED post-decision");

    const re = await approve(payId, "cm_session=admin-token", {});
    eq(re.status, 409, "re-approving is 409");
    eq(re.json.code, "INVALID_TRANSITION", "re-approve maps to INVALID_TRANSITION");
    eq(paymentRow(payId).reviewedByUserId, "u-admin", "the forbidden repeat did not re-write the reviewer");
  }

  // =========================================================================
  section("B. Rejection: reason validation + entitlement preservation");
  // =========================================================================
  {
    const sub = await enroll("cm_session=rej-token");
    const payId = sub.json.payment.id;
    const subId = sub.json.subscription.id;

    eq((await reject(payId, "cm_session=admin-token", {})).status, 400, "missing reason → 400");
    eq((await reject(payId, "cm_session=admin-token", { reason: "   " })).status, 400, "blank reason → 400");
    eq(
      (await reject(payId, "cm_session=admin-token", { reason: "x".repeat(501) })).status,
      400,
      "over-500-char reason → 400"
    );
    eq(paymentRow(payId).status, "PENDING", "failed rejections leave the payment PENDING");

    const rj = await reject(payId, "cm_session=admin-token", { reason: "  Bank reference   does not match " });
    eq(rj.status, 200, "a valid reason is accepted");
    const p = paymentRow(payId);
    eq(p.status, "REJECTED", "payment is REJECTED");
    eq(p.rejectionReason, "Bank reference does not match", "reason normalized (trim + collapse) and stored");
    eq(p.reviewedByUserId, "u-admin", "reviewer persisted on rejection");
    eq(subRow(subId).status, "PENDING", "the subscription was NEVER activated by a rejection");
    eq(studentRow("s-rej").groupId, null, "no group assigned by a rejection");
    const notif = q1(`SELECT * FROM "Notification" WHERE "userId" = 'u-rej' AND "type" = 'PAYMENT_REJECTED'`);
    ok(notif, "a PAYMENT_REJECTED notification reached the student");
    ok(notif.message.includes("Bank reference does not match"), "the rejection notification carries the admin's reason");

    eq((await reject(payId, "cm_session=admin-token", { reason: "again" })).json.code, "INVALID_TRANSITION", "re-rejecting → INVALID_TRANSITION");
    eq((await approve(payId, "cm_session=admin-token", {})).json.code, "INVALID_TRANSITION", "approving a rejected payment → INVALID_TRANSITION");
    eq(paymentRow(payId).rejectionReason, "Bank reference does not match", "the original reason is preserved (no overwrite)");
  }

  // =========================================================================
  section("C. Grandfathered: legacy seated student, no Subscription row");
  // =========================================================================
  {
    eq(q1(`SELECT COUNT(*) AS c FROM "Subscription" WHERE "studentId" = 's-grand'`).c, 0, "precondition: no Subscription row exists");
    const sub = await enroll("cm_session=grand-token");
    eq(sub.status, 200, "the legacy student can still submit");
    eq(sub.json.scenario, "LEGACY_GRANDFATHERED", "submission scenario is LEGACY_GRANDFATHERED");
    eq(sub.json.subscription, null, "NO Subscription row was manufactured (PR2a audit fix)");
    const payId = sub.json.payment.id;
    eq(paymentRow(payId).subscriptionId, null, "the payment carries subscriptionId = NULL");
    eq(q1(`SELECT COUNT(*) AS c FROM "Subscription" WHERE "studentId" = 's-grand'`).c, 0, "still no row after submission (access stays live)");

    const ap = await approve(payId, "cm_session=admin-token", {});
    eq(ap.status, 200, "the legacy approval succeeds over the wire");
    eq(ap.json.scenario, "GRANDFATHERED_ACTIVATION", "scenario is GRANDFATHERED_ACTIVATION");
    eq(ap.json.accessNotification, "CONFIRMED", "truthful kind: CONFIRMED (access already existed)");
    const p = paymentRow(payId);
    eq(p.status, "APPROVED", "payment APPROVED");
    ok(p.subscriptionId, "Payment.subscriptionId is now linked");
    const s = subRow(p.subscriptionId);
    eq(s.status, "ACTIVE", "the singleton row was BORN ACTIVE on approval");
    eq(s.planId, "p-monthly", "approved plan set");
    const rows = qAll(`SELECT * FROM "Subscription" WHERE "studentId" = 's-grand'`);
    eq(rows.length, 1, "exactly ONE row (the singleton)");
    eq(studentRow("s-grand").groupId, "g-main", "the group was preserved (no seat churn)");
    const notif = q1(`SELECT * FROM "Notification" WHERE "userId" = 'u-grand' AND "type" = 'PAYMENT_APPROVED'`);
    ok(notif && !/course.*open|newly/i.test(notif.message), "the notification is 'confirmed/valid', never 'course newly opened'");
  }

  // =========================================================================
  section("D. Stale pair: newest pending request wins over the wire");
  // =========================================================================
  {
    const a = await enroll("cm_session=stale-token");
    const b = await enroll("cm_session=stale-token");
    eq(a.status, 200 && b.status, 200, "both submissions are accepted");
    const rows = qAll(`SELECT * FROM "Payment" WHERE "userId" = 'u-stale' AND "status" = 'PENDING' ORDER BY "createdAt" DESC, "id" DESC`);
    eq(rows.length, 2, "two PENDING requests exist");
    const [newest, older] = [rows[0], rows[1]];

    const staleRes = await approve(older.id, "cm_session=admin-token", {});
    eq(staleRes.status, 409, "approving the OLDER request is refused (409)");
    eq(staleRes.json.code, "STALE_PAYMENT", "…with STALE_PAYMENT");
    const op = paymentRow(older.id);
    eq(op.status, "PENDING", "the stale request stays PENDING (history preserved)");
    eq(op.reviewedAt, null, "no review fields on the stale attempt");

    const won = await approve(newest.id, "cm_session=admin-token", {});
    eq(won.status, 200, "the NEWEST request approves");
    eq(paymentRow(newest.id).status, "APPROVED", "newest is APPROVED");
    eq(paymentRow(older.id).status, "PENDING", "the older request is left PENDING — nothing auto-rejected");
  }

  // =========================================================================
  section("E. Security: auth + anti-spoofing over the wire");
  // =========================================================================
  {
    const sub = await enroll("cm_session=spoof-token");
    const payId = sub.json.payment.id;

    eq((await approve(payId, null, {})).status, 401, "no session → 401");
    eq((await approve(payId, "cm_session=spoof-token", {})).status, 403, "student session → 403");
    eq((await reject(payId, "cm_session=spoof-token", { reason: "x" })).status, 403, "reject: student session → 403");
    eq((await call("GET", "/api/admin/payments", { cookie: "cm_session=spoof-token" })).status, 403, "queue read: student session → 403");

    // The client body may carry ANY of these — every one must be ignored.
    const sp = await approve(
      payId,
      "cm_session=admin-token",
      {
        userId: "u-rej",
        studentId: "s-rej",
        subscriptionId: "sub-ghost",
        reviewedByUserId: "u-evil",
        reviewedAt: "2020-01-01T00:00:00.000Z",
        status: "REJECTED",
        scenario: "RENEWAL",
      }
    );
    eq(sp.status, 200, "the decision itself succeeds (spoofed fields are ignored, not fatal)");
    eq(sp.json.payment.userId, "u-spoof", "the decision acts on the PAYMENT's user, not the body");
    eq(sp.json.payment.reviewedByUserId, "u-admin", "reviewedByUserId = the session admin, never the body");
    eq(studentRow("s-spoof").groupId, "g-main", "group = the request's own intent (same course), not the body's groupId");
    const p = paymentRow(payId);
    eq(p.reviewedByUserId, "u-admin", "persisted reviewer is the session admin");
    eq(p.subscriptionId, sub.json.subscription.id, "subscriptionId = the REAL singleton, not the body's ghost");

    // Error bodies: deterministic code + localized message, no DB internals.
    const errRes = await approve("ghost-payment-id", "cm_session=admin-token", {});
    eq(errRes.status, 404, "unknown payment → 404");
    eq(errRes.json.code, "PAYMENT_NOT_FOUND", "…with PAYMENT_NOT_FOUND");
    ok(typeof errRes.json.error === "string" && !/prisma|sqlite|E1002|SQL/i.test(errRes.json.error), "the error message is clean (no DB internals)");
  }

  // =========================================================================
  section("F. Legacy context failures over HTTP (GROUP_REQUIRED + override, PLAN_REQUIRED)");
  // =========================================================================
  {
    // F1: legacy PENDING payment with NO group intent (direct-inserted legacy row).
    db.prepare(
      `INSERT INTO "Subscription" ("id","studentId","planId","status","createdAt","updatedAt") VALUES (?,?,?,?,?,?)`
    ).run("sub-leg1", "s-leg1", "p-monthly", "PENDING", now, now);
    db.prepare(
      `INSERT INTO "Payment" ("id","userId","subscriptionId","amount","method","status","reference","senderPhone","requestedGroupId","requestedPlanId","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run("pay-leg1", "u-leg1", "sub-leg1", 200, "INSTAPAY", "PENDING", "LEG-1", "01011112222", null, "p-monthly", now - 3600000, now);

    const g1 = await approve("pay-leg1", "cm_session=admin-token", {});
    eq(g1.status, 409, "no group intent anywhere → 409");
    eq(g1.json.code, "GROUP_REQUIRED", "…with GROUP_REQUIRED (fail safe)");
    eq(paymentRow("pay-leg1").status, "PENDING", "the payment stays PENDING for the admin to fix the context");
    eq(studentRow("s-leg1").groupId, null, "nothing was assigned");

    // The admin override IS the recovery path (spec §21).
    const g1b = await approve("pay-leg1", "cm_session=admin-token", { groupId: "g-main" });
    eq(g1b.status, 200, "the override recovers the decision");
    eq(studentRow("s-leg1").groupId, "g-main", "the override assigns the seat");
    eq(paymentRow("pay-leg1").status, "APPROVED", "the recovered payment is APPROVED");

    // F2: legacy payment with a group but NO plan intent, grandfathered (no row).
    db.prepare(
      `INSERT INTO "Payment" ("id","userId","subscriptionId","amount","method","status","reference","senderPhone","requestedGroupId","requestedPlanId","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run("pay-leg2", "u-leg2", null, 200, "INSTAPAY", "PENDING", "LEG-2", "01033334444", "g-main", null, now - 1800000, now);
    const g2 = await approve("pay-leg2", "cm_session=admin-token", {});
    eq(g2.status, 409, "legacy row without plan intent + no valid current plan → 409");
    eq(g2.json.code, "PLAN_REQUIRED", "…with PLAN_REQUIRED (no false activation)");
    eq(q1(`SELECT COUNT(*) AS c FROM "Subscription" WHERE "studentId" = 's-leg2'`).c, 0, "no row manufactured by a refused plan");
    eq(paymentRow("pay-leg2").status, "PENDING", "the payment stays PENDING");
  }

  // =========================================================================
  section("G. Capacity: fill after submission → GROUP_FULL; same-group renewal at capacity approves");
  // =========================================================================
  {
    // g-full (cap 2): s-seat1 (seated, live sub) + s-fill2 (filler) = FULL.
    // s-full1/s-full2 submitted while there was room; the group filled later.
    const f1 = await call("POST", "/api/enroll", {
      cookie: "cm_session=full1-token",
      body: {
        courseId: "c-one",
        groupId: "g-full",
        planId: "p-monthly",
        method: "INSTAPAY",
        senderPhone: "01055556666",
        reference: "FULL-1",
      },
    });
    const f2 = await call("POST", "/api/enroll", {
      cookie: "cm_session=full2-token",
      body: {
        courseId: "c-one",
        groupId: "g-full",
        planId: "p-monthly",
        method: "INSTAPAY",
        senderPhone: "01077778888",
        reference: "FULL-2",
      },
    });
    eq(f1.status, 200 && f2.status, 200, "both submitted while a seat was open");
    // The seated member's SAME-GROUP renewal is also submitted while there is
    // (still) room — the point is what happens when the group fills AFTER.
    const rn = await call("POST", "/api/enroll", {
      cookie: "cm_session=seat1-token",
      body: {
        courseId: "c-one",
        groupId: "g-full",
        planId: "p-monthly",
        method: "INSTAPAY",
        senderPhone: "01099990000",
        reference: "SEAT-1",
      },
    });
    eq(rn.status, 200, "the seated member can submit a renewal while a seat is open");
    eq(rn.json.scenario, "RENEWAL", "submission scenario is RENEWAL (live entitlement)");
    db.prepare(`UPDATE "Student" SET "groupId" = 'g-full', "updatedAt" = ? WHERE "id" = 's-fill2'`).run(now);
    eq(q1(`SELECT COUNT(*) AS c FROM "Student" WHERE "groupId" = 'g-full'`).c, 2, "the group is now FULL (2/2) — after all submissions");

    const r1 = await approve(f1.json.payment.id, "cm_session=admin-token", {});
    eq(r1.status, 409, "approval into the full group → 409");
    eq(r1.json.code, "GROUP_FULL", "…with GROUP_FULL (capacity enforced at APPROVAL, not only submission)");
    const p1 = paymentRow(f1.json.payment.id);
    eq(p1.status, "PENDING", "the payment remains PENDING");
    eq(p1.reviewedAt, null, "no review fields");
    eq(p1.reviewedByUserId, null, "no reviewer");
    eq(q1(`SELECT "status" FROM "Subscription" WHERE "studentId" = 's-full1'`).status, "PENDING", "no Subscription mutation");
    eq(studentRow("s-full1").groupId, null, "no group mutation");
    eq(q1(`SELECT COUNT(*) AS c FROM "AuditLog" WHERE "entityId" = ?`, f1.json.payment.id).c, 0, "no audit for the refused seat");

    const r2 = await approve(f2.json.payment.id, "cm_session=admin-token", {});
    eq(r2.json.code, "GROUP_FULL", "the second contender is refused the same way");

    // The seated member's SAME-GROUP renewal at capacity still approves.
    const ra = await approve(rn.json.payment.id, "cm_session=admin-token", {});
    eq(ra.status, 200, "same-group renewal at FULL capacity APPROVES (no seat consumed)");
    eq(ra.json.scenario, "RENEWAL", "decision scenario is RENEWAL");
    eq(ra.json.accessNotification, "RENEWED", "truthful kind: RENEWED");
    const subAfter = subRow(seatSubId);
    eq(subAfter.status, "ACTIVE", "the live entitlement stays ACTIVE");
    ok(new Date(subAfter.endDate).getTime() > now + 10 * 86400000, "endDate STACKED beyond the prior (future) endDate");
    eq(q1(`SELECT COUNT(*) AS c FROM "Student" WHERE "groupId" = 'g-full'`).c, 2, "capacity unchanged (no phantom seat)");
  }

  // =========================================================================
  section("H. Import: decision statuses are constrained to PENDING ledger entries");
  // =========================================================================
  {
    const wb = XLSX.utils.book_new();
    const rows = [
      { userEmail: "imp@students.test", amount: 300, method: "INSTAPAY", reference: "IMP-APPROVED-1", status: "APPROVED", notes: "row requests an approval" },
      { userEmail: "imp@students.test", amount: 200, method: "ETISALAT_CASH", reference: "IMP-REJECTED-1", status: "REJECTED", notes: "row requests a rejection" },
    ];
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, "Payments");
    const buf = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    const file = new File([buf], "import.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

    const before = q1(`SELECT COUNT(*) AS c FROM "Payment" WHERE "userId" = 'u-imp'`).c;
    eq(before, 0, "precondition: no prior imports for this user");

    const res = await driveImport("cm_session=admin-token", file);
    eq(res.status, 200, "the import is accepted (admin)");
    ok(res.json.created === 2, `both rows are created (created=${res.json.created})`);
    for (const r of res.json.results) {
      eq(r.status, "created", `row ${r.row} is created`);
      eq(r.importedAs, "PENDING", `row ${r.row} that requested a decision status is importedAs PENDING`);
    }

    const made = qAll(`SELECT * FROM "Payment" WHERE "userId" = 'u-imp' ORDER BY "createdAt"`);
    eq(made.length, 2, "exactly two payments were created");
    for (const p of made) {
      eq(p.status, "PENDING", `the imported payment (${p.reference}) is PENDING — imports never mint a decided state`);
      eq(p.reviewedByUserId, null, `no reviewer was written by the import (${p.reference})`);
      eq(p.reviewedAt, null, `no decision time was written by the import (${p.reference})`);
    }
    eq(q1(`SELECT COUNT(*) AS c FROM "Payment" WHERE "status" = 'APPROVED' AND "userId" = 'u-imp'`).c, 0, "NO APPROVED row exists for the importer's user");
    eq(q1(`SELECT COUNT(*) AS c FROM "Subscription" WHERE "studentId" = 's-imp'`).c, 0, "the import never touches the Subscription singleton");
    eq(studentRow("s-imp").groupId, null, "the import never assigns a group");

    // Non-admin import is refused.
    const studentFile = new File([buf], "import.xlsx");
    const denied = await driveImport("cm_session=norm-token", studentFile);
    eq(denied.status, 403, "a student cannot import");
    const anon = await driveImport(null, new File([buf], "import.xlsx"));
    eq(anon.status, 401, "an anonymous caller cannot import");
    eq(q1(`SELECT COUNT(*) AS c FROM "Payment" WHERE "userId" = 'u-imp'`).c, 2, "the refused imports created nothing");
  }

  // =========================================================================
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${fail === 0 ? "PASS" : "FAIL"} — payment-lifecycle-phase25-pr2b-fullchain: ${pass} assertions passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nFailed:");
    for (const f of failures) console.log("  ✗", f);
  }
} catch (e) {
  console.error("HARNESS ERROR:", e);
  fail++;
} finally {
  server.close();
  rawDb.close();
}
}

main()
  .catch((e) => {
    console.error("HARNESS ERROR:", e);
    process.exit(1);
  })
  .finally(() => process.exit(fail ? 1 : 0));
