#!/usr/bin/env node
// i18n extraction v2 - builds the translation catalog.
// Walks all component .tsx files, finds every Arabic-bearing string
// (plain literals, template literals, JSX text), assigns a stable key
// 'domain.NNN' and emits scripts/i18n/catalog.json
import fs from "fs";
import path from "path";
import ts from "typescript";

const AR = /[\u0600-\u06FF]/;

function domainFor(file) {
  const p = file.replace(/\\/g, "/");
  if (p.includes("/admin/")) return "admin";
  if (p.includes("/teacher/")) return "teacher";
  if (p.includes("/student/")) return "student";
  if (p.includes("/parent/")) return "parent";
  if (p.includes("/auth/")) return "auth";
  if (p.includes("/landing/")) return "landing";
  if (p.includes("/course/")) return "course";
  if (p.includes("/dashboard/")) return "shell";
  if (p.includes("/ai/")) return "ai";
  if (p.includes("/shared/")) return "shared";
  return "app";
}

const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx$/.test(e.name)) files.push(p);
  }
}
const ROOT = process.argv[2] || "src/components";
walk(ROOT);
files.sort(); // deterministic order -> stable keys

const catalog = [];
const seen = new Set(); // file + ar/shape dedupe

// counters per domain for stable keys (global across files, deterministic)
const counters = {};
function nextKey(domain) {
  counters[domain] = (counters[domain] || 0) + 1;
  return `${domain}.${String(counters[domain]).padStart(3, "0")}`;
}

for (const f of files) {
  const domain = domainFor(f);
  const src = fs.readFileSync(f, "utf8");
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  function shapeOf(node) {
    // template -> cooked text with {pN}
    let s = "";
    let n = 0;
    s += node.head.text;
    for (const sp of node.templateSpans) {
      n++;
      s += `{p${n}}` + sp.literal.text;
    }
    return s;
  }

  function add(key, ar, kind, shape) {
    const k = key;
    if (seen.has(f + "|" + (shape || ar))) return;
    seen.add(f + "|" + (shape || ar));
    catalog.push({ key: k, file: f.replace(/^src\/components\//, ""), ar, kind, shape });
  }

// global per-domain counters (see below)

  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (AR.test(node.text)) add(nextKey(domain), node.text, "plain");
    } else if (ts.isTemplateExpression(node)) {
      const shape = shapeOf(node);
      if (AR.test(shape)) add(nextKey(domain), node.getText(sf), "tmpl", shape);
    } else if (ts.isJsxText(node)) {
      const txt = node.getText(sf);
      if (AR.test(txt)) add(nextKey(domain), txt, "jsxtext");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

catalog.sort((a, b) => a.key.localeCompare(b.key));
fs.writeFileSync(
  path.join("scripts/i18n", "catalog.json"),
  JSON.stringify(catalog, null, 1)
);
const byDomain = {};
for (const c of catalog) byDomain[c.file.split("/")[0]] = (byDomain[c.file.split("/")[0]] || 0) + 1;
console.log("catalog entries:", catalog.length);
console.log(byDomain);
console.log("kinds:", catalog.reduce((m, c) => ((m[c.kind] = (m[c.kind] || 0) + 1), m), {}));
