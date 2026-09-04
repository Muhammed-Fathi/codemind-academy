#!/usr/bin/env node
// Codemod for server files (src/app/api/** + selected src/lib):
// replaces Arabic literals with tApi("key") / tApi("key", {p}) calls and
// injects `const tApi = await getServerT();` at the top of every async
// handler that needs it.
//
// Usage: node scripts/i18n/codemod-api.mjs [--dry]
import fs from "fs";
import path from "path";
import ts from "typescript";

const DRY = process.argv.includes("--dry");
const catalog = JSON.parse(fs.readFileSync("scripts/i18n/catalog-api.json", "utf8"));
const INTENTIONAL = catalog.filter((e) => /ai(\/|-)/.test(e.file) && e.ar.length > 200).map((e) => e.ar);

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

const EXCLUDE = [
  "src/lib/curriculum.ts", "src/lib/curriculum-seed.ts", "src/lib/i18n.ts",
  "src/lib/i18n-dict.ts", "src/lib/i18n-server.ts", "src/lib/db.ts",
  "src/lib/auth.ts", "src/lib/gamification.ts", "src/lib/brand.ts",
  "src/lib/utils.ts", "src/lib/api.ts",
  "src/app/api/ai/chat/route.ts", // AI system prompt stays Arabic (by design)
  "src/app/api/admin/ai-generate-quiz/route.ts", // quiz-gen prompt stays Arabic
];

const AR = /[\u0600-\u06FF]/;
const summary = [];

for (const file of files) {
  if (EXCLUDE.includes(file.replace(/\\/g, "/"))) continue;
  const entries = catalog.filter((e) => e.file === file.replace(/^src\//, ""));
  if (!entries.length) continue;
  const map = new Map(entries.map((e) => [e.ar, e.key]));
  const sourceText = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const edits = [];
  const handlerSpans = []; // {start,end} of functions containing replacements

  function shapeOf(node) {
    let s = node.head.text, n = 0;
    for (const sp of node.templateSpans) { n++; s += `{p${n}}` + sp.literal.text; }
    return s;
  }

  /** innermost enclosing function-like node */
  function enclosingFn(node) {
    let anc = node.parent;
    while (anc && !(
      ts.isFunctionDeclaration(anc) || ts.isArrowFunction(anc) ||
      ts.isFunctionExpression(anc) || ts.isMethodDeclaration(anc)
    )) anc = anc.parent;
    return anc;
  }

  const visit = (node) => {
    let key0 = null, isTmpl = false;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      key0 = node.text.replace(/\s+/g, " ").trim();
    } else if (ts.isTemplateExpression(node)) {
      key0 = shapeOf(node); isTmpl = true;
    }
    if (key0 && AR.test(key0)) {
      if (INTENTIONAL.includes(key0)) return;
      const key = map.get(key0);
      if (!key) { console.error("NO KEY", file, JSON.stringify(key0.slice(0, 60))); return; }
      const fn = enclosingFn(node);
      if (fn) handlerSpans.push({ start: fn.getStart(sf), end: fn.getEnd(), node: fn });
      if (isTmpl) {
        const params = [];
        let n = 0;
        let call = `tApi("${key}"`;
        for (const sp of node.templateSpans) {
          n++;
          params.push(`p${n}: ${sp.expression.getText(sf)}`);
        }
        if (n) call += `, { ${params.join(", ")} }`;
        call += `)`;
        edits.push({ start: node.getStart(sf), end: node.getEnd(), text: call });
      } else {
        edits.push({ start: node.getStart(sf), end: node.getEnd(), text: `tApi("${key}")` });
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (!edits.length) continue;

  let out = sourceText;
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

  // Inject tApi into each distinct enclosing function that is async OR make it async.
  const fns = [];
  const seenStart = new Set();
  for (const h of handlerSpans) {
    if (seenStart.has(h.start)) continue;
    seenStart.add(h.start);
    fns.push(h.node);
  }
  // Re-parse to get fresh positions after literal replacement
  const sf2 = ts.createSourceFile(file, out, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // match functions by their name text
  const injects = [];
  for (const fn of fns) {
    let name = null;
    if (ts.isFunctionDeclaration(fn) && fn.name) name = fn.name.text;
    else if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
             ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name))
      name = fn.parent.name.text;
    // find fresh node by name
    let target = null;
    const scan = (n) => {
      if (target) return;
      if (ts.isFunctionDeclaration(n) && n.name && n.name.text === name) { target = n; return; }
      if (name && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name &&
          (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
        target = n.initializer; return;
      }
      ts.forEachChild(n, scan);
    };
    scan(sf2);
    if (!target || !target.body) { console.error("NO FN", file, name); continue; }
    const isAsync = target.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ||
                    target.asyncModifier === undefined && false;
    const bodyStart = target.body.getStart(sf2);
    injects.push({ bodyStart, bodyEnd: target.body.getEnd(), isBlock: ts.isBlock(target.body), name, hasAsync:
      (target.getText(sf2).match(/^\s*(export\s+)?(async\s+)?function/) || [""])[0].includes("async") ||
      (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) &&
        (() => { let p = target.parent; while (p && !ts.isVariableDeclaration(p)) p = p.parent; return p?.initializer === target ? /async\s*(\(|function)/.test(target.getText(sf2).slice(0, 30)) : false; })()
    });
  }
  injects.sort((a, b) => b.bodyStart - a.bodyStart);
  for (const inj of injects) {
    const decl = `\n  const tApi = await getServerT();`;
    if (inj.isBlock) {
      out = out.slice(0, inj.bodyStart + 1) + decl + out.slice(inj.bodyStart + 1);
    } else {
      // expression-bodied arrow -> blockify
      const bodyText = out.slice(inj.bodyStart, inj.bodyEnd);
      out = out.slice(0, inj.bodyStart) + `{ const tApi = await getServerT(); return (${bodyText}); }` + out.slice(inj.bodyEnd);
    }
  }
  // make non-async injected functions async (function declarations)
  const linesNeedAsync = [];
  for (const inj of injects) {
    if (!inj.hasAsync) linesNeedAsync.push(inj.name);
  }
  for (const name of linesNeedAsync) {
    if (!name) continue;
    const re = new RegExp(`((?:export\\s+)?function\\s+${name}\\s*\\()`, "g");
    out = out.replace(re, (m) => m.replace("function", "async function"));
  }

  // add import
  if (!out.includes('from "@/lib/i18n-server"')) {
    const lines = out.split("\n");
    let at = 0;
    if (lines[0]?.includes('"use client"') || lines[0]?.includes("use client")) at = 1;
    lines.splice(at, 0, 'import { getServerT } from "@/lib/i18n-server";');
    out = lines.join("\n");
  }

  if (!DRY) fs.writeFileSync(file, out);
  summary.push({ file, edits: edits.length, fns: injects.length });
}

console.log("api codemod done:", summary.length, "files");
for (const s of summary) console.log(`  ${s.edits} edits, ${s.fns} fns\t${s.file}`);
