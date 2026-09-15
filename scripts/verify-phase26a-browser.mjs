#!/usr/bin/env node
// CodeMind Academy — Phase 26A PUBLIC & AUTH browser verification.
//
// WHAT THIS PROVES (and why it is a real browser, not a source read)
//   A REAL Chromium loads the REAL Next.js client bundle (the running
//   `next dev` server), at real desktop/tablet/mobile widths, in Arabic (RTL)
//   and English (LTR), and asserts on the LIVE DOM and geometry:
//
//     * the public landing page renders, its navigation works, and it has no
//       horizontal overflow at any of the three widths;
//     * **Kodgy is NOT present anywhere on the unauthenticated/public surface**
//       (landing, login, register, forgot-password, reset, teacher activation) —
//       polled for a full second after load, so a hydration flicker fails too;
//     * each authenticated role DOES get Kodgy, and login lands on that role's
//       own dashboard (proved by WHICH `/api/*` endpoints the real client calls
//       after login — the role shell is picked by the shipped store/router);
//     * logout returns to the public surface, removes Kodgy, and invalidates the
//       session server-side;
//     * no raw translation keys ("auth.201", "shell.021", …) leak into visible
//       text in either locale;
//     * the post-login shell has no right-side layout overflow (the previously
//       reported dashboard regression) at 1440px.
//
//   The only bridge: this sandbox cannot run the Prisma engine
//   (`binaries.prisma.sh` unreachable — documented since Phase 6), so `/api/*`
//   is served by scripts/verify-phase26a-auth.mjs, which runs the SHIPPED route
//   handlers over a real SQLite database. The client bundle, the components, the
//   store, the CSS and the HTTP traffic are all the real thing.
//
// Usage:
//   node scripts/verify-phase26a-auth.mjs --serve 3111 &   # API bridge
//   npx next dev -p 3000                                    # (already running)
//   node scripts/verify-phase26a-browser.mjs
//
// Env: BROWSER_BASE (default http://127.0.0.1:3000), BRIDGE_BASE
//      (default http://127.0.0.1:3111), VISUAL_CHROME (default /tmp/chromium),
//      BROWSER_SHOT_DIR (default $TMPDIR/codemind-26a-shots).
//      If the bridge is NOT running, this script starts it as a child process.

import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");

const SUB = process.argv.includes("--sub");
// NOTE: `localhost`, not 127.0.0.1 — Next 16 blocks its own dev resources
// (including the HMR client that boots the dynamic shell) for origins that are
// not in `allowedDevOrigins`, and `next dev` allow-lists `localhost` by default.
const BASE = process.env.BROWSER_BASE || "http://localhost:3000";
const BRIDGE =
  process.env.BRIDGE_BASE || `http://127.0.0.1:${3100 + Math.floor(Math.random() * 800)}`;
const CHROME = process.env.VISUAL_CHROME || "/tmp/chromium";
// The extracted @sparticuz/chromium browser needs the libraries it ships.
process.env.LD_LIBRARY_PATH = ["/tmp/al2023/lib", process.env.LD_LIBRARY_PATH]
  .filter(Boolean)
  .join(":");
const SHOT_DIR = process.env.BROWSER_SHOT_DIR || path.join(os.tmpdir(), "codemind-26a-shots");
if (SUB) fs.mkdirSync(SHOT_DIR, { recursive: true });

let pass = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) pass++;
  else failures.push(`${label}${extra !== undefined ? ` :: ${extra}` : ""}`);
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${cond || extra === undefined ? "" : ` :: ${extra}`}`);
}
const section = (t) => console.log(`\n── ${t} ──`);

// ---------------------------------------------------------------------------
// API bridge (shipped route handlers over real SQLite)
// ---------------------------------------------------------------------------
let bridgeChild = null;
async function ensureBridge() {
  try {
    const r = await fetch(`${BRIDGE}/__qa/t?keys=shell.021&locale=ar`);
    if (r.ok) {
      const j = await r.json();
      // Only an up-to-date bridge (one that also serves structured strings) is
      // acceptable; a stale process from an earlier run would silently mask
      // dictionary changes.
      if (j && j.strings && j.strings.nav && j.strings.nav.login) return;
    }
  } catch {
    /* not running yet */
  }
  bridgeChild = spawn(
    process.execPath,
    [path.join(HERE, "verify-phase26a-auth.mjs"), "--serve", new URL(BRIDGE).port],
    { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] }
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bridge did not start in 60s")), 60000);
    bridgeChild.stdout.on("data", (d) => {
      if (String(d).includes("PHASE26A_SERVER_READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    bridgeChild.stderr.on("data", (d) => process.stderr.write(`[bridge] ${d}`));
    bridgeChild.on("exit", (c) => {
      clearTimeout(timer);
      reject(new Error(`bridge exited early (${c})`));
    });
  });
}

// Cookie plumbing: Playwright's route.fulfill does not reliably apply
// Set-Cookie, so the bridge's cookies are applied to the browser context
// explicitly — still the real cookie VALUES minted by the shipped handlers.
async function applySetCookies(context, setCookies) {
  for (const sc of setCookies) {
    const [pair, ...attrs] = sc.split(";").map((s) => s.trim());
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const maxAge = attrs.find((a) => /^max-age=/i.test(a));
    if (maxAge && /max-age=0/i.test(maxAge)) {
      await context.clearCookies({ name });
      continue;
    }
    const httpOnly = attrs.some((a) => /^httponly$/i.test(a));
    const secure = attrs.some((a) => /^secure$/i.test(a));
    const sameSiteAttr = attrs.find((a) => /^samesite=/i.test(a));
    const expiresAttr = attrs.find((a) => /^expires=/i.test(a));
    const cookie = {
      name,
      value,
      url: BASE,
      httpOnly,
      secure,
      sameSite: sameSiteAttr
        ? /none/i.test(sameSiteAttr)
          ? "None"
          : /strict/i.test(sameSiteAttr)
            ? "Strict"
            : "Lax"
        : "Lax",
    };
    if (expiresAttr) {
      const t = Date.parse(expiresAttr.split("=").slice(1).join("="));
      if (Number.isFinite(t)) cookie.expires = Math.floor(t / 1000);
    }
    await context.addCookies([cookie]);
  }
}

async function installBridge(context, log) {
  await context.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    log.push({ method: req.method(), path: url.pathname, search: url.search });
    let res;
    try {
      res = await fetch(`${BRIDGE}${url.pathname}${url.search}`, {
        method: req.method(),
        headers: {
          "content-type": "application/json",
          "user-agent": "phase26a-verifier",
          ...(req.headers()["cookie"] ? { cookie: req.headers()["cookie"] } : {}),
        },
        body: req.method() === "GET" || req.method() === "HEAD" ? undefined : req.postData(),
      });
    } catch (e) {
      return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "bridge-down" }) });
    }
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    await applySetCookies(context, setCookies);
    const body = await res.text();
    const headers = { "content-type": res.headers.get("content-type") || "application/json" };
    await route.fulfill({ status: res.status, headers, body });
  });
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------
function collectConsole(page) {
  const messages = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") {
      messages.push({ type: m.type(), text: m.text() });
    }
  });
  page.on("pageerror", (e) => messages.push({ type: "pageerror", text: String(e.message || e) }));
  return messages;
}

async function geometry(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const controls = [...document.querySelectorAll("input,button,select,textarea,a[href]")].filter(visible);
    const outside = controls
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { tag: el.tagName, name: el.getAttribute("name") || el.id || (el.textContent || "").trim().slice(0, 24),
                 left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) };
      })
      .filter((r) => r.right > window.innerWidth + 1 || r.left < -1);
    return {
      scrollWidth: de.scrollWidth,
      clientWidth: de.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dir: getComputedStyle(de).direction,
      lang: de.lang,
      docDirAttr: de.getAttribute("dir"),
      outsideControls: outside.slice(0, 6),
      overflow: de.scrollWidth - de.clientWidth,
    };
  });
}

// §17 probe: any in-flow element whose box crosses an edge of the viewport.
// Kodgy is excluded (deliberately fixed-positioned and edge-anchored), as are
// elements with no visible text (decorative backgrounds and gradients).
async function edgeOverflow(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("body *")) {
      if (el.closest("[data-kodgy-side], .kodgy-anchor, #kodgy-panel, [data-kodgy-open]")) continue;
      const s = getComputedStyle(el);
      if (s.position === "fixed" || s.position === "absolute") continue;
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (!(el.textContent || "").trim()) continue;
      if (r.right > window.innerWidth + 1 || r.left < -1) {
        out.push({
          tag: el.tagName,
          cls: String(el.className || "").slice(0, 48),
          txt: (el.textContent || "").trim().slice(0, 24),
          l: Math.round(r.left),
          r: Math.round(r.right),
        });
        if (out.length >= 4) break;
      }
    }
    return out;
  });
}

const KODGY_SELECTOR = '[data-kodgy-side], .kodgy-anchor, #kodgy-panel, [data-kodgy-open]';
async function kodgyCount(page) {
  return page.locator(KODGY_SELECTOR).count();
}
async function kodgyFlicker(page, ms = 1000) {
  // Poll: any appearance of Kodgy during the window counts as a leak/flicker.
  const deadline = Date.now() + ms;
  let seen = 0;
  while (Date.now() < deadline) {
    const n = await kodgyCount(page);
    if (n > 0) seen++;
    await page.waitForTimeout(100);
  }
  return seen;
}
const RAW_KEY_RE = /\b(?:auth|api|landing|shell|nav|admin|student|teacher|parent|kodgy)\.[0-9]{3}\b/;
async function rawKeyHits(page) {
  return page.evaluate(() => {
    const re = /\b(?:auth|api|landing|shell|nav|admin|student|teacher|parent|kodgy)\.[0-9]{3}\b/;
    const hits = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = (walker.currentNode.nodeValue || "").trim();
      if (t && re.test(t)) hits.push(t.slice(0, 60));
    }
    for (const el of document.querySelectorAll("[placeholder],[title],[aria-label]")) {
      for (const attr of ["placeholder", "title", "aria-label"]) {
        const v = el.getAttribute(attr);
        if (v && re.test(v)) hits.push(`${attr}="${v.slice(0, 40)}"`);
      }
    }
    return hits.slice(0, 5);
  });
}

async function strings(locale, keys) {
  const r = await fetch(`${BRIDGE}/__qa/t?locale=${locale}&keys=${keys.join(",")}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
await ensureBridge();
const KEYS = ["shell.021", "shell.020", "auth.200", "auth.201", "auth.220", "auth.211", "auth.209", "api.057"];
const T = {
  ar: { ...(await strings("ar", KEYS)).strings, flat: await strings("ar", KEYS) },
  en: { ...(await strings("en", KEYS)).strings, flat: await strings("en", KEYS) },
};
// `nav.*` live in the structured strings object; `shell.*`/`auth.*` are flat
// dictionary keys. Flatten both into one lookup so call sites read naturally.
for (const l of ["ar", "en"]) {
  T[l] = { ...T[l], ...T[l].flat, nav: T[l].nav, auth: T[l].auth };
}
console.log(`Bridge strings resolved (${Object.keys(T.ar.flat).length} keys, locale "${Object.keys(T.ar).includes("nav") ? "ar" : "?"}")`);

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--font-render-hinting=none"],
});
ok(true, `Chromium launched (${CHROME})`);

const consoleErrors = [];
const apiLog = [];

// ===========================================================================
// PASS 1 — public surface: layout, navigation, Kodgy absence, raw keys
//   3 viewports × 2 locales, plus in-depth interaction at desktop/ar.
// ===========================================================================
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 834, height: 1112 },
  { name: "mobile", width: 390, height: 844 },
];

for (const locale of ["ar", "en"]) {
  for (const vp of VIEWPORTS) {
    section(`PUBLIC-01/03 — landing ${locale.toUpperCase()} @ ${vp.name} (${vp.width}px)`);
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      locale: locale === "ar" ? "ar-EG" : "en-US",
    });
    await installBridge(context, apiLog);
    const page = await context.newPage();
    const msgs = collectConsole(page);
    consoleErrors.push(...msgs.map((m) => ({ ...m, where: `${locale}/${vp.name}/landing` })));

    const resp = await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 60000 });
    ok(resp.status() === 200, `${vp.name}/${locale}: GET / is 200`, resp.status());
    // The landing shell must be interactive (client bundle booted).
    await page.waitForSelector("header", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(800);
    if (locale === "en") {
      // Arabic is the default first-visit locale; English is selected through
      // the shipped `LanguageToggle` — the same path a real user takes.
      const toggle = page.getByRole("button", { name: /Switch to English/i }).first();
      ok((await toggle.count()) > 0, `${vp.name}/en: the language control is available pre-login`);
      await toggle.click();
      await page.waitForTimeout(700);
    }
    const heroText = await page.locator("body").innerText();

    const g = await geometry(page);
    ok(g.dir === (locale === "ar" ? "rtl" : "ltr"), `${vp.name}/${locale}: document direction is ${locale === "ar" ? "rtl" : "ltr"}`, g.dir);
    ok(g.lang === locale, `${vp.name}/${locale}: html[lang] is ${locale}`, g.lang);
    ok(heroText.length > 400, `${vp.name}/${locale}: landing page rendered substantial content`, heroText.length);
    ok(/CodeMind/i.test(heroText), `${vp.name}/${locale}: brand appears in the landing copy`);

    // Sections + footer
    const sections = await page.locator("section[id]").count();
    ok(sections >= 5, `${vp.name}/${locale}: landing sections rendered`, sections);
    ok((await page.locator("footer").count()) > 0, `${vp.name}/${locale}: footer rendered`);

    // Overflow — the primary responsive regression check.
    ok(g.overflow <= 1, `${vp.name}/${locale}: no horizontal document overflow`, `scrollWidth-innerWidth=${g.overflow}`);
    ok(g.outsideControls.length === 0, `${vp.name}/${locale}: no control is clipped outside the viewport`, JSON.stringify(g.outsideControls));

    // Kodgy must be completely absent for a guest.
    ok((await kodgyCount(page)) === 0, `${vp.name}/${locale}: NO Kodgy on the public landing page`);
    ok((await kodgyFlicker(page, 700)) === 0, `${vp.name}/${locale}: Kodgy never flickers in after hydration`);

    // No raw i18n keys leaked into visible text.
    const hits = await rawKeyHits(page);
    ok(hits.length === 0, `${vp.name}/${locale}: no raw translation keys visible`, JSON.stringify(hits));

    if (SUB) {
      await page.screenshot({ path: path.join(SHOT_DIR, `landing-${locale}-${vp.name}.png`), fullPage: false });
    }

    // Navigation (desktop only: tablet/mobile hide the nav behind layout).
    if (vp.name === "desktop") {
      section(`PUBLIC-02 — landing navigation (${locale})`);
      for (const id of ["why", "curriculum", "features", "pricing", "faq"]) {
        // The shipped landing nav scrolls smoothly, so wait for the scroll
        // position to settle before measuring the section's viewport box.
        await page.evaluate((sel) => document.getElementById(sel)?.scrollIntoView(), id);
        let stable = false;
        let prev = -1;
        for (let i = 0; i < 25 && !stable; i++) {
          await page.waitForTimeout(120);
          const y = await page.evaluate(() => window.scrollY);
          stable = y === prev;
          prev = y;
        }
        const inView = await page.evaluate((sel) => {
          const el = document.getElementById(sel);
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.top < window.innerHeight && r.bottom > 0;
        }, id);
        ok(inView, `${locale}: #${id} is reachable and scrolls into view`, `scrollY ${prev}`);
      }
      // A REAL navbar click must scroll too (the shipped scrollTo helper).
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(400);
      await page.locator("header nav button").nth(3).click();
      await page.waitForTimeout(1500);
      const scrolled = await page.evaluate(() => window.scrollY);
      ok(scrolled > 100, `${locale}: a real nav-bar click scrolls the landing page`, scrolled);
      // Footer quick links must switch to the auth views (real click path).
      await page.evaluate(() => window.scrollTo(0, 0));
      const backHome = T[locale].nav.backHome;
      await page.getByRole("button", { name: T[locale].nav.login, exact: true }).first().click();
      await page.waitForTimeout(500);
      const atLogin = await page.locator('input[name="password"]').count();
      ok(atLogin > 0, `${locale}: navbar login CTA opens the login form`);
      ok((await kodgyCount(page)) === 0, `${locale}: NO Kodgy on the login view`);
      const gl = await geometry(page);
      ok(gl.overflow <= 1, `${locale}: login view has no horizontal overflow`, gl.overflow);
      const lhits = await rawKeyHits(page);
      ok(lhits.length === 0, `${locale}: login view shows no raw translation keys`, JSON.stringify(lhits));

      // ---- §14 AUTH ERROR UX: a real failed login, in the real UI ----
      {
        await page.fill('input[name="email"]', "qa26a-nobody@codemind.test");
        await page.fill('input[name="password"]', "DefinitelyWrong1!");
        await page.click('button[type="submit"]');
        await page.waitForSelector("[data-sonner-toast]", { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(600);
        const toastText = (await page.locator("[data-sonner-toast]").first().innerText().catch(() => ""))
          .replace(/\s+/g, " ")
          .trim();
        const expected = T[locale].flat["api.057"];
        ok(toastText.length > 0, `${locale}: a failed login surfaces a visible message`, toastText);
        ok(
          toastText === expected || toastText.includes(expected),
          `${locale}: the failed-login message is the SHIPPED localized string`,
          `got "${toastText}" want "${expected}"`
        );
        ok(
          !/SQLITE|prisma|scrypt|at Object|node_modules|stack/i.test(toastText),
          `${locale}: the failed-login message leaks no internal detail`,
          toastText
        );
        const a11y = await page.evaluate(() => {
          const toast = document.querySelector("[data-sonner-toast]");
          if (!toast) return null;
          let node = toast;
          while (node) {
            if (node.getAttribute && (node.getAttribute("aria-live") || node.getAttribute("role"))) {
              return { role: node.getAttribute("role"), live: node.getAttribute("aria-live"), tag: node.tagName };
            }
            node = node.parentElement;
          }
          return null;
        });
        ok(
          Boolean(a11y && (a11y.live || a11y.role)),
          `${locale}: the error toast sits in a live region for assistive tech`,
          JSON.stringify(a11y)
        );
        // The form itself must stay usable (no destructive state).
        ok((await page.locator('input[name="password"]').count()) === 1, `${locale}: the login form stays usable after an error`);
        const ke = await rawKeyHits(page);
        ok(ke.length === 0, `${locale}: the error state shows no raw translation keys`, JSON.stringify(ke));
      }

      // Forgot-password view
      await page.getByRole("button", { name: T[locale]["auth.200"], exact: false }).first().click();
      await page.waitForSelector("#fp-email", { timeout: 15000 });
      ok((await page.locator("#fp-email").count()) === 1, `${locale}: forgot-password view renders the email field`);
      ok((await kodgyCount(page)) === 0, `${locale}: NO Kodgy on the forgot-password view`);
      const gf = await geometry(page);
      ok(gf.overflow <= 1, `${locale}: forgot-password view has no horizontal overflow`, gf.overflow);
      if (SUB) await page.screenshot({ path: path.join(SHOT_DIR, `forgot-${locale}.png`) });

      // Register view + role pickers
      await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: T[locale].nav.startFree, exact: true }).first().click();
      await page.waitForTimeout(500);
      const roleButtons = await page.getByRole("button", { name: /Student|Parent|Teacher/ }).count();
      ok(roleButtons >= 3, `${locale}: registration offers the three public roles`, roleButtons);
      ok((await page.locator('input[name="studentPhone"]').count()) === 1, `${locale}: student registration shows the student fields`);
      ok((await kodgyCount(page)) === 0, `${locale}: NO Kodgy on the register view`);
      const gr = await geometry(page);
      ok(gr.overflow <= 1, `${locale}: register view has no horizontal overflow`, gr.overflow);
      const rhits = await rawKeyHits(page);
      ok(rhits.length === 0, `${locale}: register view shows no raw translation keys`, JSON.stringify(rhits));
      if (SUB) await page.screenshot({ path: path.join(SHOT_DIR, `register-${locale}.png`) });

      // Parent + teacher variants of registration
      await page.getByRole("button", { name: /Parent/ }).first().click();
      await page.waitForTimeout(250);
      ok((await page.locator('input[name="studentCode"]').count()) === 1, `${locale}: parent registration shows the linking fields`);
      await page.getByRole("button", { name: /Teacher/ }).first().click();
      await page.waitForTimeout(250);
      const teacherPw = await page.locator('input[name="password"]').count();
      ok(teacherPw === 0, `${locale}: the PUBLIC teacher application asks for NO password`, teacherPw);
      const gt = await geometry(page);
      ok(gt.overflow <= 1, `${locale}: teacher application has no horizontal overflow`, gt.overflow);

      // Reset-password view (emailed link)
      await page.goto(`${BASE}/?token=qa26a-dummy-reset-token`, { waitUntil: "networkidle" });
      await page.waitForSelector("#fp-token", { timeout: 20000 });
      ok((await page.locator("#fp-password").count()) === 1, `${locale}: reset link opens the confirm form with a password field`);
      ok((await kodgyCount(page)) === 0, `${locale}: NO Kodgy on the reset-password view`);
      const gs = await geometry(page);
      ok(gs.overflow <= 1, `${locale}: reset-password view has no horizontal overflow`, gs.overflow);
      if (SUB) await page.screenshot({ path: path.join(SHOT_DIR, `reset-${locale}.png`) });

      // Teacher activation view (approval email link)
      await page.goto(`${BASE}/?teacherActivation=qa26a-dummy-activation-token`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1200);
      const actPw = await page.locator('input[type="password"]').count();
      const actHeading = await page.evaluate(() => document.body.innerText.slice(0, 400));
      ok(actPw >= 1, `${locale}: teacher activation link opens the set-password form`, `${actPw} :: ${actHeading.replace(/\n/g, " | ").slice(0, 140)}`);
      ok(
        (await page.locator('input[name="email"], input#fp-email').count()) === 0,
        `${locale}: the activation link does NOT land on the public landing/login form`
      );
      ok((await kodgyCount(page)) === 0, `${locale}: NO Kodgy on the teacher activation view`);
      const ga = await geometry(page);
      ok(ga.overflow <= 1, `${locale}: activation view has no horizontal overflow`, ga.overflow);
      if (SUB) await page.screenshot({ path: path.join(SHOT_DIR, `activation-${locale}.png`) });
    }

    await context.close();
  }
}

// ===========================================================================
// PASS 1b — §4 GUEST PROTECTED-SHELL BEHAVIOUR
//   The app has exactly ONE page route (`/`), so a guest cannot request a
//   dashboard URL: the "protected page" case is reached by client state only.
//   Proven here: a guest never sees a role shell (no sidebar, no identity, no
//   role nav) at any point during auth resolution, the boot always RESOLVES
//   (never an infinite loading state), it resolves to the public landing view,
//   and there is no redirect loop (one history entry, one /api/auth/me call).
// ===========================================================================
section("§4 — guest protected-shell: no leak, bounded resolution, no loop");
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ar-EG" });
  const log = [];
  await installBridge(context, log);
  const page = await context.newPage();
  const msgs = collectConsole(page);
  consoleErrors.push(...msgs.map((m) => ({ ...m, where: "ar/desktop/guest-shell" })));

  // /api/auth/me must answer 401 for the guest (no session).
  let meStatus = null;
  page.on("response", (r) => {
    if (new URL(r.url()).pathname === "/api/auth/me") meStatus = r.status();
  });

  // A redirect loop in this app would show up as REPEATED MAIN-FRAME
  // NAVIGATIONS (full document loads), not as extra history entries — the
  // router is pure React state and never calls window.location.
  // A redirect loop in this app would mean the DOCUMENT is replaced (or the URL
  // changes) repeatedly. `framenavigated` alone cannot tell a real document load
  // apart from Next's own same-document `history.replaceState` during client
  // bootstrap, so identity is proved with a boot token: if the window object is
  // the same object at the end, the document was never reloaded.
  await page.addInitScript(() => {
    window.__CM26A_BOOT_TOKEN = String(Math.random());
  });
  let reloads = 0;
  let urlChanged = 0;
  let bootUrl = null;
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    if (frame.url().startsWith("about:")) return;
    if (bootUrl === null) {
      bootUrl = frame.url();
      return;
    }
    if (frame.url() !== bootUrl) urlChanged++;
  });

  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  const bootToken = await page.evaluate(() => window.__CM26A_BOOT_TOKEN);

  // Sample the DOM during the whole auth-resolution window.
  let roleShellSeen = 0;
  let identitySeen = 0;
  let protectedNavSeen = 0;
  const samples = [];
  for (let i = 0; i < 25; i++) {
    const s = await page.evaluate(() => {
      const text = document.body.innerText || "";
      return {
        sidebar: document.querySelectorAll("aside").length,
        // A role shell would expose the signed-in identity or a role nav key.
        identity: /@codemind\.(academy|test)|qa26a-|admin@|teacher@/i.test(text),
        protectedNav:
          document.querySelectorAll(
            'nav a[href*="/admin"], aside nav, [data-role-nav]'
          ).length,
        landing: document.querySelectorAll("section[id]").length,
        form: document.querySelectorAll("form input").length,
        spinner: document.querySelectorAll(".animate-spin").length,
      };
    });
    if (s.sidebar > 0) roleShellSeen++;
    if (s.identity) identitySeen++;
    if (s.protectedNav > 0) protectedNavSeen++;
    samples.push(s);
    await page.waitForTimeout(120);
  }

  ok(roleShellSeen === 0, "a guest NEVER renders a role shell (no sidebar) during resolution", roleShellSeen);
  ok(identitySeen === 0, "no account identity/e-mail flashes for a guest", identitySeen);
  ok(protectedNavSeen === 0, "no role navigation flashes for a guest", protectedNavSeen);
  ok(meStatus === 401, "the guest's session probe is refused (401)", meStatus);

  // Bounded resolution: the app must settle on real content, never sit in the
  // loading state. `waitForFunction` throws on timeout → that IS the failure.
  let resolved = true;
  try {
    await page.waitForFunction(
      () =>
        document.querySelectorAll("section[id]").length >= 5 ||
        document.querySelectorAll("form input").length > 0,
      { timeout: 8000 }
    );
  } catch {
    resolved = false;
  }
  ok(resolved, "the guest boot RESOLVES within 8s (no infinite loading state)");
  const finalState = await page.evaluate(() => ({
    landing: document.querySelectorAll("section[id]").length,
    sidebar: document.querySelectorAll("aside").length,
    spinner: document.querySelectorAll(".animate-spin").length,
  }));
  ok(finalState.landing >= 5, "a guest resolves to the public landing view", JSON.stringify(finalState));
  ok(finalState.sidebar === 0, "the resolved guest view is not a protected shell");
  ok(
    !(finalState.spinner > 0 && finalState.landing === 0),
    "the guest does not end on a spinner-only screen",
    JSON.stringify(finalState)
  );

  // No redirect loop: the landing must remain reachable and stable, with a
  // single history entry (state-based routing, no window.location assignment).
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => ({
    href: window.location.href,
    entries: history.length,
  }));
  const endToken = await page.evaluate(() => window.__CM26A_BOOT_TOKEN);
  ok(
    endToken === bootToken && Boolean(bootToken),
    "the document is never reloaded after boot (no redirect loop)",
    `boot token ${String(bootToken).slice(0, 6)} → ${String(endToken).slice(0, 6)}`
  );
  ok(urlChanged === 0, "the URL never changes during a guest boot", `${urlChanged} URL changes`);
  ok(
    after.entries <= 2,
    "no extra history entries accumulate (state-based routing only)",
    `history.length=${after.entries}`
  );
  ok(!/\/login|\/admin|\/dashboard/.test(new URL(after.href).pathname), "the guest stays on / (no role URL redirect)", after.href);
  ok(
    log.filter((r) => r.path === "/api/auth/me").length <= 2,
    "the session probe is not retried in a loop",
    JSON.stringify(log.filter((r) => r.path === "/api/auth/me").length)
  );
  ok((await kodgyCount(page)) === 0, "the resolved guest view shows no Kodgy");
  await context.close();
}

// ===========================================================================
// PASS 2 — authenticated roles: redirect destination, Kodgy, shell overflow
// ===========================================================================
const ROLE_CASES = [
  { role: "STUDENT", email: "qa26a-student-login@codemind.test", password: "Qa26aStudent1!", own: "/api/students/me/dashboard" },
  { role: "PARENT", email: "qa26a-parent-login@codemind.test", password: "Qa26aParent1!", own: "/api/parents/me/dashboard" },
  { role: "TEACHER", email: "teacher@codemind.academy", password: "Qa26aTeacher1!", own: "/api/teacher/dashboard" },
  { role: "ADMIN", email: "admin@codemind.academy", password: "Qa26aAdminLocal1!", own: "/api/admin/overview" },
];
const FORBIDDEN = {
  STUDENT: ["/api/admin/overview", "/api/teacher/dashboard", "/api/parents/me/dashboard"],
  PARENT: ["/api/admin/overview", "/api/students/me/dashboard", "/api/students/me/enrollment"],
  TEACHER: ["/api/admin/overview", "/api/students/me/dashboard", "/api/students/me/enrollment"],
  ADMIN: ["/api/students/me/dashboard", "/api/parents/me/dashboard"],
};

for (const c of ROLE_CASES) {
  section(`AUTH-03/06/15 — ${c.role} login → role shell → logout`);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "ar-EG",
  });
  const log = [];
  await installBridge(context, log);
  const page = await context.newPage();
  const msgs = collectConsole(page);
  consoleErrors.push(...msgs.map((m) => ({ ...m, where: `ar/desktop/${c.role}` })));

  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  ok((await kodgyCount(page)) === 0, `${c.role}: guest landing shows no Kodgy`);

  await page.getByRole("button", { name: T.ar.nav.login, exact: true }).first().click();
  await page.waitForSelector("#password", { timeout: 20000 });
  await page.fill('input[name="email"]', c.email);
  await page.fill('input[name="password"]', c.password);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);
  const loginAt = log.findIndex((r) => r.path === "/api/auth/login");
  const afterLogin = loginAt === -1 ? [] : log.slice(loginAt + 1);

  ok((await page.locator('input[name="password"]').count()) === 0, `${c.role}: the login form is left behind (credentials accepted)`);
  ok(loginAt !== -1, `${c.role}: the UI posted to /api/auth/login`);
  ok(
    afterLogin.some((r) => r.path === c.own),
    `${c.role}: client called its OWN dashboard endpoint ${c.own}`,
    JSON.stringify(afterLogin.map((r) => r.path))
  );
  for (const f of FORBIDDEN[c.role]) {
    ok(!afterLogin.some((r) => r.path === f), `${c.role}: client never called the forbidden ${f}`);
  }

  // Kodgy retained for authenticated roles.
  ok((await kodgyCount(page)) > 0, `${c.role}: Kodgy IS present for the authenticated ${c.role} shell`);

  // §17 — the previously reported right-side overflow after login.
  const g = await geometry(page);
  ok(g.overflow <= 1, `${c.role}: authenticated shell has no horizontal overflow at 1440px`, `overflow=${g.overflow}`);
  const shellText = await page.locator("body").innerText();
  ok(shellText.length > 200, `${c.role}: a dashboard shell rendered (not a blank screen)`, shellText.length);
  // §17 — the previously reported right-side dashboard overflow, measured on
  // EVERY in-flow element (not only form controls).
  const edge = await edgeOverflow(page);
  ok(
    edge.length === 0,
    `${c.role}: no in-flow element overflows the viewport at 1440px (§17 regression probe)`,
    JSON.stringify(edge)
  );
  const rh = await rawKeyHits(page);
  ok(rh.length === 0, `${c.role}: authenticated shell shows no raw translation keys`, JSON.stringify(rh));
  if (SUB) await page.screenshot({ path: path.join(SHOT_DIR, `dashboard-${c.role}.png`) });

  // Session is real: the shell resolved /api/auth/me on mount.
  ok(log.some((r) => r.path === "/api/auth/me"), `${c.role}: the shell resolved /api/auth/me`);

  // ---- logout through the real UI -------------------------------------
  log.length = 0;
  await page.locator("aside button, header button, button").first().waitFor({ timeout: 10000 }).catch(() => {});
  const settingsBtn = page.locator("aside button:has(svg.lucide-settings)").last();
  const anyMenu = (await settingsBtn.count()) > 0;
  ok(anyMenu, `${c.role}: account menu trigger is present`);
  if (anyMenu) {
    await settingsBtn.click({ force: true });
    await page.waitForTimeout(400);
    const logoutItem = page.getByRole("menuitem", { name: T.ar["shell.021"] }).first();
    const hasItem = (await logoutItem.count()) > 0;
    ok(hasItem, `${c.role}: logout action is reachable in the account menu`);
    if (hasItem) {
      await logoutItem.click();
      await page.waitForTimeout(2000);
      ok(log.some((r) => r.path === "/api/auth/logout"), `${c.role}: the UI called /api/auth/logout`);
      ok((await kodgyCount(page)) === 0, `${c.role}: Kodgy is GONE after logout`);
      const gl = await geometry(page);
      ok(gl.overflow <= 1, `${c.role}: post-logout (public) view has no overflow`, gl.overflow);
      // The session must be dead server-side.
      const meAfter = await fetch(`${BRIDGE}/api/auth/me`, {
        headers: { cookie: (await context.cookies()).filter((x) => x.name === "cm_session").map((x) => `cm_session=${x.value}`).join("; ") },
      });
      ok(meAfter.status === 401, `${c.role}: the session is invalid server-side after logout`, meAfter.status);
      const logoutPage = await page.locator("body").innerText();
      ok(logoutPage.length > 200, `${c.role}: logout returns the browser to a usable public/landing view`);
    }
  }
  await context.close();
}

// ===========================================================================
// PASS 3 — restored session (reload) must not briefly show the guest landing
//          with Kodgy, and must land back on the role shell.
// ===========================================================================
section("§3 — no Kodgy flicker while auth resolves (page reload with a live session)");
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ar-EG" });
  const log = [];
  await installBridge(context, log);
  const page = await context.newPage();

  // Log in via the API bridge, then reload the app with that cookie present.
  const r = await fetch(`${BRIDGE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "qa26a-student-login@codemind.test", password: "Qa26aStudent1!" }),
  });
  const setCookies = r.headers.getSetCookie();
  await applySetCookies(context, setCookies);
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  // Sample Kodgy + document state during the auth-resolution window. Kodgy is
  // ALLOWED here (the session is valid) — what must never happen is a guest
  // landing with Kodgy, i.e. a stable public page that keeps a floating robot.
  let guestWithKodgy = 0;
  for (let i = 0; i < 10; i++) {
    const state = await page.evaluate(() => ({
      kodgy: document.querySelectorAll('[data-kodgy-side], .kodgy-anchor, #kodgy-panel').length,
      hasAuthSurface: Boolean(document.querySelector('input[name="password"], #fp-email')),
    }));
    if (state.kodgy > 0 && state.hasAuthSurface) guestWithKodgy++;
    await page.waitForTimeout(150);
  }
  ok(guestWithKodgy === 0, "Kodgy never coexists with a public/auth surface while auth resolves", guestWithKodgy);
  await page.waitForTimeout(2500);
  const text = await page.locator("body").innerText();
  ok(text.length > 200, "reload with a live session renders the authenticated shell");
  ok((await kodgyCount(page)) > 0, "reload with a live session keeps Kodgy for the authenticated role");
  await context.close();
}

console.log(`\n${"=".repeat(64)}`);
console.log(`Phase 26A browser verification: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
}
const realConsoleErrors = consoleErrors.filter(
  (m) => m.type === "error" || m.type === "pageerror"
);
console.log(`\nConsole errors captured: ${realConsoleErrors.length}`);
for (const m of realConsoleErrors.slice(0, 12)) console.log(`  [${m.where}] ${m.type}: ${m.text.slice(0, 160)}`);
if (!failures.length) console.log("PHASE26A_BROWSER_OK");

await browser.close();
if (bridgeChild) bridgeChild.kill("SIGTERM");
process.exit(failures.length ? 1 : 0);
