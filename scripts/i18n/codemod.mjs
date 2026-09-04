#!/usr/bin/env node
// i18n codemod — rewrites Arabic string literals in component files to
// t("key") / tt("key") calls using the catalog + dictionary.
//
// - Component scope -> `t("key")` (hook injected) with {pN} interpolation
//   for template expressions.
// - Module scope -> raw "key" string (usage sites get wrapped manually).
// - JsxAttribute position gets {t("key")} braces.
//
// Usage: node scripts/i18n/codemod.mjs [--dry]
import fs from "fs";
import path from "path";
import ts from "typescript";

const DRY = process.argv.includes("--dry");
const catalog = JSON.parse(fs.readFileSync("scripts/i18n/catalog.json", "utf8"));
const norm = (s) => s.replace(/\s+/g, " ").trim();

// key lookup: file -> normalizedText|shape -> key (first wins)
const byFile = new Map();
for (const e of catalog) {
  if (!byFile.has(e.file)) byFile.set(e.file, new Map());
  const m = byFile.get(e.file);
  const k = e.kind === "tmpl" ? e.shape : norm(e.ar);
  if (!m.has(k)) m.set(k, e.key);
}
const EXCLUDED = new Set(["error-boundary.tsx", "ui/password-input.tsx"]);

const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx$/.test(e.name)) files.push(p);
  }
}
walk("src/components");
files.sort();

const AR = /[\u0600-\u06FF]/;
const stats = [];
const moduleScopeFiles = new Set();

for (const file of files) {
  const rel = file.replace(/^src\/components\//, "");
  if (EXCLUDED.has(rel)) continue;
  const map = byFile.get(rel);
  if (!map) continue;
  const sourceText = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  // Pick a safe hook variable name: "t" unless taken (legacy getStrings
  // binding or an unrelated local `const t = ...`), then "tr", then "tt".
  function pickHookName(src) {
    const taken = (name) =>
      new RegExp(`const\\s+${name}\\s*=`).test(src) ||
      new RegExp(`function\\s+${name}\\b`).test(src) ||
      new RegExp(`\\(${name}\\s*[:,)]`).test(src) ||
      new RegExp(`,\\s*${name}\\s*[,)]`).test(src);
    for (const name of ["t", "tr", "tt"]) if (!taken(name)) return name;
    return "tLocale";
  }
  const T = pickHookName(sourceText);

  /** Is this node inside a React component (hook-legal scope)? */
  function inComponent(node) {
    let anc = node.parent;
    while (anc) {
      if (
        ts.isFunctionDeclaration(anc) ||
        ts.isFunctionExpression(anc) ||
        ts.isArrowFunction(anc) ||
        ts.isMethodDeclaration(anc)
      ) {
        // named component?
        let name = anc.name && ts.isIdentifier(anc.name) ? anc.name.text : undefined;
        if (!name && (ts.isVariableDeclaration(anc.parent))) {
          const n = anc.parent.name;
          if (ts.isIdentifier(n)) name = n.text;
        }
        if (name && /^[A-Z]/.test(name)) return true;
        // anonymous/heuristic component: contains real JSX nodes in its body
        if (anc.body) {
          const hasJsx = (() => {
            let found = false;
            const scan = (n) => {
              if (found) return;
              if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
                found = true;
                return;
              }
              ts.forEachChild(n, scan);
            };
            scan(anc.body);
            return found;
          })();
          if (hasJsx) return true;
        }
      }
      anc = anc.parent;
    }
    return false;
  }

  function lookup(key0) {
    const k = map.get(key0);
    return k || null;
  }

  /** @type {{start:number,end:number,text:string}[]} */
  const edits = [];
  let replaced = 0;

  function callExpr(key, params) {
    const arg = params && params.length
      ? `"${key}", { ${params.map((p) => p.decl).join(", ")} }`
      : `"${key}"`;
    return `${T}(${arg})`;
  }

  const visit = (node) => {
    // ---- StringLiteral & NoSubstitutionTemplateLiteral ----
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!AR.test(node.text)) return;
      const key0 = norm(node.text);
      const key = lookup(key0);
      if (!key) { console.error("NO KEY", rel, JSON.stringify(key0)); return; }
      replaced++;
      const inAttr = node.parent && ts.isJsxAttribute(node.parent);
      if (inComponent(node)) {
        edits.push({
          start: node.getStart(sf),
          end: node.getEnd(),
          text: inAttr ? `{${T}("${key}")}` : `${T}("${key}")`,
        });
      } else {
        moduleScopeFiles.add(rel);
        edits.push({ start: node.getStart(sf), end: node.getEnd(), text: `"${key}"` });
      }
      return;
    }

    // ---- TemplateExpression ----
    if (ts.isTemplateExpression(node)) {
      const params = [];
      let shape = node.head.text;
      let n = 0;
      for (const sp of node.templateSpans) {
        n++;
        shape += `{p${n}}` + sp.literal.text;
        params.push({ decl: `p${n}: ${sp.expression.getText(sf)}` });
      }
      if (!AR.test(shape)) return;
      const key = lookup(shape);
      if (!key) { console.error("NO KEY (tmpl)", rel, JSON.stringify(shape)); return; }
      replaced++;
      const inAttr = node.parent && ts.isJsxAttribute(node.parent);
      if (inComponent(node)) {
        edits.push({
          start: node.getStart(sf),
          end: node.getEnd(),
          text: inAttr ? `{${callExpr(key, params)}}` : callExpr(key, params),
        });
      } else {
        moduleScopeFiles.add(rel);
        edits.push({ start: node.getStart(sf), end: node.getEnd(), text: `"${key}"` });
      }
      return;
    }

    // ---- JsxText ----
    if (ts.isJsxText(node)) {
      const raw = node.getText(sf);
      if (!AR.test(raw)) return;
      const key0 = norm(raw);
      const key = lookup(key0);
      if (!key) { console.error("NO KEY (jsx)", rel, JSON.stringify(key0)); return; }
      replaced++;
      edits.push({
        start: node.getStart(sf),
        end: node.getEnd(),
        text: `{${T}("${key}")}`,
      });
      return;
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (!edits.length) continue;

  // Apply edits (sorted desc so positions stay valid)
  let out = sourceText;
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

  // Inject hook into components that now use T but don't define it.
  const usesHook = new RegExp(`\\b${T}\\(`).test(out);
  const definesT = new RegExp(`const ${T} = useT\\(`).test(out);
  if (usesHook && !definesT) {
    // add import
    const impRe = /import\s*\{([^}]*)\}\s*from\s*"@\/lib\/i18n";/;
    const impCallRe = /import\s*\{([^}]*)\}\s*from\s*"@\/lib\/i18n\/use-t";/;
    if (impRe.test(out)) {
      out = out.replace(impRe, (_m, inner) => `import {${inner}, useT } from "@/lib/i18n";`);
    } else if (impCallRe.test(out)) {
      out = out.replace(impCallRe, (_m, inner) => `import {${inner}, useT } from "@/lib/i18n/use-t";`);
    } else {
      // insert right after the "use client" directive (always safe),
      // or at the very top when absent.
      const lines = out.split("\n");
      let at = 0;
      if (lines[0] && lines[0].includes("use client")) at = 1;
      lines.splice(at, 0, `import { useT } from "@/lib/i18n";`);
      out = lines.join("\n");
    }

    // inject `const T = useT();` into each component function that contains T(
    const sf2 = ts.createSourceFile(file, out, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const hookEdits = [];
    const usesIn = new Set(); // node -> uses
    const walk2 = (node) => {
      const isComp =
        (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node)) &&
        (() => {
          let name;
          if (node.name && ts.isIdentifier(node.name)) name = node.name.text;
          else if (node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name))
            name = node.parent.name.text;
          return name && /^[A-Z]/.test(name);
        })();
      if (isComp && node.body) {
        const body = node.body.getText();
        if (new RegExp(`\\b${T}\\(`).test(body)) usesIn.add(node);
      }
      ts.forEachChild(node, walk2);
    };
    walk2(sf2);
    for (const comp of usesIn) {
      const body = comp.body;
      // skip nested arrows whose parent chain already has an injected comp with a hook (they close over T)
      const bodyText = body.getText();
      if (ts.isBlock(body)) {
        hookEdits.push({ pos: body.getStart(sf2) + 1, text: `\n  const ${T} = useT();` });
      } else {
        // expression-bodied arrow -> wrap: (...) : JSX => <X/>  =>  (...) : JSX => { const T = useT(); return <X/> }
        hookEdits.push({
          pos: body.getStart(sf2),
          text: `{ const ${T} = useT(); return (${bodyText}) as any; }`,
        });
        // remove original body text
        hookEdits.push({ pos: body.getStart(sf2), end: body.getEnd(), text: "" });
        // simpler: convert below with combined handling
        hookEdits.pop();
        hookEdits.pop();
        hookEdits.push({
          start: body.getStart(sf2),
          end: body.getEnd(),
          text: `{ const ${T} = useT(); return (${bodyText}); }`,
        });
      }
    }
    hookEdits.sort((a, b) => (b.start ?? b.pos) - (a.start ?? a.pos));
    for (const e of hookEdits) {
      if (e.start !== undefined) {
        out = out.slice(0, e.start) + e.text + out.slice(e.end);
      } else {
        out = out.slice(0, e.pos) + e.text + out.slice(e.pos);
      }
    }
  }

  if (!DRY) fs.writeFileSync(file, out);
  stats.push({ file: rel, replaced, moduleScope: false });
}

console.log("codemod done:", stats.length, "files");
for (const s of stats) if (s.replaced) console.log(`  ${s.replaced}\t${s.file}`);
console.log("MODULE-SCOPE files needing manual t() wrapping:");
for (const f of moduleScopeFiles) console.log("  ", f);
