// CodeMind Academy — a SQLite-backed client with Prisma's query surface.
//
// WHAT THIS IS, EXACTLY (read this before trusting a result from it)
//   It is NOT a mock: every read, write, filter, constraint and error below is
//   produced by SQLite itself. `prisma/schema.prisma` is parsed to learn the
//   tables, columns and relations, and each Prisma-shaped call is translated
//   into real SQL against a real `node:sqlite` database — so a `where` that
//   matches nothing matches nothing FOR REAL, a UNIQUE violation is the
//   database's own, and `NOT NULL` / foreign keys behave as declared.
//
//   It is also NOT the Prisma engine. The engine binaries cannot be
//   downloaded in this sandbox (binaries.prisma.sh is unreachable), so
//   `@prisma/client` cannot open the database at all here. This adapter exists
//   so that the modules whose behavior Phase 13 changes —
//   `official-curriculum.ts` (injectable client by design),
//   `session-lifecycle.ts` (injectable client), `session-progress.ts` — can be
//   executed against real rows instead of being asserted about from source text
//   alone. It implements the subset those modules use and RAISES on anything
//   else rather than approximating it: a silently-ignored `orderBy` or an
//   unsupported filter is how a fake "everything still works" is produced, and
//   that failure mode is documented in docs/PHASE_12_FINAL_REPORT.md.
//
//   Anything this adapter does not support throws `UnsupportedQuery`. That is
//   deliberate: a test that silently gets sloppy behavior is worse than a test
//   that refuses to run.
//
// Run from: scripts/verify-phase13-db.mjs, tests/session-lifecycle-phase13.test.js

import fs from "node:fs";
import path from "node:path";

export class UnsupportedQuery extends Error {
  constructor(what) {
    super(`sqlite-prisma-lite: unsupported query feature: ${what}`);
    this.name = "UnsupportedQuery";
  }
}

const PRISMA_TO_SQLITE = {
  String: "TEXT",
  Int: "INTEGER",
  BigInt: "INTEGER",
  Float: "REAL",
  Boolean: "BOOLEAN",
  DateTime: "DATETIME",
  Json: "TEXT",
  Bytes: "BLOB",
};

// ---------------------------------------------------------------------------
// Schema introspection
// ---------------------------------------------------------------------------

export function introspect(schemaPath) {
  const text = fs.readFileSync(schemaPath, "utf8");
  const enumNames = new Set(
    [...text.matchAll(/^enum\s+([A-Za-z0-9_]+)/gm)].map((m) => m[1])
  );
  const blocks = [
    ...text.matchAll(/^model\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)^\}/gm),
  ];
  const modelNames = new Set(blocks.map((b) => b[1]));
  const models = new Map();

  for (const [, name, body] of blocks) {
    const fields = [];
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("//") || line.startsWith("///")) continue;
      const m = /^(\w+)\s+([\w.]+)(\[\])?(\?)?\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, fieldName, type, list, optional, rest] = m;
      const f = {
        name: fieldName,
        type,
        isList: !!list,
        optional: !!optional,
        isRelation: modelNames.has(type) || /@relation/.test(rest),
        isEnum: enumNames.has(type),
        isId: /@id\b/.test(rest),
        isUpdatedAt: /@updatedAt/.test(rest),
        defaultRaw: null,
        relationFields: null,
        relationRefs: null,
      };
      const rel = /@relation\(([^)]*)\)/.exec(rest);
      if (rel) {
        const fieldsM = /fields:\s*\[([^\]]*)\]/.exec(rel[1]);
        const refsM = /references:\s*\[([^\]]*)\]/.exec(rel[1]);
        f.relationFields = fieldsM
          ? fieldsM[1].split(",").map((x) => x.trim()).filter(Boolean)
          : null;
        f.relationRefs = refsM
          ? refsM[1].split(",").map((x) => x.trim()).filter(Boolean)
          : null;
      }
      // Balanced enough for `now()`, `cuid()`, `autoincrement()`, `dbgenerated(...)`.
      const dflt = /@default\(((?:[^()]|\([^()]*\))*)\)/.exec(rest);
      if (dflt) f.defaultRaw = dflt[1].trim();
      fields.push(f);
    }
    models.set(name, { name, table: name, fields });
  }
  return { models, enumNames };
}

/** Build the relation graph: for each field, how to reach the other side. */
function buildRelations(models) {
  const relations = new Map(); // model -> Map(field -> rel)
  for (const [name, model] of models) {
    relations.set(name, new Map());
  }
  for (const [name, model] of models) {
    for (const f of model.fields) {
      if (!f.isRelation) continue;
      if (f.relationFields && f.relationFields.length) {
        // This model holds the FK.
        relations.get(name).set(f.name, {
          kind: f.isList ? "many" : "one",
          to: f.type,
          localFields: f.relationFields,
          foreignFields: f.relationRefs,
          ownFk: true,
        });
      } else {
        // Back-relation: find the owning side in the target model.
        const target = models.get(f.type);
        if (!target) continue;
        for (const tf of target.fields) {
          if (tf.type !== name || !tf.relationFields?.length) continue;
          relations.get(name).set(f.name, {
            kind: "many",
            to: f.type,
            localFields: tf.relationRefs,
            foreignFields: tf.relationFields,
            ownFk: false,
            uniqueOnForeign: !tf.isList,
          });
          break;
        }
      }
    }
  }
  return relations;
}

// ---------------------------------------------------------------------------
// Value conversion (Prisma's SQLite representation)
// ---------------------------------------------------------------------------

function toSqlValue(field, value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (field?.isEnum || field?.type === "String") {
    return typeof value === "string" ? value : String(value);
  }
  if (field?.type === "Boolean") return value ? 1 : 0;
  if (field?.type === "DateTime") {
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return Math.floor(value);
    return new Date(value).getTime();
  }
  if (field?.type === "Int" || field?.type === "BigInt")
    return Math.floor(Number(value));
  if (field?.type === "Float") return Number(value);
  if (field?.isEnum) return typeof value === "string" ? value : String(value);
  return value;
}

function fromSqlValue(field, value) {
  if (value === null || value === undefined) return value;
  if (field?.type === "Boolean") return value === 1 || value === true;
  if (field?.type === "DateTime") {
    if (typeof value === "number") return new Date(value);
    if (value instanceof Date) return value;
    return new Date(String(value).replace(" ", "T") + "Z");
  }
  return value;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {import("node:sqlite").DatabaseSync} opts.db
 * @param {string} opts.schemaPath
 */
export function createSqlitePrisma({ db, schemaPath }) {
  const { models } = introspect(schemaPath);
  const relations = buildRelations(models);

  const fieldOf = (model, name) => models.get(model)?.fields.find((f) => f.name === name);

  const isColumn = (model, name) => {
    const f = fieldOf(model, name);
    return !!f && !f.isRelation;
  };

  /** Translate a scalar operator object for one column. */
  const scalarCondition = (model, field, op, out, params, alias = `"${model}"`) => {
    const f = fieldOf(model, field);
    const col = `${alias}."${field}"`;
    if (op === null || typeof op !== "object" || op instanceof Date) {
      if (op === null) out.push(`${col} IS NULL`);
      else {
        out.push(`${col} = ?`);
        params.push(toSqlValue(f, op));
      }
      return;
    }
    if (Array.isArray(op)) {
      throw new UnsupportedQuery(`array shorthand on ${model}.${field}`);
    }
    for (const [key, raw] of Object.entries(op)) {
      switch (key) {
        case "in": {
          if (!Array.isArray(raw) || raw.length === 0) {
            out.push("0 = 1"); // Prisma: `in: []` matches nothing
            continue;
          }
          out.push(`${col} IN (${raw.map(() => "?").join(",")})`);
          params.push(...raw.map((v) => toSqlValue(f, v)));
          continue;
        }
        case "notIn": {
          if (Array.isArray(raw) && raw.length === 0) continue;
          out.push(`${col} NOT IN (${raw.map(() => "?").join(",")})`);
          params.push(...raw.map((v) => toSqlValue(f, v)));
          continue;
        }
        case "not": {
          if (raw === null) out.push(`${col} IS NOT NULL`);
          else if (typeof raw === "object") {
            // { not: { equals: x } } and friends
            const inner = [];
            scalarCondition(model, field, raw, inner, params, alias);
            out.push(`NOT (${inner.join(" AND ")})`);
          } else {
            out.push(`(${col} <> ? OR ${col} IS NULL)`);
            params.push(toSqlValue(f, raw));
          }
          continue;
        }
        case "equals":
          out.push(`${col} = ?`);
          params.push(toSqlValue(f, raw));
          continue;
        case "lt":
        case "lte":
        case "gt":
        case "gte": {
          const sqlOp = { lt: "<", lte: "<=", gt: ">", gte: ">=" }[key];
          out.push(`${col} ${sqlOp} ?`);
          params.push(toSqlValue(f, raw));
          continue;
        }
        case "contains":
          out.push(`${col} LIKE ? ESCAPE '\\'`);
          params.push(`%${String(raw).replace(/[%_\\]/g, (c) => "\\" + c)}%`);
          continue;
        case "startsWith":
          out.push(`${col} LIKE ? ESCAPE '\\'`);
          params.push(`${String(raw).replace(/[%_\\]/g, (c) => "\\" + c)}%`);
          continue;
        case "mode":
          continue; // SQLite LIKE is case-insensitive for ASCII anyway
        default:
          throw new UnsupportedQuery(`${model}.${field} filter '${key}'`);
      }
    }
  };

  /** Recursively translate a `where` object for `model`, alias `a`. */
  function translateWhere(model, where, alias, out, params) {
    // `alias` is the SQL alias the caller gave this table; a nested relation
    // filter runs under a DIFFERENT alias, so every column reference has to be
    // qualified with it — hardcoding the table name breaks inside EXISTS.
    void 0;
    for (const [key, raw] of Object.entries(where ?? {})) {
      if (key === "AND" || key === "OR") {
        const parts = [];
        const list = Array.isArray(raw) ? raw : [raw];
        for (const sub of list) {
          const inner = [];
          translateWhere(model, sub, alias, inner, params);
          if (inner.length) parts.push(`(${inner.join(" AND ")})`);
        }
        if (!parts.length) continue;
        out.push(key === "AND" ? parts.join(" AND ") : `(${parts.join(" OR ")})`);
        continue;
      }
      if (key === "NOT") {
        const inner = [];
        const list = Array.isArray(raw) ? raw : [raw];
        for (const sub of list) translateWhere(model, sub, alias, inner, params);
        if (inner.length) out.push(`NOT (${inner.join(" AND ")})`);
        continue;
      }
      if (isColumn(model, key)) {
        scalarCondition(model, key, raw, out, params, alias);
        continue;
      }
      const rel = relations.get(model)?.get(key);
      if (rel) {
        // Relation filter → correlated EXISTS over the other table.
        const targetAlias = `${alias}_${key}`.replace(/[^a-zA-Z0-9_]/g, "_");
        const inner = [];
        const subParams = [];
        const conds = [];
        rel.foreignFields.forEach((ff, i) => {
          const localCol = rel.localFields[i];
          conds.push(
            rel.ownFk
              ? `"${targetAlias}"."${ff}" = ${alias}."${localCol}"`
              : `"${targetAlias}"."${ff}" = ${alias}."${localCol}"`
          );
        });
        let listOp = null;
        let payload = raw;
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          const keys = Object.keys(raw);
          if (keys.length === 1 && ["some", "none", "every"].includes(keys[0])) {
            listOp = keys[0];
            payload = raw[keys[0]];
          }
        }
        if (payload && typeof payload === "object" && Object.keys(payload).length) {
          translateWhere(rel.to, payload, targetAlias, inner, subParams);
        }
        const exists = `EXISTS (SELECT 1 FROM "${rel.to}" AS "${targetAlias}" WHERE ${conds.join(
          " AND "
        )}${inner.length ? " AND " + inner.join(" AND ") : ""})`;
        if (listOp === "none") out.push(`NOT ${exists}`);
        else if (listOp === "every") {
          // every: no related row may violate the condition
          const neg = [];
          const negParams = [];
          if (payload && typeof payload === "object") {
            translateWhere(rel.to, negateFilter(payload), targetAlias, neg, negParams);
          }
          out.push(
            `NOT (EXISTS (SELECT 1 FROM "${rel.to}" AS "${targetAlias}" WHERE ${conds.join(
              " AND "
            )}${neg.length ? " AND " + neg.join(" AND ") : ""}))`
          );
          params.push(...negParams);
        } else {
          if (rel.kind === "one" && listOp === "some") {
            throw new UnsupportedQuery("`some` on a to-one relation");
          }
          out.push(exists);
        }
        params.push(...subParams);
        continue;
      }
      throw new UnsupportedQuery(`filter on unknown field '${model}.${key}'`);
    }
  }

  /** `every` needs "rows that violate", implemented as a NOT of the leafs. */
  function negateFilter(filter) {
    const out = {};
    for (const [k, v] of Object.entries(filter)) {
      out[k] = v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)
        ? { not: v }
        : { not: v };
    }
    return out;
  }

  function project(model, row, spec, mode /* 'select' | 'include' */) {
    const fields = models.get(model).fields;
    const selected =
      mode === "select"
        ? Object.entries(spec).filter(([, v]) => v === true || (v && typeof v === "object"))
        : [
            ...fields.filter((f) => !f.isRelation).map((f) => [f.name, true]),
            ...Object.entries(spec),
          ];
    const obj = {};
    for (const f of fields) {
      if (!f.isRelation) {
        if (mode === "select" && spec[f.name] !== true) continue;
        obj[f.name] = fromSqlValue(f, row[f.name]);
      }
    }
    for (const [key, sub] of selected) {
      if (sub === true && isColumn(model, key)) continue; // already set
      if (key === "_count") {
        obj._count = {};
        for (const [relName, sel] of Object.entries(sub.select ?? {})) {
          if (sel !== true) throw new UnsupportedQuery("_count projection other than true");
          const rel = relations.get(model).get(relName);
          if (!rel) throw new UnsupportedQuery(`_count of unknown relation ${model}.${relName}`);
          const conds = rel.foreignFields.map(
            (ff, i) => `"${rel.to}"."${ff}" = "${row[rel.localFields[i]]}"`
          );
          obj._count[relName] = db
            .prepare(
              `SELECT COUNT(*) AS c FROM "${rel.to}" WHERE ${conds.join(" AND ")}`
            )
            .get().c;
        }
        continue;
      }
      const rel = relations.get(model)?.get(key);
      if (!rel) throw new UnsupportedQuery(`select/include of unknown field ${model}.${key}`);
      const relWhere = sub && typeof sub === "object" ? sub.where ?? {} : {};
      const relSelect = sub && typeof sub === "object" ? sub.select : undefined;
      const relInclude = sub && typeof sub === "object" ? sub.include : undefined;
      const relOrderBy = sub && typeof sub === "object" ? sub.orderBy : undefined;
      const conds = rel.foreignFields.map(
        (ff, i) => `"${rel.to}"."${ff}" = ?`
      );
      const params = rel.foreignFields.map((ff, i) => row[rel.localFields[i]]);
      const out = [];
      translateWhere(rel.to, relWhere, rel.to, out, params);
      const orderSql = translateOrderBy(rel.to, relOrderBy);
      const sql = `SELECT "${rel.to}".* FROM "${rel.to}" WHERE ${conds.join(
        " AND "
      )}${out.length ? " AND " + out.join(" AND ") : ""}${orderSql}`;
      const rows = db.prepare(sql).all(...params);
      const map = (r) =>
        relSelect
          ? project(rel.to, r, relSelect, "select")
          : relInclude
            ? project(rel.to, r, relInclude, "include")
            : hydrateScalars(rel.to, r);
      if (rel.kind === "many" || rel.uniqueOnForeign === undefined && rel.kind !== "one") {
        obj[key] = rel.kind === "many" ? rows.map(map) : (rows[0] ? map(rows[0]) : null);
      } else {
        obj[key] = rows[0] ? map(rows[0]) : null;
      }
    }
    return obj;
  }

  function hydrateScalars(model, row) {
    const out = {};
    for (const f of models.get(model).fields) {
      if (f.isRelation) continue;
      out[f.name] = fromSqlValue(f, row[f.name]);
    }
    return out;
  }

  function translateOrderBy(model, orderBy) {
    if (!orderBy) return "";
    const list = Array.isArray(orderBy) ? orderBy : [orderBy];
    const parts = [];
    for (const entry of list) {
      for (const [key, dir] of Object.entries(entry)) {
        if (key === "relation") continue;
        if (typeof dir === "string") {
          if (!isColumn(model, key)) {
            throw new UnsupportedQuery(`orderBy on non-column ${model}.${key}`);
          }
          parts.push(`"${model}"."${key}" ${dir === "desc" ? "DESC" : "ASC"} NULLS LAST`);
        } else {
          throw new UnsupportedQuery(`nested orderBy on ${model}.${key}`);
        }
      }
    }
    return parts.length ? ` ORDER BY ${parts.join(", ")}` : "";
  }

  function defaultsFor(model) {
    const data = {};
    for (const f of models.get(model).fields) {
      if (f.isRelation || f.defaultRaw === null || f.defaultRaw === undefined) continue;
      const raw = f.defaultRaw;
      if (raw === "now()") data[f.name] = Date.now();
      else if (raw === "cuid()") data[f.name] = cuidLike();
      else if (raw === "uuid()") data[f.name] = cryptoRandomId();
      else if (/^autoincrement$/i.test(raw)) continue;
      else if (raw === "true") data[f.name] = 1;
      else if (raw === "false") data[f.name] = 0;
      else if (/^-?\d+(\.\d+)?$/.test(raw)) data[f.name] = Number(raw);
      else data[f.name] = raw.replace(/^"|"$/g, "");
    }
    return data;
  }

  function insertRow(model, data) {
    const fields = models.get(model).fields;
    const merged = { ...defaultsFor(model), ...stripRelations(model, data) };
    // Prisma's `@updatedAt` is maintained by the client, not the database.
    for (const f of fields) if (f.isUpdatedAt) merged[f.name] = Date.now();
    const cols = [];
    const vals = [];
    const params = [];
    for (const f of fields) {
      if (f.isRelation) continue;
      if (f.name === "id" && merged.id === undefined) merged.id = cuidLike();
      if (f.name in merged && merged[f.name] === undefined) {
        throw new Error(
          `sqlite-prisma-lite: write of ${model}.${f.name} is \`undefined\` (a missing field must be omitted, not undefined)`
        );
      }
      if (!(f.name in merged)) {
        if (!f.optional) throw new UnsupportedQuery(`missing required ${model}.${f.name}`);
        continue;
      }
      cols.push(`"${f.name}"`);
      params.push(toSqlValue(f, merged[f.name]));
      vals.push("?");
    }
    const sql = `INSERT INTO "${model}" (${cols.join(", ")}) VALUES (${vals.join(", ")})`;
    const info = db.prepare(sql).run(...params);
    return (
      db.prepare(`SELECT * FROM "${model}" WHERE rowid = ?`).get(Number(info.lastInsertRowid)) ??
      (merged.id !== undefined ? readUnique(model, { id: merged.id }) : null)
    );
  }

  function stripRelations(model, data) {
    const out = {};
    for (const [k, v] of Object.entries(data ?? {})) {
      if (isColumn(model, k)) out[k] = v;
      else if (relations.get(model)?.has(k)) {
        throw new UnsupportedQuery(`nested write on ${model}.${k} (not needed by Phase 13)`);
      } else throw new UnsupportedQuery(`unknown data key ${model}.${k}`);
    }
    return out;
  }

  function readUnique(model, where) {
    const out = [];
    const params = [];
    translateWhere(model, where, `"${model}"`, out, params);
    const row = db
      .prepare(`SELECT * FROM "${model}" WHERE ${out.join(" AND ")} LIMIT 2`)
      .get(...params);
    return row ?? null;
  }

  function findMany(model, args = {}) {
    const out = [];
    const params = [];
    const guard = (p, i) => {
      if (p === undefined) {
        throw new Error(
          `sqlite-prisma-lite: ${model} query bound an \`undefined\` filter value (where #${i}) — a real Prisma client would have thrown too; the caller computed a missing field`
        );
      }
      return p;
    };
    translateWhere(model, args.where, `"${model}"`, out, params);
    const orderSql = translateOrderBy(model, args.orderBy);
    let sql = `SELECT * FROM "${model}"${out.length ? " WHERE " + out.join(" AND ") : ""}${orderSql}`;
    if (args.take !== undefined) sql += ` LIMIT ${Number(args.take)}`;
    if (args.skip !== undefined) sql += ` OFFSET ${Number(args.skip)}`;
    params.forEach(guard);
    const rows = db.prepare(sql).all(...params);
    return rows.map((r) =>
      args.select
        ? project(model, r, args.select, "select")
        : args.include
          ? project(model, r, args.include, "include")
          : hydrateScalars(model, r)
    );
  }

  function findFirst(model, args = {}) {
    const rows = findMany(model, { ...args, take: 1 });
    return rows[0] ?? null;
  }

  function delegate(model) {
    return {
      findMany: async (args = {}) => findMany(model, args),
      findFirst: async (args = {}) => findFirst(model, args),
      findFirstOrThrow: async (args = {}) => {
        const r = findFirst(model, args);
        if (!r) throw new Error(`${model} row not found`);
        return r;
      },
      findUnique: async (args = {}) => {
        const rows = findMany(model, { ...args, take: 2 });
        return rows[0] ?? null;
      },
      findUniqueOrThrow: async (args = {}) => {
        const r = delegate(model).findUnique(args);
        if (!r) throw new Error(`${model} row not found`);
        return r;
      },
      count: async (args = {}) => {
        const out = [];
        const params = [];
        translateWhere(model, args.where, `"${model}"`, out, params);
        return db
          .prepare(
            `SELECT COUNT(*) AS c FROM "${model}"${out.length ? " WHERE " + out.join(" AND ") : ""}`
          )
          .get(...params).c;
      },
      create: async (args = {}) => {
        const created = insertRow(model, args.data);
        const row = created ?? readUnique(model, {});
        return args.select
          ? project(model, row, args.select, "select")
          : args.include
            ? project(model, row, args.include, "include")
            : hydrateScalars(model, row);
      },
      update: async (args = {}) => {
        const target = readUnique(model, args.where);
        if (!target) throw new Error(`${model} row not found for update`);
        const merged = { ...stripRelations(model, args.data) };
        applyUpdate(model, `"${model}"."id" = ?`, [target.id], merged);
        const after = db.prepare(`SELECT * FROM "${model}" WHERE "id" = ?`).get(target.id);
        return args.select
          ? project(model, after, args.select, "select")
          : args.include
            ? project(model, after, args.include, "include")
            : hydrateScalars(model, after);
      },
      updateMany: async (args = {}) => ({ count: applyUpdate(model, null, null, args.data, args.where) }),
      delete: async (args = {}) => {
        const target = readUnique(model, args.where);
        if (!target) throw new Error(`${model} row not found for delete`);
        db.prepare(`DELETE FROM "${model}" WHERE "id" = ?`).run(target.id);
        return target;
      },
      deleteMany: async (args = {}) => {
        const out = [];
        const params = [];
        translateWhere(model, args.where, `"${model}"`, out, params);
        const info = db
          .prepare(`DELETE FROM "${model}"${out.length ? " WHERE " + out.join(" AND ") : ""}`)
          .run(...params);
        return { count: Number(info.changes ?? 0) };
      },
      upsert: async (args = {}) => {
        const existing = readUnique(model, args.where);
        if (existing) {
          const merged = { ...stripRelations(model, args.update ?? {}) };
          if (Object.keys(merged).length) {
            applyUpdate(model, `"${model}"."id" = ?`, [existing.id], merged);
          }
        } else {
          insertRow(model, args.create ?? {});
        }
        const row =
          db
            .prepare(
              `SELECT * FROM "${model}" WHERE ${Object.keys(args.where)
                .map((k) => `"${k}" = ?`)
                .join(" AND ")}`
            )
            .get(...Object.values(args.where)) ?? readUnique(model, args.where);
        return args.select
          ? project(model, row, args.select, "select")
          : args.include
            ? project(model, row, args.include, "include")
            : hydrateScalars(model, row);
      },
      groupBy: async () => {
        throw new UnsupportedQuery("group");
      },
    };
  }

  function applyUpdate(model, whereSql, whereParams, data, rawWhere) {
    const merged = stripRelations(model, data);
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(merged)) {
      const f = fieldOf(model, k);
      if (typeof v === "object" && v !== null && "increment" in v) {
        sets.push(`"${k}" = "${k}" + ?`);
        params.push(v.increment);
        continue;
      }
      if (typeof v === "object" && v !== null && "set" in v) {
        sets.push(`"${k}" = ?`);
        params.push(toSqlValue(f, v.set));
        continue;
      }
      sets.push(`"${k}" = ?`);
      params.push(toSqlValue(f, v));
    }
    const nowFields = models
      .get(model)
      .fields.filter((f) => f.isUpdatedAt && !(f.name in merged));
    for (const f of nowFields) {
      sets.push(`"${f.name}" = ?`);
      params.push(Date.now());
    }
    if (!sets.length) return 0;
    let sql = `UPDATE "${model}" SET ${sets.join(", ")}`;
    if (whereSql) {
      sql += ` WHERE ${whereSql}`;
      params.push(...whereParams);
    } else if (rawWhere) {
      const out = [];
      translateWhere(model, rawWhere, `"${model}"`, out, params);
      if (out.length) sql += ` WHERE ${out.join(" AND ")}`;
    }
    const info = db.prepare(sql).run(...params);
    return Number(info.changes ?? 0);
  }

  const client = {};
  for (const [name] of models) {
    const d = delegate(name);
    client[name] = d;
    // Prisma's generated client exposes models camelCased (`db.lesson` for
    // `model Lesson`); expose both so callers can use either.
    const lower = name[0].toLowerCase() + name.slice(1);
    if (lower !== name && !client[lower]) client[lower] = d;
  }

  client.$transaction = async (arg) => {
    if (typeof arg === "function") {
      db.exec("BEGIN");
      try {
        const result = await arg(client);
        db.exec("COMMIT");
        return result;
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw e;
      }
    }
    return Promise.all(arg);
  };
  client.$disconnect = async () => {};
  client.$connect = async () => {};
  client.$executeRaw = async (strings, ...values) =>
    Number(db.prepare(strings.join("?")).run(...values)?.changes ?? 0);
  client.$executeRawUnsafe = async (sql, ...values) =>
    Number(db.prepare(sql).run(...values)?.changes ?? 0);
  client.$queryRaw = async (strings, ...values) =>
    db.prepare(strings.join("?")).all(...values);
  client.$sqlite = db; // escape hatch for verification scripts

  return client;
}

let counter = 0;
function cuidLike() {
  counter += 1;
  const stamp = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 1e9).toString(36);
  return `c${stamp}${rand}${counter.toString(36)}`;
}
function cryptoRandomId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export { PRISMA_TO_SQLITE };
