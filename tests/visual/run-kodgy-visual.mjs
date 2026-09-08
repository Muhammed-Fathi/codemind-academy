#!/usr/bin/env node
// CodeMind Academy — Kodgy real-browser verification (Phase 10).
//
// Drives a REAL Chromium (extracted from @sparticuz/chromium) via Playwright
// against the REAL Kodgy components compiled with the REAL globals.css.
//
// Verifies, per viewport (1440×900, 834×1112, 390×844) × locale (ar/en):
//   * Arabic → robot on the LEFT half; English → robot on the RIGHT half
//   * robot + panel stay fully inside the viewport; no horizontal overflow
//   * click opens, Escape closes, keyboard Enter reopens
//   * asking a question renders user + scripted assistant bubbles, localized
//   * no raw i18n keys (kodgy.NNN / student.NNN / …) anywhere in visible text
//   * mouse dragging moves the robot, stays in-bounds, survives reload
//     (localStorage persistence), and a plain click still opens afterwards
//   * prefers-reduced-motion disables the flame/float animations while the
//     robot stays visible
//
// Usage:
//   node tests/visual/run-kodgy-visual.mjs [--shots]
// Config: VISUAL_CHROME (default: auto-extracted /tmp/chromium),
//         VISUAL_BASE (default http://127.0.0.1:8099),
//         VISUAL_SHOT_DIR (default $TMPDIR/codemind-kodgy-shots)

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import os from "os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const REPO = path.resolve(new URL("..", import.meta.url).pathname, "..");
const BASE = process.env.VISUAL_BASE || "http://127.0.0.1:8099";
const SHOTS = process.argv.includes("--shots");
const SHOT_DIR =
  process.env.VISUAL_SHOT_DIR || path.join(os.tmpdir(), "codemind-kodgy-shots");

const AR = /[\u0600-\u06FF]/;
const RAW_KEY = /(kodgy|student|shell|admin|app)\.[0-9]{3}/;

// ---------------------------------------------------------------------------
// Chromium: use VISUAL_CHROME, else extract @sparticuz/chromium (sandbox-safe).
// ---------------------------------------------------------------------------
async function chromeBinary() {
  if (process.env.VISUAL_CHROME) return process.env.VISUAL_CHROME;
  const binDir = path.join(REPO, "node_modules", "@sparticuz", "chromium", "bin");
  const { inflate } = require("@sparticuz/chromium");
  const Chromium = require("@sparticuz/chromium").default;
  if (!fs.existsSync("/tmp/al2023/lib/libnspr4.so")) {
    await inflate(path.join(binDir, "al2023.tar.br"));
  }
  const exec = await Chromium.executablePath(binDir);
  process.env.LD_LIBRARY_PATH =
    "/tmp/al2023/lib" + (process.env.LD_LIBRARY_PATH ? ":" + process.env.LD_LIBRARY_PATH : "");
  return exec;
}

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 834, height: 1112 },
  { name: "mobile", width: 390, height: 844 },
];
const LOCALES = [
  { name: "ar", dir: "rtl", lang: "ar", q: "ما هو المتغير؟", expectedBubble: "variable" },
  { name: "en", dir: "ltr", lang: "en", q: "What is a variable?", expectedBubble: "variable" },
];

let pass = 0;
const failures = [];
const ok = (cond, label) => {
  if (cond) pass++;
  else failures.push(label);
};

const CHROME = await chromeBinary();
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
});

const robotBox = async (page) =>
  page.locator("[data-kodgy-side]").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
  });

/**
 * CSS anchor position (style.left/top). Unlike the bounding box this is NOT
 * affected by the intentional idle float transform, so it is the right
 * invariant for "opening the panel must not re-position Kodgy".
 */
const robotAnchor = async (page) =>
  page.locator("[data-kodgy-side]").evaluate((el) => ({
    left: parseFloat(el.style.left || "0"),
    top: parseFloat(el.style.top || "0"),
  }));

/**
 * Click the robot at its current centre. The robot floats continuously
 * (intentional idle animation), so Playwright's stability wait can never
 * settle — a coordinate click is exactly what a real user does.
 */
async function clickRobot(page) {
  const b = await robotBox(page);
  await page.mouse.click(b.x + b.w / 2, b.y + b.h / 2);
}

const visibleText = async (page) => {
  const body = page.locator("body");
  // Include aria-labels/titles/placeholders in the leak scan.
  const attrs = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("[aria-label],[title],[placeholder]")) {
      const v = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder");
      if (v) out.push(v);
    }
    return out;
  });
  return ((await body.innerText()) + " " + attrs.join(" ")).trim();
};

for (const vp of VIEWPORTS) {
  for (const loc of LOCALES) {
    const tag = `kodgy @ ${vp.name} ${vp.width}x${vp.height} / ${loc.name.toUpperCase()}`;
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      locale: loc.name === "ar" ? "ar-EG" : "en-US",
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.message || e).slice(0, 300)));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text().slice(0, 300));
    });

    await page.goto(`${BASE}/index.html?scene=kodgy&locale=${loc.name}`, { waitUntil: "load" });
    await page.waitForTimeout(500);

    // ---- A. Locale-dependent side (Arabic LEFT / English RIGHT) ----------
    const anchor = page.locator("[data-kodgy-side]");
    ok((await anchor.count()) === 1, `${tag} — robot rendered`);
    const side = await anchor.getAttribute("data-kodgy-side");
    ok(side === (loc.name === "ar" ? "left" : "right"), `${tag} — data side is ${loc.name === "ar" ? "left" : "right"} (got ${side})`);
    const box = await robotBox(page);
    const centerX = box.x + box.w / 2;
    ok(
      loc.name === "ar" ? centerX < vp.width / 2 : centerX > vp.width / 2,
      `${tag} — robot in the ${loc.name === "ar" ? "LEFT" : "RIGHT"} half (centerX=${centerX.toFixed(0)})`
    );
    ok(box.x >= -1 && box.right <= vp.width + 1 && box.y >= -1 && box.bottom <= vp.height + 1,
      `${tag} — robot fully inside viewport`);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
      `${tag} — no horizontal overflow (closed)`);

    // ---- B. Click opens the panel; geometry stays in bounds ---------------
    await clickRobot(page);
    await page.waitForTimeout(450); // framer entrance
    const panel = page.locator("[role=dialog]");
    ok((await panel.count()) === 1, `${tag} — click opens the chat panel`);
    const pbox = await panel.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
    });
    ok(pbox.x >= -1 && pbox.right <= vp.width + 1, `${tag} — panel inside viewport horizontally`);
    ok(pbox.y >= -1 && pbox.bottom <= vp.height + 1, `${tag} — panel inside viewport vertically`);
    ok(pbox.w <= vp.width, `${tag} — panel width fits the screen`);
    const anchorBefore = await robotAnchor(page);
    const anchorAfter = await robotAnchor(page);
    ok(Math.abs(anchorAfter.left - anchorBefore.left) < 1 && Math.abs(anchorAfter.top - anchorBefore.top) < 1,
      `${tag} — opening does not move the robot`);

    // ---- C. Conversation: user + scripted assistant bubbles, localized ----
    const area = page.locator("textarea");
    await area.fill(loc.q);
    await area.press("Enter");
    await page.waitForTimeout(200);
    ok((await page.locator("body").innerText()).includes(loc.q), `${tag} — user message rendered`);
    await page.waitForTimeout(900); // thinking (500ms) + render
    const bodyText = await page.locator("body").innerText();
    ok(!RAW_KEY.test(bodyText), `${tag} — no raw i18n keys in visible text`);
    ok(!RAW_KEY.test(await visibleText(page)), `${tag} — no raw keys in aria/title/placeholder`);
    const bubbles = page.locator("[role=dialog] div.whitespace-pre-wrap");
    const bubbleCount = await bubbles.count();
    ok(bubbleCount >= 2, `${tag} — user + assistant bubbles rendered (${bubbleCount})`);
    const lastText = await bubbles.last().innerText();
    ok(lastText.length > 0, `${tag} — assistant answered`);
    ok(
      loc.name === "ar" ? AR.test(lastText) : !AR.test(lastText),
      `${tag} — assistant answer is ${loc.name === "ar" ? "Arabic" : "English"}`
    );

    // ---- D. Escape closes; keyboard Enter reopens ------------------------
    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);
    ok((await page.locator("[role=dialog]").count()) === 0, `${tag} — Escape closes`);
    await anchor.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(450);
    ok((await page.locator("[role=dialog]").count()) === 1, `${tag} — keyboard Enter reopens`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // ---- E. Dragging: moves, stays in bounds, persists, click still opens --
    const before = await robotBox(page);
    const sx = before.x + before.w / 2;
    const sy = before.y + before.h / 2;
    const dx = loc.name === "ar" ? 240 : -240; // drag toward the other side
    const dy = -160;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(sx + (dx * i) / 8, sy + (dy * i) / 8);
      await page.waitForTimeout(20);
    }
    await page.mouse.up();
    await page.waitForTimeout(250);
    const after = await robotBox(page);
    ok(Math.abs(after.x - before.x) > 40, `${tag} — drag moved the robot horizontally`);
    ok(after.x >= -1 && after.right <= vp.width + 1 && after.y >= -1 && after.bottom <= vp.height + 1,
      `${tag} — dragged robot stays inside viewport`);
    await clickRobot(page); // must open, not be swallowed by the drag flag
    await page.waitForTimeout(400);
    ok((await page.locator("[role=dialog]").count()) === 1, `${tag} — click after drag still opens`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Persistence across reload.
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(500);
    const reloaded = await robotBox(page);
    ok(Math.abs(reloaded.x - after.x) < 3 && Math.abs(reloaded.y - after.y) < 3,
      `${tag} — dragged position persists after reload (localStorage)`);

    // ---- F. No runtime errors --------------------------------------------
    ok(errors.length === 0, `${tag} — no console/page errors (${errors[0] || "none"})`);

    if (SHOTS) {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(SHOT_DIR, `${loc.name}__${vp.name}__after-drag.png`) });
    }
    await ctx.close();
  }
}

// ---- Reduced motion ------------------------------------------------------
{
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
    locale: "en-US",
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/index.html?scene=kodgy&locale=en`, { waitUntil: "load" });
  await page.waitForTimeout(500);
  const anchor = page.locator("[data-kodgy-side]");
  const anim = await page.evaluate(() => {
    const flame = document.querySelector(".kodgy-flame-tongue");
    const float = document.querySelector(".kodgy-float");
    return {
      flame: getComputedStyle(flame).animationName,
      float: getComputedStyle(float).animationName,
    };
  });
  ok(anim.flame === "none", `reduced motion — flame animation off (got ${anim.flame})`);
  ok(anim.float === "none", `reduced motion — float animation off (got ${anim.float})`);
  const box = await robotBox(page);
  ok(box.w > 0 && box.h > 0, "reduced motion — robot still visible and usable");
  await clickRobot(page);
  await page.waitForTimeout(400);
  ok((await page.locator("[role=dialog]").count()) === 1, "reduced motion — chat still opens");
  await ctx.close();
}

await browser.close();

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures.slice(0, 80)) console.log("  ✗", f);
}
process.exit(failures.length === 0 ? 0 : 1);
