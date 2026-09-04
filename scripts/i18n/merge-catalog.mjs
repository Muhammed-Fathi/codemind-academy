#!/usr/bin/env node
// Merges the per-domain ar2en maps with the catalog and verifies full coverage.
// Emits scripts/i18n/merge-report.json and prints missing entries.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(fs.readFileSync(path.join(here, "catalog.json"), "utf8"));
const catalogApi = JSON.parse(fs.readFileSync(path.join(here, "catalog-api.json"), "utf8"));

// Strings intentionally left Arabic (product behavior, not UI chrome):
// - AI chat system prompt (assistant teaches in Egyptian Arabic by design)
// - AI quiz-generator prompt (generates Arabic questions per curriculum policy)
const INTENTIONAL = new Set(
  catalogApi
    .filter((e) => /ai(\/|-)/.test(e.file) && e.ar.length > 200)
    .map((e) => e.ar)
);

const ar2en = {};
for (const f of fs.readdirSync(path.join(here, "en")).sort()) {
  if (!/^ar2en\./.test(f)) continue;
  const mod = await import(path.join(here, "en", f));
  Object.assign(ar2en, mod.ar2en);
}

const norm = (s) => s.replace(/\s+/g, " ").trim();
const missing = [];
const used = new Set();
const mapping = [];

for (const e of [...catalog, ...catalogApi]) {
  if (INTENTIONAL.has(e.ar)) continue;
  const key0 = e.kind === "tmpl" ? e.shape || e.ar : norm(e.ar);
  const en = ar2en[key0];
  if (en === undefined) {
    missing.push({ key: e.key, file: e.file, ar: key0, kind: e.kind });
  } else {
    used.add(key0);
  }
  mapping.push({ ...e, lookup: key0, en });
}

fs.writeFileSync(path.join(here, "merge-report.json"), JSON.stringify({ missing, mapping }, null, 1));

// unused authored entries (typos in keys)
const unusedAuthored = Object.keys(ar2en).filter((k) => !used.has(k));

console.log("catalog:", catalog.length + catalogApi.length, "| missing EN:", missing.length, "| unused authored:", unusedAuthored.length, "| intentional AR:", INTENTIONAL.size);
if (missing.length) {
  console.log("MISSING:");
  for (const m of missing.slice(0, 60)) console.log(" ", JSON.stringify(m.ar), "(" + m.file + ")");
}
if (unusedAuthored.length) {
  console.log("UNUSED authored keys:");
  for (const k of unusedAuthored.slice(0, 40)) console.log(" ", JSON.stringify(k));
}
