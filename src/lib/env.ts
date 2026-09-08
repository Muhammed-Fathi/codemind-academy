// CodeMind Academy — Server-only environment validation.
//
// This module is the single place that decides what the runtime environment
// MUST provide before the application is allowed to serve production traffic.
// It runs on the server only (imported by security helpers, `instrumentation.ts`
// and `next.config.ts`) and must never be imported from a client component.
//
// Rules:
//   * Values are NEVER logged or returned — only the variable NAME appears in
//     error messages.
//   * There is deliberately NO production fallback for secrets. A missing
//     production secret is a hard failure, not a warning.
//   * Development/test keep a convenient (but clearly non-secret) fallback so
//     `bun run dev` and the offline test suites work without configuration.

/** Minimum accepted length for SECURITY_HASH_SECRET (256 bits as hex). */
export const MIN_SECURITY_HASH_SECRET_LENGTH = 32;

/**
 * Development-only fallback. Intentionally recognisable so it can never be
 * mistaken for a real secret, and rejected outright in production even if
 * someone copies it into a production `.env`.
 */
const DEV_FALLBACK_HASH_SECRET = "codemind-dev-hash-secret";

/**
 * Values that are never acceptable in production regardless of length: the
 * dev fallback and the `.env.example` placeholder (so copying the example
 * file to a server verbatim still fails loudly).
 */
const REJECTED_PRODUCTION_SECRETS = new Set<string>([
  DEV_FALLBACK_HASH_SECRET,
  "REPLACE_WITH_openssl_rand_hex_32",
]);

export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production";
}

/**
 * Return a human-readable problem for SECURITY_HASH_SECRET, or `null` when the
 * value is acceptable for the given environment. Never includes the value.
 */
export function getSecurityHashSecretProblem(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const raw = env.SECURITY_HASH_SECRET;
  const value = typeof raw === "string" ? raw.trim() : "";

  if (!isProduction(env)) {
    // Development/test: optional. If provided it just has to be non-empty.
    return null;
  }

  if (!value) {
    return (
      "SECURITY_HASH_SECRET is required when NODE_ENV=production. " +
      "Generate one with: openssl rand -hex 32 (or: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\") " +
      "and set it in the server environment (see .env.example)."
    );
  }
  if (REJECTED_PRODUCTION_SECRETS.has(value)) {
    return (
      "SECURITY_HASH_SECRET must not be a placeholder value in production. " +
      "Generate a real random value (openssl rand -hex 32)."
    );
  }
  if (value.length < MIN_SECURITY_HASH_SECRET_LENGTH) {
    return (
      `SECURITY_HASH_SECRET is too short (minimum ${MIN_SECURITY_HASH_SECRET_LENGTH} characters). ` +
      "Generate a real random value (openssl rand -hex 32)."
    );
  }
  return null;
}

/**
 * Resolve the secret used to key IP / device hashes.
 *
 *  - production: SECURITY_HASH_SECRET is mandatory — throws if missing/invalid.
 *  - development/test: SECURITY_HASH_SECRET if set, else a dev-only fallback.
 */
export function getSecurityHashSecret(env: NodeJS.ProcessEnv = process.env): string {
  const problem = getSecurityHashSecretProblem(env);
  if (problem) throw new Error(problem);
  const value = env.SECURITY_HASH_SECRET?.trim();
  return value || DEV_FALLBACK_HASH_SECRET;
}

/**
 * Validate every production-critical variable. Returns the list of problems
 * (empty when the environment is acceptable). Only variable names are
 * mentioned — never values.
 */
export function validateProductionEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  const secretProblem = getSecurityHashSecretProblem(env);
  if (secretProblem) problems.push(secretProblem);
  return problems;
}

/**
 * Fail fast: throw a single aggregated error when the production environment
 * is not acceptable. Used at server startup (instrumentation) and by the
 * production build so a misconfigured deployment never silently starts with
 * predictable secrets.
 */
export function assertProductionEnv(env: NodeJS.ProcessEnv = process.env): void {
  const problems = validateProductionEnv(env);
  if (problems.length === 0) return;
  throw new Error(
    "[codemind] Refusing to start: production environment is not configured.\n" +
      problems.map((p) => `  - ${p}`).join("\n")
  );
}
