// CodeMind Academy — Phase 10 Kodgy AI Assistant regression tests.
//
// Offline (no database, no network, no running server). Three layers:
//
//   A. RESPONSE ENGINE — transpile src/lib/kodgy/response-engine.ts and drive
//      the REAL deterministic matcher: greetings, platform intents,
//      educational intents, differences, unknown questions, Arabic/English,
//      case/whitespace normalization, determinism and input safety.
//
//   B. POSITION MATH — transpile src/lib/kodgy/position.ts and exercise the
//      real clamping / locale-edge / panel geometry helpers (Arabic LEFT,
//      English RIGHT, viewport bounds, above/below placement).
//
//   C. SOURCE-LEVEL INVARIANTS + I18N — the Kodgy UI is fully client-side
//      (no /api/ai route, no AI SDK import, no fetch, no dangerouslySetInnerHTML),
//      every `kodgy.*` chrome key exists bilingually, the assistant is mounted
//      in the authenticated shell, and reduced-motion CSS exists.
//
// Run: node tests/kodgy-phase10.test.js

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node test runner, same as the other suites */
const fs = require("fs");
const path = require("path");
const os = require("os");
const ts = require(path.join(__dirname, "..", "node_modules/typescript/lib/typescript.js"));

const REPO = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(REPO, rel));

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) pass++;
  else {
    fail++;
    console.error("FAIL:", label);
  }
};
const eq = (a, b, label) => {
  const equal = JSON.stringify(a) === JSON.stringify(b);
  ok(equal, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
};
const section = (t) => console.log(`\n${t}`);
const AR = /[\u0600-\u06FF]/;

// ---------------------------------------------------------------------------
// Compile the engine + position math to CommonJS in a temp dir.
// ---------------------------------------------------------------------------
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p10-test-"));
const compile = (rel, outName) => {
  const src = read(rel);
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      jsx: ts.JsxEmit.React,
    },
    fileName: path.basename(rel),
  });
  const rewritten = outputText.replace(
    /require\(["']@\/lib\/([^"']+)["']\)/g,
    (_m, p) => `require(${JSON.stringify(path.join(OUT, p + ".js"))})`
  );
  fs.writeFileSync(path.join(OUT, outName), rewritten);
};

compile("src/lib/kodgy/response-engine.ts", "engine.js");
compile("src/lib/kodgy/position.ts", "position.js");
compile("src/lib/i18n-core.ts", "i18n-core.js");
compile("src/lib/i18n-dict.ts", "i18n-dict.js");
compile("src/lib/i18n-dict-2026.ts", "i18n-dict-2026.js");

const E = require(path.join(OUT, "engine.js"));
const P = require(path.join(OUT, "position.js"));
const I = require(path.join(OUT, "i18n-core.js"));

// ===========================================================================
section("A1. Normalization — case, whitespace, punctuation, Arabic variants");
// ===========================================================================
{
  eq(E.normalize("  WHAT   IS   A   VARIABLE ?! "), "what is a variable", "EN case/whitespace/punct");
  eq(E.normalize("ما   هو   المتغير   ؟"), "ما هو متغير", "AR whitespace/punct/article");
  eq(E.normalize("ما هي الدالة؟"), "ما هي داله", "AR ة → ه + article-strip");
  eq(E.normalize("أحمد إبراهيم آدم"), "احمد ابراهيم ادم", "AR hamza variants");
  eq(E.normalize("خوارزمِيَّة"), "خوارزميه", "AR diacritics");
  eq(E.normalize("الـfunction"), "function", "AR ligature prefix");
  eq(E.normalize(""), "", "empty input");
  eq(E.normalize(null), "", "null input");
}

// ===========================================================================
section("A2. Greetings");
// ===========================================================================
{
  for (const q of ["اهلا", "أهلاً بيك", "مرحبا", "السلام عليكم", "صباح الخير", "hi", "hello", "hey", "good morning"]) {
    ok(E.match(q).intent === "greeting", `greeting: "${q}"`);
  }
  ok(E.match("Hi there!").intent === "greeting", "greeting with casing");
  ok(E.match("this is a question").intent !== "greeting", "no false greeting from 'this' (substring guard)");
}

// ===========================================================================
section("A3. Platform intents (AR + EN)");
// ===========================================================================
{
  const cases = [
    ["platform.getting-started", "إزاي أبدأ أول درس؟"],
    ["platform.getting-started", "How do I start my first lesson?"],
    ["platform.courses", "فين الكورسات؟"],
    ["platform.courses", "What courses do you have?"],
    ["platform.lessons", "إزاي أفتح الدرس الجاي؟"],
    ["platform.lessons", "Where are the lessons?"],
    ["platform.quizzes", "فين الكويزات بتاعتي؟"],
    ["platform.quizzes", "Where can I find my quizzes?"],
    ["platform.session-progression", "الجلسات المقفولة بتفتح إزاي؟"],
    ["platform.session-progression", "How do sessions unlock?"],
    ["platform.mock-exam", "فين الامتحانات التجريبية؟"],
    ["platform.mock-exam", "Where are the mock exams?"],
    ["platform.study-scheduler", "إزاي أستخدم جدول المذاكرة؟"],
    ["platform.study-scheduler", "How does the study plan work?"],
    ["platform.progress", "فين ألاقي تقدمي؟"],
    ["platform.progress", "Where can I view my progress?"],
    ["platform.certificate", "إزاي أطلع الشهادة؟"],
    ["platform.certificate", "How do I get the certificate?"],
    ["platform.navigation", "إزاي أتنقل في المنصة؟"],
    ["platform.navigation", "How do I navigate the platform?"],
    ["platform.notifications", "فين الإشعارات؟"],
    ["platform.notifications", "Where are my notifications?"],
    ["help", "بتقدر تساعدني في إيه؟"],
    ["help", "What can you do?"],
  ];
  for (const [intent, q] of cases) {
    const r = E.match(q);
    ok(r.matched && r.intent === intent, `platform "${q}" → ${intent} (got ${r.intent})`);
  }
  // Specific concept beats generic navigation ("where can I find X").
  ok(E.match("How do I access mock exams?").intent === "platform.mock-exam", "specific mock-exam beats navigation");
  ok(E.match("Where can I find my progress?").intent === "platform.progress", "specific progress beats navigation");
}

// ===========================================================================
section("A4. Educational intents (AR + EN)");
// ===========================================================================
{
  const cases = [
    ["edu.variable", "ما هو المتغير؟"],
    ["edu.variable", "What is a variable?"],
    ["edu.function", "ما هي الدالة؟"],
    ["edu.function", "Explain functions to me"],
    ["edu.loop", "ما هي الحلقة؟"],
    ["edu.loop", "What is a loop?"],
    ["edu.condition", "ما هو الشرط؟"],
    ["edu.condition", "What is a condition?"],
    ["edu.array", "ما هي المصفوفة؟"],
    ["edu.array", "What is an array?"],
    ["edu.algorithm", "ما هي الخوارزمية؟"],
    ["edu.algorithm", "What is an algorithm?"],
    ["edu.programming", "ازمتعلم البرمجة؟"],
    ["edu.programming", "How do I start learning programming?"],
    ["edu.data-types", "What are data types?"],
    ["edu.input-output", "What is input and output?"],
    ["edu.ai-basics", "What is AI?"],
    ["edu.ai-basics", "ما هو الذكاء الاصطناعي؟"],
    ["edu.ml-basics", "What is machine learning?"],
    ["edu.ml-basics", "ما هو تعلم الآلة؟"],
    ["edu.neural-network", "What is a neural network?"],
    ["edu.neural-network", "ما هي الشبكة العصبية؟"],
    ["edu.llm", "What is an LLM?"],
    ["edu.llm", "ما هي نماذج اللغة الكبيرة؟"],
  ];
  for (const [intent, q] of cases) {
    const r = E.match(q);
    ok(r.matched && r.intent === intent, `edu "${q}" → ${intent} (got ${r.intent})`);
  }
  // "explain/example" softness: concept name still wins when present.
  ok(E.match("help me understand variables").intent === "edu.variable", "concept beats explain wrapper");
  ok(E.match("Explain this concept simply").intent === "edu.explain", "bare explain → edu.explain");
  ok(E.match("Give me a simple example").intent === "edu.explain", "bare example → edu.explain");
}

// ===========================================================================
section("A5. Curated differences + graceful fallbacks");
// ===========================================================================
{
  const diffs = [
    ["edu.difference.variable-vs-constant", "ما الفرق بين المتغير والثابت؟"],
    ["edu.difference.variable-vs-constant", "What is the difference between a variable and a constant?"],
    ["edu.difference.loop-vs-condition", "الفرق بين الحلقة والشرط؟"],
    ["edu.difference.loop-vs-condition", "difference between a loop and a condition"],
    ["edu.difference.supervised-vs-unsupervised", "إيه الفرق بين supervised و unsupervised؟"],
    ["edu.difference.supervised-vs-unsupervised", "supervised vs unsupervised learning"],
  ];
  for (const [intent, q] of diffs) {
    ok(E.match(q).intent === intent, `difference "${q}" → ${intent}`);
  }
  const generic = E.match("What is the difference between x and y?");
  ok(generic.intent === "edu.difference.generic", "unknown comparison → difference guidance");
  ok(!generic.matched, "unknown comparison is not a curated match");

  const unknown = E.match("Tell me about quantum teleportation please");
  ok(unknown.intent === "fallback" && !unknown.matched, "unknown question → graceful fallback");
  const arUnknown = E.match("عايز أتعلم الطبخ");
  ok(arUnknown.intent === "fallback" && !arUnknown.matched, "unknown Arabic question → graceful fallback");
  ok(E.match("").intent === "fallback", "blank input → fallback");
}

// ===========================================================================
section("A6. English / Arabic responses + determinism + safety");
// ===========================================================================
{
  const variable = E.match("What is a variable?");
  ok(variable.answer.ar.length > 0 && AR.test(variable.answer.ar), "AR answer contains Arabic");
  ok(variable.answer.en.length > 0 && !AR.test(variable.answer.en), "EN answer is English-only");
  ok(E.pickAnswer(variable, "ar") === variable.answer.ar, "pickAnswer picks AR");
  ok(E.pickAnswer(variable, "en") === variable.answer.en, "pickAnswer picks EN");

  // Determinism: same query → byte-identical response every time.
  const a = E.match("   ما   هو   المتغير   ؟ ");
  const b = E.match("ما هو المتغير؟");
  eq(JSON.stringify(a), JSON.stringify(b), "deterministic matching");
  const c1 = E.match("WHERE CAN I FIND MY QUIZZES?");
  const c2 = E.match("where can i find my quizzes?");
  eq(JSON.stringify(c1), JSON.stringify(c2), "case-insensitive deterministic matching");

  // Suggestions: 4 curated bilingual prompts; AR has Arabic, EN has English.
  const sugAr = E.suggestedPrompts("ar");
  const sugEn = E.suggestedPrompts("en");
  ok(sugAr.length === 4 && sugEn.length === 4, "suggestions count = 4");
  ok(sugAr.every((s) => AR.test(s)), "AR suggestions are Arabic");
  ok(sugEn.every((s) => !AR.test(s)), "EN suggestions are English");

  // Security: raw input is never echoed; HTML is not executable content.
  const evil = E.match('<script>alert("x")</script>');
  ok(evil.intent === "fallback", "scripty input → fallback");
  const evilText = JSON.stringify(evil.answer);
  ok(!evilText.includes("<script") && !evilText.includes("alert"), "engine never echoes untrusted input");
  const wrapped = E.match("ما هو <img src=x onerror=alert(1)> المتغير؟");
  ok(wrapped.intent === "edu.variable", "HTML in the middle does not break matching");
  ok(!JSON.stringify(wrapped.answer).includes("<img"), "answer strips/never contains injected markup");

  // Max input length guard (engine slices to MAX_SAFE_INPUT).
  const long = "a".repeat(5000) + " ما هو المتغير؟";
  ok(E.match(long).intent === "edu.variable" || E.match(long).intent === "fallback", "long input is handled safely");

  // No raw translation keys anywhere in the scripted content.
  const content = JSON.stringify([...E.supportedIntents(), ...E.suggestedPrompts("ar"), ...E.suggestedPrompts("en")]);
  ok(!/(kodgy|student|shell|admin|app)\.[0-9]{3}/.test(content), "no raw dict keys in engine content");
  ok(E.supportedIntents().length >= 20, `supported intent surface = ${E.supportedIntents().length}`);
}

// ===========================================================================
section("B1. Position — Arabic LEFT / English RIGHT (locale-dynamic)");
// ===========================================================================
{
  eq(P.defaultEdge("ar"), "left", "Arabic → LEFT edge");
  eq(P.defaultEdge("en"), "right", "English → RIGHT edge");
  eq(P.defaultPos("ar"), { x: 16, y: 16 }, "AR default position");
  eq(P.defaultPos("en"), { x: 16, y: 16 }, "EN default position");

  const vp = { width: 1440, height: 900 };
  const size = P.robotSizeFor(vp);

  // x is measured from the locale edge → locale switch re-anchors the side.
  const arBox = P.robotBox({ x: 16, y: 16 }, vp, size, "ar");
  const enBox = P.robotBox({ x: 16, y: 16 }, vp, size, "en");
  ok(arBox.left < vp.width / 2, "AR robot sits in the LEFT half");
  ok(enBox.left > vp.width / 2, "EN robot sits in the RIGHT half");
  ok(Math.abs(enBox.left - (vp.width - arBox.left - size)) < 0.001, "locale switch mirrors horizontally");

  // Pointer → stored position round trips (y measured from the bottom of the
  // robot's true aspect-ratio height).
  const pointerY = vp.height - P.robotHeight(size) - 16;
  eq(P.posFromPointer(16, pointerY, vp, size, "ar"), { x: 16, y: 16 }, "AR pointer → x from LEFT");
  eq(P.posFromPointer(1440 - 16 - size, pointerY, vp, size, "en"), { x: 16, y: 16 }, "EN pointer → x from RIGHT");
}

// ===========================================================================
section("B2. Position — clamping to the visible viewport");
// ===========================================================================
{
  const vp = { width: 390, height: 844 };
  const size = P.robotSizeFor(vp);
  eq(size, P.KODGY_MOBILE_ROBOT_SIZE, "mobile robot size");
  eq(P.robotSizeFor({ width: 1440, height: 900 }), P.KODGY_DESKTOP_ROBOT_SIZE, "desktop robot size");

  const low = P.clampPos({ x: -999, y: -999 }, vp, size);
  ok(low.x >= P.KODGY_MARGIN && low.y >= P.KODGY_MARGIN, "negative offsets clamped inside");
  const high = P.clampPos({ x: 99999, y: 99999 }, vp, size);
  ok(high.x + size <= vp.width - P.KODGY_MARGIN, "x clamped: robot stays inside width");
  ok(high.y + size <= vp.height - P.KODGY_MARGIN, "y clamped: robot stays inside height");
  const nan = P.clampPos({ x: NaN, y: Infinity }, vp, size);
  ok(Number.isFinite(nan.x) && Number.isFinite(nan.y), "NaN/Infinity sanitized");

  // Pointer positions are clamped to usable bounds before conversion.
  const px = P.posFromPointer(-5000, -5000, vp, size, "ar");
  ok(px.x >= P.KODGY_MARGIN && px.y >= P.KODGY_MARGIN, "pointer far outside → clamped");
}

// ===========================================================================
section("B3. Panel geometry — placement, bounds, below fallback");
// ===========================================================================
{
  const vp = { width: 1440, height: 900 };
  const above = P.panelGeometry({ x: 16, y: 16 }, vp, "ar", 416, 544);
  ok(above.placement === "above", "bottom-docked robot → panel above");
  ok(above.side === "left", "AR panel hugs LEFT");
  ok(above.left != null && above.left >= P.KODGY_SIDE_PANEL_INSET, "panel clamped to viewport horizontally");
  ok(above.maxHeight <= 544, "panel respects desired height");
  ok(above.bottom + above.maxHeight <= vp.height, "panel top stays inside viewport");

  const enAbove = P.panelGeometry({ x: 16, y: 16 }, vp, "en", 416, 544);
  ok(enAbove.side === "right" && enAbove.right != null, "EN panel hugs RIGHT");

  // Robot dragged high → panel falls below and stays inside the viewport.
  const below = P.panelGeometry({ x: 200, y: 750 }, vp, "ar", 416, 544);
  ok(below.placement === "below", "high robot → panel below");
  const panelTopFromBottom = below.bottom + below.maxHeight;
  ok(panelTopFromBottom <= vp.height, "below panel still inside viewport");
  ok(below.bottom >= P.KODGY_MARGIN, "below panel bottom margin respected");

  // Mobile: panel width is clamped to the screen.
  const mob = P.panelGeometry({ x: 12, y: 12 }, { width: 390, height: 844 }, "ar", 9999, 700);
  ok(mob.left != null && mob.left >= P.KODGY_SIDE_PANEL_INSET, "mobile panel clamped in");
}

// ===========================================================================
section("C1. I18N — Kodgy chrome keys exist bilingually and never leak");
// ===========================================================================
{
  const keys = [
    "kodgy.001", "kodgy.002", "kodgy.003", "kodgy.004", "kodgy.005", "kodgy.006",
    "kodgy.007", "kodgy.008", "kodgy.009", "kodgy.010", "kodgy.011", "kodgy.012",
    "kodgy.013", "kodgy.014", "kodgy.015",
  ];
  for (const k of keys) {
    ok(I.hasDictKey(k), `${k} exists in the merged dictionary`);
    const ar = I.translate("ar", k);
    const en = I.translate("en", k);
    ok(ar.length > 0 && AR.test(ar), `${k} has Arabic text`);
    ok(en.length > 0, `${k} has English text`);
  }
  ok(I.translate("ar", "kodgy.999") === "", "missing key → empty, never the raw key");
  ok(I.looksLikeDictKey("kodgy.001"), "looksLikeDictKey recognizes kodgy keys");
  // The UI must only ever render through translate() — no raw key returns.
  ok(I.translate("ar", "kodgy.001") !== "kodgy.001", "translate never returns the raw key");

  // Every kodgy.* key referenced from Kodgy components exists in the dict.
  const components = [
    "src/components/kodgy/kodgy-assistant.tsx",
    "src/components/kodgy/kodgy-chat-panel.tsx",
  ];
  const refs = new Set();
  for (const rel of components) {
    const src = read(rel);
    const found = src.match(/["'`]kodgy\.\d{3}["'`]/g) || [];
    for (const f of found) refs.add(f.replace(/["'`]/g, ""));
  }
  ok(refs.size >= 8, `chassis references ${refs.size} kodgy.* keys`);
  for (const k of refs) ok(I.hasDictKey(k), `${k} referenced by Kodgy UI exists in dict`);
}

// ===========================================================================
section("C2. Source invariants — client-side only, no AI API, no unsafe HTML");
// ===========================================================================
{
  const kodgyFiles = [
    "src/components/kodgy/kodgy-assistant.tsx",
    "src/components/kodgy/kodgy-chat-panel.tsx",
    "src/components/kodgy/kodgy-robot.tsx",
    "src/components/kodgy/use-kodgy-chat.ts",
    "src/lib/kodgy/response-engine.ts",
    "src/lib/kodgy/position.ts",
  ];
  for (const rel of kodgyFiles) {
    ok(exists(rel), `${rel} exists`);
    const src = read(rel);
    ok(!/fetch\s*\(/.test(src), `${rel} makes no network calls`);
    // The response engine legitimately TEACHES about LLMs/Gemini/ChatGPT
    // (curriculum content), so the integration check only forbids SDK/API
    // wiring — and is stricter for the UI/controller files.
    const integration = rel.includes("response-engine")
      ? /z-ai|openai|anthropic|claude|process\.env|api[_-]?key|completions\.create/i
      : /z-ai|openai|anthropic|gemini|claude|gpt-|llm-api|process\.env/i;
    ok(!integration.test(src), `${rel} has no external AI integration`);
    ok(!/dangerouslySetInnerHTML\s*=/.test(src), `${rel} has no unsafe HTML injection`);
  }

  // Engine must stay dependency-free (single-file, deterministic, offline).
  ok(!/^\s*import\s/m.test(read("src/lib/kodgy/response-engine.ts")), "response engine has no imports");

  // The old external-AI endpoint is gone; nothing pretends to be an AI service.
  ok(!exists("src/app/api/ai/chat/route.ts"), "/api/ai/chat route removed");
  ok(!exists("src/app/api/ai"), "/api/ai namespace removed");
  ok(!/["'`]\/api\/ai["'`]/.test(read("src/components/app-shell.tsx")), "shell no longer reaches /api/ai");
  ok(!/["']\/api\/ai["']/.test(read("src/lib/route-protection.ts")), "route protection has no dead /api/ai prefix");

  // The only remaining LLM consumer is the Phase 5 admin quiz generator.
  ok(
    /z-ai-web-dev-sdk/.test(read("src/app/api/admin/ai-generate-quiz/route.ts")),
    "admin ai-generate-quiz keeps its intentional LLM integration"
  );

  // Kodgy is mounted in the authenticated shell (all roles), like before.
  const shell = read("src/components/app-shell.tsx");
  ok(/KodgyAssistant/.test(shell), "app-shell mounts KodgyAssistant");
  ok(!/AiAssistant/.test(shell), "old AiAssistant import removed");

  // Architecture layering: the controller imports the engine; the UI imports
  // the controller; no component reaches into the knowledge set directly.
  ok(/response-engine/.test(read("src/components/kodgy/use-kodgy-chat.ts")), "controller → engine boundary");

  // Old component gone; no orphaned ai/ directory.
  ok(!exists("src/components/ai"), "old src/components/ai removed");

  // Reduced-motion support exists in the stylesheet.
  const css = read("src/app/globals.css");
  ok(/prefers-reduced-motion:\s*reduce/.test(css), "globals.css has prefers-reduced-motion");
  ok(/kodgy-flame-tongue/.test(css) && /kodgy-ring/.test(css) && /kodgy-float/.test(css), "kodgy animation classes defined");
  ok(/animation:\s*none\s*!important/.test(css), "reduced motion disables animations");

  // Dragging constraints + locale data hooks are present (testable surface).
  const assistant = read("src/components/kodgy/kodgy-assistant.tsx");
  ok(/onPointerDown/.test(assistant) && /onPointerMove/.test(assistant) && /onPointerUp/.test(assistant), "pointer dragging implemented");
  ok(/cm-kodgy-pos/.test(assistant), "drag position persisted in localStorage");
  ok(/data-kodgy-side/.test(assistant), "locale side exposed as data attribute");
  ok(/role="button"/.test(assistant) && /aria-expanded/.test(assistant), "robot is keyboard accessible");
  ok(/Escape/.test(assistant), "Escape closes panel");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nPhase 10 Kodgy assistant: ${pass} passed, ${fail} failed`);
try {
  fs.rmSync(OUT, { recursive: true, force: true });
} catch {}
process.exit(fail ? 1 : 0);
