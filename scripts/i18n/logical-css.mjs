#!/usr/bin/env node
// Converts physical Tailwind direction utilities to logical ones so layouts
// mirror correctly between RTL (ar) and LTR (en):
//   ml-*/mr-*/pl-*/pr-*       -> ms-*/me-*/ps-*/pe-*
//   left-*/right-*            -> start-*/end-*
//   text-left/text-right      -> text-start/text-end
//   border-l-*/border-r-*     -> border-e-*/border-s-*
// Usage: node scripts/i18n/logical-css.mjs [--dry]
import fs from "fs";
import glob from "fast-glob";

const DRY = process.argv.includes("--dry");
const files = glob.sync(["src/components/**/*.tsx", "src/app/**/*.tsx"], { dot: true });

let total = 0;
const perFile = {};
for (const f of files) {
  let s = fs.readFileSync(f, "utf8");
  const before = s;
  let n = 0;
  const sub = (re, to) => {
    s = s.replace(re, (...a) => {
      n++;
      return typeof to === "function" ? to(...a) : to;
    });
  };
  // negatives first (literal token prefixes)
  for (const [a, b] of [["-ml-", "-ms-"], ["-mr-", "-me-"], ["-pl-", "-ps-"], ["-pr-", "-pe-"], ["-left-", "-start-"], ["-right-", "-end-"]]) {
    const c = (s.match(new RegExp(a.replace("-", "\\-"), "g")) || []).length;
    s = s.split(a).join(b);
    n += c;
  }
  // plain tokens not preceded by [A-Za-z0-9-]
  const plain = (from, to) =>
    sub(new RegExp(`([^\\w-])${from}(?=[\\w\\[.])`, "g"), (_m, p1) => p1 + to);
  plain("ml-", "ms-");
  plain("mr-", "me-");
  plain("pl-", "ps-");
  plain("pr-", "pe-");
  plain("left-", "start-");
  plain("right-", "end-");
  // text alignment
  sub(/text-left/g, "text-start");
  sub(/text-right/g, "text-end");
  // borders: border-l / border-r (+ variants like border-l-2, border-l-primary)
  sub(/([^\w-])border-l(?=[\s"'`\]-])/, "$1border-e");
  sub(/([^\w-])border-r(?=[\s"'`\]-])/, "$1border-s");
  sub(/([^\w-])border-l-/, "$1border-e-");
  sub(/([^\w-])border-r-/, "$1border-s-");

  if (s !== before) {
    if (!DRY) fs.writeFileSync(f, s);
    perFile[f] = n;
    total += n;
  }
}
console.log("converted:", total);
for (const [f, n] of Object.entries(perFile).sort((a, b) => b[1] - a[1]).slice(0, 20))
  console.log(`  ${n}\t${f}`);
