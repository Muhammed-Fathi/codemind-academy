// CodeMind Academy — Admin media upload UX verification (browser substitute).
//
// WHAT THIS IS
//   The upload-progress phase asks for a VISUAL contract: real byte progress,
//   five distinguishable states, Arabic wording, disabled controls while busy,
//   one upload per click, a recoverable failure. This sandbox has no Chromium
//   binary (the Playwright CDN is unreachable — the same egress restriction
//   recorded for Phase 16), so this script is the strongest available
//   substitute, following scripts/verify-phase16-render.mts: it renders the
//   REAL shipped components in a REAL DOM (jsdom), drives them with a fake
//   XMLHttpRequest that emits real progress samples, and asserts the contract
//   end to end for BOTH media types (session video + session PDF).
//
//   Nothing here touches the network, a database, a bucket or a credential:
//   fetch and XHR are both scripted in-process.
//
// WHAT THIS IS NOT
//   It is not layout geometry (jsdom has no layout engine): bar width in
//   pixels, RTL overlap and hit targets still need a real browser. The
//   operator-facing description of the same flow lives in
//   docs/SESSION_MEDIA_PUBLISHING_GUIDE_AR.md.
//
// Run:  npx tsx scripts/verify-media-upload-ux.mts

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
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.MouseEvent = dom.window.MouseEvent;
g.File = dom.window.File;
g.FormData = dom.window.FormData;
g.ProgressEvent = dom.window.ProgressEvent;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.window.matchMedia =
  g.window.matchMedia ||
  (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
(dom.window.Element.prototype as unknown as Record<string, unknown>).scrollIntoView = () => {};
g.requestAnimationFrame = (cb: (...a: unknown[]) => void) => setTimeout(() => cb(), 0) as unknown as number;
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
// Radix/framer-motion reach for DOM constructors by their GLOBAL name
// (HTMLFormElement, DOMRect, PointerEvent, …). Copy every jsdom global that
// Node does not already provide — Node's own (fetch, File, FormData) win.
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in globalThis) continue;
  try {
    const desc = Object.getOwnPropertyDescriptor(dom.window, key);
    if (!desc) continue;
    if ("value" in desc) g[key] = desc.value;
    else Object.defineProperty(g, key, desc);
  } catch {
    // A non-configurable jsdom accessor: nothing in this flow needs it.
  }
}

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
function section(t: string) {
  console.log(`\n${t}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Scripted network: fetch (the two app legs) + XHR (the presigned PUT)
// ---------------------------------------------------------------------------

type NetLog = { url: string; method: string; body: unknown }[];

function installFetch(opts: {
  initStatus?: number;
  initBody?: unknown;
  completeStatus?: number;
  completeBody?: unknown;
  log: NetLog;
}) {
  const initStatus = opts.initStatus ?? 200;
  const completeStatus = opts.completeStatus ?? 200;
  g.fetch = (async (url: unknown, init?: { method?: string; body?: unknown }) => {
    const u = String(url);
    opts.log.push({ url: u, method: (init && init.method) || "GET", body: init && init.body });
    let status = 200;
    let body: unknown = {};
    if (u.endsWith("/media-uploads/init")) {
      status = initStatus;
      body = opts.initBody ?? { error: "no grant configured", code: null };
    } else if (u.endsWith("/media-uploads/complete")) {
      status = completeStatus;
      body = opts.completeBody ?? {};
    } else if (u.endsWith("/materials")) {
      status = 200;
      body = { materials: [] };
    } else if (u.includes("/api/admin/batches")) {
      status = 200;
      body = {
        batches: [
          {
            id: "b1", name: "Arabic School", nameAr: "المدرسة العربية", schoolType: "ARABIC",
            course: { id: "c1", name: "Math", nameAr: "رياضيات" }, isActive: true, members: 3, videos: 0,
          },
        ],
        eligible: { ARABIC: 3, LANGUAGE: 0 },
      };
    } else if (u.includes("/api/admin/session-videos")) {
      status = 200;
      body = { videos: [] };
    }
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }) as typeof fetch;
}

/**
 * A fake XMLHttpRequest that reports REAL byte counters, exactly like the
 * browser does. `holdMs` keeps the transfer in flight long enough for the test
 * to observe an intermediate percentage.
 */
function installFakeXHR(opts: {
  samples: number[];
  total: number;
  status?: number;
  holdMs?: number;
  log: { instances: unknown[] };
}) {
  const status = opts.status ?? 200;
  class FakeXHR {
    upload: Record<string, unknown> = {};
    headers: Record<string, string> = {};
    status = 0;
    method = "";
    url = "";
    body: unknown = null;
    aborted = false;
    withCredentials = false;
    onprogress: ((e: unknown) => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onloadend: (() => void) | null = null;
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(k: string, v: string) {
      this.headers[k] = v;
    }
    abort() {
      this.aborted = true;
      this.status = 0;
      if (this.onabort) this.onabort();
      if (this.onloadend) this.onloadend();
    }
    send(body: unknown) {
      this.body = body;
      opts.log.instances.push(this);
      const emit = (loaded: number) => {
        if (this.upload.onprogress) {
          (this.upload.onprogress as (e: unknown) => void)({
            lengthComputable: true,
            loaded,
            total: opts.total,
          });
        }
      };
      // Synchronously emit every sample except the last, then finish after the
      // hold so an intermediate state is observable from the test.
      for (const s of opts.samples.slice(0, -1)) emit(s);
      setTimeout(() => {
        emit(opts.samples[opts.samples.length - 1]);
        this.status = status;
        if (status === 0) {
          if (this.onerror) this.onerror();
        }
        if (this.onloadend) this.onloadend();
      }, opts.holdMs ?? 0);
    }
  }
  g.XMLHttpRequest = FakeXHR;
  g.window.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
}

async function main() {
  const React = await import("react");
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useApp } = await import("@/lib/store");
  const { UploadProgressPanel } = await import("@/components/admin/upload-progress-panel");
  const { SessionPdfManager } = await import("@/components/admin/session-pdf-manager");
  const { SessionVideosView } = await import("@/components/admin/session-videos-view");
  const UP = await import("@/lib/upload-progress");

  async function render(el: React.ReactElement) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(el);
      await sleep(60);
    });
    return {
      host,
      get html() {
        return host.innerHTML;
      },
      get text() {
        return host.textContent || "";
      },
      step: async (ms = 60) => {
        await act(async () => {
          await sleep(ms);
        });
      },
      unmount: async () => {
        await act(async () => {
          root.unmount();
        });
        host.remove();
      },
    };
  }

  function setLocale(locale: "ar" | "en") {
    useApp.getState().setLocale(locale);
  }

  /** Build a state snapshot for the panel without running a real upload. */
  function snapshot(phase: string, opts: { loaded?: number; total?: number; failure?: unknown } = {}) {
    let s = UP.initialUploadState();
    s = UP.reduceUploadState(s, { type: "start", fileName: "lesson.mp4", totalBytes: opts.total ?? 20 * MB });
    if (phase === "preparing") return s;
    s = UP.reduceUploadState(s, { type: "stage", stage: "transfer" });
    if (typeof opts.loaded === "number") {
      s = UP.reduceUploadState(s, { type: "progress", loadedBytes: opts.loaded, totalBytes: opts.total ?? 20 * MB });
    }
    if (phase === "uploading") return s;
    if (phase === "buffered") return UP.reduceUploadState(s, { type: "buffered", totalBytes: opts.total ?? 20 * MB });
    s = UP.reduceUploadState(s, { type: "stage", stage: "complete" });
    if (phase === "confirming") return s;
    if (phase === "failed") return UP.reduceUploadState(s, { type: "failed", failure: opts.failure ?? null });
    return UP.reduceUploadState(s, { type: "succeeded" });
  }

  // =========================================================================
  section("A. The panel renders every state, in Arabic and in English");
  // =========================================================================
  {
    setLocale("ar");
    const cases: [string, unknown, string[]][] = [
      ["preparing", snapshot("preparing", { total: 20 * MB }), ["جارٍ تجهيز الرفع", "lesson.mp4"]],
      ["uploading 41%", snapshot("uploading", { loaded: Math.round(8.2 * MB), total: 20 * MB }), ["جارٍ رفع الملف", "8.2 MB / 20.0 MB", "41%"]],
      ["confirming", snapshot("confirming", { loaded: 20 * MB, total: 20 * MB }), ["تم رفع الملف، جارٍ تأكيد الحفظ", "100%"]],
      ["succeeded", snapshot("succeeded", { loaded: 20 * MB, total: 20 * MB }), ["تم رفع الملف بنجاح"]],
      ["buffered (no byte counter)", snapshot("buffered", { total: 20 * MB }), ["جارٍ رفع الملف", "نسبة التقدم بالبايت مش متاحة"]],
    ];
    for (const [label, state, expected] of cases) {
      const r = await render(React.createElement(UploadProgressPanel, { state }));
      for (const needle of expected) {
        ok(r.text.includes(needle), `AR ${label}: renders "${needle}"`);
      }
      ok(!/\b(admin|api|course|student)\.\d+\b/.test(r.text), `AR ${label}: no raw dictionary key reaches the UI`);
      await r.unmount();
    }

    // A failure renders the stage-specific message and offers a retry.
    const { resolveUploadFailure } = await import("@/lib/upload-error-text");
    const failureCases: [string, unknown, string][] = [
      ["init", resolveUploadFailure({ stage: "init", status: 415, code: "INVALID_CONTENT_TYPE" }), "نوع الملف مش مدعوم"],
      ["transfer", resolveUploadFailure({ stage: "transfer", status: 403, code: null }), "فشل رفع الملف للتخزين"],
      ["complete", resolveUploadFailure({ stage: "complete", status: 500, code: "DB_CREATE_FAILED" }), "خدمة التخزين مش متاحة"],
      ["network", resolveUploadFailure({ stage: "transfer", status: 0, code: null }), "تعذّر الاتصال بخدمة الرفع"],
      ["pdf magic", resolveUploadFailure({ stage: "complete", status: 415, code: "MAGIC_REJECTED" }), "مش PDF صالح"],
    ];
    for (const [label, failure, needle] of failureCases) {
      const r = await render(
        React.createElement(UploadProgressPanel, { state: snapshot("failed", { failure, total: 20 * MB }), onRetry: () => {} })
      );
      ok(r.text.includes("فشل الرفع"), `AR failure/${label}: the panel says the upload failed`);
      ok(r.text.includes(needle), `AR failure/${label}: renders "${needle}"`);
      ok(r.text.includes("حاول تاني"), `AR failure/${label}: offers a retry`);
      await r.unmount();
    }

    // Idle renders nothing at all.
    const idle = await render(React.createElement(UploadProgressPanel, { state: UP.initialUploadState() }));
    ok(idle.html.trim() === "", "idle renders nothing (no empty panel left behind)");
    await idle.unmount();

    // English locale: the same states resolve, no Arabic leaks, no empty text.
    setLocale("en");
    const en = await render(
      React.createElement(UploadProgressPanel, { state: snapshot("uploading", { loaded: Math.round(8.2 * MB), total: 20 * MB }) })
    );
    ok(en.text.includes("Uploading file"), "EN uploading: renders the English phase label");
    ok(en.text.includes("8.2 MB / 20.0 MB"), "EN uploading: renders the same real byte counts");
    ok(en.text.includes("41%"), "EN uploading: renders the same real percentage");
    ok(!/[\u0600-\u06FF]/.test(en.text), "EN uploading: no Arabic text leaks into the English locale");
    await en.unmount();
    const enOk = await render(React.createElement(UploadProgressPanel, { state: snapshot("succeeded", { total: 20 * MB }) }));
    ok(enOk.text.includes("File uploaded successfully"), "EN succeeded: renders the English success text");
    await enOk.unmount();
    setLocale("ar");
  }

  // =========================================================================
  section("B. PDF surface — real progress, disabled controls, success only after confirming");
  // =========================================================================
  {
    setLocale("ar");
    const log: NetLog = [];
    const xhrLog = { instances: [] as unknown[] };
    installFetch({
      initBody: {
        uploadUrl: "https://bucket.account.r2.invalid/session-pdfs/x-1.pdf?X-Amz-Signature=deadbeef",
        method: "PUT",
        token: "payload.mac",
        contentType: "application/pdf",
        maxBytes: 25 * MB,
        expiresInSec: 600,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        purpose: "LESSON_PDF",
      },
      completeBody: { purpose: "LESSON_PDF", mediaAssetId: "ma_1", pdfUrlWritten: false },
      log,
    });
    installFakeXHR({ samples: [0, Math.round(8.2 * MB), 20 * MB], total: 20 * MB, holdMs: 120, log: xhrLog });

    let changed = 0;
    const r = await render(
      React.createElement(SessionPdfManager, {
        lessonId: "l1",
        lessonTrackScope: "ARABIC",
        materials: [],
        onChanged: () => {
          changed++;
        },
      })
    );

    const fileInput = r.host.querySelector("#pdf-file") as HTMLInputElement | null;
    ok(!!fileInput, "PDF: the file picker is rendered");
    const uploadButton = [...r.host.querySelectorAll("button")].find((b) => (b.textContent || "").includes("ارفع PDF")) as HTMLButtonElement | undefined;
    ok(!!uploadButton, "PDF: the upload button is rendered");
    ok(uploadButton!.disabled === true, "PDF: the upload button starts disabled (no file chosen)");

    // Choose a 20 MB PDF.
    const file = new dom.window.File([new Uint8Array(64)], "notes.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "size", { value: 20 * MB });
    Object.defineProperty(fileInput!, "files", { value: [file], configurable: true });
    await act(async () => {
      fileInput!.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await sleep(30);
    });
    ok(uploadButton!.disabled === false, "PDF: the upload button enables once a file is chosen");

    // Click, then observe the intermediate state while the PUT is in flight.
    await act(async () => {
      uploadButton!.click();
      await sleep(30);
    });
    ok(r.text.includes("جارٍ تجهيز الرفع") || r.text.includes("جارٍ رفع الملف"), "PDF: a busy phase is visible immediately after the click");
    ok(uploadButton!.disabled === true, "PDF: the button is disabled while the upload is in flight");
    ok((r.host.querySelector("#pdf-file") as HTMLInputElement).disabled === true, "PDF: the file picker is locked while uploading");
    ok(!!r.host.querySelector("[role='status']"), "PDF: the phase is announced to assistive tech");

    await r.step(60);
    ok(r.text.includes("جارٍ رفع الملف"), "PDF: the uploading phase is shown while bytes move");
    ok(r.text.includes("8.2 MB / 20.0 MB"), "PDF: the panel shows the REAL bytes uploaded");
    ok(r.text.includes("41%"), "PDF: the panel shows the REAL percentage (41%, not a timer)");
    ok(changed === 0, "PDF: nothing is reported as saved before the complete leg answers");
    ok(!r.text.includes("تم رفع الملف بنجاح"), "PDF: success is NOT claimed during the transfer");

    // Let the PUT finish → confirming → success.
    await r.step(300);
    ok(r.text.includes("تم رفع الملف بنجاح"), "PDF: success appears only after the complete leg succeeded");
    ok(changed === 1, "PDF: the detail screen is refreshed exactly once, after confirmation");
    const puts = xhrLog.instances as { method: string; url: string; headers: Record<string, string>; withCredentials: boolean }[];
    ok(puts.length === 1, "PDF: exactly one presigned PUT was issued");
    ok(puts[0].method === "PUT" && puts[0].url.includes("X-Amz-Signature"), "PDF: the PUT used the granted URL and method");
    ok(puts[0].headers["Content-Type"] === "application/pdf", "PDF: the granted Content-Type was sent");
    ok(puts[0].withCredentials === false, "PDF: the PUT carried no credential to the storage origin");
    ok(!r.html.includes("X-Amz-Signature"), "PDF: the presigned URL is never rendered into the DOM");

    // The success state clears itself, leaving no stale panel behind.
    await r.step(2100);
    ok(!r.text.includes("تم رفع الملف بنجاح"), "PDF: the success panel clears itself");
    ok((r.host.querySelector("#pdf-file") as HTMLInputElement).disabled === false, "PDF: the form is usable again after success");
    await r.unmount();
  }

  // =========================================================================
  section("C. PDF surface — a failed confirmation is recoverable and never claims success");
  // =========================================================================
  {
    const log: NetLog = [];
    const xhrLog = { instances: [] as unknown[] };
    installFetch({
      initBody: {
        uploadUrl: "https://bucket.account.r2.invalid/session-pdfs/x-2.pdf?X-Amz-Signature=deadbeef",
        method: "PUT", token: "payload.mac", contentType: "application/pdf",
        maxBytes: 25 * MB, expiresInSec: 600, expiresAt: new Date(Date.now() + 600000).toISOString(), purpose: "LESSON_PDF",
      },
      completeStatus: 500,
      completeBody: { error: "could not connect to server", code: "DB_CREATE_FAILED" },
      log,
    });
    installFakeXHR({ samples: [0, 20 * MB], total: 20 * MB, holdMs: 20, log: xhrLog });

    let changed = 0;
    const r = await render(
      React.createElement(SessionPdfManager, {
        lessonId: "l1", lessonTrackScope: "ARABIC", materials: [], onChanged: () => { changed++; },
      })
    );
    const fileInput = r.host.querySelector("#pdf-file") as HTMLInputElement;
    const file = new dom.window.File([new Uint8Array(64)], "notes.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "size", { value: 20 * MB });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    await act(async () => {
      fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await sleep(20);
    });
    const uploadButton = [...r.host.querySelectorAll("button")].find((b) => (b.textContent || "").includes("ارفع PDF")) as HTMLButtonElement;
    await act(async () => {
      uploadButton.click();
      await sleep(200);
    });
    ok(r.text.includes("فشل الرفع"), "PDF failure: the panel says the upload failed");
    ok(r.text.includes("خدمة التخزين مش متاحة"), "PDF failure: the specific infrastructure reason is shown");
    ok(!r.text.includes("تم رفع الملف بنجاح"), "PDF failure: success is never claimed");
    ok(changed === 0, "PDF failure: the screen is not refreshed as if something was saved");
    ok(r.text.includes("20.0 MB"), "PDF failure: the panel still shows how far the bytes got");
    const retry = [...r.host.querySelectorAll("button")].find((b) => (b.textContent || "").includes("حاول تاني")) as HTMLButtonElement | undefined;
    ok(!!retry, "PDF failure: a retry affordance is rendered");
    ok(uploadButton.disabled === false, "PDF failure: the form is recoverable (the button is enabled again)");
    ok((r.host.querySelector("#pdf-file") as HTMLInputElement).disabled === false, "PDF failure: another file can be chosen");

    // Choosing another file clears the failure panel.
    const file2 = new dom.window.File([new Uint8Array(64)], "other.pdf", { type: "application/pdf" });
    Object.defineProperty(file2, "size", { value: 2 * MB });
    const input2 = r.host.querySelector("#pdf-file") as HTMLInputElement;
    Object.defineProperty(input2, "files", { value: [file2], configurable: true });
    await act(async () => {
      input2.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await sleep(30);
    });
    ok(!r.text.includes("فشل الرفع"), "PDF failure: picking another file clears the failed panel");
    await r.unmount();
  }

  // =========================================================================
  section("D. Duplicate clicks — one click, one upload (two clicks, still one)");
  // =========================================================================
  {
    const log: NetLog = [];
    const xhrLog = { instances: [] as unknown[] };
    installFetch({
      initBody: {
        uploadUrl: "https://bucket.account.r2.invalid/session-pdfs/x-3.pdf?X-Amz-Signature=deadbeef",
        method: "PUT", token: "payload.mac", contentType: "application/pdf",
        maxBytes: 25 * MB, expiresInSec: 600, expiresAt: new Date(Date.now() + 600000).toISOString(), purpose: "LESSON_PDF",
      },
      completeBody: { purpose: "LESSON_PDF", mediaAssetId: "ma_3" },
      log,
    });
    installFakeXHR({ samples: [0, 20 * MB], total: 20 * MB, holdMs: 200, log: xhrLog });

    const r = await render(
      React.createElement(SessionPdfManager, { lessonId: "l1", lessonTrackScope: "ARABIC", materials: [], onChanged: () => {} })
    );
    const fileInput = r.host.querySelector("#pdf-file") as HTMLInputElement;
    const file = new dom.window.File([new Uint8Array(64)], "notes.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "size", { value: 20 * MB });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    await act(async () => {
      fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await sleep(20);
    });
    const uploadButton = [...r.host.querySelectorAll("button")].find((b) => (b.textContent || "").includes("ارفع PDF")) as HTMLButtonElement;
    // Two clicks in the SAME tick: React has not re-rendered yet, so only a
    // synchronous latch can prevent a second init/PUT/complete cycle.
    await act(async () => {
      uploadButton.click();
      uploadButton.click();
      await sleep(40);
    });
    const inits = log.filter((c) => c.url.endsWith("/media-uploads/init"));
    ok(inits.length === 1, `two rapid clicks issue exactly ONE init (got ${inits.length})`);
    ok(xhrLog.instances.length === 1, `two rapid clicks issue exactly ONE PUT (got ${xhrLog.instances.length})`);
    await r.step(400);
    const completes = log.filter((c) => c.url.endsWith("/media-uploads/complete"));
    ok(completes.length === 1, `two rapid clicks issue exactly ONE complete (got ${completes.length})`);
    await r.unmount();
  }

  // =========================================================================
  section("E. VIDEO surface — the same states, the same real progress");
  // =========================================================================
  {
    const log: NetLog = [];
    const xhrLog = { instances: [] as unknown[] };
    installFetch({
      initBody: {
        uploadUrl: "https://bucket.account.r2.invalid/session-videos/x-9.mp4?X-Amz-Signature=deadbeef",
        method: "PUT", token: "payload.mac", contentType: "video/mp4",
        maxBytes: 512 * MB, expiresInSec: 600, expiresAt: new Date(Date.now() + 600000).toISOString(), purpose: "SESSION_VIDEO",
      },
      completeBody: { purpose: "SESSION_VIDEO", mediaAssetId: "ma_9", video: { id: "v1" } },
      log,
    });
    installFakeXHR({ samples: [0, Math.round(32.4 * MB), 80 * MB], total: 80 * MB, holdMs: 150, log: xhrLog });

    const r = await render(React.createElement(SessionVideosView, {}));
    await r.step(120);
    ok(r.text.includes("فيديوهات الجلسات") || r.text.length > 0, "video: the surface rendered");

    // Switch to the upload method.
    const uploadTab = [...r.host.querySelectorAll("button")].find((b) => (b.textContent || "").includes("رفع ملف")) as HTMLButtonElement | undefined;
    ok(!!uploadTab, "video: the upload method toggle exists");
    await act(async () => {
      uploadTab!.click();
      await sleep(40);
    });
    const fileInput = r.host.querySelector("#sv-file") as HTMLInputElement | null;
    ok(!!fileInput, "video: the file picker is rendered for the UPLOAD method");
    ok(fileInput!.getAttribute("accept") === "video/mp4,video/webm,video/ogg,video/quicktime", "video: the picker still accepts exactly the four supported types");
    ok(r.text.includes("MP4، WebM، OGG، MOV"), "video: the accepted formats are stated in the form");

    const publish = [...r.host.querySelectorAll("button")].find((b) => (b.textContent || "").includes("انشر للمجموعة")) as HTMLButtonElement | undefined;
    ok(!!publish, "video: the publish button exists");

    // No title → a specific validation message, and no request at all.
    const before = log.length;
    await act(async () => {
      publish!.click();
      await sleep(30);
    });
    ok(log.length === before, "video: submitting without a file/title issues no request");

    // Fill the title, choose an 80 MB video, publish.
    const titleInput = r.host.querySelector("#sv-title") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(titleInput, "Lesson 1");
      titleInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await sleep(20);
    });
    const file = new dom.window.File([new Uint8Array(64)], "lesson.mp4", { type: "video/mp4" });
    Object.defineProperty(file, "size", { value: 80 * MB });
    Object.defineProperty(fileInput!, "files", { value: [file], configurable: true });
    await act(async () => {
      fileInput!.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await sleep(20);
    });
    const publish2 = [...r.host.querySelectorAll("button")].find((b) => (b.textContent || "").includes("انشر للمجموعة")) as HTMLButtonElement;
    await act(async () => {
      publish2.click();
      await sleep(40);
    });
    ok(publish2.disabled === true, "video: both action buttons are disabled while uploading");
    const draft = [...r.host.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "مسودة") as HTMLButtonElement | undefined;
    ok(!!draft && draft.disabled === true, "video: the draft button is disabled too (no parallel upload)");
    ok((r.host.querySelector("#sv-file") as HTMLInputElement).disabled === true, "video: the file picker is locked while uploading");

    await r.step(60);
    ok(r.text.includes("جارٍ رفع الملف"), "video: the uploading phase is visible");
    ok(r.text.includes("32.4 MB / 80.0 MB"), "video: the panel shows the REAL bytes uploaded (32.4 of 80 MB)");
    ok(r.text.includes("41%"), "video: the panel shows the REAL percentage");
    ok(!r.text.includes("تم رفع الملف بنجاح"), "video: success is not claimed mid-transfer");
    ok(!r.html.includes("X-Amz-Signature"), "video: the presigned URL is never rendered into the DOM");

    await r.step(400);
    ok(r.text.includes("تم رفع الملف بنجاح"), "video: success appears only after the complete leg succeeded");
    const puts = xhrLog.instances as { method: string; headers: Record<string, string>; withCredentials: boolean }[];
    ok(puts.length === 1 && puts[0].method === "PUT", "video: exactly one presigned PUT");
    ok(puts[0].headers["Content-Type"] === "video/mp4", "video: the granted Content-Type was sent");
    ok(puts[0].withCredentials === false, "video: the PUT carried no credential");
    const completeBody = JSON.parse(String(log.find((c) => c.url.endsWith("/media-uploads/complete"))!.body)) as Record<string, unknown>;
    ok(completeBody.title === "Lesson 1" && completeBody.publish === true, "video: the completion payload reached the server");

    // Cancelling is offered while a transfer is in flight.
    await r.step(2000);
    await r.unmount();
  }

  // =========================================================================
  section("F. Cancellation is offered during a transfer and stops before confirming");
  // =========================================================================
  {
    const log: NetLog = [];
    const xhrLog = { instances: [] as unknown[] };
    installFetch({
      initBody: {
        uploadUrl: "https://bucket.account.r2.invalid/session-pdfs/x-4.pdf?X-Amz-Signature=deadbeef",
        method: "PUT", token: "payload.mac", contentType: "application/pdf",
        maxBytes: 25 * MB, expiresInSec: 600, expiresAt: new Date(Date.now() + 600000).toISOString(), purpose: "LESSON_PDF",
      },
      completeBody: { purpose: "LESSON_PDF", mediaAssetId: "ma_4" },
      log,
    });
    // A transfer that never finishes on its own: only a cancel ends it.
    installFakeXHR({ samples: [0, Math.round(8.2 * MB)], total: 20 * MB, holdMs: 60000, log: xhrLog });

    const r = await render(
      React.createElement(SessionPdfManager, { lessonId: "l1", lessonTrackScope: "ARABIC", materials: [], onChanged: () => {} })
    );
    const fileInput = r.host.querySelector("#pdf-file") as HTMLInputElement;
    const file = new dom.window.File([new Uint8Array(64)], "notes.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "size", { value: 20 * MB });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    await act(async () => {
      fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await sleep(20);
    });
    const uploadButton = [...r.host.querySelectorAll("button")].find((b) => (b.textContent || "").includes("ارفع PDF")) as HTMLButtonElement;
    await act(async () => {
      uploadButton.click();
      await sleep(60);
    });
    const cancel = [...r.host.querySelectorAll("button")].find((b) => (b.textContent || "").includes("إلغاء الرفع")) as HTMLButtonElement | undefined;
    ok(!!cancel, "cancel: the cancel button is offered during the transfer");
    await act(async () => {
      cancel!.click();
      await sleep(80);
    });
    const puts = xhrLog.instances as { aborted: boolean }[];
    ok(puts.length === 1 && puts[0].aborted === true, "cancel: the in-flight PUT was really aborted");
    ok(log.filter((c) => c.url.endsWith("/media-uploads/complete")).length === 0, "cancel: a cancelled upload is never confirmed");
    ok(!r.text.includes("جارٍ رفع الملف"), "cancel: the busy panel is gone");
    ok(!r.text.includes("فشل الرفع"), "cancel: a cancellation is not presented as a failure");
    ok(uploadButton.disabled === false, "cancel: the form is immediately usable again");
    await r.unmount();
  }

  console.log("\n" + "=".repeat(64));
  console.log(`Media upload UX render verification: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("\nFailures:");
    for (const f of failures) console.error(" -", f);
    process.exit(1);
  }
  console.log("MEDIA_UPLOAD_UX_RENDER_OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
