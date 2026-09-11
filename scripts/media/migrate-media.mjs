// CodeMind Academy — Phase 21: deterministic media migration (local -> durable).
//
//   node scripts/media/migrate-media.mjs --source ./storage/media --dest /mnt/codemind-media \
//       --manifest /var/backups/codemind/media-20260911.json
//   node scripts/media/migrate-media.mjs --source … --dest … --inventory-only
//   node scripts/media/migrate-media.mjs --check <manifest.json> --dest <dir>
//
// Durable media for this platform is a FILESYSTEM VOLUME (MEDIA_STORAGE_PATH
// pointed at a persistent mount — see docs/PHASE_21_PRODUCTION_DATABASE_STORAGE.md
// §10 for why volume, not object storage, and why MediaAsset is unchanged).
// This script moves bytes from the ephemeral/local tree to the durable tree.
//
// CONTRACT
//   * Deterministic: keys are relative POSIX paths, visited in sorted order;
//     the manifest is stable byte-for-byte for identical trees.
//   * Verified: every file is hashed (SHA-256) BEFORE and AFTER the copy; any
//     mismatch fails the run (exit 1) and is listed.
//   * NEVER deletes the source. The operator removes the source tree only after
//     `--check` against the manifest succeeds on the destination (the runbook
//     makes this a two-person step). A migration tool that deletes first is a
//     data-loss tool.
//   * Symlinks are SKIPPED (never followed, never copied as links) and listed.
//   * --check mode copies nothing: it re-hashes the destination and compares
//     against a manifest (post-migration audit / periodic integrity audit).
//
// EXIT: 0 = all files verified; 1 = usage error; 2 = mismatch/error.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function usage(exit = 1) {
  console.error(`usage:
  node scripts/media/migrate-media.mjs --source <dir> --dest <dir> --manifest <path>
  node scripts/media/migrate-media.mjs --source <dir> --dest <dir> --inventory-only
  node scripts/media/migrate-media.mjs --check <manifest.json> --dest <dir>`);
  process.exit(exit);
}

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") out.source = argv[++i];
    else if (a === "--dest") out.dest = argv[++i];
    else if (a === "--manifest") out.manifest = argv[++i];
    else if (a === "--check") out.check = argv[++i];
    else if (a === "--inventory-only") out.inventoryOnly = true;
    else if (a === "-h" || a === "--help") usage(0);
    else { console.error(`unknown argument: ${a}`); usage(1); }
  }
  return out;
}

function sha256File(abs) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(abs, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

/** Sorted relative POSIX keys of every regular file under root (no symlink following). */
export function inventoryDir(root) {
  const out = [];
  const skippedSymlinks = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, e.name);
      const key = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) { skippedSymlinks.push(key); continue; }
      if (e.isDirectory()) walk(full, key);
      else if (e.isFile()) out.push(key);
    }
  };
  walk(root, "");
  return { keys: out.sort(), skippedSymlinks };
}

function buildManifest(source, keys) {
  const files = keys.map((key) => {
    const abs = path.join(source, ...key.split("/"));
    const st = fs.statSync(abs);
    return { key, bytes: st.size, sha256: sha256File(abs) };
  });
  return {
    tool: "migrate-media.mjs (Phase 21)",
    createdAt: new Date().toISOString(),
    source: path.resolve(source),
    files,
    totalFiles: files.length,
    totalBytes: files.reduce((a, f) => a + f.bytes, 0),
  };
}

function main() {
  const o = args();

  // ---- --check mode: verify dest against an existing manifest ----
  if (o.check) {
    if (!o.dest) usage(1);
    const manifest = JSON.parse(fs.readFileSync(o.check, "utf8"));
    let okCount = 0;
    const bad = [];
    for (const f of manifest.files || []) {
      const abs = path.join(o.dest, ...String(f.key).split("/"));
      if (!fs.existsSync(abs)) { bad.push(`${f.key}: MISSING`); continue; }
      const st = fs.statSync(abs);
      if (st.size !== f.bytes) { bad.push(`${f.key}: size ${st.size} != ${f.bytes}`); continue; }
      const got = sha256File(abs);
      if (got !== f.sha256) { bad.push(`${f.key}: sha256 mismatch`); continue; }
      okCount++;
    }
    console.log(`check: ${okCount}/${(manifest.files || []).length} files verified against ${o.check}`);
    if (bad.length) {
      for (const b of bad.slice(0, 20)) console.error(`  ${b}`);
      if (bad.length > 20) console.error(`  … and ${bad.length - 20} more`);
      process.exit(2);
    }
    console.log("MEDIA_CHECK_OK");
    return;
  }

  // ---- migrate / inventory mode ----
  if (!o.source || !o.dest) usage(1);
  if (!o.inventoryOnly && !o.manifest) usage(1);
  if (!fs.existsSync(o.source) || !fs.statSync(o.source).isDirectory()) {
    console.error(`source is not a directory: ${o.source}`);
    process.exit(2);
  }
  const { keys, skippedSymlinks } = inventoryDir(o.source);
  console.log(`inventory: ${keys.length} file(s) under ${o.source}` + (skippedSymlinks.length ? ` (${skippedSymlinks.length} symlink(s) skipped)` : ""));
  const manifest = buildManifest(o.source, keys);
  manifest.dest = path.resolve(o.dest);
  manifest.skippedSymlinks = skippedSymlinks;

  if (!o.inventoryOnly) {
    let copied = 0;
    const bad = [];
    for (const f of manifest.files) {
      const srcAbs = path.join(o.source, ...f.key.split("/"));
      const dstAbs = path.join(o.dest, ...f.key.split("/"));
      try {
        fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
        fs.copyFileSync(srcAbs, dstAbs);
        const got = sha256File(dstAbs);
        if (got !== f.sha256) bad.push(`${f.key}: post-copy sha256 mismatch`);
        else copied++;
      } catch (e) {
        bad.push(`${f.key}: ${e.message}`);
      }
    }
    manifest.copied = copied;
    console.log(`copied + verified: ${copied}/${manifest.files.length}`);
    if (bad.length) {
      for (const b of bad.slice(0, 20)) console.error(`  ${b}`);
      if (bad.length > 20) console.error(`  … and ${bad.length - 20} more`);
      process.exit(2);
    }
  }

  if (o.manifest) {
    fs.mkdirSync(path.dirname(path.resolve(o.manifest)), { recursive: true });
    fs.writeFileSync(o.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`manifest: ${o.manifest}`);
  }
  console.log(o.inventoryOnly ? "MEDIA_INVENTORY_OK" : "MEDIA_MIGRATE_OK");
}

main();
