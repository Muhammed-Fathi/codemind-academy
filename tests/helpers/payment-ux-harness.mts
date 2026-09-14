// CodeMind Academy — Phase 25 PR3 render harness (jsdom).
//
// Renders the SHIPPED PR3 components (src/components/...) in a real DOM with a
// mocked network, and asserts the payment-experience contract the PR3 spec
// requires. It is the same technique as scripts/verify-phase16-render.mts:
// real components, real i18n dictionary, real store — only fetch is stubbed.
//
// Run by tests/payment-experience-phase25-pr3.test.js:
//   node node_modules/tsx/dist/cli.mjs tests/helpers/payment-ux-harness.mts
// Prints one `HARNESS_JSON {...}` line.

import { JSDOM } from "jsdom";

process.env.IS_REACT_ACT_ENVIRONMENT = "true";
(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
g.localStorage = dom.window.localStorage;
g.HTMLElement = dom.window.HTMLElement;
g.HTMLInputElement = dom.window.HTMLInputElement;
g.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.MouseEvent = dom.window.MouseEvent;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.CustomEvent = dom.window.CustomEvent;
g.MutationObserver = dom.window.MutationObserver;
g.HTMLFormElement = dom.window.HTMLFormElement;
g.HTMLSelectElement = dom.window.HTMLSelectElement;
g.DOMRect = dom.window.DOMRect;
g.DocumentFragment = dom.window.DocumentFragment;
// jsdom has no PointerEvent / ResizeObserver — Radix + vaul need them to exist.
if (!("PointerEvent" in dom.window)) {
  (dom.window as unknown as Record<string, unknown>).PointerEvent = dom.window.MouseEvent;
}
g.PointerEvent = (dom.window as unknown as Record<string, unknown>).PointerEvent;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(dom.window as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
g.ResizeObserver = ResizeObserverStub;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.window.matchMedia =
  g.window.matchMedia ||
  (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
(dom.window.Element.prototype as unknown as Record<string, unknown>).scrollIntoView = () => {};
(dom.window.Element.prototype as unknown as Record<string, unknown>).hasPointerCapture = () => false;
(dom.window.Element.prototype as unknown as Record<string, unknown>).releasePointerCapture = () => {};
(dom.window.Element.prototype as unknown as Record<string, unknown>).setPointerCapture = () => {};
g.requestAnimationFrame = (cb: (...a: unknown[]) => void) => setTimeout(() => cb(), 0) as unknown as number;
g.cancelAnimationFrame = (id: number) => clearTimeout(id);

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: unknown, label: string) {
  if (cond) pass++;
  else {
    fail++;
    failures.push(label);
    console.error("FAIL:", label);
  }
}
const section = (t: string) => console.log(`\n== ${t} ==`);

// ---------------------------------------------------------------------------
// Network mock — records every call so the suites can assert request bodies.
// ---------------------------------------------------------------------------
type Handler = {
  method?: string;
  match: (url: string) => boolean;
  status?: number;
  body?: unknown;
};
let handlers: Handler[] = [];
const calls: { url: string; method: string; body: any }[] = [];

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
g.fetch = (async (url: unknown, opts?: any) => {
  const u = String(url);
  const method = String(opts?.method || "GET").toUpperCase();
  let parsed: any = null;
  if (opts?.body) {
    try {
      parsed = JSON.parse(String(opts.body));
    } catch {
      parsed = String(opts.body);
    }
  }
  calls.push({ url: u, method, body: parsed });
  for (const h of handlers) {
    if (h.method && h.method !== method) continue;
    if (h.match(u)) return jsonResponse(h.status ?? 200, h.body ?? {});
  }
  return jsonResponse(404, { error: "not found" });
}) as typeof fetch;

const resetNet = (next: Handler[] = []) => {
  handlers = next;
  calls.length = 0;
};
const callsTo = (fragment: string, method?: string) =>
  calls.filter((c) => c.url.includes(fragment) && (!method || c.method === method));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
async function main() {
  const React = await import("react");
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useApp } = await import("@/lib/store");
  const { EnrollView } = await import("@/components/auth/enroll-view");
  const { StudentPaymentPanel } = await import("@/components/student/payment-status");
  const { PaymentReviewDrawer } = await import("@/components/admin/payment-review-drawer");
  const UX = await import("@/lib/payment-ux");
  const I18N = await import("@/lib/i18n-core");
  const BRAND = await import("@/lib/brand");

  async function render(el: React.ReactElement) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(el);
      await sleep(120);
    });
    const html = () => host.innerHTML;
    const bodyHtml = () => document.body.innerHTML;
    const q = (sel: string) => host.querySelector(sel);
    const qAll = (sel: string) => Array.from(host.querySelectorAll(sel));
    const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`);
    const byTestIdAll = (id: string) => Array.from(host.querySelectorAll(`[data-testid="${id}"]`));
    return {
      host,
      html,
      bodyHtml,
      q,
      qAll,
      byTestId,
      byTestIdAll,
      text: () => host.textContent || "",
      async click(el: Element | null) {
        if (!el) throw new Error("click: element missing");
        await act(async () => {
          el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
          await sleep(400);
        });
      },
      async type(el: Element | null, value: string) {
        if (!el) throw new Error("type: element missing");
        const proto =
          el instanceof dom.window.HTMLTextAreaElement
            ? dom.window.HTMLTextAreaElement.prototype
            : dom.window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        await act(async () => {
          setter?.call(el, value);
          el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
          await sleep(60);
        });
      },
      async unmount() {
        await act(async () => {
          root.unmount();
        });
        host.remove();
      },
    };
  }

  function setShell(locale: "ar" | "en") {
    const s = useApp.getState();
    s.setLocale(locale);
    s.setUser({
      id: "user-1",
      email: "student@example.com",
      name: "محمد فتحي",
      role: "STUDENT",
    });
    s.setView("enroll");
  }

  // ---- fixtures (deliberately NOT the real course/group names) -------------
  const COURSE = {
    id: "course-x",
    name: "Test Course",
    nameAr: "كورس الاختبار",
    description: "وصف",
    color: "#123456",
  };
  const GROUP = {
    id: "group-x",
    name: "مجموعة النخبة المسائية",
    capacity: 20,
    schedule: "Sat & Tue, 8:00 PM",
    _count: { students: 3 },
  };
  const PLAN = {
    id: "plan-x",
    name: "Gold Plan",
    nameAr: "الباقة الذهبية",
    durationMonths: 3,
    price: 1250,
    isPromo: false,
  };
  const PAYMENTS_READ = (over: any = {}) => ({
    payments: [],
    latestPending: null,
    latestRejected: null,
    entitlement: {
      state: "NONE",
      accessAllowed: false,
      grandfathered: false,
      hasSubscription: false,
      groupName: null,
      endDate: null,
      plan: null,
    },
    ...over,
  });

  const catalogHandlers = (payments: any): Handler[] => [
    { match: (u) => u.includes("/api/courses"), body: { courses: [COURSE] } },
    { match: (u) => u.includes("/api/subscription-plans"), body: { plans: [PLAN] } },
    { match: (u) => u.includes("/api/groups"), body: { groups: [GROUP] } },
    { match: (u) => u.includes("/api/students/me/payments"), body: payments },
    { match: (u) => u.includes("/api/settings/public"), body: { settings: {} } },
  ];

  const enrollResponse = (over: any = {}) => ({
    scenario: "NEW_REQUEST",
    subscription: { id: "sub-1", status: "PENDING", planId: "plan-x" },
    payment: { id: "pay-1", status: "PENDING" },
    batchId: "batch-1",
    entitlement: {
      state: "PENDING",
      accessAllowed: false,
      grandfathered: false,
      hasSubscription: true,
      groupName: null,
      endDate: null,
      plan: { name: "Gold Plan", nameAr: "الباقة الذهبية" },
    },
    ...over,
  });

  /** Walk the wizard to the payment page. */
  async function walkToPaymentPage(r: Awaited<ReturnType<typeof render>>) {
    await r.click(r.q("button[aria-pressed]")); // course card (only one)
    const groupBtn = r.qAll("button[aria-pressed]").find((b) =>
      (b.textContent || "").includes(GROUP.name)
    );
    await r.click(groupBtn ?? null);
    await r.click(r.byTestId("nav-next") ?? r.qAll("button").find((b) => (b.textContent || "").includes("التالي")) ?? null);
    const planBtn = r.qAll("button[aria-pressed]").find((b) =>
      (b.textContent || "").includes(PLAN.nameAr)
    );
    await r.click(planBtn ?? null);
    await r.click(r.qAll("button").find((b) => (b.textContent || "").includes("التالي")) ?? null);
  }

  // =========================================================================
  section("S1. Payment page — real course / group / plan / amount (AR)");
  {
    setShell("ar");
    resetNet(catalogHandlers(PAYMENTS_READ()));
    const r = await render(React.createElement(EnrollView));
    await walkToPaymentPage(r);

    const text = r.text();
    ok(document.documentElement.dir === "rtl", "S1: document.dir is rtl");
    ok(text.includes("كورس الاختبار"), "S1: the ACTUAL selected course is shown");
    ok(text.includes("مجموعة النخبة المسائية"), "S1: the ACTUAL selected group is shown");
    ok(text.includes("الباقة الذهبية"), "S1: the ACTUAL selected plan is shown");
    ok(text.includes("1,250"), "S1: the ACTUAL plan price is shown (1,250)");
    ok(text.includes("3") && text.includes("شهر"), "S1: the plan duration is shown");
    ok(!r.html().includes("Programming & AI"), "S1: no hardcoded 'Programming & AI'");
    ok(!r.html().includes(">Group A<") && !/"Group A"/.test(r.html()), "S1: no hardcoded 'Group A'");
    ok(!!r.byTestId("sender-phone-input"), "S1: senderPhone input present");
    ok(!!r.byTestId("reference-input"), "S1: reference input present");
    ok(
      (r.byTestId("sender-phone-input")?.getAttribute("inputmode") || "") === "tel",
      "S1: sender phone is a telephone input (mobile keyboards)"
    );
    ok(text.includes("01147422177"), "S1: an Egyptian example format is shown");
    ok(!r.byTestId("payment-destination"), "S1: no destination is shown before a method is chosen");
    ok(!!r.byTestId("proof-instructions"), "S1: proof instruction card present");
    ok(!!r.byTestId("proof-numbers-note"), "S1: pre-submission proof numbers note present");
    const numbers = r.byTestId("proof-numbers-list")?.textContent || "";
    ok(numbers.includes("01147422177") && numbers.includes("01099942942"), "S1: both approved WhatsApp numbers listed");
    ok(
      (r.byTestId("proof-one-number-only")?.textContent || "").includes("رقم واحد فقط"),
      "S1: the ONE-number-only rule is stated on the payment page"
    );
    ok((r.byTestId("proof-review-time")?.textContent || "").includes("24"), "S1: 24-hour review window stated");
    ok(r.qAll('input[type="file"]').length === 0, "S1: no screenshot/file upload input exists");
    ok(!!r.q(".lg\\:grid-cols-\\[minmax\\(0\\,1\\.35fr\\)_minmax\\(0\\,1fr\\)\\]"), "S1: desktop two-column grid present");

    // Method-specific instructions + destination.
    const instapay = r.qAll("button[aria-pressed]").find((b) => (b.textContent || "").includes("InstaPay"));
    await r.click(instapay ?? null);
    ok(
      (r.byTestId("payment-destination")?.textContent || "").includes("InstaPay"),
      "S1: InstaPay destination block is method-specific"
    );
    ok(r.text().includes("تطبيق InstaPay"), "S1: InstaPay instructions rendered");
    const ecash = r.qAll("button[aria-pressed]").find((b) => (b.textContent || "").includes("e& Cash"));
    await r.click(ecash ?? null);
    ok(r.text().includes("تطبيق e& Cash"), "S1: e& Cash instructions rendered");

    // Client validation: no phone → error, nothing posted.
    await r.type(r.byTestId("reference-input"), "1234567890");
    await r.click(r.byTestId("submit-payment-request"));
    ok(callsTo("/api/enroll", "POST").length === 0, "S1: invalid submit posts nothing");
    ok(
      (r.q('[role="alert"]')?.textContent || "").length > 0,
      "S1: a field error is associated and visible"
    );
    await r.type(r.byTestId("sender-phone-input"), "12345");
    await r.click(r.byTestId("submit-payment-request"));
    ok(
      r.text().includes("رقم مصري"),
      "S1: invalid Egyptian phone gets useful validation feedback"
    );
    ok(callsTo("/api/enroll", "POST").length === 0, "S1: still nothing posted for an invalid phone");

    await r.unmount();
  }

  // =========================================================================
  section("S1b. Method availability — no destination ⇒ no selection, no submission");
  {
    setShell("ar");
    resetNet([
      ...catalogHandlers(PAYMENTS_READ()),
      { method: "POST", match: (u) => u.includes("/api/enroll"), body: enrollResponse() },
    ]);
    const tile = (r: Awaited<ReturnType<typeof render>>, name: string) =>
      (r.qAll("button[aria-pressed]").find((b) =>
        (b.textContent || "").includes(name)
      ) ?? null) as HTMLButtonElement | null;
    // Simulate a FUTURE configuration change (a launch method losing its
    // destination) without touching the repository configuration: the brand
    // object is read at call time by `paymentDestinationFor`.
    const paymentsCfg = BRAND.brand.payments as { eCash: string | null };
    const setECash = (v: string | null) => {
      paymentsCfg.eCash = v;
    };
    const realECash = BRAND.brand.payments.eCash;

    try {
      // --- (1) Real configuration: both launch methods are available.
      const r = await render(React.createElement(EnrollView));
      await walkToPaymentPage(r);
      ok(tile(r, "InstaPay")?.disabled === false, "S1b: InstaPay is selectable (destination configured)");
      ok(!(tile(r, "InstaPay")?.textContent || "").includes("قريبًا"), "S1b: InstaPay carries no coming-soon badge");
      ok(!(tile(r, "InstaPay")?.textContent || "").includes("مش متاحة"), "S1b: InstaPay carries no unavailable badge");
      ok(tile(r, "e& Cash")?.disabled === false, "S1b: e& Cash is selectable (destination configured)");
      const vodafone = tile(r, "Vodafone Cash");
      ok(vodafone?.disabled === true, "S1b: Vodafone Cash is disabled (no destination)");
      ok((vodafone?.textContent || "").includes("قريبًا"), "S1b: Vodafone Cash still reads as coming soon");

      // A configured method must still submit normally (positive control).
      await r.click(tile(r, "e& Cash"));
      ok(
        (r.byTestId("payment-destination")?.textContent || "").includes("+20 1147422177"),
        "S1b: e& Cash destination shown"
      );
      await r.type(r.byTestId("sender-phone-input"), "01147422177");
      await r.type(r.byTestId("reference-input"), "7777777777");
      await r.click(r.byTestId("submit-payment-request"));
      const ecashPosts = callsTo("/api/enroll", "POST");
      ok(ecashPosts.length === 1, `S1b: e& Cash submits when its destination exists (got ${ecashPosts.length})`);
      ok(ecashPosts[0]?.body?.method === "ETISALAT_CASH", "S1b: the posted method is e& Cash");
      await r.unmount();

      // --- (2) Defense in depth: a method already held in component state
      //         stops being submittable the moment its destination disappears.
      resetNet([
        ...catalogHandlers(PAYMENTS_READ()),
        { method: "POST", match: (u) => u.includes("/api/enroll"), body: enrollResponse() },
      ]);
      const r2 = await render(React.createElement(EnrollView));
      await walkToPaymentPage(r2);
      await r2.click(tile(r2, "e& Cash"));
      await r2.type(r2.byTestId("sender-phone-input"), "01147422177");
      await r2.type(r2.byTestId("reference-input"), "9876543210");
      ok(UX.paymentMethodAvailable("ETISALAT_CASH") === true, "S1b: e& Cash is available before the change");
      ok(callsTo("/api/enroll", "POST").length === 0, "S1b: nothing posted before the change");

      setECash(null);
      ok(UX.paymentDestinationFor("ETISALAT_CASH") === null, "S1b: a nulled destination resolves to null");
      ok(
        UX.paymentDestinationFor("INSTAPAY") === "+20 1147422177",
        "S1b: InstaPay never lends its destination to another method"
      );
      ok(UX.paymentMethodAvailable("ETISALAT_CASH") === false, "S1b: e& Cash becomes unavailable");
      ok(UX.paymentMethodAvailable("INSTAPAY") === true, "S1b: InstaPay stays available");
      await r2.click(r2.byTestId("submit-payment-request"));
      ok(
        callsTo("/api/enroll", "POST").length === 0,
        "S1b: a forced unavailable method posts NOTHING to /api/enroll"
      );
      ok(r2.text().includes("مش متاحة حاليًا"), "S1b: the unavailable-method message is shown");
      ok(
        (r2.q('[role="alert"]')?.textContent || "").includes("مش متاحة حاليًا"),
        "S1b: the block is surfaced as an accessible field error"
      );
      await r2.unmount();

      // --- (3) With an empty destination the tile is not even selectable,
      //         while a configured method still submits normally.
      setECash("");
      resetNet([
        ...catalogHandlers(PAYMENTS_READ()),
        { method: "POST", match: (u) => u.includes("/api/enroll"), body: enrollResponse() },
      ]);
      ok(UX.paymentMethodAvailable("ETISALAT_CASH") === false, "S1b: an empty destination is treated as unavailable");
      const r3 = await render(React.createElement(EnrollView));
      await walkToPaymentPage(r3);
      const ecashTile = tile(r3, "e& Cash");
      ok(ecashTile?.disabled === true, "S1b: an empty destination disables the method tile");
      ok((ecashTile?.textContent || "").includes("مش متاحة حاليًا"), "S1b: the disabled tile says it is unavailable");
      ok(ecashTile?.getAttribute("aria-disabled") === "true", "S1b: the disabled tile is aria-disabled");
      ok(ecashTile?.getAttribute("aria-pressed") === "false", "S1b: the disabled tile is not selected");
      await r3.click(ecashTile);
      ok(!r3.byTestId("payment-destination"), "S1b: clicking a disabled tile selects nothing");
      ok(!r3.text().includes("تطبيق e& Cash"), "S1b: no transfer instructions for an unavailable method");

      // The fix must not break a method that HAS a destination.
      await r3.click(tile(r3, "InstaPay"));
      ok(
        (r3.byTestId("payment-destination")?.textContent || "").includes("+20 1147422177"),
        "S1b: InstaPay destination still shown"
      );
      await r3.type(r3.byTestId("sender-phone-input"), "01147422177");
      await r3.type(r3.byTestId("reference-input"), "4242424242");
      await r3.click(r3.byTestId("submit-payment-request"));
      const posts = callsTo("/api/enroll", "POST");
      ok(posts.length === 1, `S1b: a method WITH a destination still submits (got ${posts.length})`);
      ok(posts[0]?.body?.method === "INSTAPAY", "S1b: the submitted method is the available one");
      await r3.unmount();
    } finally {
      setECash(realECash);
    }

    ok(
      BRAND.brand.payments.eCash === "+20 1147422177" &&
        BRAND.brand.payments.instapay === "+20 1147422177",
      "S1b: destination configuration is restored — the tests never change the real values"
    );
  }

  // =========================================================================
  section("S2. Submission — body, double-submit guard, PENDING (never ACTIVE)");
  {
    setShell("ar");
    resetNet([
      ...catalogHandlers(PAYMENTS_READ()),
      { method: "POST", match: (u) => u.includes("/api/enroll"), body: enrollResponse() },
    ]);
    const r = await render(React.createElement(EnrollView));
    await walkToPaymentPage(r);
    await r.click(r.qAll("button[aria-pressed]").find((b) => (b.textContent || "").includes("InstaPay")) ?? null);
    await r.type(r.byTestId("sender-phone-input"), "+20 114 742 2177");
    await r.type(r.byTestId("reference-input"), "9876543210");

    const submitBtn = r.byTestId("submit-payment-request");
    await r.click(submitBtn);
    await r.click(submitBtn); // double click while in flight

    const posts = callsTo("/api/enroll", "POST");
    ok(posts.length === 1, `S2: exactly one POST /api/enroll (got ${posts.length})`);
    const body = posts[0]?.body || {};
    ok(body.senderPhone === "+20 114 742 2177", "S2: body carries senderPhone");
    ok(body.reference === "9876543210", "S2: body carries reference");
    ok(body.method === "INSTAPAY" && body.courseId === "course-x" && body.groupId === "group-x" && body.planId === "plan-x", "S2: body carries the real selection ids");
    for (const forbidden of ["userId", "studentId", "subscriptionId", "status", "reviewedByUserId", "scenario"]) {
      ok(!(forbidden in body), `S2: body never carries ${forbidden}`);
    }

    ok(!!r.byTestId("pending-state"), "S2: the submitted state renders as PENDING");
    ok((r.byTestId("pending-title")?.textContent || "").includes("طلب الدفع تحت المراجعة"), "S2: pending headline copy");
    ok(!r.text().includes("تم تأكيد اشتراكك"), "S2: pending is never shown as approved/active");
    ok(r.text().includes("محتوى الكورس هيتفتح"), "S2: NEW student copy says access opens after approval");
    ok(!r.text().includes("تفعيل الأكونت"), "S2: never says 'account activation'");
    ok(r.text().includes("1,250") && r.text().includes("مجموعة النخبة المسائية"), "S2: request summary shows the real amount + group");
    ok(r.text().includes("9876543210"), "S2: request summary shows the reference");

    // WhatsApp proof
    const links = r.byTestIdAll("whatsapp-proof-link");
    ok(links.length === 2, `S2: exactly the two approved WhatsApp numbers (got ${links.length})`);
    const hrefs = links.map((a) => a.getAttribute("href") || "");
    ok(hrefs.some((h) => h.startsWith("https://wa.me/201147422177?text=")), "S2: first number normalized to wa.me international form");
    ok(hrefs.some((h) => h.startsWith("https://wa.me/201099942942?text=")), "S2: second number normalized to wa.me international form");
    ok(
      hrefs.every((h) => {
        const text = decodeURIComponent(h.split("?text=")[1] || "");
        return h.includes(encodeURIComponent(" ")) || !/\s/.test(h.split("?text=")[1] || "");
      }),
      "S2: prefilled text is URL-encoded"
    );
    ok(links.every((a) => a.getAttribute("target") === "_blank"), "S2: links open in a new tab");
    ok(
      links.every((a) => (a.getAttribute("rel") || "").includes("noopener")),
      "S2: links carry a safe rel"
    );
    const message = decodeURIComponent((hrefs[0] || "").split("?text=")[1] || "");
    ok(message.includes("محمد فتحي"), "S2: message contains the student name");
    ok(message.includes("1,250"), "S2: message contains the amount");
    ok(message.includes("InstaPay"), "S2: message contains the payment method");
    ok(message.includes("9876543210"), "S2: message contains the transaction reference");
    ok(message.includes("+20 114 742 2177"), "S2: message contains the sender phone");
    ok(!message.includes("CM-"), "S2: message contains NO CodeMind student code");
    for (const id of ["user-1", "pay-1", "sub-1", "plan-x", "group-x", "course-x"]) {
      ok(!message.includes(id), `S2: message contains no internal id (${id})`);
    }
    ok(
      (r.byTestId("whatsapp-one-number-only")?.textContent || "").includes("رقم واحد فقط"),
      "S2: told to use ONE number only after submission"
    );
    ok(
      (r.text() || "").includes("يدوي"),
      "S2: screenshot attachment is described as manual, never automatic"
    );
    ok(r.qAll('input[type="file"]').length === 0, "S2: no upload input on the submitted state");

    await r.unmount();
  }

  // =========================================================================
  section("S3. Renewal + grandfathered pending copy");
  {
    setShell("ar");
    const renewalResponse = enrollResponse({
      scenario: "RENEWAL",
      entitlement: {
        state: "ACTIVE",
        accessAllowed: true,
        grandfathered: false,
        hasSubscription: true,
        groupName: "مجموعة النخبة المسائية",
        endDate: "2027-03-01T00:00:00.000Z",
        plan: { name: "Gold Plan", nameAr: "الباقة الذهبية" },
      },
    });
    resetNet([...catalogHandlers(PAYMENTS_READ()), { method: "POST", match: (u) => u.includes("/api/enroll"), body: renewalResponse }]);
    const r = await render(React.createElement(EnrollView));
    await walkToPaymentPage(r);
    await r.click(r.qAll("button[aria-pressed]").find((b) => (b.textContent || "").includes("InstaPay")) ?? null);
    await r.type(r.byTestId("sender-phone-input"), "01147422177");
    await r.type(r.byTestId("reference-input"), "RENEW-1234");
    await r.click(r.byTestId("submit-payment-request"));

    ok(r.text().includes("طلب التجديد تحت المراجعة"), "S3: renewal copy shown");
    ok(r.text().includes("اشتراكك الحالي مستمر"), "S3: renewal says the current subscription stays active");
    ok(!!r.byTestId("current-end-date"), "S3: current entitlement end date shown");
    ok(!r.text().includes("محتوى الكورس هيتفتح"), "S3: renewal does not promise new access");
    await r.unmount();

    const gfResponse = enrollResponse({
      scenario: "LEGACY_GRANDFATHERED",
      entitlement: {
        state: "NONE",
        accessAllowed: true,
        grandfathered: true,
        hasSubscription: false,
        groupName: "مجموعة النخبة المسائية",
        endDate: null,
        plan: null,
      },
    });
    resetNet([...catalogHandlers(PAYMENTS_READ()), { method: "POST", match: (u) => u.includes("/api/enroll"), body: gfResponse }]);
    const r2 = await render(React.createElement(EnrollView));
    await walkToPaymentPage(r2);
    await r2.click(r2.qAll("button[aria-pressed]").find((b) => (b.textContent || "").includes("InstaPay")) ?? null);
    await r2.type(r2.byTestId("sender-phone-input"), "01147422177");
    await r2.type(r2.byTestId("reference-input"), "LEGACY-9999");
    await r2.click(r2.byTestId("submit-payment-request"));

    ok((r2.byTestId("pending-title")?.textContent || "").includes("طلب الدفع تحت المراجعة"), "S3: legacy pending headline");
    ok(r2.text().includes("محتوى الكورس الحالي شغال"), "S3: legacy student keeps course access wording");
    ok(!r2.text().toLowerCase().includes("grandfather"), "S3: internal 'grandfathered' term never shown");
    ok(!r2.text().includes("مفيش اشتراك"), "S3: no misleading 'no subscription' message");
    await r2.unmount();
  }

  // =========================================================================
  section("S4. Pending / rejected banners on entry");
  {
    setShell("ar");
    const pendingRow = {
      id: "pay-pending-1",
      status: "PENDING",
      amount: 900,
      method: "ETISALAT_CASH",
      reference: "REF-555",
      senderPhone: "01099942942",
      requestedPlan: { id: "plan-x", name: "Gold Plan", nameAr: "الباقة الذهبية" },
      requestedGroup: { id: "group-x", name: "مجموعة النخبة المسائية", isActive: true },
      createdAt: "2026-09-10T10:00:00.000Z",
      reviewedAt: null,
      rejectionReason: null,
      duplicateReference: false,
    };
    resetNet(catalogHandlers(PAYMENTS_READ({ latestPending: pendingRow })));
    const r = await render(React.createElement(EnrollView));
    ok(!!r.byTestId("existing-pending-banner"), "S4: an existing pending request is announced");
    ok(r.text().includes("e& Cash"), "S4: the pending banner labels the method truthfully");
    await r.unmount();

    resetNet(
      catalogHandlers(
        PAYMENTS_READ({
          latestRejected: {
            ...pendingRow,
            id: "pay-rej-1",
            status: "REJECTED",
            rejectionReason: "المبلغ المحول أقل من المطلوب",
            reviewedAt: "2026-09-11T10:00:00.000Z",
          },
          entitlement: {
            state: "ACTIVE",
            accessAllowed: true,
            grandfathered: false,
            hasSubscription: true,
            groupName: "مجموعة النخبة المسائية",
            endDate: "2027-01-01T00:00:00.000Z",
            plan: { name: "Gold Plan", nameAr: "الباقة الذهبية" },
          },
        })
      )
    );
    const r2 = await render(React.createElement(EnrollView));
    ok(!!r2.byTestId("existing-rejected-banner"), "S4: a rejection is announced");
    ok(
      (r2.byTestId("rejected-reason")?.textContent || "").includes("المبلغ المحول أقل"),
      "S4: the rejection reason is visible"
    );
    ok(!!r2.byTestId("rejected-access-kept"), "S4: a rejected renewal keeps current access wording");
    ok(r2.text().includes("طلب دفع جديد"), "S4: the recovery action is a NEW request");
    await r2.unmount();
  }

  // =========================================================================
  section("S5. Student dashboard payment panel — every state");
  {
    setShell("ar");
    const pendingRow = {
      id: "pay-1",
      amount: 1250,
      method: "INSTAPAY",
      reference: "REF-777",
      senderPhone: "01147422177",
      requestedPlan: { id: "plan-x", name: "Gold Plan", nameAr: "الباقة الذهبية" },
      requestedGroup: { id: "group-x", name: "مجموعة النخبة المسائية", isActive: true },
      createdAt: "2026-09-12T10:00:00.000Z",
    };
    const noop = () => setShell("ar");

    // 5a. NEW student pending
    noop();
    resetNet([{ match: (u) => u.includes("/api/students/me/payments"), body: { payments: [] } }]);
    let r = await render(
      React.createElement(StudentPaymentPanel, {
        subscription: { status: "PENDING", endDate: null, daysToExpiry: 0, planName: "الباقة الذهبية", accessAllowed: false, grandfathered: false, hasSubscription: true },
        pending: pendingRow,
        rejected: null,
        groupName: null,
        courseName: "كورس الاختبار",
        onNewRequest: () => {},
      })
    );
    ok(r.text().includes("طلب الدفع تحت المراجعة"), "S5a: pending headline");
    ok(r.text().includes("محتوى الكورس هيتفتح"), "S5a: new student copy");
    ok(!r.text().includes("تم تأكيد اشتراكك"), "S5a: pending is not styled as confirmed");
    ok(r.byTestIdAll("whatsapp-proof-link").length === 2, "S5a: proof actions available while pending");
    await r.unmount();

    // 5b. ACTIVE renewal pending
    resetNet([{ match: (u) => u.includes("/api/students/me/payments"), body: { payments: [] } }]);
    r = await render(
      React.createElement(StudentPaymentPanel, {
        subscription: { status: "ACTIVE", endDate: "2027-02-01T00:00:00.000Z", daysToExpiry: 140, planName: "الباقة الذهبية", accessAllowed: true, grandfathered: false, hasSubscription: true },
        pending: pendingRow,
        rejected: null,
        groupName: "مجموعة النخبة المسائية",
        courseName: "كورس الاختبار",
        onNewRequest: () => {},
      })
    );
    ok(r.text().includes("تم تأكيد اشتراكك"), "S5b: the ACTIVE entitlement stays the headline");
    ok(r.text().includes("طلب التجديد تحت المراجعة"), "S5b: renewal pending copy");
    ok(!!r.byTestId("panel-pending-end-date"), "S5b: current end date shown");
    await r.unmount();

    // 5c. Grandfathered pending
    resetNet([{ match: (u) => u.includes("/api/students/me/payments"), body: { payments: [] } }]);
    r = await render(
      React.createElement(StudentPaymentPanel, {
        subscription: { status: "NONE", endDate: null, daysToExpiry: 0, planName: null, accessAllowed: true, grandfathered: true, hasSubscription: false },
        pending: pendingRow,
        rejected: null,
        groupName: "مجموعة النخبة المسائية",
        courseName: "كورس الاختبار",
        onNewRequest: () => {},
      })
    );
    ok(r.text().includes("طلب الدفع تحت المراجعة"), "S5c: legacy pending headline");
    ok(r.text().includes("محتوى الكورس الحالي شغال"), "S5c: legacy access wording");
    ok(!r.text().includes("مفيش اشتراك"), "S5c: no 'no subscription' claim");
    ok(!r.text().toLowerCase().includes("grandfather"), "S5c: no internal terminology");
    await r.unmount();

    // 5d. Rejected with an active entitlement
    resetNet([{ match: (u) => u.includes("/api/students/me/payments"), body: { payments: [] } }]);
    let retried = false;
    r = await render(
      React.createElement(StudentPaymentPanel, {
        subscription: { status: "ACTIVE", endDate: "2027-02-01T00:00:00.000Z", daysToExpiry: 140, planName: "الباقة الذهبية", accessAllowed: true, grandfathered: false, hasSubscription: true },
        pending: null,
        rejected: {
          id: "pay-r1",
          amount: 1250,
          method: "INSTAPAY",
          reference: "REF-888",
          senderPhone: "01147422177",
          requestedPlan: null,
          requestedGroup: null,
          createdAt: "2026-09-12T10:00:00.000Z",
          reviewedAt: "2026-09-13T10:00:00.000Z",
          rejectionReason: "رقم العملية غير واضح",
        },
        groupName: "مجموعة النخبة المسائية",
        courseName: "كورس الاختبار",
        onNewRequest: () => {
          retried = true;
        },
      })
    );
    ok(r.text().includes("تم رفض طلب الدفع"), "S5d: rejected headline");
    ok((r.byTestId("panel-rejected-reason")?.textContent || "").includes("رقم العملية غير واضح"), "S5d: reason displayed");
    ok(!!r.byTestId("panel-rejected-access-kept"), "S5d: current entitlement represented separately");
    ok(r.text().includes("تم تأكيد اشتراكك"), "S5d: the active entitlement stays primary");
    await r.click(r.byTestId("panel-retry"));
    ok(retried, "S5d: retry triggers the normal new-request flow");
    await r.unmount();

    // 5e. Approved/active + history
    resetNet([
      {
        match: (u) => u.includes("/api/students/me/payments"),
        body: {
          payments: [
            { id: "h1", status: "APPROVED", amount: 1250, method: "INSTAPAY", reference: "REF-1", senderPhone: "01147422177", requestedPlan: null, requestedGroup: null, createdAt: "2026-09-01T10:00:00.000Z", reviewedAt: "2026-09-02T10:00:00.000Z", rejectionReason: null, duplicateReference: false },
            { id: "h2", status: "PENDING", amount: 900, method: "ETISALAT_CASH", reference: "REF-1", senderPhone: "01099942942", requestedPlan: null, requestedGroup: null, createdAt: "2026-09-12T10:00:00.000Z", reviewedAt: null, rejectionReason: null, duplicateReference: true },
          ],
        },
      },
    ]);
    r = await render(
      React.createElement(StudentPaymentPanel, {
        subscription: { status: "ACTIVE", endDate: "2027-02-01T00:00:00.000Z", daysToExpiry: 140, planName: "الباقة الذهبية", accessAllowed: true, grandfathered: false, hasSubscription: true },
        pending: null,
        rejected: null,
        groupName: "مجموعة النخبة المسائية",
        courseName: "كورس الاختبار",
        onNewRequest: () => {},
      })
    );
    ok(r.text().includes("تم تأكيد اشتراكك"), "S5e: approved state is the headline");
    ok(!r.byTestId("panel-pending"), "S5e: no stale pending banner over an active entitlement");
    await r.click(r.q('[data-testid="panel-history"] button'));
    ok(!!r.byTestId("panel-history-list"), "S5e: history list loads");
    ok(r.qAll('[data-testid="panel-history-list"] > li').length === 2, "S5e: both requests listed");
    ok(r.text().includes("مؤكد") && r.text().includes("تحت المراجعة"), "S5e: statuses labelled");
    ok(r.text().includes("رقم عملية مكرر"), "S5e: duplicate reference warning surfaced");
    ok(!r.text().includes("reviewedBy"), "S5e: no reviewer identity exposed");
    await r.unmount();
  }

  // =========================================================================
  section("A1. Admin review drawer — context, approve, group override");
  {
    setShell("ar");
    useApp.getState().setLocale("ar");
    const paymentRow: any = {
      id: "pay-100",
      userId: "user-9",
      userName: "أحمد محمد",
      userEmail: "ahmed@example.com",
      userPhone: "01000000000",
      userRole: "STUDENT",
      amount: 1250,
      method: "INSTAPAY",
      status: "PENDING",
      reference: "REF-100",
      notes: "Coupon: WELCOME10 (-100 EGP)",
      createdAt: "2026-09-12T10:00:00.000Z",
      subscription: null,
      senderPhone: "01147422177",
      requestedGroupId: "group-x",
      requestedPlanId: "plan-x",
      requestedPlan: { id: "plan-x", name: "Gold Plan", nameAr: "الباقة الذهبية", durationMonths: 3, price: 1250, isActive: true },
      requestedGroup: { id: "group-x", name: "مجموعة النخبة المسائية", isActive: true, capacity: 20, courseId: "course-x", schedule: "Sat & Tue", seatsUsed: 19 },
      reviewedAt: null,
      rejectionReason: null,
      duplicateReference: true,
      isLatestPending: true,
      studentContext: {
        id: "stu-9",
        parentPhone: "01222222222",
        groupId: null,
        groupName: null,
        courseId: null,
        currentPlanName: null,
        subscriptionStatus: "PENDING",
        hasSubscription: true,
        accessAllowed: false,
        grandfathered: false,
        state: "PENDING",
        startDate: null,
        endDate: null,
        daysToExpiry: 0,
      },
    };
    const groupsPayload = {
      groups: [
        { id: "group-x", name: "مجموعة النخبة المسائية", courseId: "course-x", capacity: 20, studentsCount: 20, isActive: true },
        { id: "group-y", name: "مجموعة الصباح", courseId: "course-x", capacity: 20, studentsCount: 5, isActive: true },
        { id: "group-z", name: "كورس تاني", courseId: "course-other", capacity: 20, studentsCount: 1, isActive: true },
      ],
    };

    let outcome: any = null;
    const renderDrawer = (row: any, net: Handler[]) => {
      resetNet(net);
      return render(
        React.createElement(PaymentReviewDrawer, {
          payment: row,
          onClose: () => {},
          onDecided: (o: any) => {
            outcome = o;
          },
        })
      );
    };

    // 1a. Context rendering
    let r = await renderDrawer(paymentRow, [
      { match: (u) => u.includes("/api/admin/groups"), body: groupsPayload },
      { method: "POST", match: (u) => u.includes("/approve"), body: { ok: true } },
    ]);
    const drawerText = r.bodyHtml();
    ok(drawerText.includes("أحمد محمد"), "A1: student name shown");
    ok(drawerText.includes("ahmed@example.com"), "A1: registered email shown");
    ok(drawerText.includes("01147422177"), "A1: sender phone shown");
    ok(drawerText.includes("REF-100"), "A1: reference shown");
    ok(drawerText.includes("الباقة الذهبية"), "A1: requested plan shown");
    ok(drawerText.includes("مجموعة النخبة المسائية"), "A1: requested group shown");
    ok(drawerText.includes("WELCOME10"), "A1: coupon/discount info shown");
    ok(document.querySelector('[data-testid="warning-duplicate"]') !== null, "A1: duplicate-reference warning visible");
    ok((document.querySelector('[data-testid="drawer-entitlement"]')?.textContent || "").includes("مفيش اشتراك مفعّل"), "A1: current entitlement context truthful");
    ok(drawerText.includes("تفعيل جديد بعد الموافقة"), "A1: decision context labelled (new activation)");
    ok(!drawerText.includes("reviewedByUserId"), "A1: no reviewer id exposed");

    // 1b. Approve with NO override → body is {}
    await r.click(document.querySelector('[data-testid="approve-button"]'));
    let posts = callsTo("/api/admin/payments/pay-100/approve", "POST");
    ok(posts.length === 1, "A1: approve called once");
    ok(JSON.stringify(posts[0]?.body) === "{}", "A1: approve sends an empty body when no override is selected");
    ok(outcome?.ok === true && outcome?.action === "approve", "A1: success outcome reported");
    await r.unmount();

    // 1c. Approve WITH override → body is exactly { groupId }
    outcome = null;
    r = await renderDrawer(paymentRow, [
      { match: (u) => u.includes("/api/admin/groups"), body: groupsPayload },
      { method: "POST", match: (u) => u.includes("/approve"), body: { ok: true } },
    ]);
    // vaul/radix Select needs pointer interaction; drive the underlying value
    // through the rendered trigger + options.
    const trigger = document.querySelector("#group-override");
    await r.click(trigger);
    const option = Array.from(document.querySelectorAll('[role="option"]')).find((o) =>
      (o.textContent || "").includes("مجموعة الصباح")
    );
    await r.click(option ?? null);
    await r.click(document.querySelector('[data-testid="approve-button"]'));
    posts = callsTo("/api/admin/payments/pay-100/approve", "POST");
    ok(posts.length === 1, "A1: override approve called once");
    ok(
      JSON.stringify(posts[0]?.body) === JSON.stringify({ groupId: "group-y" }),
      `A1: override body is exactly { groupId } (got ${JSON.stringify(posts[0]?.body)})`
    );
    const sentOptions = Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent || "");
    ok(
      !sentOptions.some((t) => t.includes("كورس تاني")),
      "A1: only groups of the payment's course context are offered"
    );
    await r.unmount();
  }

  // =========================================================================
  section("A2. Admin domain errors + rejection validation");
  {
    setShell("ar");
    const baseRow: any = {
      id: "pay-200",
      userId: "user-9",
      userName: "أحمد محمد",
      userEmail: "ahmed@example.com",
      userPhone: null,
      userRole: "STUDENT",
      amount: 1250,
      method: "ETISALAT_CASH",
      status: "PENDING",
      reference: "REF-200",
      notes: null,
      createdAt: "2026-09-12T10:00:00.000Z",
      subscription: null,
      senderPhone: "01099942942",
      requestedGroupId: null,
      requestedPlanId: "plan-x",
      requestedPlan: { id: "plan-x", name: "Gold Plan", nameAr: "الباقة الذهبية", durationMonths: 3, price: 1250, isActive: true },
      requestedGroup: null,
      reviewedAt: null,
      rejectionReason: null,
      duplicateReference: false,
      isLatestPending: true,
      studentContext: {
        id: "stu-9",
        parentPhone: null,
        groupId: "group-x",
        groupName: "مجموعة النخبة المسائية",
        courseId: "course-x",
        currentPlanName: "الباقة الذهبية",
        subscriptionStatus: "ACTIVE",
        hasSubscription: true,
        accessAllowed: true,
        grandfathered: false,
        state: "ACTIVE",
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2027-01-01T00:00:00.000Z",
        daysToExpiry: 100,
      },
    };
    const groupsPayload = {
      groups: [{ id: "group-y", name: "مجموعة الصباح", courseId: "course-x", capacity: 20, studentsCount: 5, isActive: true }],
    };
    let outcome: any = null;
    const renderDrawer = (net: Handler[]) => {
      resetNet(net);
      return render(
        React.createElement(PaymentReviewDrawer, {
          payment: baseRow,
          onClose: () => {},
          onDecided: (o: any) => {
            outcome = o;
          },
        })
      );
    };
    const errBody = (code: string, message: string) => ({
      method: "POST",
      match: (u: string) => u.includes("/approve"),
      status: 409,
      body: { error: message, code },
    });

    // GROUP_REQUIRED → recovery copy + stays pending
    outcome = null;
    let r = await renderDrawer([
      { match: (u) => u.includes("/api/admin/groups"), body: groupsPayload },
      errBody("GROUP_REQUIRED", "raw sql should never show"),
    ]);
    await r.click(document.querySelector('[data-testid="approve-button"]'));
    let err = document.querySelector('[data-testid="decision-error"]');
    ok(!!err, "A2: GROUP_REQUIRED renders an inline error");
    ok(err?.getAttribute("data-code") === "GROUP_REQUIRED", "A2: the domain code is exposed for tests/telemetry only");
    ok((err?.textContent || "").includes("اختار جروب"), "A2: GROUP_REQUIRED offers group recovery");
    ok((err?.textContent || "").includes("لسه تحت المراجعة"), "A2: the payment visibly stays PENDING");
    ok(!(err?.textContent || "").includes("raw sql"), "A2: no raw database error rendered");
    ok(outcome?.ok === false && outcome?.refresh === false, "A2: GROUP_REQUIRED is not a queue-refresh code");
    ok(!!document.querySelector("#group-override"), "A2: the group override control is available for recovery");
    await r.unmount();

    // GROUP_FULL
    outcome = null;
    r = await renderDrawer([
      { match: (u) => u.includes("/api/admin/groups"), body: groupsPayload },
      errBody("GROUP_FULL", "full"),
    ]);
    await r.click(document.querySelector('[data-testid="approve-button"]'));
    err = document.querySelector('[data-testid="decision-error"]');
    ok((err?.textContent || "").includes("مكتمل"), "A2: GROUP_FULL message shown");
    ok((err?.textContent || "").includes("لسه تحت المراجعة"), "A2: GROUP_FULL keeps the payment pending");
    ok(outcome?.ok === false, "A2: GROUP_FULL is not a success");
    await r.unmount();

    // STALE_PAYMENT → refresh requested
    outcome = null;
    r = await renderDrawer([
      { match: (u) => u.includes("/api/admin/groups"), body: groupsPayload },
      errBody("STALE_PAYMENT", "stale"),
    ]);
    await r.click(document.querySelector('[data-testid="approve-button"]'));
    err = document.querySelector('[data-testid="decision-error"]');
    ok((err?.textContent || "").includes("أحدث"), "A2: STALE_PAYMENT warns about the newer request");
    ok(outcome?.ok === false && outcome?.refresh === true, "A2: STALE_PAYMENT asks the queue to refresh");
    await r.unmount();

    // INVALID_TRANSITION → conflict + refresh
    outcome = null;
    r = await renderDrawer([
      { match: (u) => u.includes("/api/admin/groups"), body: groupsPayload },
      errBody("INVALID_TRANSITION", "already decided"),
    ]);
    await r.click(document.querySelector('[data-testid="approve-button"]'));
    err = document.querySelector('[data-testid="decision-error"]');
    ok((err?.textContent || "").includes("اتراجع عليه بالفعل"), "A2: INVALID_TRANSITION conflict message");
    ok(outcome?.ok === false && outcome?.refresh === true, "A2: INVALID_TRANSITION asks the queue to refresh");
    await r.unmount();

    // PLAN_REQUIRED → no plan override offered, stays pending
    outcome = null;
    r = await renderDrawer([
      { match: (u) => u.includes("/api/admin/groups"), body: groupsPayload },
      errBody("PLAN_REQUIRED", "no plan"),
    ]);
    await r.click(document.querySelector('[data-testid="approve-button"]'));
    err = document.querySelector('[data-testid="decision-error"]');
    ok((err?.textContent || "").includes("باقة"), "A2: PLAN_REQUIRED explained");
    ok((err?.textContent || "").includes("لسه تحت المراجعة"), "A2: PLAN_REQUIRED keeps it pending");
    ok(!document.body.innerHTML.includes("planId"), "A2: no client-side plan override contract exists");
    await r.unmount();

    // Rejection validation
    outcome = null;
    resetNet([
      { match: (u) => u.includes("/api/admin/groups"), body: groupsPayload },
      { method: "POST", match: (u) => u.includes("/reject"), body: { ok: true } },
    ]);
    r = await render(
      React.createElement(PaymentReviewDrawer, {
        payment: baseRow,
        onClose: () => {},
        onDecided: (o: any) => {
          outcome = o;
        },
      })
    );
    await r.click(document.querySelector('[data-testid="reject-button"]'));
    ok(!!document.querySelector('[data-testid="reject-panel"]'), "A2: rejection panel opens");
    await r.click(document.querySelector('[data-testid="reject-confirm-button"]'));
    ok(callsTo("/api/admin/payments/pay-200/reject", "POST").length === 0, "A2: an empty reason posts nothing");
    ok(!!document.querySelector('[data-testid="reject-reason-error"]'), "A2: empty reason blocked with a message");

    const reasonInput = document.querySelector('[data-testid="reject-reason-input"]');
    await r.type(reasonInput, "   ");
    await r.click(document.querySelector('[data-testid="reject-confirm-button"]'));
    ok(callsTo("/api/admin/payments/pay-200/reject", "POST").length === 0, "A2: a whitespace reason posts nothing");

    await r.type(reasonInput, "x".repeat(501));
    ok(
      (document.querySelector('[data-testid="reject-reason-count"]')?.textContent || "").startsWith("501"),
      "A2: the character count is visible"
    );
    await r.click(document.querySelector('[data-testid="reject-confirm-button"]'));
    ok(callsTo("/api/admin/payments/pay-200/reject", "POST").length === 0, "A2: an over-long reason posts nothing");
    ok(!!document.querySelector('[data-testid="reject-reason-error"]'), "A2: over-long reason blocked");

    await r.type(reasonInput, "المبلغ المحول أقل من المطلوب");
    await r.click(document.querySelector('[data-testid="reject-confirm-button"]'));
    const rejects = callsTo("/api/admin/payments/pay-200/reject", "POST");
    ok(rejects.length === 1, "A2: a valid reason posts once");
    ok(
      JSON.stringify(rejects[0]?.body) === JSON.stringify({ reason: "المبلغ المحول أقل من المطلوب" }),
      "A2: the reject body is exactly { reason }"
    );
    ok(outcome?.ok === true && outcome?.action === "reject", "A2: rejection success reported");
    await r.unmount();

    // Already-decided row → no decision controls at all
    resetNet([{ match: (u) => u.includes("/api/admin/groups"), body: groupsPayload }]);
    r = await render(
      React.createElement(PaymentReviewDrawer, {
        payment: { ...baseRow, status: "APPROVED", reviewedAt: "2026-09-13T10:00:00.000Z", rejectionReason: null },
        onClose: () => {},
        onDecided: () => {},
      })
    );
    ok(!!document.querySelector('[data-testid="already-decided"]'), "A2: a decided row shows no decision controls");
    ok(!document.querySelector('[data-testid="approve-button"]'), "A2: no approve button on a decided row");
    await r.unmount();
  }

  // =========================================================================
  section("A3. Pure presentation module (payment-ux)");
  {
    ok(UX.paymentMethodLabel("INSTAPAY") === "InstaPay", "A3: INSTAPAY → InstaPay");
    ok(UX.paymentMethodLabel("ETISALAT_CASH") === "e& Cash", "A3: ETISALAT_CASH → e& Cash");
    ok(UX.paymentMethodLabel("VODAFONE_CASH") === "Vodafone Cash", "A3: VODAFONE_CASH label");
    ok(UX.paymentMethodLabel("SOME_LEGACY_METHOD") === "Some Legacy Method", "A3: unknown enum gets a readable fallback");
    ok(UX.paymentMethodLabel("ETISALAT_CASH") !== UX.paymentMethodLabel("ETISALAT CASH"), "A3: raw enum strings are never shown as-is");
    ok(UX.isLaunchPaymentMethod("instapay") && UX.isLaunchPaymentMethod("ETISALAT_CASH"), "A3: launch methods recognized (case-insensitive)");
    ok(!UX.isLaunchPaymentMethod("VODAFONE_CASH"), "A3: Vodafone Cash is not a launch method");

    // Destinations are read per method from configuration.
    ok(UX.paymentDestinationFor("INSTAPAY") === "+20 1147422177", "A3: InstaPay destination from config");
    ok(UX.paymentDestinationFor("ETISALAT_CASH") === "+20 1147422177", "A3: e& Cash destination from config (documented single-line launch config)");
    ok(UX.paymentDestinationFor("VODAFONE_CASH") === null, "A3: an unconfigured method yields no destination (never borrowed)");
    ok(UX.paymentDestinationFor("UNKNOWN") === null, "A3: unknown method yields no destination");

    // Availability = launch method AND a non-empty configured destination.
    ok(UX.paymentMethodAvailable("INSTAPAY") === true, "A3: InstaPay available (launch method + destination)");
    ok(UX.paymentMethodAvailable("instapay") === true, "A3: availability is case-insensitive");
    ok(UX.paymentMethodAvailable("ETISALAT_CASH") === true, "A3: e& Cash available (launch method + destination)");
    ok(UX.paymentMethodAvailable("VODAFONE_CASH") === false, "A3: Vodafone Cash unavailable (not a launch method, no destination)");
    ok(UX.paymentMethodAvailable("UNKNOWN") === false, "A3: an unknown method is never available");
    ok(UX.paymentMethodAvailable(null) === false && UX.paymentMethodAvailable("") === false, "A3: no method ⇒ not available");

    ok(UX.normalizeEgyptianWhatsappNumber("01147422177") === "201147422177", "A3: local form normalized");
    ok(UX.normalizeEgyptianWhatsappNumber("+20 114-742-2177") === "201147422177", "A3: +20 form normalized");
    ok(UX.normalizeEgyptianWhatsappNumber("12345") === null, "A3: a non-Egyptian number is rejected");
    const href = UX.whatsappProofHref("01099942942", "السلام عليكم a b");
    ok(!!href && href.startsWith("https://wa.me/201099942942?text="), "A3: wa.me link shape");
    ok(!!href && href.includes("%D8%A7%D9%84%D8%B3%D9%84%D8%A7%D9%85"), "A3: arabic text URL-encoded");
    ok(!!href && !/\s/.test(href), "A3: no raw whitespace in the href");
    ok(UX.whatsappProofHref("bad", "x") === null, "A3: an invalid number yields no link");

    ok(
      JSON.stringify([...UX.PAYMENT_PROOF_WHATSAPP_NUMBERS]) ===
        JSON.stringify(["01147422177", "01099942942"]),
      "A3: exactly the two approved WhatsApp numbers"
    );

    const t = (key: string, params?: Record<string, unknown>) =>
      I18N.translate("ar", key, params);
    const msg = UX.buildPaymentProofMessage(
      { studentName: "محمد فتحي", amount: 1250, method: "INSTAPAY", reference: "REF-1", senderPhone: "01147422177" },
      t
    );
    ok(msg.includes("محمد فتحي") && msg.includes("1,250") && msg.includes("InstaPay"), "A3: message carries name/amount/method");
    ok(msg.includes("REF-1") && msg.includes("01147422177"), "A3: message carries reference + sender phone");
    ok(!msg.includes("CM-"), "A3: message has no student code");
    ok(UX.paymentDecisionErrorKey("GROUP_FULL") === "pay.errorGroupFull", "A3: domain code → i18n key");
    ok(UX.paymentDecisionErrorKey("SOMETHING_NEW") === "pay.errorGeneric", "A3: unknown code → generic copy");
    ok(UX.paymentDecisionErrorKey(undefined) === "pay.errorGeneric", "A3: missing code → generic copy");
    ok(UX.PAYMENT_DECISION_REFRESH_CODES.includes("STALE_PAYMENT"), "A3: STALE_PAYMENT is a refresh code");
    ok(UX.PAYMENT_DECISION_GROUP_RECOVERY_CODES.includes("GROUP_REQUIRED"), "A3: GROUP_REQUIRED is a group-recovery code");
    ok(UX.normalizeRejectionReasonForUi("  a   b  ") === "a b", "A3: reason normalized like the server");
    ok(UX.normalizeRejectionReasonForUi("   ") === null, "A3: blank reason rejected");
    ok(UX.normalizeRejectionReasonForUi("x".repeat(501)) === null, "A3: over-500 reason rejected");
    ok(UX.normalizeRejectionReasonForUi("x".repeat(500)) !== null, "A3: exactly 500 accepted");
    ok(UX.REJECTION_REASON_MAX_LENGTH === 500, "A3: 500-char cap");
  }

  console.log(
    `\nHARNESS_JSON ${JSON.stringify({ pass, fail, failures: failures.slice(0, 25) })}`
  );
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("HARNESS_ERROR", e);
  console.log(`HARNESS_JSON ${JSON.stringify({ pass, fail: fail + 1, failures: [String(e)] })}`);
  process.exitCode = 1;
});
