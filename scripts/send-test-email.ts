// CodeMind Academy — Gmail SMTP test script.
//
// Verifies the SMTP connection (credentials + STARTTLS) and sends a test
// email WITHOUT touching the password-reset flow. Server-side only; never
// prints SMTP credentials.
//
// Usage:
//   npm run test:email                 # uses EMAIL_TEST_TO from .env
//   npm run test:email you@example.com # explicit recipient
//
// Exit codes: 0 = success, 1 = not configured, 2 = connection/auth failed,
//             3 = send failed.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  isSmtpConfigured,
  getSmtpConfig,
  sendMailViaSmtp,
  verifySmtpConnection,
  smtpDiagnostics,
} from "../src/lib/mailer";

function loadEnvFiles(): void {
  // Loading order mirrors Next.js: .env.local overrides .env, but real
  // process.env always wins. Never load .env.example.
  for (const name of [".env.local", ".env"]) {
    const p = resolve(process.cwd(), name);
    if (existsSync(p)) {
      try {
        process.loadEnvFile(p);
      } catch {
        // Ignore unreadable files; real env vars take precedence anyway.
      }
    }
  }
}

function redacted(value: string): string {
  const [local, domain] = value.split("@");
  return domain ? `${local?.[0] ?? "*"}***@${domain}` : `${value.slice(0, 2)}***`;
}

async function main() {
  loadEnvFiles();

  const to = process.argv[2] || process.env.EMAIL_TEST_TO || "";
  if (!to) {
    console.error("No recipient: set EMAIL_TEST_TO in .env or pass one as an argument.");
    process.exit(1);
  }

  if (!isSmtpConfigured()) {
    console.error("\nSMTP is NOT configured. Add these to .env (no real secrets here):");
    console.error("  SMTP_HOST=smtp.gmail.com");
    console.error("  SMTP_PORT=587");
    console.error("  SMTP_USER=YOUR_CODEMIND_GMAIL");
    console.error("  SMTP_PASSWORD=YOUR_GMAIL_APP_PASSWORD");
    process.exit(1);
  }

  const config = getSmtpConfig()!;
  const diag = smtpDiagnostics();
  console.log("── SMTP diagnostics ─────────────────────────────");
  console.log(`  host      : ${diag.host}`);
  console.log(`  port      : ${diag.port} (${diag.secure ? "implicit TLS" : "STARTTLS"})`);
  console.log(`  from      : ${redacted(diag.from || "")}`);
  console.log(`  user      : ${diag.userMasked}`);
  console.log(`  recipient : ${redacted(to)}`);
  console.log("─────────────────────────────────────────────────");

  console.log("\n1) Verifying SMTP connection + credentials (transport.verify)…");
  const verify = await verifySmtpConnection();
  if (!verify.ok) {
    console.error(`   FAILED  code=${verify.errorCode || "unknown"}`);
    console.error(`   ${verify.errorMessage || "unknown error"}`);
    console.error("\n   Common causes:");
    console.error("   - Wrong App Password (Gmail says 'Invalid login' / 535).");
    console.error("   - The Gmail account needs 2-Step Verification before an App Password exists.");
    console.error("   - Port 587 blocked by a firewall/proxy — try SMTP_PORT=465 + SMTP_SECURE=1.");
    console.error("   - SMTP_SECURE / port mismatch (587 needs STARTTLS, 465 needs secure=1).");
    process.exit(2);
  }
  console.log("   OK — authentication and STARTTLS succeeded.");

  console.log("\n2) Sending test email…");
  const result = await sendMailViaSmtp({
    to,
    subject: "CodeMind Academy — SMTP test",
    text:
      "This is a test email from CodeMind Academy.\n\n" +
      "If you received this, Gmail SMTP is configured correctly and password " +
      "reset emails will be delivered through the same transport.\n",
    html:
      "<p>This is a test email from <strong>CodeMind Academy</strong>.</p>" +
      "<p>If you received this, Gmail SMTP is configured correctly and password " +
      "reset emails will be delivered through the same transport.</p>",
  });

  if (!result.ok) {
    console.error(`   FAILED  code=${result.errorCode || "unknown"}`);
    console.error(`   ${result.errorMessage || "unknown error"}`);
    console.error("\n   Check: sender/recipient mismatch, Gmail 'sender not allowed', SPF/DKIM.");
    process.exit(3);
  }
  console.log(`   OK — delivered (messageId=${result.messageId || "n/a"})`);
  console.log("\nSuccess. Check " + to + " (spam folder too) for the test email.");
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
