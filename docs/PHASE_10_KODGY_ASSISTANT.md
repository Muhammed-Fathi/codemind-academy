# Phase 10 — Kodgy AI Assistant (Rebuild: Scripted + Animated Robot)

**Status:** completed (2026-09-08)
**Branch:** `arena/01a08222-codemind-academy`
**Baseline:** `12e4e63` (Phase 9 merge on `main`)

---

## Objective

Rebuild the existing Kodgy AI Assistant, which was architecturally
oriented toward an external AI API (z-ai-web-dev-sdk chat), into a
**beautiful, interactive, animated, scripted assistant** embedded in
CodeMind Academy. No external AI/LLM is integrated in this phase; real
AI/API integration is intentionally deferred.

---

## Baseline

| Item | Value |
|---|---|
| `main` HEAD at start | `12e4e63` |
| Working tree | clean |
| Branch | `arena/01a08222-codemind-academy` |
| Prior phase | Phase 9 Calendar / i18n (merged PR #26) |

---

## 1. Discovery findings (what existed before)

| Item | Finding |
|---|---|
| UI | `src/components/ai/ai-assistant.tsx` — generic floating chat bubble (sparkle icon in a gradient circle), glass panel, suggestion chips |
| API | `src/app/api/ai/chat/route.ts` — `POST/GET/DELETE` backed by **z-ai-web-dev-sdk** with an Egyptian-Arabic system prompt; in-memory conversation store keyed by sessionId (max 12 messages) |
| State | Component-local `open/messages/input/loading/sessionId` + server history |
| DB | **No** AI/chat models in `prisma/schema.prisma` — conversations were in-memory only |
| i18n | `ai.001`…`ai.012` keys in the generated dictionary (`scripts/i18n/catalog.json`) |
| Mount | `<AiAssistant/>` in `src/components/app-shell.tsx`, shown only when `user` exists and view is not `landing/login/register` → **all authenticated roles** |
| Protection | `/api/ai` in `PROTECTED_API_PREFIXES` (`src/lib/route-protection.ts`) |
| Env | `.env.example` documented only the sandbox-configured SDK; no keys in repo |
| Other AI | `src/app/api/admin/ai-generate-quiz/route.ts` — separate LLM quiz generator (**kept as-is**, unrelated to Kodgy) |
| Docs | README, `docs/ARCHITECTURE.md` §5, `docs/DEVELOPMENT_GUIDE.md`, `docs/PORTALS_AND_FEATURES.md` described the SDK chatbot |

### Why restructuring was required

The old implementation was **built around a live AI endpoint**: the
client called `/api/ai/chat`, the route called the external LLM SDK, and
the UX (typing indicator, history persistence, sessionId) simulated
network-backed conversations. The visual was a generic sparkle-chat-bubble,
not the reference robot. This phase removes the AI-API assumption from
the normal Kodgy flow entirely, replaces the response source with a
deterministic scripted engine, and rebuilds the UI around a code-first
animated robot.

### Decisions

- **Remove** `src/app/api/ai/chat/route.ts` and `src/components/ai/ai-assistant.tsx`
  — no dead API wiring, no endpoint that pretends to be an AI service.
- **Keep** `src/app/api/admin/ai-generate-quiz` (unrelated, intentional
  LLM feature with its own route guard).
- **No schema change.** No Prisma model, no migration, no `db push`, no
  conversation persistence. Conversation history stays client-side.
- **No new dependency.** Framer Motion is already in the project; the
  robot is inline SVG + CSS animations (no rendering framework).
- **No secrets.** Kodgy needs no credentials in any environment.

---

## 2. Final architecture

```text
Kodgy UI (kodgy-assistant.tsx + kodgy-robot.tsx + kodgy-chat-panel.tsx)
      ↓
Kodgy Assistant Controller (use-kodgy-chat.ts — local React state)
      ↓
Scripted Response Engine (src/lib/kodgy/response-engine.ts)
      ↓
Matched Response  ({ intent, matched, score, answer: { ar, en } })
```

Plus:

| Layer | File | Role |
|---|---|---|
| Positioning math | `src/lib/kodgy/position.ts` | locale edge, clamping, panel geometry (pure, testable) |
| Chrome i18n | `src/lib/i18n-dict-2026.ts` (`kodgy.001`…`kodgy.015`) | assistant chrome strings |
| Answer content | `response-engine.ts` | bilingual curated scripted answers |
| Styles | `src/app/globals.css` | robot/flame/ring/ember animation + reduced-motion |
| Mount | `src/components/app-shell.tsx` | `<KodgyAssistant/>`, all authenticated roles |

The engine exposes a single stable contract (`KodgyResponse`). A future
real AI engine can replace `match()` behind that contract without
touching the UI.

## 3. Scripted response engine

- Deterministic keyword/phrase scoring over a curated knowledge set.
- Normalization: NFKC + lowercase, Arabic diacritics/hamza/ta-marbuta
  collapse, definite-article strip, punctuation removal (incl. `؟ ،`),
  whitespace collapse.
- Phrase hits score high; single-token keywords (e.g. `ai`, `ml`) match
  exact tokens only to avoid substring false positives.
- `edu.difference.*` pairs (variable vs constant, loop vs condition,
  supervised vs unsupervised) take precedence on compare questions;
  unknown comparison → dedicated graceful guidance.
- Unknown questions → bilingual fallback that names the supported scope.
- Input is sliced to 500 chars; no output ever echoes raw user input.

### Platform topics

getting started · courses · lessons · quizzes · session progression ·
mock exams · study scheduler · progress · certificates · navigation ·
notifications · greetings · help

### Educational topics

variable · function · loop · condition · array · algorithm ·
programming basics · data types · input/output · AI basics ·
machine learning · neural networks · LLMs · curated differences

## 4. Robot UI (primary visual requirement)

- **Code-first SVG robot** (no image assets, no graphics framework):
  rounded head + visor face, antenna with amber tip, ears, body, arms,
  legs, glowing eyes, smile, chest light.
- **Flame/energy burst**: inner hot core (always breathing) + center
  tongue (~130px tall in viewBox units) + two side tongues + two slim
  tongues + 12 petals arranged around the energy ring. Tongues use
  `transform-box: fill-box` + `transform-origin` and a shared
  appear → grow → shrink → fade → disappear → reappear keyframe cycle
  (3.1–5.1 s, phase-offset per tongue — continuous, not flashing).
- **Energy ring**: dashed spinning ring + soft ring glow + halo, all
  rotating/pulsing on transform/opacity only.
- **Aura + embers**: radial-gradient aura breathing behind everything;
  three embers rise and fade.
- **Idle**: whole robot floats and micro-tilts (`@keyframes kodgyFloat`,
  transform-only).
- Light & dark theme tokens (`--kodgy-*`) keep the treatment visible in
  both modes; no layout-triggering animation properties.

## 5. Interaction

- **Open/close**: click/tap the robot (a click without movement toggles;
  drag and click are disambiguated); close X, Escape, and keyboard
  Enter/Space on the focused robot.
- **Conversation**: user + assistant bubbles, bilingual curated
  suggestions, local thinking animation (~500 ms, honest — no fake
  network), Enter sends, Shift+Enter newline, clear-conversation button,
  auto-scroll.
- **Dragging**: Pointer Events (mouse + touch) with 6 px threshold,
  `setPointerCapture`, `touch-action: none`, `user-select: none`;
  position clamped to the visible viewport (never lost off-screen),
  persisted per-locale in `localStorage` (`cm-kodgy-pos`), resized
  re-clamped, reset button in the panel footer.
- **Responsive**: robot 96 px desktop / 72 px under 640 px; panel
  `w-[min(92vw,26rem)]`, height capped to viewport, opens above the
  robot when possible, below otherwise; verified 1440/834/390 px.

## 6. Localization (Arabic LEFT / English RIGHT)

- Positions are stored as **x from the locale-default edge**:
  Arabic → LEFT edge, English → RIGHT edge (explicit `defaultEdge`).
  Switching locale re-anchors Kodgy to the required side automatically.
- Data attributes `data-kodgy-side` / `data-kodgy-locale` expose the
  active side for tests and debugging.
- All chrome strings use the existing i18n dictionary (`kodgy.001`…),
  rendered through `useT()`; no raw keys can reach the DOM
  (`translate()` never returns a dotted key).
- Only the *scripted answer content* is author-managed bilingual
  `{ar,en}` in the engine (deliberate, so the knowledge set is
  self-contained and offline-testable).
- RTL/LTR verified in-browser: panel, bubbles (`dir="auto"`), input,
  send icon (`flip-rtl`), footer.

## 7. Accessibility & performance

- Robot is `role="button"` + `tabIndex=0` with localized
  `aria-label`, `aria-expanded`, `aria-haspopup="dialog"`,
  `aria-controls`; focus-visible ring.
- Panel is `role="dialog"` with localized label; input has label +
  placeholder; every icon action has aria-label/title; no focus trap
  (Tab flows out; Escape closes); `aria-live` on thinking status.
- `prefers-reduced-motion: reduce` disables float, flame, ring, aura,
  embers, status/thinking animations while keeping Kodgy visible and
  fully usable (verified in Chromium).
- Motion uses `transform`/`opacity` only; SVG + CSS (no animation
  library, no large assets, no network requests).

## 8. Security

- **No external AI**: no SDK import, no `/api/ai/*` route, no
  `fetch`, no env keys in the Kodgy flow.
- **No unsafe HTML**: zero `dangerouslySetInnerHTML`; user text renders
  as plain React text nodes (React-escaped); the engine never echoes
  input.
- **No server trust of client state**: there is no Kodgy server surface
  at all.
- Route protection no longer carries a dead `/api/ai` prefix; the old
  endpoint is gone so nothing can "pretend" to be an AI service.

## 9. Database / migrations

**None.** No Prisma change, no migration, no `db push`, no reset, no
conversation model.

## 10. Tests

### Offline suites (node, all green)

| Suite | Assertions |
|---|---|
| `tests/kodgy-phase10.test.js` (new) | 231 |
| Phase 4 `session-progression` | 144 |
| Phase 5 `session-quiz` | 70 |
| Phase 6 `quiz-analytics` | 44 |
| Phase 7 `parent-dashboard-isolation` | 112 |
| Phase 8 `mock-exam-phase8` | 135 |
| Phase 9 `calendar-i18n-phase9` | 440 |
| `security-hardening` | 239 |
| `authorization-invariants` | 93 |
| `mock-exam-grading-isolation` | 22 |
| `parent-monthly-report` | 67 |
| `registration-validators` | 24 |
| `migration-sql` | 15 |
| `platform-upgrade-2026-migration` | 98 |
| `seed-idempotency` | 18 |
| **Total** | **1,752** |

`kodgy-phase10.test.js` covers: normalization (case/whitespace/Arabic
variants), greetings, all platform + educational intents (AR+EN),
differences, unknown/blank/scripty input → graceful fallback,
determinism, bilingual answers + suggestions, position math (Arabic LEFT
/ English RIGHT, clamping, panel geometry, mobile), i18n key existence
with no raw-key leaks, plus source invariants: no `/api/ai`, no AI SDK,
no `fetch`, no `dangerouslySetInnerHTML`, reduced-motion CSS, drag
handlers, keyboard access.

### Real-browser visual suite

`tests/visual/harness.tsx` + `tests/visual/run-kodgy-visual.mjs` drive
the REAL Kodgy components against the REAL compiled `globals.css` in a
real Chromium (from `@sparticuz/chromium`):

- **142 assertions, 0 failures** across 3 viewports (1440×900, 834×1112,
  390×844) × 2 locales: robot on the correct side (AR LEFT / EN RIGHT),
  in-bounds; panel in-bounds; open/close; localized conversation with
  user + scripted bubbles; no raw i18n keys (text + aria/title/
  placeholder); Escape/Enter keyboard; mouse drag moves + stays in
  bounds + persists after reload + click-after-drag still opens; zero
  console/page errors; reduced-motion disables flame/float while Kodgy
  stays usable.
- Screenshots reviewed (light + dark, AR + EN, all viewports) — no
  broken assets, no overflow/clipping, no z-index issues.

## 11. Typecheck / lint / build

- `tsc --noEmit`: **0 errors in Phase 10 files**. 22 pre-existing errors
  remain, all "missing generated Prisma client" fallout (sandbox cannot
  reach `binaries.prisma.sh` — identical to Phases 6–9 baselines).
- ESLint: **0 findings in Phase 10 files** (new files + app-shell +
  i18n dict + route-protection + tests). Repo-wide state improved from
  the Phase 9 baseline (76 existing problems, one fewer than before
  because the removed legacy files carried findings; none are Phase 10).
- `npm run build` (`prisma generate` first step) is **blocked in this
  sandbox** by `binaries.prisma.sh` being unreachable (same as Phases
  6–9). The compiled component harness + real browser verification
  substitutes for the UI half of production verification; build must be
  re-run where Prisma engines are reachable.

## 12. Known limitations

- Real external AI/LLM integration is **intentionally deferred**; Kodgy
  answers from the curated scripted knowledge base only.
- Conversation history is client-side session state (not persisted).
- `ai.001`…`ai.012` legacy dictionary keys remain in the generated
  catalogue but are unused (harmless; regenerated by the i18n tooling).
- Full `next build` + production server start could not be executed in
  this sandbox (Prisma engine download blocked); re-run where reachable.
- Scripted educational coverage is intentionally limited to the curated
  initial set (see §3); no fabricated advanced coverage.

## 13. Files changed

**Added**

```
src/lib/kodgy/response-engine.ts
src/lib/kodgy/position.ts
src/components/kodgy/kodgy-assistant.tsx
src/components/kodgy/kodgy-chat-panel.tsx
src/components/kodgy/kodgy-robot.tsx
src/components/kodgy/use-kodgy-chat.ts
tests/kodgy-phase10.test.js
tests/visual/run-kodgy-visual.mjs
docs/PHASE_10_KODGY_ASSISTANT.md
```

**Modified**

```
src/components/app-shell.tsx        (mount KodgyAssistant)
src/lib/i18n-dict-2026.ts           (kodgy.001…015)
src/app/globals.css                 (robot/flame CSS + reduced-motion)
src/lib/route-protection.ts         (drop dead /api/ai prefix)
src/components/dashboard/shell.tsx  (unchanged — no unrelated refactor)
src/app/api/admin/ai-generate-quiz/route.ts (unchanged)
scripts/i18n/codemod-api.mjs        (path comment for removed route)
tests/security-hardening.test.js    (route enumeration no longer lists /api/ai/chat)
tests/visual/harness.tsx            (kodgy scene)
README.md, docs/ARCHITECTURE.md, docs/DEVELOPMENT_GUIDE.md,
docs/PORTALS_AND_FEATURES.md        (living docs)
docs/PROJECT_STATE.md               (phase status)
```

**Removed**

```
src/app/api/ai/chat/route.ts        (external-AI endpoint)
src/components/ai/ai-assistant.tsx  (generic chat bubble)
src/app/api/ai/  src/components/ai/ (empty dirs)
```
