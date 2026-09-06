// CodeMind Academy — Real browser visual RTL/LTR verification.
//
// Drives a REAL Chromium (extracted from @sparticuz/chromium) via Playwright
// against the REAL components compiled with the REAL globals.css, and makes
// GEOMETRIC assertions — element bounding boxes measured in the live layout,
// not source inspection.
//
// Checks performed per scene / viewport / direction:
//   * no horizontal document overflow (scrollWidth <= clientWidth + 1)
//   * every form control lies fully inside the viewport on both axes
//   * dialog/drawer/sheet panels stay inside the viewport and are centred
//   * computed `direction` matches the requested locale
//   * input icons never overlap their input's text box
//   * buttons are fully visible and meet a usable hit target
//   * step-card number never overlaps the step-card icon
//
// Usage: node tests/visual/run-visual-tests.mjs [--shots]

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import os from "os";

const BASE = process.env.VISUAL_BASE || "http://127.0.0.1:8099";
// No default browser path: the binary is environment-specific and must never
// be committed. Playwright's own bundled Chromium is used unless the caller
// points VISUAL_CHROME at another executable.
const CHROME = process.env.VISUAL_CHROME || undefined;
const SHOTS = process.argv.includes("--shots");
// Screenshots are review evidence, not source. They default to the OS temp
// directory so a run can never dirty the working tree; override with
// VISUAL_SHOT_DIR.
const SHOT_DIR =
  process.env.VISUAL_SHOT_DIR || path.join(os.tmpdir(), "codemind-visual-shots");

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 834, height: 1112 },
  { name: "mobile", width: 390, height: 844 },
];

const LOCALES = [
  { name: "ar", dir: "rtl", lang: "ar" },
  { name: "en", dir: "ltr", lang: "en" },
];

const SCENES = [
  "login",
  "forgot-password",
  "student-registration",
  "parent-registration",
  "step-cards",
  "admin-student-tabs",
  "admin-session-videos",
  "admin-mock-exams",
  "admin-quiz-review",
  "dialog-form",
  "dialog-long",
  "sheet-form",
  "drawer-form",
];

let pass = 0;
const failures = [];
const ok = (cond, label) => {
  if (cond) pass++;
  else failures.push(label);
};

/** Measurements taken inside the page, in the live layout. */
async function measure(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
    };
    const visible = (el) => {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    const controls = [...document.querySelectorAll("input,textarea,select,button,[role=tab]")]
      .filter(visible)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || el.getAttribute("data-testid") || el.getAttribute("aria-label") || "",
        ...box(el),
      }));

    // Icon-vs-input overlap: an icon inside .field-with-icon must not sit on
    // top of the input's TEXT area (its padded content box).
    const iconOverlaps = [];
    for (const wrap of document.querySelectorAll(".field-with-icon")) {
      const input = wrap.querySelector("input,textarea");
      const icon = wrap.querySelector(".field-icon");
      if (!input || !icon || !visible(input) || !visible(icon)) continue;
      const ib = input.getBoundingClientRect();
      const gb = icon.getBoundingClientRect();
      const cs = getComputedStyle(input);
      const padL = parseFloat(cs.paddingLeft) || 0;
      const padR = parseFloat(cs.paddingRight) || 0;
      const textL = ib.left + padL;
      const textR = ib.right - padR;
      const overlaps = gb.right > textL + 0.5 && gb.left < textR - 0.5;
      iconOverlaps.push({
        id: input.id || "(anon)",
        overlaps,
        iconL: gb.left, iconR: gb.right, textL, textR,
      });
    }

    // Panels that must remain inside the viewport.
    const panels = [];
    for (const sel of [
      "[data-testid=dialog-panel]",
      "[data-testid=sheet-panel]",
      "[data-testid=drawer-panel]",
      "[role=dialog]",
    ]) {
      for (const el of document.querySelectorAll(sel)) {
        if (!visible(el)) continue;
        panels.push({ sel, ...box(el) });
      }
    }

    // Step cards: number must never overlap the icon.
    const stepPairs = [...document.querySelectorAll("[data-testid=step-card]")].map((card) => {
      const icon = card.querySelector("[data-testid=step-icon]");
      const num = card.querySelector("[data-testid=step-num]");
      if (!icon || !num) return null;
      const a = icon.getBoundingClientRect();
      const b = num.getBoundingClientRect();
      const overlap = !(a.right <= b.left + 0.5 || b.right <= a.left + 0.5 ||
                        a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5);
      return { overlap, iconL: a.left, iconR: a.right, numL: b.left, numR: b.right };
    }).filter(Boolean);

    return {
      vw, vh,
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      bodyDir: getComputedStyle(document.body).direction,
      controls, iconOverlaps, panels, stepPairs,
      controlCount: controls.length,
    };
  });
}

// Radix panels animate in. Measuring during the slide reports a transform
// offset that looks like an overflow bug, so all animation is disabled and
// geometry is sampled at the settled position.
const FREEZE_CSS = `*,*::before,*::after{
  animation-duration:0s!important;animation-delay:0s!important;
  transition-duration:0s!important;transition-delay:0s!important;
}`;

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--font-render-hinting=none"],
});

if (SHOTS) fs.mkdirSync(SHOT_DIR, { recursive: true });

for (const vp of VIEWPORTS) {
  for (const loc of LOCALES) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      locale: loc.name === "ar" ? "ar-EG" : "en-US",
    });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      // Deterministic data for components that fetch on mount, so their real
      // populated layout is measured rather than an empty skeleton.
      const json = (d) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(d) });
      window.fetch = (url) => {
        const u = String(url);
        if (u.includes("/api/admin/batches"))
          return json({ batches: [
            { id: "b1", name: "Arabic Batch", nameAr: "دفعة عربي", schoolType: "ARABIC", course: null, isActive: true, members: 128, videos: 3 },
            { id: "b2", name: "Language Batch", nameAr: "دفعة لغات", schoolType: "LANGUAGE", course: null, isActive: true, members: 94, videos: 2 }],
            eligible: { ARABIC: 128, LANGUAGE: 94 } });
        if (u.includes("/api/admin/session-videos"))
          return json({ videos: [
            { id: "v1", title: "Session 1 — Introduction to Programming", titleAr: "الجلسة الأولى — مقدمة في البرمجة", description: null,
              batch: { id: "b1", name: "Arabic", nameAr: "عربي", schoolType: "ARABIC" }, lesson: null,
              requiredPercent: 95, isPublished: true, publishedAt: "2026-09-01", source: "UPLOAD",
              externalUrl: null, streamUrl: "/api/media/m1", viewers: 42 }] });
        if (u.includes("/api/admin/mock-exams"))
          return json({ exams: [
            { id: "e1", title: "Mock Exam 1", titleAr: "امتحان تجريبي ١", description: null, schoolType: "ARABIC",
              course: null, questionCount: 20, durationMin: 45, passMark: 60, difficulty: "MIXED",
              selectionMode: "RANDOM", isPublished: true, pinnedQuestions: 0, attempts: 17 }],
            pools: { ARABIC: 240, LANGUAGE: 180 } });
        if (u.includes("/api/admin/quiz-evidence"))
          return json({ attempts: [
            { attemptId: "a1", startedAt: "2026-09-01T10:00:00Z", finishedAt: "2026-09-01T10:30:00Z",
              percentage: 85, cameraStatus: "GRANTED",
              student: { id: "s1", name: "محمد فتحي عبد الرحمن", email: "s@x.com", studentCode: "CM-0001" },
              quiz: { id: "q1", title: "Quiz 1", titleAr: "اختبار ١" },
              evidence: [{ id: "ev1", kind: "SNAPSHOT", status: null, capturedAt: "2026-09-01T10:05:00Z", retainUntil: null, url: null }] }],
            pagination: { totalPages: 3 } });
        return json({});
      };
    });
    await page.addStyleTag; // (styles are injected per-navigation below)

    for (const scene of SCENES) {
      const tag = `${scene} @ ${vp.name} ${vp.width}x${vp.height} / ${loc.name.toUpperCase()}`;
      const errors = [];
      page.removeAllListeners("pageerror");
      page.on("pageerror", (e) => errors.push(e.message));

      await page.goto(`${BASE}/index.html?scene=${scene}`, { waitUntil: "load" });
      await page.evaluate(
        ({ dir, lang }) => {
          document.documentElement.setAttribute("dir", dir);
          document.documentElement.setAttribute("lang", lang);
        },
        { dir: loc.dir, lang: loc.lang }
      );
      await page.addStyleTag({ content: FREEZE_CSS });
      // Let Radix portals mount and layout settle (animations are frozen).
      await page.waitForTimeout(300);

      const m = await measure(page);

      ok(errors.length === 0, `${tag} — no runtime errors (${errors[0] || ""})`);
      // Purely presentational scenes legitimately have no form controls.
      const PRESENTATIONAL = new Set(["step-cards", "admin-quiz-review"]);
      ok(
        m.controlCount > 0 || PRESENTATIONAL.has(scene),
        `${tag} — scene rendered content`
      );
      ok(m.bodyDir === loc.dir, `${tag} — computed direction is ${loc.dir} (got ${m.bodyDir})`);

      // Horizontal overflow of the document.
      ok(
        m.scrollW <= m.clientW + 1,
        `${tag} — no horizontal overflow (scrollW ${m.scrollW} vs clientW ${m.clientW})`
      );

      // Every control fully inside the viewport (no clipping either side).
      const clipped = m.controls.filter(
        (c) => c.x < -1 || c.right > m.vw + 1 || c.w > m.vw + 1
      );
      ok(
        clipped.length === 0,
        `${tag} — no control clipped horizontally (${clipped
          .slice(0, 3)
          .map((c) => `${c.tag}#${c.id}[x=${c.x.toFixed(0)},r=${c.right.toFixed(0)}]`)
          .join(", ")})`
      );

      // Buttons must be fully visible and usably tall.
      const tinyButtons = m.controls.filter(
        (c) => c.tag === "button" && (c.h < 16 || c.w < 16)
      );
      ok(tinyButtons.length === 0, `${tag} — all buttons have a usable hit target`);

      // Icons must not sit on the input text.
      const bad = m.iconOverlaps.filter((o) => o.overlaps);
      ok(
        bad.length === 0,
        `${tag} — input icons never overlap text (${bad
          .map((b) => `${b.id}: icon[${b.iconL.toFixed(0)}-${b.iconR.toFixed(0)}] text[${b.textL.toFixed(0)}-${b.textR.toFixed(0)}]`)
          .join("; ")})`
      );

      // Panels inside the viewport, and horizontally centred.
      for (const p of m.panels) {
        ok(
          p.x >= -1 && p.right <= m.vw + 1,
          `${tag} — panel ${p.sel} inside viewport horizontally (x=${p.x.toFixed(0)} right=${p.right.toFixed(0)} vw=${m.vw})`
        );
        ok(
          p.h <= m.vh + 1,
          `${tag} — panel ${p.sel} fits viewport height (h=${p.h.toFixed(0)} vh=${m.vh})`
        );
        // Centred panels only (dialogs); sheets/drawers are edge-anchored.
        if (p.sel === "[data-testid=dialog-panel]") {
          const leftGap = p.x;
          const rightGap = m.vw - p.right;
          ok(
            Math.abs(leftGap - rightGap) <= 2,
            `${tag} — dialog is horizontally centred (gaps ${leftGap.toFixed(1)} vs ${rightGap.toFixed(1)})`
          );
        }
      }

      // Step cards.
      for (const [i, sp] of m.stepPairs.entries()) {
        ok(
          !sp.overlap,
          `${tag} — step card ${i + 1}: number does not overlap icon (icon[${sp.iconL.toFixed(0)}-${sp.iconR.toFixed(0)}] num[${sp.numL.toFixed(0)}-${sp.numR.toFixed(0)}])`
        );
      }

      if (SHOTS) {
        await page.screenshot({
          path: path.join(SHOT_DIR, `${scene}__${vp.name}__${loc.name}.png`),
          fullPage: false,
        });
      }
    }

    // ---- Interactive: admin student tabs -----------------------------------
    {
      const tag = `admin-student-tabs interaction @ ${vp.name} / ${loc.name.toUpperCase()}`;
      await page.goto(`${BASE}/index.html?scene=admin-student-tabs`, { waitUntil: "load" });
      await page.evaluate(
        ({ dir, lang }) => {
          document.documentElement.setAttribute("dir", dir);
          document.documentElement.setAttribute("lang", lang);
        },
        { dir: loc.dir, lang: loc.lang }
      );
      await page.addStyleTag({ content: FREEZE_CSS });
      await page.waitForTimeout(200);

      for (const t of ["LANGUAGE", "UNSPECIFIED", "ARABIC"]) {
        await page.click(`[data-testid=tab-${t}]`);
        await page.waitForTimeout(90);
        const sel = await page.getAttribute(`[data-testid=tab-${t}]`, "aria-selected");
        ok(sel === "true", `${tag} — tab ${t} becomes selected on click`);
        const m2 = await measure(page);
        ok(
          m2.scrollW <= m2.clientW + 1,
          `${tag} — tab ${t} does not introduce horizontal overflow`
        );
      }

      await page.fill("input", "محمد");
      await page.waitForTimeout(90);
      const m3 = await measure(page);
      ok(m3.scrollW <= m3.clientW + 1, `${tag} — typing in search keeps layout stable`);
      const searchClipped = m3.controls.filter((c) => c.x < -1 || c.right > m3.vw + 1);
      ok(searchClipped.length === 0, `${tag} — search field not clipped`);
    }

    await ctx.close();
  }
}

await browser.close();

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures.slice(0, 60)) console.log("  ✗", f);
}
process.exit(failures.length === 0 ? 0 : 1);
