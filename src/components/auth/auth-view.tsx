"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useApp } from "@/lib/store";
import { CodeMindLogo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import {
  ChevronRight,
  Mail,
  Lock,
  User as UserIcon,
  Phone,
  GraduationCap,
  Heart,
  Briefcase,
  Shield,
  Rocket,
  CheckCircle2,
} from "lucide-react";
import { brand } from "@/lib/brand";

type Role = "STUDENT" | "PARENT" | "TEACHER" | "ADMIN";

export function AuthView() {
  const view = useApp((s) => s.view);
  const setUser = useApp((s) => s.setUser);
  const setView = useApp((s) => s.setView);

  const [mode, setMode] = React.useState<"login" | "register">(
    view === "register" ? "register" : "login"
  );
  React.useEffect(() => {
    setMode(view === "register" ? "register" : "login");
  }, [view]);

  return (
    <div className="flex-1 flex items-stretch">
      <div className="w-full grid lg:grid-cols-2 min-h-[calc(100vh-5rem)]">
        {/* Left: form */}
        <div className="flex items-center justify-center p-6 sm:p-10">
          <div className="w-full max-w-md">
            <button
              onClick={() => setView("landing")}
              className="text-sm text-muted-foreground hover:text-foreground mb-6 inline-flex items-center gap-1"
            >
              <ChevronRight className="w-4 h-4" />
              رجوع للرئيسية
            </button>

            <div className="mb-6">
              <CodeMindLogo withWordmark size={40} />
            </div>

            <h1 className="text-2xl font-extrabold mb-1">
              {mode === "login" ? "أهلاً بعودتك 👋" : "اخلق حسابك"}
            </h1>
            <p className="text-sm text-muted-foreground mb-6">
              {mode === "login"
                ? "ادخل بياناتك عشان تكمّل من حيث ما وقفت."
                : "اختار نوع الحساب وادخل بياناتك عشان تبدأ."}
            </p>

            {mode === "register" && <RolePicker />}

            <AuthForm mode={mode} />

            <div className="mt-6 text-center text-sm text-muted-foreground">
              {mode === "login" ? (
                <>
                  ماعندكش حساب؟{" "}
                  <button
                    onClick={() => setMode("register")}
                    className="text-primary font-semibold hover:underline"
                  >
                    اعمل واحد
                  </button>
                </>
              ) : (
                <>
                  عندك حساب بالفعل؟{" "}
                  <button
                    onClick={() => setMode("login")}
                    className="text-primary font-semibold hover:underline"
                  >
                    ادخل
                  </button>
                </>
              )}
            </div>

            {/* Demo accounts helper */}
            <div className="mt-6 rounded-xl bg-muted/40 border border-border/40 p-3 text-xs">
              <div className="font-semibold mb-1.5">حسابات تجريبية:</div>
              <div className="space-y-1 text-muted-foreground">
                <DemoAccount label="Student" email="student@codemind.academy" />
                <DemoAccount label="Parent" email="parent@codemind.academy" />
                <DemoAccount label="Teacher" email="teacher@codemind.academy" />
                <DemoAccount label="Admin" email="admin@codemind.academy" />
              </div>
              <div className="mt-1.5 text-[10px] text-muted-foreground">
                (كلمة السر لكل الحسابات: اسم الحساب + 123)
              </div>
            </div>
          </div>
        </div>

        {/* Right: visual */}
        <AuthAside />
      </div>
    </div>
  );
}

function DemoAccount({ label, email }: { label: string; email: string }) {
  const setUser = useApp((s) => s.setUser);
  const setView = useApp((s) => s.setView);
  return (
    <button
      className="block w-full text-right hover:text-foreground transition-colors"
      onClick={async () => {
        const password =
          (email.split("@")[0] || "user") + "123";
        const r = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const data = await r.json();
        if (!r.ok) {
          toast.error(data.error || "فشل تسجيل الدخول");
          return;
        }
        toast.success("تم تسجيل الدخول بنجاح");
        setUser(data.user);
        setView(homeFor(data.user.role));
      }}
    >
      → <span className="font-mono">{email}</span>{" "}
      <span className="opacity-60">({label})</span>
    </button>
  );
}

function homeFor(role: Role) {
  switch (role) {
    case "STUDENT":
      return "student-dashboard" as const;
    case "PARENT":
      return "parent-dashboard" as const;
    case "TEACHER":
      return "teacher-dashboard" as const;
    case "ADMIN":
      return "admin-overview" as const;
  }
}

function RolePicker() {
  const [role, setRole] = React.useState<Role>("STUDENT");
  // Expose via window for the form to read
  React.useEffect(() => {
    (window as any).__cm_role = role;
  }, [role]);

  const roles: { key: Role; label: string; icon: any; desc: string }[] = [
    { key: "STUDENT", label: "Student", icon: GraduationCap, desc: "طالب" },
    { key: "PARENT", label: "Parent", icon: Heart, desc: "ولي أمر" },
    { key: "TEACHER", label: "Teacher", icon: Briefcase, desc: "معلم" },
  ];
  return (
    <div className="grid grid-cols-3 gap-2 mb-5">
      {roles.map((r) => (
        <button
          key={r.key}
          type="button"
          onClick={() => setRole(r.key)}
          className={`rounded-xl border-2 px-3 py-3 text-center transition-all ${
            role === r.key
              ? "border-primary bg-primary/5 shadow-sm"
              : "border-border bg-card hover:border-primary/40"
          }`}
        >
          <r.icon
            className={`w-5 h-5 mx-auto mb-1.5 ${
              role === r.key ? "text-primary" : "text-muted-foreground"
            }`}
          />
          <div className="text-xs font-bold">{r.label}</div>
          <div className="text-[10px] text-muted-foreground">{r.desc}</div>
        </button>
      ))}
    </div>
  );
}

function AuthForm({ mode }: { mode: "login" | "register" }) {
  const setUser = useApp((s) => s.setUser);
  const setView = useApp((s) => s.setView);
  const [loading, setLoading] = React.useState(false);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const payload: any = {
      email: fd.get("email"),
      password: fd.get("password"),
    };
    if (mode === "register") {
      payload.name = fd.get("name");
      payload.phone = fd.get("phone");
      payload.role = (window as any).__cm_role || "STUDENT";
    }
    setLoading(true);
    try {
      const r = await fetch(
        mode === "login" ? "/api/auth/login" : "/api/auth/register",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const data = await r.json();
      if (!r.ok) {
        toast.error(data.error || "حصلت مشكلة. حاول تاني.");
        return;
      }
      toast.success(mode === "login" ? "أهلاً بعودتك!" : "تم إنشاء حسابك 🎉");
      setUser(data.user);
      setView(homeFor(data.user.role));
    } catch {
      toast.error("حصلت مشكلة في الاتصال. حاول تاني.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      {mode === "register" && (
        <Field
          name="name"
          label="الاسم"
          icon={<UserIcon className="w-4 h-4" />}
          placeholder="الاسم الكامل"
          required
        />
      )}
      <Field
        name="email"
        type="email"
        label="البريد الإلكتروني"
        icon={<Mail className="w-4 h-4" />}
        placeholder="you@example.com"
        required
      />
      {mode === "register" && (
        <Field
          name="phone"
          label="رقم التليفون"
          icon={<Phone className="w-4 h-4" />}
          placeholder="+20 100 000 0000"
        />
      )}
      <Field
        name="password"
        type="password"
        label="كلمة السر"
        icon={<Lock className="w-4 h-4" />}
        placeholder="••••••••"
        required
      />

      <Button
        type="submit"
        disabled={loading}
        className="w-full h-11 font-bold mt-2"
      >
        {loading ? (
          <span className="inline-flex items-center gap-2">
            <span className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />
            استنى شوية…
          </span>
        ) : mode === "login" ? (
          "ادخل"
        ) : (
          "اعمل حسابي"
        )}
      </Button>
    </form>
  );
}

function Field({
  name,
  label,
  icon,
  type = "text",
  placeholder,
  required,
}: {
  name: string;
  label: string;
  icon: React.ReactNode;
  type?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={name} className="text-xs font-semibold">
        {label}
      </Label>
      <div className="relative">
        <div className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
          {icon}
        </div>
        <Input
          id={name}
          name={name}
          type={type}
          placeholder={placeholder}
          required={required}
          className="h-11 pr-10"
        />
      </div>
    </div>
  );
}

function AuthAside() {
  return (
    <div className="hidden lg:flex items-center justify-center bg-gradient-to-br from-primary via-teal-500 to-amber-500 relative overflow-hidden p-10">
      <div className="absolute inset-0 bg-grid opacity-20" />
      <div className="absolute -top-20 -right-20 w-96 h-96 rounded-full bg-white/10 blur-3xl" />
      <div className="absolute -bottom-20 -left-20 w-96 h-96 rounded-full bg-white/10 blur-3xl" />

      <div className="relative text-white max-w-md">
        <Rocket className="w-10 h-10 mb-4" />
        <h2 className="text-3xl font-extrabold leading-tight">
          اتعلم Programming & AI
          <br />
          من مكان واحد.
        </h2>
        <p className="mt-4 text-white/90 leading-relaxed">
          Live Classes · Quizzes · Homework · PDFs · Reports · Parent Dashboard.
          كل اللي محتاجه عشان تنجح.
        </p>

        <ul className="mt-8 space-y-3 text-sm">
          {[
            "منهج Programming & AI كامل",
            "Live Classes + Recordings",
            "تقارير شهرية ومتابعة الأهل",
            "Quizzes أوتوماتيك التصحيح",
          ].map((it) => (
            <li key={it} className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" />
              {it}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
