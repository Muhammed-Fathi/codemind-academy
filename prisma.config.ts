// Prisma config (Prisma 6.7+): lets the CLI run `generate` / `db push` /
// `migrate` WITHOUT downloading native engine binaries from
// binaries.prisma.sh (which is unreachable in this sandbox).
// engine:"js" + a better-sqlite3 driver adapter fully replaces the native
// engines for SQLite schema push / migration operations.
import path from "node:path";
import dotenv from "dotenv";

// Prisma config detection disables automatic .env loading — load it here.
dotenv.config({ path: path.join(__dirname, ".env") });

import { defineConfig } from "prisma/config";

export default defineConfig({
  experimental: {
    adapter: true,
  },
  schema: path.join(__dirname, "prisma", "schema.prisma"),
  // "js" = use the JS/WASM engine implementations (no native binaries).
  engine: "js",
  adapter: async () => {
    const { PrismaBetterSQLite3 } = await import(
      "@prisma/adapter-better-sqlite3"
    );
    const dbFile =
      process.env.DATABASE_URL?.replace(/^file:/, "") || "prisma/db/custom.db";
    return new PrismaBetterSQLite3({ url: `file:${dbFile}` });
  },
});
