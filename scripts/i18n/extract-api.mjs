#!/usr/bin/env node
// Extraction for server-side files: src/app/api/**/*.ts + selected src/lib.
// Emits scripts/i18n/catalog-api.json with keys api.NNN / lib.NNN.
import fs from "fs";
import path from "path";
import ts from "typescript";

const AR = /[\u0600-\u06FF]/;
const EXCLUDE = [
  "lib/curriculum.ts",
  "lib/curriculum-seed.ts",
  "lib/i18n.ts",
  "lib/i18n-dict.ts",
  "lib/i18n-server.ts",
  "lib/db.ts",
  "lib/auth.ts",
  "lib/gamification.ts", // badge/level strings already have EN twins (…En fields)
  "lib/brand.ts", // brand config, intentionally Arabic-first
  "lib/utils.ts",
  "lib/api.ts",
];

const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.ts$/.test(e.name)) files.push(p);
  }
}
walk("src/app/api");
walk("src/lib");
files.sort();

const catalog = [];
const seen = new Set();
const counters = { api: 0, lib: 0 };

for (const f of files) {
  if (EXCLUDE.some((x) => f.endsWith(x))) continue;
  const domain = f.includes("/api/") ? "api" : "lib";
  const src = fs.readFileSync(f, "utf8");
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  function shapeOf(node) {
    let s = node.head.text, n = 0;
    for (const sp of node.templateSpans) {
      n++;
      s += `{p${n}}` + sp.literal.text;
    }
    return s;
  }
  const visit = (node) => {
    let s = null, shape = null, kind = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      s = node.text; kind = "plain";
    } else if (ts.isTemplateExpression(node)) {
      shape = shapeOf(node); s = shape; kind = "tmpl";
    }
    if (s && AR.test(s)) {
      const k = kind === "tmpl" ? shape : s.replace(/\s+/g, " ").trim();
      if (!seen.has(f + "|" + k)) {
        seen.add(f + "|" + k);
        counters[domain]++;
        catalog.push({
          key: `${domain}.${String(counters[domain]).padStart(3, "0")}`,
          file: f.replace(/^src\//, ""),
          ar: k,
          kind,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

catalog.sort((a, b) => a.key.localeCompare(b.key));
fs.writeFileSync(
  path.join("scripts/i18n", "catalog-api.json"),
  JSON.stringify(catalog, null, 1)
);
console.log("catalog-api entries:", catalog.length);
