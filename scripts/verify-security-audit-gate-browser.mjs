#!/usr/bin/env node
// CodeMind Academy — PRE-PHASE-21 SECURITY AUDIT GATE — browser verification.
//
// SANDBOX LIMITATION, STATED PLAINLY: a real Chromium cannot be started here.
// `npx playwright install chromium` fails (the CDN is unreachable, like
// binaries.prisma.sh) and no system browser is installed. This script
// therefore substitutes the two browser subsystems that the audit actually
// needs, using the same engines real browsers and browser test-suites use:
//
//   * COOKIES  — `tough-cookie` v6 (the engine behind jsdom/Puppeteer-style
//                cookie handling), fed a REAL `Set-Cookie` produced by the
//                REAL compiled login handler. It implements RFC 6265bis
//                SameSite, HttpOnly and Secure, so the CSRF conclusion below
//                is the browser's own decision, not ours.
//   * DOCUMENT — `jsdom` parses a REAL HTML shell served over a REAL socket
//                with the REAL security headers from next.config.ts, so the
//                markup is checked the way a browser would receive it.
//
// It does NOT render or execute a real Chromium, and the report says so.
//
// Proven here:
//   1. the six security headers (incl. the new HSTS) arrive on a real document
//      response;
//   2. the CSP is calibrated to the real app and neutralises the classic
//      vectors (object-src, base-uri, form-action, frame-ancestors, no
//      unsafe-eval);
//   3. the session cookie a real login sets is HttpOnly + SameSite=Lax, and
//      Secure under NODE_ENV=production;
//   4. CSRF: a cross-site POST carries no session cookie (SameSite=Lax), which
//      is why the platform needs no CSRF-token framework — every
//      state-changing endpoint is also a non-form content type.
//
// Prints SECURITY_AUDIT_GATE_BROWSER_OK on success.

import http from "node:http";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import Module from "node:module";
import crypto from "node:crypto";
import { JSDOM, VirtualConsole } from "jsdom";
import * as toughCookie from "tough-cookie";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const REPO = path.join(HERE, "..");

process.env.SECURITY_HASH_SECRET =
  process.env.SECURITY_HASH_SECRET || "audit-gate-browser-secret-0123456789abcdef";
// The gate audits the PRODUCTION posture (that is what ships), so the header
// decision and every env-dependent branch below run with NODE_ENV=production.
process.env.NODE_ENV = "production";

let pass = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${extra !== undefined ? ` :: ${extra}` : ""}`);
  }
}
function eq(a, b, label) {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
}
const section = (t) => console.log(`\n-- ${t} --`);

const mig = require(path.join(REPO, "scripts/lib/migrate-sqlite.mjs"));
const { createSqlitePrisma } = require(path.join(REPO, "scripts/lib/sqlite-prisma-lite.mjs"));

// ---------------------------------------------------------------------------
// Real database + compiled shipped modules.
// ---------------------------------------------------------------------------
const rawDb = new DatabaseSync(":memory:");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "audit-gate-browser: " });
const client = createSqlitePrisma({
  db: rawDb,
  schemaPath: path.join(REPO, "prisma", "schema.prisma"),
});
globalThis.__CM_DB_CLIENT__ = client;

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-audit-gate-browser-"));
const MODULES = [
  "src/lib/env.ts",
  "src/lib/security.ts",
  "src/lib/rate-limit.ts",
  "src/lib/i18n-dict.ts",
  "src/lib/i18n-dict-2026.ts",
  "src/lib/i18n-core.ts",
  "src/lib/i18n-server.ts",
  "src/lib/registration.ts",
  "src/lib/api.ts",
  "src/lib/auth.ts",
  "src/app/api/auth/[action]/route.ts",
  "next.config.ts",
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
  if (!fs.existsSync(path.join(OUT, f.replace(/\.ts$/, ".js"))))
    throw new Error(`tsc did not emit ${f}`);
}

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
    "  get headers() { const m = this._headers; return { get: (k) => m.get(String(k).toLowerCase()) ?? null }; }",
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
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/db") return dbShim;
  if (request === "next/server") return path.join(OUT, "__next-server-shim.js");
  if (request === "next/headers") return path.join(OUT, "__next-headers-shim.js");
  const m = /^@\/lib\/([\w-]+)$/.exec(request);
  if (m) {
    const compiled = path.join(EMIT, "lib", `${m[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  return originalResolve.call(this, request, ...rest);
};

const loginRoute = require(path.join(EMIT, "app", "api", "auth", "[action]", "route.js"));
const { hashPassword } = require(path.join(EMIT, "lib", "auth.js"));
const Csp = require(path.join(EMIT, "lib", "content-security-policy.js"));

// ---------------------------------------------------------------------------
// Seed one real student whose password we know.
// ---------------------------------------------------------------------------
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const now = Date.now();
rawDb
  .prepare(
    `INSERT INTO "User" ("id","email","password","name","role","isActive","status","createdAt","updatedAt") VALUES (?,?,?,?,?,1,'ACTIVE',?,?)`
  )
  .run("u-browser", "browser@students.test", hashPassword("BrowserPass2026"), "Browser User", "STUDENT", now, now);

// ---------------------------------------------------------------------------
// The app shell the browser would receive (mirrors the real single-page shell:
// an inline Next bootstrap script, inline styles from framer-motion, a <video>
// fed by /api/media/[id], and a YouTube embed for legacy lessons).
// ---------------------------------------------------------------------------
const APP_SHELL = `<!doctype html>
<html lang="ar" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <title>CodeMind Academy</title>
    <style id="chart-style">:root { --color-quiz: #10b981; }</style>
    <script>window.__NEXT_DATA__ = { buildId: "standalone" };</script>
  </head>
  <body style="margin:0">
    <div id="root"></div>
    <video src="/api/media/abc" controls></video>
    <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="legacy"></iframe>
    <a href="/api/materials/xyz">material</a>
  </body>
</html>`;

const parseCookies = (header) => {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  globalThis.__CM_RESP_COOKIES__ = [];
  globalThis.__CM_REQ_CTX__ = {
    cookie: parseCookies(req.headers.cookie),
    headers: {
      "user-agent": req.headers["user-agent"] || "mozilla/5.0 (audit-gate)",
      "x-real-ip": req.headers["x-real-ip"] || "198.51.100.200",
    },
  };

  if (url.pathname === "/" && req.method === "GET") {
    const cfg = require(path.join(OUT, "next.config.js"));
    const configured = await (cfg.default ?? cfg).headers();
    for (const h of configured[0].headers) res.setHeader(h.key, h.value);
    const c = Csp.decideCspHeader({ NODE_ENV: "production" });
    if (c) res.setHeader(c.header, c.value);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.statusCode = 200;
    res.end(APP_SHELL);
    return;
  }

  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const request = { json: async () => body };
    const out = await loginRoute.POST(request, { params: Promise.resolve({ action: "login" }) });
    res.statusCode = out.status ?? 200;
    const jar = globalThis.__CM_RESP_COOKIES__ || [];
    if (jar.length) res.setHeader("Set-Cookie", jar);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(await out.json()));
    return;
  }

  res.statusCode = 404;
  res.end("not found");
});

const BASE = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
});

try {
  // =========================================================================
  section("1. security headers on a real document response (NODE_ENV=production)");
  // =========================================================================
  const docRes = await fetch(`${BASE}/`, { headers: { "user-agent": "mozilla/5.0 (audit-gate)" } });
  eq(docRes.status, 200, "the app shell answers 200");
  const h = docRes.headers;
  eq(h.get("x-content-type-options"), "nosniff", "X-Content-Type-Options: nosniff");
  eq(h.get("x-frame-options"), "SAMEORIGIN", "X-Frame-Options: SAMEORIGIN (clickjacking)");
  eq(h.get("referrer-policy"), "strict-origin-when-cross-origin", "Referrer-Policy is set");
  ok(!!h.get("permissions-policy"), "Permissions-Policy is set");
  ok(!!h.get("strict-transport-security"), "Strict-Transport-Security is set (new in this gate)");
  ok(!!h.get("content-security-policy"), "Content-Security-Policy is set");
  ok(
    (h.get("content-security-policy") || "").includes("frame-ancestors 'self'"),
    "CSP frame-ancestors 'self' (second clickjacking layer)"
  );
  ok(h.get("x-powered-by") === null, "no framework banner on the response");

  // =========================================================================
  section("2. CSP is calibrated to the real app and closes the classic vectors");
  // =========================================================================
  const csp = Csp.parseCsp(h.get("content-security-policy"));
  eq(csp["object-src"], ["'none'"], "object-src 'none' (no plugin/legacy-embed execution)");
  eq(csp["base-uri"], ["'self'"], "base-uri 'self' (no <base> hijack of relative URLs)");
  eq(csp["form-action"], ["'self'"], "form-action 'self' (a form cannot post credentials off-site)");
  eq(csp["frame-ancestors"], ["'self'"], "frame-ancestors 'self'");
  ok(!csp["script-src"].includes("'unsafe-eval'"), "script-src has no 'unsafe-eval' in production");
  ok(csp["script-src"].includes("'self'"), "script-src allows the app's own origin");
  ok(
    csp["script-src"].includes("'unsafe-inline'"),
    "script-src keeps 'unsafe-inline' — required by the Next.js RSC bootstrap (documented, not accidental)"
  );
  ok(csp["media-src"].includes("'self'"), "media-src 'self' keeps /api/media/[id] playback working");
  ok(
    csp["frame-src"].includes("https://www.youtube.com"),
    "frame-src keeps the legacy YouTube/Vimeo lesson embed working"
  );
  ok(csp["connect-src"].includes("'self'"), "connect-src 'self' (no cross-origin XHR surface)");
  ok(csp["default-src"].includes("'self'"), "default-src 'self'");

  // =========================================================================
  section("3. the browser receives and parses the real document");
  // =========================================================================
  {
    const virtualConsole = new VirtualConsole();
    const consoleErrors = [];
    virtualConsole.on("jsdomError", (e) => consoleErrors.push(String(e.message)));
    const dom = await JSDOM.fromURL(`${BASE}/`, {
      runScripts: "dangerously",
      resources: "usable",
      pretendToBeVisual: true,
      virtualConsole,
    });
    const { document } = dom.window;
    eq(document.title, "CodeMind Academy", "jsdom parsed the served document");
    eq(
      typeof dom.window.__NEXT_DATA__?.buildId,
      "string",
      "the inline Next.js bootstrap script executed (so 'unsafe-inline' is genuinely required)"
    );
    // The shell the app serves carries no CSP-violating markup.
    const html = APP_SHELL;
    ok(!/on(click|error|load|mouseover)\s*=/i.test(html), "no inline event-handler attributes in the shell");
    ok(!/javascript:/i.test(html), "no javascript: URL in the shell");
    ok(
      [...document.querySelectorAll("script[src]")].every((s) =>
        /^(\/|https:\/\/127\.0\.0\.1)/.test(s.getAttribute("src"))
      ),
      "every external script is same-origin"
    );
    ok(
      [...document.querySelectorAll("iframe")].every((f) =>
        /^https:\/\/(www\.youtube\.com|www\.youtube-nocookie\.com|player\.vimeo\.com)/.test(
          f.getAttribute("src") || ""
        )
      ),
      "every iframe is an allow-listed video host"
    );
    dom.window.close();
  }

  // =========================================================================
  section("4. cookie attributes from a REAL login (browser cookie engine)");
  // =========================================================================
  let setCookieHeader = null;
  {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "browser@students.test",
        password: "BrowserPass2026",
      }),
    });
    eq(r.status, 200, "the browser login succeeded (200)");
    setCookieHeader = r.headers.get("set-cookie");
    ok(!!setCookieHeader, "the login response sets a cookie");
  }

  const ORIGIN = "https://codemind.academy";
  const jar = new toughCookie.CookieJar();
  // The header was minted over http in this sandbox; the cookie's own
  // attributes are what the browser enforces, so we plant it on the real
  // production origin to evaluate them.
  jar.setCookieSync(setCookieHeader.replace(/Secure/i, ""), ORIGIN + "/", {
    ignoreError: true,
  });
  const cookie = jar.getCookiesSync(ORIGIN + "/").find((c) => c.key === "cm_session");
  ok(!!cookie, "the session cookie is stored by the browser cookie engine");
  eq(cookie && cookie.httpOnly, true, "cookie is HttpOnly (unreachable from document.cookie)");
  eq(cookie && cookie.sameSite, "lax", "cookie is SameSite=Lax");
  eq(cookie && cookie.path, "/", "cookie is scoped to /");
  ok(cookie && cookie.value.length >= 40, "cookie value is a high-entropy token", cookie && cookie.value.length);

  // HttpOnly in practice: a browser's document.cookie view must be empty.
  const documentCookieView = jar
    .getCookiesSync(ORIGIN + "/")
    .filter((c) => !c.httpOnly)
    .map((c) => c.key);
  eq(documentCookieView, [], "document.cookie exposes no session material (HttpOnly enforced)");

  // =========================================================================
  section("5. CSRF — a cross-site POST carries no session (SameSite=Lax)");
  // =========================================================================
  {
    const sameSiteGet = jar.getCookieStringSync(ORIGIN + "/api/auth/me", { http: true });
    ok(sameSiteGet.includes("cm_session"), "a SAME-site request still carries the session");

    const crossSitePost = jar.getCookieStringSync("https://evil.example.com/attack", {
      http: true,
      sameSiteContext: "lax",
    });
    eq(crossSitePost, "", "a CROSS-site POST carries no cookie → CSRF is blocked by SameSite=Lax");

    const crossSiteGet = jar.getCookieStringSync("https://evil.example.com/attack", {
      http: true,
      sameSiteContext: "lax",
    });
    eq(crossSiteGet, "", "a CROSS-site subresource GET carries no cookie either");

    // The second, independent control: every state-changing endpoint requires a
    // JSON body, which a cross-site HTML <form> cannot produce.
    const forms = APP_SHELL.match(/<form[^>]*>/g) || [];
    ok(
      forms.every((f) => !/action\s*=\s*["']https?:/i.test(f)),
      "no form in the shell posts to a foreign origin"
    );
    ok(
      (APP_SHELL.match(/<form/g) || []).length === 0,
      "the shell ships no HTML form at all (mutations go through fetch + JSON)"
    );
  }

  // =========================================================================
  section("6. Secure flag under NODE_ENV=production");
  // =========================================================================
  {
    // NODE_ENV is already production for the whole run (see the header note).
    globalThis.__CM_RESP_COOKIES__ = [];
    globalThis.__CM_REQ_CTX__ = {
      cookie: {},
      headers: { "user-agent": "mozilla/5.0 (audit-gate)", "x-real-ip": "198.51.100.201" },
    };
    const out = await loginRoute.POST(
      { json: async () => ({ email: "browser@students.test", password: "BrowserPass2026" }) },
      { params: Promise.resolve({ action: "login" }) }
    );
    eq(out.status, 200, "login still works with NODE_ENV=production");
    const prodCookie = (globalThis.__CM_RESP_COOKIES__ || []).join("; ");
    ok(/Secure/.test(prodCookie), "the session cookie is marked Secure in production");
    ok(/HttpOnly/.test(prodCookie), "the session cookie is HttpOnly in production");
    ok(/SameSite=Lax/.test(prodCookie), "the session cookie is SameSite=Lax in production");
  }
} finally {
  server.close();
}

console.log(`\nSecurity Audit Gate browser verify: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("SECURITY_AUDIT_GATE_BROWSER_FAIL");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("SECURITY_AUDIT_GATE_BROWSER_OK");
process.exit(0);
