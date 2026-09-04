// CodeMind Academy — Registration validator tests (offline).
// Compiles src/lib/registration.ts with tsc and asserts every rule used by
// the student/parent registration flow and parent-linking logic:
// Arabic 3-part names, Egyptian phones (+ normalization equivalence),
// 14-digit national IDs, and CM-XXXXXX student codes (incl. 500 uniqueness).
//
// Run: node tests/registration-validators.test.js
// Exit code: 0 = all pass, 1 = failure.

const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-reg-test-"));

const TSCONFIG = path.join(OUT, "tsconfig.json");
fs.writeFileSync(
  TSCONFIG,
  JSON.stringify({
    compilerOptions: {
      target: "es2020",
      module: "commonjs",
      strict: true,
      skipLibCheck: true,
      typeRoots: [path.join(REPO, "node_modules/@types")],
      outDir: OUT,
    },
    files: [path.join(REPO, "src/lib/registration.ts")],
  })
);
execSync(`npx tsc -p ${TSCONFIG}`, { cwd: REPO, stdio: "pipe" });

const R = require(path.join(OUT, "registration.js"));

let pass = 0,
  fail = 0;
const ok = (cond, label) => {
  if (cond) pass++;
  else {
    fail++;
    console.error("FAIL:", label);
  }
};

// --- Arabic three-part names (student) ---
ok(R.isValidArabicThreePartName("أحمد محمد حسن"), "ar 3-part valid");
ok(!R.isValidArabicThreePartName("أحمد محمد"), "ar 2-part invalid");
ok(!R.isValidArabicThreePartName("أحمد محمد حسن علي"), "ar 4-part invalid");
ok(!R.isValidArabicThreePartName("Ahmed Mohamed Hassan"), "latin rejected for student");
ok(!R.isValidArabicThreePartName(""), "empty invalid");
ok(!R.isValidArabicThreePartName("أحمد  حسن"), "2-part with double space invalid");

// --- Parent three-part names (Arabic or Latin) ---
ok(R.isValidThreePartName("Mr Ahmed Hassan"), "parent latin 3-part valid");
ok(R.isValidThreePartName("أحمد محمد حسن"), "parent ar 3-part valid");
ok(!R.isValidThreePartName("Ahmed Hassan"), "parent 2-part invalid");

// --- Egyptian phones ---
ok(R.isValidEgyptianPhone("01147422177"), "local 011 valid");
ok(R.isValidEgyptianPhone("+20 1147422177"), "intl spaced valid");
ok(R.isValidEgyptianPhone("201147422177"), "intl digits valid");
ok(!R.isValidEgyptianPhone("12345"), "short invalid");
ok(!R.isValidEgyptianPhone("02147422177"), "bad prefix invalid");
ok(
  R.normalizePhone("+20 1147422177") === R.normalizePhone("01147422177"),
  "local ≡ intl after normalization (linking-safe)"
);

// --- National ID ---
ok(R.isValidNationalId("29901010101010"), "14-digit valid");
ok(!R.isValidNationalId("123"), "short invalid");
ok(!R.isValidNationalId("2990101010101A"), "alpha invalid");

// --- Student codes ---
const seen = new Set();
let fmtOk = true;
for (let i = 0; i < 500; i++) {
  const c = R.generateStudentCode();
  if (!R.isValidStudentCode(c)) {
    fmtOk = false;
    break;
  }
  if (seen.has(c)) {
    fmtOk = false;
    console.error("DUP:", c);
    break;
  }
  seen.add(c);
}
ok(fmtOk, "500 unique well-formed codes (CM-XXXXXX)");
ok(R.isValidStudentCode("CM-ABC123"), "sample code valid");
ok(R.isValidStudentCode("cm-abc123"), "lowercase accepted");
ok(!R.isValidStudentCode("ABC123"), "missing prefix invalid");
ok(!R.isValidStudentCode("CM-ABC12"), "short invalid");
ok(!R.isValidStudentCode("CM-ABC1234"), "long invalid");

console.log(`\nregistration validators: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
