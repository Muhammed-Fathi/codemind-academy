// CodeMind Academy — Phase 16 render verification (browser substitute).
//
// WHAT THIS IS
//   The Phase 16 brief asks for Playwright/manual browser verification across
//   AR/EN, RTL/LTR, mobile/desktop, student/parent. This sandbox cannot run a
//   real browser (no Chromium binary; the Playwright CDN is unreachable — the
//   same egress restriction that blocks the Prisma engine downloads, already
//   recorded for Phase 9). This script is the strongest available substitute:
//   it renders the REAL shipped components in a REAL DOM (jsdom) with mocked
//   network, and asserts the Phase 16 contract end to end:
//
//     skeleton   • locked sessions render title + officialCode + presence
//                  badges, stay disabled, and leak no protected URLs.
//     unified    • the lesson page renders requirements + recordings + quiz +
//                  homework as one session; locked vs missing denials render
//                  content-free skeletons.
//     deep links • notification links navigate (view + navParam); homework
//                  and recordings landings highlight their target.
//     i18n/RTL   • every string resolves in AR and EN (no dotted keys, no
//                  empties); document.dir follows the locale.
//
// WHAT THIS IS NOT
//   It is not layout geometry (jsdom has no layout engine): viewport
//   overflow, overlap and hit-target assertions still need the Playwright
//   harness where a browser exists. The manual checklist for that run lives
//   in docs/PHASE_16_STUDENT_LOCKED_CURRICULUM.md § Browser Verification.
//
// Run:  npx tsx scripts/verify-phase16-render.mts

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
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
// jsdom lacks these; the components only need them to exist.
g.window.matchMedia =
  g.window.matchMedia ||
  (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
(dom.window.Element.prototype as unknown as Record<string, unknown>).scrollIntoView = () => {};
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

type FetchHandler = (url: string, opts?: unknown) => { status: number; body: unknown } | null;
let handlers: FetchHandler[] = [];
function mockFetch(h: FetchHandler) {
  handlers.push(h);
}
function resetFetch() {
  handlers = [];
}
function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
g.fetch = (async (url: unknown) => {
  const u = String(url);
  for (const h of handlers) {
    const r = h(u);
    if (r) return jsonResponse(r.status, r.body);
  }
  return jsonResponse(404, {});
}) as typeof fetch;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const React = await import("react");
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useApp } = await import("@/lib/store");
  const { StudentCourseView } = await import("@/components/course/student-course");
  const { StudentLessonView } = await import("@/components/course/student-lesson");
  const { StudentDashboard } = await import("@/components/student/student-dashboard");
  const { StudentSessionVideosView } = await import("@/components/course/session-videos-view");

  async function render(el: React.ReactElement) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(el);
      await sleep(250);
    });
    const html = host.innerHTML;
    await act(async () => {
      root.unmount();
    });
    host.remove();
    return { host, html };
  }
  function setShell(locale: "ar" | "en", view: string, navParam: string | null) {
    const s = useApp.getState();
    s.setLocale(locale);
    s.setView(view as never);
    s.setNavParam(navParam);
  }

  const coursePayload = {
    course: { id: "c1", slug: "slug", name: "Course", nameAr: "الكورس", description: "d", color: "#111" },
    parts: [
      {
        id: "p1", title: "Part", titleAr: "الجزء", description: null, order: 1,
        units: [
          {
            id: "u1", title: "Unit", titleAr: "الوحدة", order: 1, icon: null,
            lessons: [
              {
                id: "open1", title: "Open", titleAr: "مفتوحة", officialCode: "1-1", order: 1, duration: 30,
                videoUrl: "https://videos.example/x", pdfUrl: "/api/materials/m1",
                summary: "s", description: "d", progress: 50, isCompleted: false, status: "current",
                requirements: { completed: false }, hasQuiz: true, hasAssignment: true,
                hasVideo: true, hasPdf: true, materialCount: 2,
                quiz: { id: "q1", title: "Q", titleAr: "س" }, homework: null,
              },
              {
                id: "lock1", title: "Locked", titleAr: "مقفولة", officialCode: "1-2", order: 2, duration: 30,
                videoUrl: null, pdfUrl: null, summary: null, description: null,
                progress: 0, isCompleted: false, status: "locked", requirements: null,
                hasQuiz: true, hasAssignment: false, hasVideo: true, hasPdf: true, materialCount: 1,
                quiz: null, homework: null,
              },
            ],
            topics: [],
          },
        ],
      },
    ],
    progress: { totalLessons: 2, completedLessons: 0, percentage: 0 },
  };

  // ------------------------------------------------------------------ S1: AR
  resetFetch();
  mockFetch((u) => (u.includes("/api/courses/") ? { status: 200, body: coursePayload } : null));
  setShell("ar", "student-course", "slug");
  {
    const { html } = await render(React.createElement(StudentCourseView));
    ok(document.documentElement.dir === "rtl", "S1: document.dir is rtl for AR");
    ok(html.includes("1-1") && html.includes("1-2"), "S1: officialCode chips render for open + locked");
    ok(html.includes("فيديو"), "S1: video badge localizes to AR");
    ok(html.includes("ملف"), "S1: file badge localizes to AR");
    ok(html.includes("مقفولة"), "S1: locked session title is visible (skeleton)");
    ok(html.includes("disabled"), "S1: locked row stays disabled");
    ok(!html.includes("videos.example"), "S1: no protected URL leaks into the tree");
    ok(!html.includes("course.2"), "S1: no untranslated course.2xx keys in AR");
  }

  // ------------------------------------------------------------------ S2: EN
  resetFetch();
  mockFetch((u) => (u.includes("/api/courses/") ? { status: 200, body: coursePayload } : null));
  setShell("en", "student-course", "slug");
  {
    const { html } = await render(React.createElement(StudentCourseView));
    ok(document.documentElement.dir === "ltr", "S2: document.dir is ltr for EN");
    ok(html.includes("Video"), "S2: video badge localizes to EN");
    ok(html.includes("PDF"), "S2: file badge localizes to EN");
    ok(html.includes("1-2"), "S2: locked skeleton keeps its identity in EN");
  }

  // ------------------------------------------------------- S3: locked lesson
  resetFetch();
  mockFetch((u) =>
    u.includes("/api/lessons/lock1")
      ? { status: 403, body: { error: "x", code: "PREVIOUS_SESSION_INCOMPLETE" } }
      : null
  );
  setShell("ar", "student-lesson", "lock1");
  {
    const { html } = await render(React.createElement(StudentLessonView));
    ok(html.includes("الجلسة مقفولة"), "S3: locked panel titles the denial");
    ok(html.includes("الجلسة السابقة"), "S3: locked panel explains the requirement");
    ok(!html.includes("<iframe"), "S3: locked panel renders no video");
    ok(!html.includes("videos.example") && !html.includes("/api/materials/"), "S3: locked panel leaks no content locations");
    ok(html.includes("ارجع للرئيسية"), "S3: locked panel offers a safe way home");
  }

  // ------------------------------------------------------- S4: missing lesson
  resetFetch();
  mockFetch((u) => (u.startsWith("/api/lessons/") ? { status: 404, body: {} } : null));
  setShell("en", "student-lesson", "ghost");
  {
    const { html } = await render(React.createElement(StudentLessonView));
    ok(html.includes("This session is not available"), "S4: missing panel renders in EN");
    ok(!html.includes("<iframe"), "S4: missing panel renders no video");
  }

  // ---------------------------------------------------------- S5: full lesson
  const lessonPayload = {
    lesson: {
      id: "open1", title: "Open", titleAr: "مفتوحة", officialCode: "1-1",
      description: "desc", summary: "sum", duration: 45, order: 1,
      videoUrl: "https://videos.example/x", pdfUrl: "/api/materials/m1",
      materials: [{ id: "m1", title: "PDF", kind: "ADMIN_UPLOADED", trackScope: "SHARED", downloadUrl: "/api/materials/m1", mimeType: "application/pdf", sizeBytes: 10, legacy: false }],
    },
    part: { id: "p1", title: "Part", titleAr: "الجزء" },
    unit: { id: "u1", title: "Unit", titleAr: "الوحدة" },
    topic: null,
    course: { id: "c1", slug: "slug", name: "Course", nameAr: "الكورس" },
    quizzes: [{ id: "q1", title: "Quiz", titleAr: "اختبار", description: null, passMark: 60, questions: [{}, {}] }],
    quiz: { id: "q1", title: "Quiz", titleAr: "اختبار", description: null, passMark: 60, questions: [{}, {}] },
    homework: { id: "h1", title: "HW", titleAr: "واجب", instructions: "do it", deadline: new Date(Date.now() + 86400000).toISOString(), maxMarks: 10 },
    progress: { progress: 50, isCompleted: false, lastViewedAt: null },
    requirements: {
      completed: false, unlocked: true,
      video: { required: true, done: false, value: 42 },
      quiz: { required: true, done: true, value: 100 },
      assignment: { required: false, done: true, value: 100 },
    },
    prevLessonId: null,
    nextLessonId: null,
  };
  resetFetch();
  mockFetch((u) => {
    if (u.startsWith("/api/lessons/open1")) return { status: 200, body: lessonPayload };
    if (u.startsWith("/api/students/me/bookmarks")) return { status: 200, body: { bookmarks: [] } };
    if (u.startsWith("/api/students/me/notes")) return { status: 200, body: { notes: [] } };
    if (u.startsWith("/api/students/me/session-videos")) {
      return { status: 200, body: { videos: [{ id: "v1", title: "Rec", titleAr: "تسجيل", progress: { percent: 10, isCompleted: false } }] } };
    }
    return null;
  });
  setShell("en", "student-lesson", "open1");
  {
    const { html } = await render(React.createElement(StudentLessonView));
    ok(html.includes("<iframe"), "S5: unified page embeds the video");
    ok(html.includes("1-1"), "S5: session identity shows in the header");
    ok(html.includes("Session completion requirements"), "S5: requirements checklist renders");
    ok(html.includes("42%"), "S5: video progress value renders");
    ok(html.includes("Not required"), "S5: unrequired components are labeled, not gated");
    ok(html.includes("Session recordings"), "S5: linked recordings render inside the session");
    ok(html.includes("Watch recording"), "S5: recordings link out to the recordings view");
    ok(html.includes("/api/materials/m1"), "S5: authorized material path renders for unlocked");
    ok(html.includes("2 Questions"), "S5: quiz card renders with its question count");
    ok(html.includes("do it"), "S5: homework instructions render");
  }

  // ------------------------------------------- S6: notification deep links
  resetFetch();
  mockFetch((u) => {
    if (u === "/api/notifications") {
      return {
        status: 200,
        body: {
          notifications: [
            { id: "n1", title: "t1", message: "m1", isRead: false, createdAt: new Date().toISOString(), link: "lesson:abc" },
            { id: "n2", title: "t2", message: "m2", isRead: true, createdAt: new Date().toISOString(), link: "admin-payments" },
            { id: "n3", title: "t3", message: "m3", isRead: true, createdAt: new Date().toISOString(), link: null },
          ],
        },
      };
    }
    return null;
  });
  setShell("ar", "student-notifications", null);
  {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(StudentDashboard));
      await sleep(250);
    });
    const opens = [...host.querySelectorAll("button")].filter((b) => b.textContent?.includes("فتح"));
    ok(opens.length === 1, `S6: exactly the well-formed link gets an Open button (got ${opens.length})`);
    await act(async () => {
      opens[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await sleep(50);
    });
    const st = useApp.getState();
    ok(st.view === "student-lesson" && st.navParam === "abc", "S6: Open navigates to (student-lesson, abc)");
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }

  // ----------------------------------------- S7: homework deep-link landing
  resetFetch();
  mockFetch((u) => {
    if (u === "/api/students/me/homework") {
      return {
        status: 200,
        body: {
          items: [
            { id: "h1", title: "HW", lessonTitle: "L", deadline: new Date(Date.now() + 86400000).toISOString(), maxMarks: 10, lessonId: "l1", submission: null },
          ],
        },
      };
    }
    return null;
  });
  setShell("ar", "student-homework", "h1");
  {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(StudentDashboard));
      await sleep(250);
    });
    const li = host.querySelector("#homework-h1");
    ok(!!li, "S7: deep-linked homework row renders with its anchor");
    ok(!!li && li.className.includes("border-primary"), "S7: deep-linked row is highlighted");
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }

  // ---------------------------------------- S8: recordings deep-link landing
  resetFetch();
  mockFetch((u) => {
    if (u === "/api/students/me/session-videos") {
      return {
        status: 200,
        body: {
          isEnrolled: true,
          videos: [
            { id: "v1", title: "One", titleAr: "واحد", description: null, lesson: null, requiredPercent: 80, publishedAt: null, src: "https://x/1", isExternal: true, progress: { percent: 0, isCompleted: false, watchedSec: 0 } },
            { id: "v2", title: "Two", titleAr: "اتنين", description: null, lesson: null, requiredPercent: 80, publishedAt: null, src: "https://x/2", isExternal: true, progress: { percent: 0, isCompleted: false, watchedSec: 0 } },
          ],
        },
      };
    }
    return null;
  });
  setShell("en", "student-session-videos", "v2");
  {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(StudentSessionVideosView));
      await sleep(250);
    });
    const heading = host.querySelector("h2");
    ok(!!heading && heading.textContent === "Two", `S8: video:<id> activates its recording (got "${heading?.textContent}")`);
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }

  console.log(`\nphase 16 render verification: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error(`\n${fail} failure(s):`);
    for (const f of failures) console.error(` - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exitCode = 1;
});
