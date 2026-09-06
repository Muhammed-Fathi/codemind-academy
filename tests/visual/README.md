# Visual RTL/LTR layout tests

These tests exist to verify one requirement of the 2026 platform upgrade that
**cannot** be checked by reading source: that every form renders correctly in
Arabic (RTL) and English (LTR) at desktop, tablet and mobile widths.

They render the **real** components (`ForgotPasswordForm`, `SessionVideosView`,
`MockExamsView`, `QuizReviewView`, and the real `src/components/ui/*`
primitives) against the **real** compiled `src/app/globals.css`, then make
geometric assertions on the resulting layout in a real Chromium.

## Why this was needed

Source inspection had passed this requirement. The browser run immediately
found a defect that source inspection structurally could not:

> `.field-with-icon > input { padding-inline-end: 2.5rem }` was declared in
> `@layer components`. Tailwind v4 orders `@layer theme, base, components,
> utilities`, and **layer order beats specificity**, so shadcn's `px-3`
> utility on `<Input>` won. The reserved space collapsed to 12px and input
> icons sat on top of the user's text — in both directions, at every
> breakpoint. Fixed by moving the rule into `@layer utilities`.

## What is asserted

Per scene × viewport (1440x900, 834x1112, 390x844) × direction (ar/rtl, en/ltr):

- no horizontal document overflow
- no control clipped past either viewport edge
- computed `direction` matches the requested locale
- input icons never overlap the input's text box (padding-aware)
- dialog/sheet/drawer panels stay inside the viewport and stay centred
- buttons meet a minimum hit target
- homepage step-card number never intersects its icon
- admin student tabs switch and filter interactively

## Running

The runner needs (a) a Chromium and (b) a static server hosting the bundled
harness. Nothing it produces is written into the repository.

```bash
# 1. compile the REAL app stylesheet + bundle the harness into a temp dir
OUT=$(mktemp -d)
npx @tailwindcss/cli -i src/app/globals.css -o "$OUT/app.css" \
  --content "./src/**/*.{ts,tsx}","./tests/visual/*.tsx"
npx esbuild tests/visual/harness.tsx --bundle --outfile="$OUT/harness.js" \
  --jsx=automatic --format=iife --define:process.env.NODE_ENV='"production"' \
  --alias:@=./src
printf '%s' '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<link rel="stylesheet" href="/app.css"></head><body><div id="root"></div>
<script src="/harness.js"></script></body></html>' > "$OUT/index.html"
python3 -m http.server 8099 --directory "$OUT" &

# 2. run
node tests/visual/run-visual-tests.mjs [--shots]
```

The harness imports `next/navigation`, `@/lib/store` and `sonner`; supply small
stub modules for those via esbuild `--alias:` (they only need to satisfy the
imports — the components under test are the real ones).

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `VISUAL_BASE` | `http://127.0.0.1:8099` | where the harness is served |
| `VISUAL_CHROME` | Playwright's bundled Chromium | alternate browser executable |
| `VISUAL_SHOT_DIR` | `$TMPDIR/codemind-visual-shots` | `--shots` output |

`--shots` writes PNGs **outside the repository on purpose**. Screenshots are
review evidence, not source; do not commit them.

### If `npx playwright install` is blocked

`@sparticuz/chromium` (already a dependency) ships a Brotli-compressed browser
that can be extracted locally and pointed at with `VISUAL_CHROME`. That path
needs `LD_LIBRARY_PATH` set to the libraries it also ships. **Never commit the
extracted binary or its libraries.**
