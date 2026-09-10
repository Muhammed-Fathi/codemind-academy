// CodeMind Academy — Visual RTL/LTR test harness.
//
// Renders the REAL form components (imported from src/, not re-implemented)
// against the REAL compiled globals.css, so what Playwright measures is the
// production layout. Only leaf infrastructure is stubbed:
//   * next/navigation + the zustand app store (routing/state, not layout)
//   * fetch (so no network/DB is needed)
// Everything visual — Radix dialogs/drawers, Tailwind classes, the logical
// properties under test — is the genuine article.

import * as React from "react";
import { createRoot } from "react-dom/client";

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Search, Eye, Mail, Upload, Link2, AlertCircle } from "lucide-react";

// --- Real feature components under test ------------------------------------
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { SessionVideosView } from "@/components/admin/session-videos-view";
import { SessionWorkflowView } from "@/components/admin/session-workflow-view";
import { MockExamsView } from "@/components/admin/mock-exams-view";
import { QuizReviewView } from "@/components/admin/quiz-review-view";
import { KodgyAssistant } from "@/components/kodgy/kodgy-assistant";
import { useApp } from "@/lib/store";

const LONG_AR = "ده نص طويل جدا عشان نتأكد إن الفورم مش هيتكسر ولا هيخرج بره الشاشة مهما كان المحتوى طويل أوي";
const LONG_EN = "This is a deliberately long piece of helper text used to confirm the form never clips or overflows horizontally at any breakpoint";

/** A dense form exercising icons, selects, textareas, validation and buttons. */
function KitchenSinkForm({ label }: { label: string }) {
  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="ks-name">{label} — name</Label>
        <Input id="ks-name" className="mt-1" defaultValue="محمد فتحي عبد الرحمن" />
      </div>

      {/* Leading-icon field: the icon must never sit on top of the text. */}
      <div>
        <Label htmlFor="ks-search">Search (leading icon)</Label>
        <div className="field-with-icon mt-1">
          <Search className="field-icon w-4 h-4" data-side="start" />
          <Input id="ks-search" defaultValue="بحث عن طالب بالاسم أو الكود" />
        </div>
      </div>

      {/* Trailing-icon field. */}
      <div>
        <Label htmlFor="ks-pass">Password (trailing icon)</Label>
        <div className="field-with-icon mt-1">
          <Input id="ks-pass" type="password" defaultValue="ExamplePassphrase" />
          <button type="button" className="field-icon" aria-label="show">
            <Eye className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>School type</Label>
          <Select defaultValue="ARABIC">
            <SelectTrigger className="mt-1 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ARABIC">مدارس عربي</SelectItem>
              <SelectItem value="LANGUAGE">مدارس لغات</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="ks-phone">Phone</Label>
          <Input id="ks-phone" dir="ltr" className="mt-1" defaultValue="+201000000001" />
        </div>
      </div>

      <div>
        <Label htmlFor="ks-desc">Description</Label>
        <Textarea id="ks-desc" rows={3} className="mt-1" defaultValue={LONG_AR} />
      </div>

      {/* Validation error must not blow out the layout. */}
      <p className="flex items-start gap-1.5 text-xs text-destructive">
        <AlertCircle className="mt-0.5 w-3.5 h-3.5 shrink-0" />
        <span>{LONG_EN}</span>
      </p>

      <div className="flex flex-wrap gap-2">
        <Button className="flex-1">حفظ التعديلات</Button>
        <Button variant="outline" className="flex-1">إلغاء</Button>
      </div>
    </div>
  );
}

/** Mirrors the landing "how to start" step cards (number vs icon collision). */
function StepCards() {
  const steps = [
    { num: "01", title: "التسجيل" }, { num: "02", title: "اختيار الباقة" },
    { num: "03", title: "الدفع" }, { num: "04", title: "موافقة الإدارة" },
    { num: "05", title: "بدء الدراسة" }, { num: "06", title: "الشهادة" },
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="step-cards">
      {steps.map((s) => (
        <div key={s.num} className="bg-card rounded-2xl p-6 border border-border/60 shadow-sm card-hover flex flex-col" data-testid="step-card">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div className="w-11 h-11 shrink-0 rounded-xl bg-primary/10 flex items-center justify-center" data-testid="step-icon">
              <Upload className="w-5 h-5 text-primary" />
            </div>
            <span aria-hidden="true" data-testid="step-num"
              className="shrink-0 text-3xl sm:text-4xl font-black text-primary/15 leading-none select-none tabular-nums">
              {s.num}
            </span>
          </div>
          <div>
            <h3 className="text-base font-bold">{s.title}</h3>
            <p className="text-sm text-muted-foreground mt-1">{LONG_AR}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Admin students tabs + table + pagination (layout only). */
function StudentTabs() {
  const [tab, setTab] = React.useState("ARABIC");
  const tabs = [
    { v: "ARABIC", l: "مدارس عربي", n: 128 },
    { v: "LANGUAGE", l: "مدارس لغات", n: 94 },
    { v: "UNSPECIFIED", l: "غير محدد", n: 7 },
  ];
  return (
    <Card className="p-4" data-testid="student-tabs-card">
      <div role="tablist" className="flex flex-wrap items-center gap-2 mb-4 border-b border-border/60 pb-3">
        {tabs.map((t) => (
          <button key={t.v} role="tab" aria-selected={tab === t.v} onClick={() => setTab(t.v)}
            data-testid={`tab-${t.v}`}
            className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold ${
              tab === t.v ? "bg-primary text-primary-foreground shadow-sm" : "bg-muted/50 text-muted-foreground"}`}>
            <span>{t.l}</span>
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${tab === t.v ? "bg-primary-foreground/20" : "bg-background"}`}>{t.n}</span>
          </button>
        ))}
      </div>
      <div className="field-with-icon mb-3">
        <Search className="field-icon w-4 h-4" data-side="start" />
        <Input placeholder="ابحث بالاسم أو الكود أو الإيميل" />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="students-table">
          <thead><tr className="text-start">
            {["الطالب", "الكود", "النوع", "الفيديو", "الحالة"].map((h) => (
              <th key={h} className="text-start p-2 whitespace-nowrap">{h}</th>))}
          </tr></thead>
          <tbody>
            {[1, 2, 3].map((i) => (
              <tr key={i} className="border-t">
                <td className="p-2">طالب رقم {i} الاسم الطويل جدا</td>
                <td className="p-2"><code dir="ltr">CM-000{i}</code></td>
                <td className="p-2">{tab === "UNSPECIFIED" ? "—" : "عربي"}</td>
                <td className="p-2 tabular-nums">{i * 30}%</td>
                <td className="p-2"><Badge>نشط</Badge></td>
              </tr>))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between gap-2 pt-3">
        <Button variant="outline" size="sm">السابق</Button>
        <span className="text-xs tabular-nums text-muted-foreground">1 / 5</span>
        <Button variant="outline" size="sm">التالي</Button>
      </div>
    </Card>
  );
}

const SCENES: Record<string, React.ReactNode> = {
  "login": (
    <div className="w-full max-w-md mx-auto">
      <h1 className="text-2xl font-extrabold mb-1">أهلاً بعودتك</h1>
      <p className="text-sm text-muted-foreground mb-6">{LONG_AR}</p>
      <div className="space-y-3">
        <div>
          <Label htmlFor="lg-mail">الإيميل</Label>
          <div className="field-with-icon mt-1">
            <Mail className="field-icon w-4 h-4" data-side="start" />
            <Input id="lg-mail" dir="ltr" defaultValue="student@codemind.academy" />
          </div>
        </div>
        <div>
          <Label htmlFor="lg-pass">كلمة السر</Label>
          <div className="field-with-icon mt-1">
            <Input id="lg-pass" type="password" defaultValue="password123" />
            <button type="button" className="field-icon" aria-label="show"><Eye className="w-4 h-4" /></button>
          </div>
        </div>
        <Button className="w-full">تسجيل الدخول</Button>
      </div>
    </div>
  ),
  "forgot-password": (
    <div className="w-full max-w-md mx-auto"><ForgotPasswordForm onBackToLogin={() => {}} /></div>
  ),
  "student-registration": (
    <div className="w-full max-w-md mx-auto"><KitchenSinkForm label="تسجيل طالب" /></div>
  ),
  "parent-registration": (
    <div className="w-full max-w-md mx-auto"><KitchenSinkForm label="تسجيل ولي أمر" /></div>
  ),
  "step-cards": <StepCards />,
  "admin-student-tabs": <StudentTabs />,
  "admin-session-videos": <SessionVideosView />,
  "admin-mock-exams": <MockExamsView />,
  "admin-quiz-review": <QuizReviewView />,
  "admin-session-workflow": (
    <div className="w-full max-w-6xl mx-auto"><SessionWorkflowView /></div>
  ),
  "admin-session-detail": <SessionDetailScene />,
  "dialog-form": (
    <Dialog open modal={false}>
      <DialogContent className="sm:max-w-lg" data-testid="dialog-panel">
        <DialogHeader>
          <DialogTitle>إضافة سؤال جديد</DialogTitle>
          <DialogDescription>{LONG_AR}</DialogDescription>
        </DialogHeader>
        <div className="form-scroll"><KitchenSinkForm label="سؤال" /></div>
        <DialogFooter>
          <Button variant="ghost">إلغاء</Button>
          <Button>حفظ</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
  "dialog-long": (
    <Dialog open modal={false}>
      <DialogContent className="sm:max-w-lg" data-testid="dialog-panel">
        <DialogHeader><DialogTitle>فورم طويل جداً</DialogTitle></DialogHeader>
        <div className="form-scroll">
          {[0, 1, 2, 3, 4].map((i) => <KitchenSinkForm key={i} label={`قسم ${i + 1}`} />)}
        </div>
        <DialogFooter><Button>حفظ</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  ),
  "sheet-form": (
    <Sheet open modal={false}>
      <SheetContent side="right" data-testid="sheet-panel">
        <SheetHeader><SheetTitle>ملف الطالب</SheetTitle></SheetHeader>
        <div className="p-4 overflow-y-auto"><KitchenSinkForm label="بيانات" /></div>
      </SheetContent>
    </Sheet>
  ),
  "drawer-form": (
    <Drawer open modal={false}>
      <DrawerContent data-testid="drawer-panel">
        <DrawerHeader><DrawerTitle>تعديل سريع</DrawerTitle></DrawerHeader>
        <div className="p-4 overflow-y-auto"><KitchenSinkForm label="تعديل" /></div>
      </DrawerContent>
    </Drawer>
  ),
  "kodgy": <KodgyScene />,
};

/** Detail scene: the REAL workflow with a lesson pre-selected via the store. */
function SessionDetailScene() {
  React.useEffect(() => {
    useApp.setState({ navParam: "l1" });
    const locale = new URLSearchParams(location.search).get("locale") === "en" ? "en" : "ar";
    useApp.getState().setLocale(locale);
  }, []);
  return (
    <div className="w-full max-w-6xl mx-auto"><SessionWorkflowView /></div>
  );
}

/** Kodgy scene: the REAL floating assistant, with a fake logged-in user. */
function KodgyScene() {
  React.useEffect(() => {
    // The shell only mounts Kodgy after a session exists; mirror that here.
    useApp.setState({
      user: {
        id: "visual-test-student",
        email: "student@codemind.academy",
        name: "Ahmed Hassan",
        role: "STUDENT",
      },
      view: "student-dashboard",
    });
    const locale = new URLSearchParams(location.search).get("locale") === "en" ? "en" : "ar";
    useApp.getState().setLocale(locale);
  }, []);
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <KodgyAssistant />
    </div>
  );
}

function App() {
  const params = new URLSearchParams(location.search);
  const scene = params.get("scene") || "login";
  return (
    <div className="min-h-dvh bg-background text-foreground p-4 sm:p-6">
      <div id="scene-root">{SCENES[scene] ?? <p>unknown scene: {scene}</p>}</div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
