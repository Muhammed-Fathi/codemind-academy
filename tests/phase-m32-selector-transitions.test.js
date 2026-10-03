// CodeMind Academy — Phase M3.2 selector and transition integrity.
//
// Renders the shipped selectors in jsdom with only the network and UI primitives
// mocked. This exercises real React effects/query keys: stale requests are allowed
// to resolve out of order so the active group's/level's options must still win.
//
// Run: node tests/phase-m32-selector-transitions.test.js

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const { JSDOM } = require("jsdom");
const { cleanupTempDir } = require("./helpers/temp-dir-cleanup.cjs");

const REPO = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m32-selectors-"));
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  HTMLSelectElement: dom.window.HTMLSelectElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  MutationObserver: dom.window.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
if (!("PointerEvent" in dom.window)) dom.window.PointerEvent = dom.window.MouseEvent;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
dom.window.ResizeObserver = ResizeObserverStub;
globalThis.ResizeObserver = ResizeObserverStub;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

let passed = 0;
let failed = 0;
const failures = [];
function ok(condition, label, detail) {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, actual === expected ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
function section(title) {
  console.log(`\n${title}`);
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function jsonResponse(body, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}
function queueResponse(key, value) {
  const queue = responseQueues.get(key) ?? [];
  queue.push(value);
  responseQueues.set(key, queue);
}
function requestKey(rawUrl) {
  const url = new URL(String(rawUrl), "http://localhost");
  const readiness = /\/api\/teacher\/lessons\/([^/]+)\/readiness$/.exec(url.pathname);
  if (readiness) return `readiness:${decodeURIComponent(readiness[1])}`;
  if (url.pathname === "/api/teacher/lessons") {
    return `catalog:${url.searchParams.get("groupId") ?? ""}:${url.searchParams.get("academicLevel") ?? ""}`;
  }
  return `${url.pathname}?${url.searchParams.toString()}`;
}
const responseQueues = new Map();
const requests = [];
function resetNetwork() {
  responseQueues.clear();
  requests.length = 0;
}
globalThis.fetch = (url, options = {}) => {
  const key = requestKey(url);
  requests.push({ key, url: String(url), method: options.method ?? "GET" });
  const queue = responseQueues.get(key) ?? [];
  const next = queue.shift();
  responseQueues.set(key, queue);
  if (!next) return Promise.reject(new Error(`No test response queued for ${key}`));
  return typeof next === "function" ? next() : next;
};

// Tiny, semantic UI primitives let the actual selectors/hooks run in a real
// React DOM without Radix portal/focus mechanics obscuring transition tests.
const React = require("react");
function html(tag, props = {}) {
  return React.forwardRef(function StubComponent({ children, ...rest }, ref) {
    const { className, variant, size, asChild, ...domProps } = rest;
    return React.createElement(tag, { ...domProps, ref, className }, children);
  });
}
const Button = React.forwardRef(function Button({ children, variant, size, asChild, ...props }, ref) {
  return React.createElement("button", { ...props, ref, type: props.type ?? "button" }, children);
});
const Badge = ({ children, ...props }) => React.createElement("span", props, children);
const Skeleton = ({ children, ...props }) => React.createElement("div", props, children);
const Label = ({ children, ...props }) => React.createElement("label", props, children);
const SelectTrigger = () => null;
const SelectValue = () => null;
const SelectContent = ({ children }) => React.createElement(React.Fragment, null, children);
const SelectGroup = ({ children }) => React.createElement(React.Fragment, null, children);
const SelectLabel = ({ children }) =>
  React.createElement("option", { disabled: true, value: `__label_${String(children).slice(0, 12)}__` }, children);
const SelectItem = ({ children, value, disabled, ...props }) =>
  React.createElement("option", { ...props, value, disabled }, children);
function findTriggerId(children) {
  let found = null;
  const visit = (node) => {
    if (found || node == null || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (!React.isValidElement(node)) return;
    if (node.type === SelectTrigger) {
      found = node.props.id ?? null;
      return;
    }
    visit(node.props.children);
  };
  visit(children);
  return found;
}
const Select = ({ children, value, onValueChange, disabled = false, ...props }) => {
  const triggerId = findTriggerId(children);
  const handleChange = (event) => onValueChange?.(event.currentTarget.value);
  return React.createElement(
    "select",
    {
      ...props,
      id: triggerId ?? props.id,
      "data-testid": triggerId ?? props["data-testid"] ?? "scoped-select",
      value: value ?? "",
      disabled,
      onChange: handleChange,
    },
    React.createElement("option", { value: "" }, ""),
    children
  );
};
const OptionalAcademicLevelFilter = ({ scope, value, onChange }) => {
  if (scope && scope.spansBothLevels === false) return null;
  return React.createElement(
    "div",
    { "data-testid": "level-filter" },
    [
      ["", "All"],
      ["FIRST_SECONDARY", "First"],
      ["SECOND_SECONDARY", "Second"],
    ].map(([level, label]) =>
      React.createElement(
        "button",
        {
          key: level || "all",
          type: "button",
          "data-level": level || "ALL",
          "aria-pressed": value === level,
          onClick: () => onChange(level),
        },
        label
      )
    )
  );
};
const AcademicLevelBadge = ({ level }) => React.createElement("span", null, level ?? "");
const icon = () => null;
const Dialog = ({ children, open }) => (open === false ? null : React.createElement("div", null, children));
const DialogContent = html("div");
const DialogDescription = html("p");
const DialogFooter = html("div");
const DialogHeader = html("div");
const DialogTitle = html("h2");
const Card = html("section");
const CardContent = html("div");
const CardHeader = html("div");
const CardTitle = html("h3");
const Progress = html("div");
const Input = html("input");
const Textarea = html("textarea");
const Checkbox = html("input");
const ScrollArea = html("div");
const EntitySelect = ({ value, onChange, options, loading, error, onRetry, disabled }) => {
  if (error) {
    return React.createElement(
      "div",
      { role: "alert", "data-testid": "schedule-lesson-error" },
      error,
      React.createElement("button", { type: "button", onClick: onRetry }, "Retry")
    );
  }
  return React.createElement(
    "div",
    null,
    React.createElement(
      "select",
      {
        "data-testid": "schedule-lesson",
        value: value ?? "",
        disabled: !!disabled || !!loading,
        onChange: (event) => onChange(event.currentTarget.value),
      },
      React.createElement("option", { value: "" }, "Pick lesson"),
      (options ?? []).map((option) =>
        React.createElement("option", { key: option.value, value: option.value }, option.label)
      )
    ),
    loading ? React.createElement("span", { role: "status", "data-testid": "schedule-lesson-loading" }, "Loading") : null
  );
};
const translation = (key) => key;
const useApp = (selector) => selector({ locale: "en" });
const useT = () => translation;
const noop = () => {};
const stubs = {
  "@/lib/i18n": { useT, useLocale: () => "en", pickAuto: (_ar, en) => en ?? "" },
  "@/lib/store": { useApp },
  "@/lib/i18n-core": { fmtDateTime: () => "", type: undefined },
  "@/lib/live-session-policy": {
    sessionDisplayOverride: (session) => session?.titleAr ?? "",
    sessionLessonIdentity: (lesson) => lesson?.title ?? lesson?.titleAr ?? null,
  },
  "@/components/shared/entity-select": { EntitySelect },
  "@/components/admin/academic-level-ui": {
    AcademicLevelBadge,
    OptionalAcademicLevelFilter,
    academicLevelLabel: (_tr, level) => level ?? "Unspecified",
  },
  "@/components/admin/session-workflow-shared": {
    CurriculumBadge: Badge,
    StatusBadge: Badge,
    TrackScopeBadge: Badge,
  },
  "@/components/shared/session-link-actions": { SessionLinkActions: () => null },
  "@/components/ui/badge": { Badge },
  "@/components/ui/button": { Button },
  "@/components/ui/calendar": { Calendar: () => null },
  "@/components/ui/card": { Card, CardContent, CardHeader, CardTitle },
  "@/components/ui/checkbox": { Checkbox },
  "@/components/ui/dialog": { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle },
  "@/components/ui/input": { Input },
  "@/components/ui/label": { Label },
  "@/components/ui/popover": { Popover: Dialog, PopoverContent: DialogContent, PopoverTrigger: Button },
  "@/components/ui/progress": { Progress },
  "@/components/ui/scroll-area": { ScrollArea },
  "@/components/ui/select": { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue },
  "@/components/ui/skeleton": { Skeleton },
  "@/components/ui/textarea": { Textarea },
  "@/components/ui/tooltip": { Tooltip: Dialog, TooltipContent: DialogContent, TooltipProvider: Dialog, TooltipTrigger: Button },
  sonner: { toast: { success: noop, error: noop, info: noop } },
  "lucide-react": new Proxy({}, { get: () => icon }),
};
globalThis.__CM_M32_STUBS__ = stubs;

// Compile shipped TS/TSX modules lazily and route only their framework/UI edges
// to the tiny DOM stubs above. The lesson API and React hooks themselves are real.
for (const extension of [".ts", ".tsx"]) {
  require.extensions[extension] = (module, filename) => {
    const source = fs.readFileSync(filename, "utf8");
    const output = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    }).outputText;
    module._compile(output, filename);
  };
}
const originalResolve = Module._resolveFilename;
const stubFiles = new Map();
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/use-json") return path.join(REPO, "src/lib/use-json.ts");
  if (request === "@/lib/utils") return path.join(REPO, "src/lib/utils.ts");
  if (Object.prototype.hasOwnProperty.call(stubs, request)) {
    let target = stubFiles.get(request);
    if (!target) {
      const safe = Buffer.from(request).toString("hex");
      target = path.join(OUT, `stub-${safe}.js`);
      fs.writeFileSync(target, `module.exports = globalThis.__CM_M32_STUBS__[${JSON.stringify(request)}];\n`);
      stubFiles.set(request, target);
    }
    return target;
  }
  return originalResolve.call(this, request, ...rest);
};

function lesson(id, level, courseId) {
  return {
    id,
    title: `Lesson ${id}`,
    titleRaw: `Lesson ${id}`,
    titleAr: `Lesson ${id}`,
    order: 1,
    officialCode: "1-1",
    trackScope: "SHARED",
    status: "PUBLISHED",
    curriculumStatus: "OFFICIAL",
    archived: false,
    chain: "CANONICAL",
    course: { id: courseId, name: "Programming & AI", academicLevel: level },
    part: { id: `part-${courseId}`, title: "Part", order: 1 },
    unit: { id: `unit-${courseId}`, title: "Unit", order: 1 },
    topic: null,
  };
}
function readinessRow(studentId, groupId, level) {
  return {
    studentId,
    studentName: studentId,
    groupId,
    groupName: "Same name group",
    groupCourseName: "Programming & AI",
    groupAcademicLevel: level,
    ready: true,
    overridden: false,
    video: { required: false, done: true, value: 100, requiredCount: 0, completedCount: 0, items: [], exempt: [] },
    quiz: { required: false, done: true, pending: [] },
    homework: { required: false, done: true, pending: [] },
  };
}
function responseBody(lessons, scope = { spansBothLevels: true }) {
  return { lessons, grouped: [], scope };
}
function tick(ms = 0) {
  return React.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}
async function resolveDeferred(item, value) {
  await React.act(async () => {
    item.resolve(value);
    await item.promise;
    await Promise.resolve();
  });
  await tick(0);
}
async function click(element) {
  if (!element) throw new Error("Cannot click a missing test element");
  await React.act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
  await tick(0);
}
async function changeSelect(element, value) {
  if (!element) throw new Error("Cannot change a missing test select");
  await React.act(async () => {
    element.value = value;
    element.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await Promise.resolve();
  });
  await tick(0);
}
function mount(element) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = require("react-dom/client").createRoot(host);
  return {
    host,
    root,
    async render(next) {
      await React.act(async () => {
        root.render(next);
        await Promise.resolve();
      });
    },
    async unmount() {
      await React.act(async () => root.unmount());
      host.remove();
    },
  };
}

(async () => {
  let activeMount = null;
  try {
    const { QueryClient, QueryClientProvider } = require("@tanstack/react-query");
    const { LessonPicker } = require(path.join(REPO, "src/components/teacher/teacher-authoring.tsx"));
    const { ScheduleDialog } = require(path.join(REPO, "src/components/teacher/live-sessions-workspace.tsx"));
    const { TeacherReadinessView } = require(path.join(REPO, "src/components/teacher/readiness-view.tsx"));

    section("M3.2 / shared LessonPicker: group and level scopes");
    resetNetwork();
    const groupA = deferred();
    const groupB = deferred();
    const firstLevel = deferred();
    const secondLevel = deferred();
    const groupCRetry = deferred();
    const groupCError = jsonResponse({ error: "temporary" }, 503);
    queueResponse("catalog:group-a:", () => groupA.promise);
    queueResponse("catalog:group-b:", () => groupB.promise);
    queueResponse("catalog:group-b:FIRST_SECONDARY", () => firstLevel.promise);
    queueResponse("catalog:group-b:SECOND_SECONDARY", () => secondLevel.promise);
    queueResponse("catalog:group-c:SECOND_SECONDARY", groupCError);
    queueResponse("catalog:group-c:SECOND_SECONDARY", () => groupCRetry.promise);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const selectedChanges = [];
    function PickerHarness({ groupId }) {
      const [value, setValue] = React.useState("lesson-a");
      return React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement("output", { "data-testid": "picker-selected" }, value),
        React.createElement(LessonPicker, {
          lessons: [],
          loading: false,
          value,
          onChange: (next) => {
            selectedChanges.push(next);
            setValue(next);
          },
          groupId,
          levelScope: { spansBothLevels: true },
        })
      );
    }
    activeMount = mount(null);
    await activeMount.render(React.createElement(PickerHarness, { groupId: "group-a" }));
    ok(!!activeMount.host.querySelector('[role="status"]'), "shared picker shows loading for the initial group query");
    await resolveDeferred(groupA, jsonResponse(responseBody([lesson("lesson-a", "FIRST_SECONDARY", "course-a")])));
    eq(activeMount.host.querySelector('[data-testid="picker-selected"]')?.textContent, "lesson-a", "current group selection is retained until its scope changes");
    let picker = activeMount.host.querySelector('[data-testid="scoped-select"]');
    ok(!!picker?.querySelector('option[value="lesson-a"]'), "the first group's canonical lesson ID is selectable");

    await activeMount.render(React.createElement(PickerHarness, { groupId: "group-b" }));
    eq(activeMount.host.querySelector('[data-testid="picker-selected"]')?.textContent, "", "changing the shared picker's group clears the stale lesson ID");
    ok(!!activeMount.host.querySelector('[role="status"]'), "new group request blocks old options while loading");
    ok(!activeMount.host.querySelector('option[value="lesson-a"]'), "old group options are removed during the transition");
    await resolveDeferred(groupB, jsonResponse(responseBody([lesson("lesson-b", "FIRST_SECONDARY", "course-b")])));
    picker = activeMount.host.querySelector('[data-testid="scoped-select"]');
    ok(!!picker?.querySelector('option[value="lesson-b"]'), "the new group response supplies its canonical lesson ID");
    ok(!picker?.querySelector('option[value="lesson-a"]'), "the new group never inherits previous options");

    await changeSelect(picker, "lesson-b");
    eq(activeMount.host.querySelector('[data-testid="picker-selected"]')?.textContent, "lesson-b", "the current group lesson can be selected by ID");
    await click(activeMount.host.querySelector('[data-level="FIRST_SECONDARY"]'));
    eq(activeMount.host.querySelector('[data-testid="picker-selected"]')?.textContent, "", "changing academic level clears the selected lesson immediately");
    ok(!!activeMount.host.querySelector('[role="status"]'), "old-level picker options are blocked while the new query loads");
    ok(!!activeMount.host.querySelector('[data-level="SECOND_SECONDARY"]'), "the level control remains usable during a pending request");
    await click(activeMount.host.querySelector('[data-level="SECOND_SECONDARY"]'));
    await resolveDeferred(secondLevel, jsonResponse(responseBody([lesson("lesson-second", "SECOND_SECONDARY", "course-b")])));
    await tick(0);
    picker = activeMount.host.querySelector('[data-testid="scoped-select"]');
    ok(!!picker?.querySelector('option[value="lesson-second"]'), "the newest level response becomes the active option set");
    await resolveDeferred(firstLevel, jsonResponse(responseBody([lesson("lesson-first", "FIRST_SECONDARY", "course-b")])));
    picker = activeMount.host.querySelector('[data-testid="scoped-select"]');
    ok(!!picker?.querySelector('option[value="lesson-second"]'), "a late old-level response cannot replace the active options");
    ok(!picker?.querySelector('option[value="lesson-first"]'), "late old-level options stay in their old query only");
    ok(requests.some((request) => request.key === "catalog:group-b:FIRST_SECONDARY") && requests.some((request) => request.key === "catalog:group-b:SECOND_SECONDARY"), "level requests retain the selected group ID in their server scope");

    await activeMount.render(React.createElement(PickerHarness, { groupId: "group-c" }));
    await tick(0);
    ok(!!activeMount.host.querySelector('[role="alert"]'), "scoped query failures have visible error feedback");
    const retryButton = [...activeMount.host.querySelectorAll("button")].find((button) => button.textContent === "live.retry");
    ok(!!retryButton, "scoped query failures expose a retry action");
    await click(retryButton);
    await tick(0);
    ok(!!activeMount.host.querySelector('[role="status"]'), "retry visibly returns to a scoped loading state");
    ok(!activeMount.host.querySelector('[data-testid="scoped-select"]'), "retry blocks stale scoped options until the server responds");
    await resolveDeferred(groupCRetry, jsonResponse(responseBody([lesson("lesson-c", "SECOND_SECONDARY", "course-c")])));
    picker = activeMount.host.querySelector('[data-testid="scoped-select"]');
    ok(!!picker?.querySelector('option[value="lesson-c"]'), "retry repopulates options from the same group scope");
    await activeMount.unmount();
    activeMount = null;
    queryClient.clear();

    section("M3.2 / live-session scheduler: group changes clear and refetch");
    resetNetwork();
    const schedulerA = deferred();
    const schedulerB = deferred();
    const schedulerCRetry = deferred();
    queueResponse("catalog:schedule-a:", () => schedulerA.promise);
    queueResponse("catalog:schedule-b:", () => schedulerB.promise);
    queueResponse("catalog:schedule-c:", jsonResponse({ error: "temporary" }, 503));
    queueResponse("catalog:schedule-c:", () => schedulerCRetry.promise);
    const scheduleGroups = [
      { id: "schedule-a", name: "Group A", courseId: "course-a", academicLevel: "FIRST_SECONDARY" },
      { id: "schedule-b", name: "Group B", courseId: "course-b", academicLevel: "SECOND_SECONDARY" },
      { id: "schedule-c", name: "Group C", courseId: "course-c", academicLevel: "SECOND_SECONDARY" },
    ];
    activeMount = mount(null);
    await activeMount.render(React.createElement(ScheduleDialog, {
      open: true,
      onOpenChange: noop,
      groups: scheduleGroups,
      onCreated: noop,
    }));
    await tick(0);
    ok(requests.some((request) => request.key === "catalog:schedule-a:"), "scheduler fetches lessons with its selected groupId");
    await resolveDeferred(schedulerA, jsonResponse(responseBody([lesson("schedule-lesson-a", "FIRST_SECONDARY", "course-a")])));
    let scheduleGroup = activeMount.host.querySelector('[data-testid="schedule-group"]');
    let scheduleLesson = activeMount.host.querySelector('[data-testid="schedule-lesson"]');
    ok(scheduleGroup?.textContent?.includes("FIRST_SECONDARY · Group A") && scheduleGroup?.textContent?.includes("SECOND_SECONDARY · Group B"), "scheduler keeps level labels visible on group options");
    ok(!!scheduleLesson?.querySelector('option[value="schedule-lesson-a"]'), "scheduler displays the selected group's lesson by canonical ID");
    await changeSelect(scheduleLesson, "schedule-lesson-a");
    eq(activeMount.host.querySelector('[data-testid="schedule-lesson"]')?.value, "schedule-lesson-a", "scheduler accepts a lesson from the selected group");

    await changeSelect(scheduleGroup, "schedule-b");
    scheduleLesson = activeMount.host.querySelector('[data-testid="schedule-lesson"]');
    eq(scheduleLesson?.value, "", "switching scheduler groups immediately clears the old lesson selection");
    eq(scheduleLesson?.disabled, true, "the stale lesson selector is disabled while the new group request is pending");
    ok(!scheduleLesson?.querySelector('option[value="schedule-lesson-a"]'), "scheduler does not retain old-group options during loading");
    ok(!!activeMount.host.querySelector('[data-testid="schedule-lesson-loading"]'), "scheduler shows loading for the selected group's request");
    await resolveDeferred(schedulerB, jsonResponse(responseBody([lesson("schedule-lesson-b", "SECOND_SECONDARY", "course-b")])));
    scheduleLesson = activeMount.host.querySelector('[data-testid="schedule-lesson"]');
    ok(!!scheduleLesson?.querySelector('option[value="schedule-lesson-b"]'), "scheduler replaces the catalogue with the new group's lessons");
    ok(!scheduleLesson?.querySelector('option[value="schedule-lesson-a"]'), "scheduler excludes previous-group lessons after completion");

    await changeSelect(activeMount.host.querySelector('[data-testid="schedule-group"]'), "schedule-c");
    await tick(0);
    let schedulerError = activeMount.host.querySelector('[data-testid="schedule-lesson-error"]');
    ok(!!schedulerError, "scheduler shows an error scoped to the selected group's request");
    await click(schedulerError.querySelector("button"));
    await tick(0);
    ok(!!activeMount.host.querySelector('[data-testid="schedule-lesson-loading"]'), "scheduler retry shows loading for the selected group");
    const retryingScheduleLesson = activeMount.host.querySelector('[data-testid="schedule-lesson"]');
    ok(retryingScheduleLesson?.disabled && !retryingScheduleLesson?.querySelector('option[value="schedule-lesson-b"]'), "scheduler retry disables the selector and blocks stale lesson options");
    await resolveDeferred(schedulerCRetry, jsonResponse(responseBody([lesson("schedule-lesson-c", "SECOND_SECONDARY", "course-c")])));
    scheduleLesson = activeMount.host.querySelector('[data-testid="schedule-lesson"]');
    ok(!!scheduleLesson?.querySelector('option[value="schedule-lesson-c"]'), "scheduler retry loads only the selected group's lessons");
    await activeMount.unmount();
    activeMount = null;

    section("M3.2 / readiness: scoped loading, response races and group IDs");
    resetNetwork();
    const initialListError = jsonResponse({ error: "unavailable" }, 503);
    const initialLessons = [
      lesson("readiness-first", "FIRST_SECONDARY", "course-first"),
      lesson("readiness-second", "SECOND_SECONDARY", "course-second"),
    ];
    const firstReadinessLevel = deferred();
    const secondReadinessLevel = deferred();
    queueResponse("catalog::", initialListError);
    queueResponse("catalog::", jsonResponse(responseBody(initialLessons)));
    queueResponse("catalog::FIRST_SECONDARY", () => firstReadinessLevel.promise);
    queueResponse("catalog::SECOND_SECONDARY", () => secondReadinessLevel.promise);
    const readyRows = [
      readinessRow("student-one", "group-one", "SECOND_SECONDARY"),
      readinessRow("student-two", "group-two", "SECOND_SECONDARY"),
    ];
    const readinessPayload = {
      lesson: { id: "readiness-second", title: "Second", titleAr: "Second", courseId: "course-second" },
      students: readyRows,
    };
    queueResponse("readiness:readiness-second", jsonResponse(readinessPayload));
    queueResponse("readiness:readiness-second", jsonResponse(readinessPayload));
    activeMount = mount(null);
    await activeMount.render(React.createElement(TeacherReadinessView));
    await tick(0);
    ok(!!activeMount.host.querySelector('[role="alert"]'), "readiness lesson-list failures show an explicit error");
    const readinessRetry = [...activeMount.host.querySelectorAll("button")].find((button) => button.textContent === "live.retry");
    ok(!!readinessRetry, "readiness lesson-list errors expose retry");
    await click(readinessRetry);
    await tick(0);
    let readinessLesson = activeMount.host.querySelector('[data-testid="readiness-lesson"]');
    ok(!!readinessLesson?.querySelector('option[value="readiness-first"]') && !!readinessLesson?.querySelector('option[value="readiness-second"]'), "retry restores the all-level lesson catalogue");
    await changeSelect(readinessLesson, "readiness-second");
    ok(!!activeMount.host.querySelector('[data-testid="readiness-group"]'), "readiness payload is visible for the selected canonical lesson ID");

    await click(activeMount.host.querySelector('[data-level="FIRST_SECONDARY"]'));
    ok(!!activeMount.host.querySelector('[role="status"]'), "readiness blocks old-level options immediately on transition");
    ok(!activeMount.host.querySelector('option[value="readiness-second"]'), "the old-level lesson is absent while the new request is pending");
    ok(!activeMount.host.querySelector('[data-testid="readiness-group"]'), "level transition clears the old readiness selection and roster");
    await click(activeMount.host.querySelector('[data-level="SECOND_SECONDARY"]'));
    await resolveDeferred(secondReadinessLevel, jsonResponse(responseBody([lesson("readiness-second", "SECOND_SECONDARY", "course-second")])));
    readinessLesson = activeMount.host.querySelector('[data-testid="readiness-lesson"]');
    ok(!!readinessLesson?.querySelector('option[value="readiness-second"]'), "the newest readiness level response is displayed");
    await resolveDeferred(firstReadinessLevel, jsonResponse(responseBody([lesson("readiness-first", "FIRST_SECONDARY", "course-first")])));
    readinessLesson = activeMount.host.querySelector('[data-testid="readiness-lesson"]');
    ok(!!readinessLesson?.querySelector('option[value="readiness-second"]'), "a late readiness response cannot replace the newer level options");
    ok(!readinessLesson?.querySelector('option[value="readiness-first"]'), "late readiness options remain excluded from the active level");

    await changeSelect(readinessLesson, "readiness-second");
    await tick(0);
    const groupFilter = activeMount.host.querySelector('[data-testid="readiness-group"]');
    ok(!!groupFilter?.querySelector('option[value="group-one"]') && !!groupFilter?.querySelector('option[value="group-two"]'), "same-named readiness groups are separate options by canonical groupId");
    const duplicateLabels = [...groupFilter.options]
      .filter((option) => option.value === "group-one" || option.value === "group-two")
      .map((option) => option.textContent);
    eq(new Set(duplicateLabels).size, 2, "same-name readiness groups have distinguishable labels");
    ok(activeMount.host.textContent.includes("student-one") && activeMount.host.textContent.includes("student-two"), "both same-named groups' readiness rows are visible before filtering");
    await changeSelect(groupFilter, "group-two");
    ok(activeMount.host.textContent.includes("student-two") && !activeMount.host.textContent.includes("student-one"), "selecting one group ID filters only that group's readiness rows");
    await activeMount.unmount();
    activeMount = null;

    console.log(`\nM3.2 selector transition tests: ${passed} passed, ${failed} failed.`);
    if (failures.length) {
      console.error("Failed assertions:\n" + failures.map((failure) => `  - ${failure}`).join("\n"));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("\nHARNESS ERROR:", error && error.stack ? error.stack : error);
    process.exitCode = 1;
  } finally {
    if (activeMount) {
      try { await activeMount.unmount(); } catch {}
    }
    Module._resolveFilename = originalResolve;
    await cleanupTempDir(OUT);
    dom.window.close();
  }
})();
