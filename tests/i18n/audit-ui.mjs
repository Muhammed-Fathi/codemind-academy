#!/usr/bin/env node
/**
 * i18n UI Audit — walks every portal view in both Arabic and English,
 * captures visible text, screenshots and console errors.
 *
 * Usage: node tests/i18n/audit-ui.mjs <label> [locales=ar,en] [baseUrl]
 * Output: tests/i18n/evidence/<label>/report.json + screenshots + per-view text dumps
 */
import fs from "fs";
import path from "path";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);

const LABEL = process.argv[2] || "run";
const LOCALES = (process.argv[3] || "ar,en").split(",");
const BASE = process.argv[4] || "http://localhost:3000";
const OUT = path.resolve("tests/i18n/evidence", LABEL);

// Chromium shared libraries extracted from @sparticuz/chromium
process.env.LD_LIBRARY_PATH = "/tmp/al2023/lib" + (process.env.LD_LIBRARY_PATH ? ":" + process.env.LD_LIBRARY_PATH : "");

const AR = /[\u0600-\u06FF]/;

const ACCOUNTS = {
  admin: { email: "admin@codemind.academy", password: "admin123" },
  teacher: { email: "teacher@codemind.academy", password: "teacher123" },
  student: { email: "student@codemind.academy", password: "student123" },
  parent: { email: "parent@codemind.academy", password: "parent123" },
};

const VIEWS = {
  student: [
    "student-dashboard", "student-course", "student-exam", "student-bookmarks",
    "student-scheduler", "student-referral", "student-progress",
    "student-leaderboard", "student-achievements", "student-certificate",
    "student-homework", "student-notifications",
  ],
  parent: ["parent-dashboard", "parent-report"],
  teacher: [
    "teacher-dashboard", "teacher-attendance", "teacher-quizzes",
    "teacher-homework", "teacher-templates", "teacher-analytics",
  ],
  admin: [
    "admin-overview", "admin-students", "admin-teachers", "admin-groups",
    "admin-courses", "admin-question-bank", "admin-payments",
    "admin-subscriptions", "admin-coupons", "admin-notifications",
    "admin-settings",
  ],
};

fs.mkdirSync(OUT, { recursive: true });

const report = { label: LABEL, generatedAt: new Date().toISOString(), base: BASE, locales: {}, console: {} };

function collectTextAudit(page) {
  return page.evaluate(() => {
    const ar = /[\u0600-\u06FF]/;
    const lines = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(n) {
          if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          const el = n.parentElement;
          if (!el) return NodeFilter.FILTER_REJECT;
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );
    while (walker.nextNode()) lines.push(walker.currentNode.nodeValue.trim());
    // placeholders / aria-labels / titles on inputs & buttons
    const attrs = [];
    for (const el of document.querySelectorAll("input, textarea")) {
      const p = el.getAttribute("placeholder");
      if (p && p.trim()) attrs.push({ kind: "placeholder", text: p.trim() });
    }
    for (const el of document.querySelectorAll("[aria-label]")) {
      const p = el.getAttribute("aria-label");
      if (p && p.trim()) attrs.push({ kind: "aria-label", text: p.trim() });
    }
    for (const el of document.querySelectorAll("[title]")) {
      const p = el.getAttribute("title");
      if (p && p.trim()) attrs.push({ kind: "title", text: p.trim() });
    }
    const arabicText = lines.filter((l) => ar.test(l));
    const arabicAttrs = attrs.filter((a) => ar.test(a.text));
    return {
      dir: document.documentElement.getAttribute("dir"),
      lang: document.documentElement.getAttribute("lang"),
      totalTextNodes: lines.length,
      arabicTextCount: arabicText.length,
      arabicSample: [...new Set(arabicText)].slice(0, 25),
      attrTotal: attrs.length,
      arabicAttrCount: arabicAttrs.length,
      arabicAttrSample: arabicAttrs.slice(0, 15),
    };
  });
}

async function setLocale(page, locale) {
  await page.evaluate((loc) => {
    localStorage.setItem("cm-locale", loc);
    try {
      const app = JSON.parse(localStorage.getItem("cm-app") || "{}");
      app.state = app.state || {};
      app.state.locale = loc;
      localStorage.setItem("cm-app", JSON.stringify(app));
    } catch {}
  }, locale);
}

async function gotoView(page, viewKey) {
  // Click the sidebar button carrying data-view=<key> (shell renders one per nav item)
  const btn = page.locator(`aside nav button[data-view="${viewKey}"]`).first();
  try {
    await btn.click({ timeout: 8000 });
  } catch {
    // Mobile layout: open the sheet first
    const burger = page.locator("button[aria-label*='enu'], button[aria-label*='القائمة']").first();
    if (await burger.count()) {
      await burger.click().catch(() => {});
      await page.waitForTimeout(400);
      await btn.click({ timeout: 5000 });
    } else throw new Error(`nav button for ${viewKey} not found`);
  }
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1600);
}

async function main() {
  for (const locale of LOCALES) {
    const browser = await chromium.launch({
      executablePath: "/tmp/chromium",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--single-process",
      ],
      headless: true,
      timeout: 90000,
    });
    const consoleMsgs = [];
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: locale === "ar" ? "ar-EG" : "en-US",
    });
    const page = await ctx.newPage();
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning")
        consoleMsgs.push({ type: m.type(), text: m.text().slice(0, 400) });
    });
    page.on("pageerror", (e) =>
      consoleMsgs.push({ type: "pageerror", text: String(e).slice(0, 400) })
    );

    const loc = {};
    fs.mkdirSync(path.join(OUT, locale), { recursive: true });

    // ---------- public: landing ----------
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await setLocale(page, locale);
    await page.reload({ waitUntil: "networkidle" }).catch(() => {});
    await page.waitForTimeout(2500);
    loc.landing = { ...(await collectTextAudit(page)) };
    await page.screenshot({ path: path.join(OUT, locale, "00-landing.png"), fullPage: false });
    // scroll through landing sections for coverage
    for (const y of [1200, 2400, 3600, 4800]) {
      await page.mouse.wheel(0, 1200).catch(() => {});
      await page.waitForTimeout(300);
    }
    loc.landingScrolled = await collectTextAudit(page);
    await page.screenshot({ path: path.join(OUT, locale, "01-landing-bottom.png") });

    // ---------- public: login + register ----------
    const loginBtn = page
      .locator("button, a")
      .filter({ hasText: /تسجيل الدخول|Log in/i })
      .first();
    if (await loginBtn.count()) {
      await loginBtn.click().catch(() => {});
      await page.waitForTimeout(1200);
    } else {
      await page.evaluate(() => {
        // fallback: drive the store directly via persisted state is not exposed; click any auth CTA
        document.querySelector("header button")?.click();
      });
      await page.waitForTimeout(800);
    }
    loc.login = await collectTextAudit(page);
    await page.screenshot({ path: path.join(OUT, locale, "02-login.png") });

    // register tab
    const regBtn = page
      .locator("button, a")
      .filter({ hasText: /ماعندكش حساب|Create one|اعمل واحد/i })
      .first();
    if (await regBtn.count()) {
      await regBtn.click().catch(() => {});
      await page.waitForTimeout(900);
    }
    loc.register = await collectTextAudit(page);
    await page.screenshot({ path: path.join(OUT, locale, "03-register.png") });

    // ---------- dashboards ----------
    for (const [role, creds] of Object.entries(ACCOUNTS)) {
      const rdir = path.join(OUT, locale, role);
      fs.mkdirSync(rdir, { recursive: true });
      // API login (sets cookie), then reload so the app restores the session
      await page.evaluate(async ({ email, password }) => {
        await fetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
      }, creds);
      await page.goto(BASE + "/", { waitUntil: "networkidle" }).catch(() => {});
      await page.waitForTimeout(2600);

      for (let i = 0; i < VIEWS[role].length; i++) {
        const view = VIEWS[role][i];
        try {
          await gotoView(page, view);
        } catch (e) {
          loc[`${role}:${view}`] = { error: String(e.message || e).slice(0, 200) };
          continue;
        }
        const audit = await collectTextAudit(page);
        loc[`${role}:${view}`] = audit;
        await page.screenshot({
          path: path.join(rdir, `${String(i).padStart(2, "0")}-${view}.png`),
        });
      }

      // log out for next role
      const logoutBtn = page
        .locator("button")
        .filter({ hasText: /تسجيل الخروج|Log ?out|خروج/i })
        .first();
      if (await logoutBtn.count()) {
        await logoutBtn.click().catch(() => {});
        await page.waitForTimeout(1200);
      }
      await page.evaluate(async () => {
        await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
        localStorage.removeItem("cm-app-user");
      });
    }

    // keep only unique console errors/warnings
    const seen = new Set();
    report.console[locale] = consoleMsgs.filter((c) => {
      const k = c.type + ":" + c.text;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    report.locales[locale] = loc;
    await ctx.close();
    await browser.close().catch(() => {});
    // Persist after each locale so partial runs keep their evidence
    fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  }

  // console summary
  for (const locale of LOCALES) {
    const loc = report.locales[locale] || {};
    let views = 0, ar = 0, arAttr = 0, errs = 0;
    for (const [k, v] of Object.entries(loc)) {
      if (!v || v.error || !("arabicTextCount" in v)) continue;
      views++;
      ar += v.arabicTextCount;
      arAttr += v.arabicAttrCount || 0;
    }
    errs = (report.console[locale] || []).filter((c) => c.type !== "warning").length;
    console.log(
      `[${locale}] views=${views} arabicTextNodes=${ar} arabicAttrs=${arAttr} consoleErrors=${errs}`
    );
  }
  console.log("Evidence →", OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
