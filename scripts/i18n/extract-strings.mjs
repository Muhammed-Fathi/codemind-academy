import fs from "fs";
import path from "path";
import ts from "typescript";

const AR = /[\u0600-\u06FF]/;
const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx?|ts)$/.test(e.name)) files.push(p);
  }
}
walk("src");
const uniq = new Map();
let total = 0;
for (const f of files) {
  if (f.includes("lib/i18n")) continue;
  const src = fs.readFileSync(f, "utf8");
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node) => {
    let s = null;
    if (ts.isStringLiteral(node) || (ts.isNoSubstitutionTemplateLiteral(node))) s = node.text;
    else if (ts.isJsxText(node)) s = node.getText(sf);
    if (s && AR.test(s)) {
      total++;
      const key = s.trim();
      if (!uniq.has(key)) uniq.set(key, { count: 0, sample: f });
      uniq.get(key).count++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
console.log("TOTAL literals:", total, "UNIQUE:", uniq.size);
const arr = [...uniq.entries()].sort((a,b)=>b[1].count-a[1].count);
fs.writeFileSync("/tmp/uniq-strings.json", JSON.stringify(arr.map(([k,v])=>({s:k,...v})), null, 1));
// histogram by file
const byFile = {};
for (const f of files) {
  if (f.includes("lib/i18n")) continue;
  const src = fs.readFileSync(f, "utf8");
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let c = 0;
  const visit = (node) => {
    let s = null;
    if (ts.isStringLiteral(node) || (ts.isNoSubstitutionTemplateLiteral(node))) s = node.text;
    else if (ts.isJsxText(node)) s = node.getText(sf);
    if (s && AR.test(s)) c++;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (c) byFile[f] = c;
}
const sorted = Object.entries(byFile).sort((a,b)=>b[1]-a[1]);
for (const [f,c] of sorted.slice(0,30)) console.log(c, f);
