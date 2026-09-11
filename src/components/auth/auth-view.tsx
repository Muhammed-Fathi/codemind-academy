"use client";

import * as React from "react";
import { useApp } from "@/lib/store";
import { getStrings , useT, pickAuto } from "@/lib/i18n";
import { CodeMindLogo } from "@/components/logo";
import { GlobalControls } from "@/components/global-controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  Rocket,
  CheckCircle2,
  IdCard,
  School,
  Hash,
  Copy,
} from "lucide-react";
import { brand } from "@/lib/brand";
import {
  isValidArabicThreePartName,
  isValidEgyptianPhone,
  isValidNationalId,
  isValidStudentCode,
  isValidThreePartName,
} from "@/lib/registration";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

type Role = "STUDENT" | "PARENT" | "TEACHER" | "ADMIN";

export function AuthView() {
  const tr = useT();
  const view = useApp((s) => s.view);
  const locale = useApp((s) => s.locale);
  const t = getStrings(locale);
  const setView = useApp((s) => s.setView);

  // "forgot" is a third client-side mode reusing the same auth shell.
  // Arriving from an emailed password-reset link (/?token=…) opens the
  // forgot/reset form directly so the token is pre-filled.
  const hasResetToken =
    view === "login" &&
    typeof window !== "undefined" &&
    Boolean(new URLSearchParams(window.location.search).get("token"));
  // Phase 20 — arriving from the teacher-application approval email
  // (/?teacherActivation=…) opens the activation form (set your own password).
  const hasActivationToken =
    view === "login" &&
    typeof window !== "undefined" &&
    Boolean(new URLSearchParams(window.location.search).get("teacherActivation"));
  const [mode, setMode] = React.useState<"login" | "register" | "forgot" | "activate">(() =>
    view === "register"
      ? "register"
      : hasResetToken
        ? "forgot"
        : hasActivationToken
          ? "activate"
          : "login"
  );
  const [role, setRole] = React.useState<Role>("STUDENT");
  // Adjust mode when the parent switches between login/register. Never
  // overwrite the reset mode: the URL token must survive view changes.
  const [prevView, setPrevView] = React.useState(view);
  if (prevView !== view) {
    setPrevView(view);
    if (!hasResetToken) setMode(view === "register" ? "register" : "login");
  }

  return (
    <div className="flex-1 flex items-stretch">
      <div className="w-full grid lg:grid-cols-2 min-h-dvh">
        {/* Left: form */}
        <div className="flex items-center justify-center p-6 sm:p-10">
          <div className="w-full max-w-md">
            <div className="flex items-center justify-between mb-6">
              <button
                onClick={() => setView("landing")}
                className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              >
                <ChevronRight className="w-4 h-4" />
                {t.nav.backHome}
              </button>
              {/* Theme + language — available pre-login (public pages) */}
              <GlobalControls />
            </div>

            <div className="mb-6">
              <CodeMindLogo withWordmark size={40} />
            </div>

            <h1 className="text-2xl font-extrabold mb-1">
              {mode === "forgot"
                ? tr("auth.201")
                : mode === "activate"
                  ? tr("auth.220")
                  : mode === "login"
                    ? t.auth.welcomeBack
                    : t.auth.createAccount}
            </h1>
            <p className="text-sm text-muted-foreground mb-6">
              {mode === "forgot"
                ? tr("auth.202")
                : mode === "activate"
                  ? tr("auth.221")
                  : mode === "login"
                    ? t.auth.loginHint
                    : t.auth.registerHint}
            </p>

            {mode === "register" && <RolePicker role={role} onChange={setRole} />}

            {mode === "forgot" ? (
              <ForgotPasswordForm onBackToLogin={() => setMode("login")} />
            ) : mode === "activate" ? (
              <TeacherActivationForm onDone={() => setMode("login")} />
            ) : (
              <>
                <AuthForm mode={mode} role={role} />
                {mode === "login" && (
                  <button
                    type="button"
                    onClick={() => setMode("forgot")}
                    className="mt-3 w-full text-center text-xs font-semibold text-primary hover:underline"
                  >
                    {tr("auth.200")}
                  </button>
                )}
              </>
            )}

            <div className="mt-6 text-center text-sm text-muted-foreground">
              {mode === "forgot" ? null : mode === "login" ? (
                <>
                  {t.auth.noAccount}{" "}
                  <button
                    onClick={() => setMode("register")}
                    className="text-primary font-semibold hover:underline"
                  >
                    {t.auth.makeOne}
                  </button>
                </>
              ) : (
                <>
                  {t.auth.haveAccount}{" "}
                  <button
                    onClick={() => setMode("login")}
                    className="text-primary font-semibold hover:underline"
                  >
                    {t.auth.doLogin}
                  </button>
                </>
              )}
            </div>

            {/* Support / contact line (public) */}
            <div className="mt-6 rounded-xl bg-muted/40 border border-border/40 p-3 text-xs text-center text-muted-foreground">
              {t.auth.contactSupport}:{" "}
              <a
                href={`tel:${brand.contact.phone.replace(/[^+0-9]/g, "")}`}
                className="font-bold text-foreground hover:text-primary transition-colors"
                dir="ltr"
              >
                {brand.contact.phone}
              </a>
            </div>
          </div>
        </div>

        {/* Right: visual */}
        <AuthAside />
      </div>
    </div>
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

function RolePicker({ role, onChange }: { role: Role; onChange: (r: Role) => void }) {
  const tr = useT();
  const roles: { key: Role; label: string; icon: any; desc: string }[] = [
    { key: "STUDENT", label: "Student", icon: GraduationCap, desc: tr("auth.001") },
    { key: "PARENT", label: "Parent", icon: Heart, desc: tr("auth.002") },
    { key: "TEACHER", label: "Teacher", icon: Briefcase, desc: tr("auth.003") },
  ];
  return (
    <div className="grid grid-cols-3 gap-2 mb-5">
      {roles.map((r) => (
        <button
          key={r.key}
          type="button"
          onClick={() => onChange(r.key)}
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

function AuthForm({ mode, role }: { mode: "login" | "register"; role: Role }) {
  const tr = useT();
  const setUser = useApp((s) => s.setUser);
  const setView = useApp((s) => s.setView);
  const locale = useApp((s) => s.locale);
  const t = getStrings(locale);
  const [loading, setLoading] = React.useState(false);
  const [schoolType, setSchoolType] = React.useState("");
  const [createdCode, setCreatedCode] = React.useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const email = String(fd.get("email") || "").trim();
    const password = String(fd.get("password") || "");

    if (mode === "login") {
      if (!email || !password) {
        toast.error(locale === "ar" ? tr("auth.004") : "Enter email and password");
        return;
      }
      setLoading(true);
      try {
        const r = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const data = await r.json();
        if (!r.ok) {
          toast.error(data.error || tr("auth.005"));
          return;
        }
        toast.success(locale === "ar" ? tr("auth.006") : "Welcome back!");
        setUser(data.user);
        setView(homeFor(data.user.role));
      } catch {
        toast.error(tr("auth.007"));
      } finally {
        setLoading(false);
      }
      return;
    }

    // ---------- register ----------
    const name = String(fd.get("name") || "").trim();
    const payload: any = { email, password, name, role };

    if (role === "STUDENT") {
      const studentPhone = String(fd.get("studentPhone") || "").trim();
      const parentPhone = String(fd.get("parentPhone") || "").trim();
      const nationalId = String(fd.get("nationalId") || "").trim();
      const schoolName = String(fd.get("schoolName") || "").trim();
      if (!isValidArabicThreePartName(name)) {
        toast.error(tr("auth.008"));
        return;
      }
      if (!isValidEgyptianPhone(studentPhone)) {
        toast.error(tr("auth.009"));
        return;
      }
      if (!isValidEgyptianPhone(parentPhone)) {
        toast.error(tr("auth.010"));
        return;
      }
      if (!isValidNationalId(nationalId)) {
        toast.error(tr("auth.011"));
        return;
      }
      if (!schoolName) {
        toast.error(tr("auth.012"));
        return;
      }
      if (schoolType !== "LANGUAGE" && schoolType !== "ARABIC") {
        toast.error(tr("auth.013"));
        return;
      }
      Object.assign(payload, { studentPhone, parentPhone, nationalId, schoolName, schoolType });
    } else if (role === "PARENT") {
      const parentPhone = String(fd.get("parentPhone") || "").trim();
      const studentNationalId = String(fd.get("studentNationalId") || "").trim();
      const studentCode = String(fd.get("studentCode") || "").trim().toUpperCase();
      if (!isValidThreePartName(name)) {
        toast.error(tr("auth.014"));
        return;
      }
      if (!isValidEgyptianPhone(parentPhone)) {
        toast.error(tr("auth.010"));
        return;
      }
      if (!isValidNationalId(studentNationalId)) {
        toast.error(tr("auth.016"));
        return;
      }
      if (!isValidStudentCode(studentCode)) {
        toast.error(tr("auth.017"));
        return;
      }
      Object.assign(payload, { parentPhone, studentNationalId, studentCode });
    } else {
      // Phase 20 — TEACHER: submit a PENDING application (no password, no
      // session, no active account). The applicant sets their own password
      // later, after an Admin approves, via the emailed activation link.
      const phone = String(fd.get("phone") || "").trim();
      if (!name) {
        toast.error(tr("auth.018"));
        return;
      }
      if (phone && !isValidEgyptianPhone(phone)) {
        toast.error(tr("auth.009"));
        return;
      }
      if (phone) payload.phone = phone;
      delete payload.password;
    }

    setLoading(true);
    try {
      const r = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) {
        toast.error(data.error || tr("auth.005"));
        return;
      }
      // Teacher application: NO account and NO session is returned. Stay on
      // the auth shell and tell the applicant to expect the activation email.
      if (data.applied) {
        toast.success(tr("api.259"));
        setMode("login");
        return;
      }
      if (data.user?.studentCode) setCreatedCode(data.user.studentCode);
      toast.success(locale === "ar" ? tr("auth.020") : "Account created 🎉");
      setUser(data.user);
      setView(homeFor(data.user.role));
    } catch {
      toast.error(tr("auth.007"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {createdCode && (
        <StudentCodeBanner code={createdCode} onDismiss={() => setCreatedCode(null)} />
      )}
      <form onSubmit={onSubmit} className="space-y-3">
        {mode === "register" && role === "STUDENT" && (
          <>
            <Field
              name="name"
              label={t.auth.fullNameAr}
              icon={<UserIcon className="w-4 h-4" />}
              placeholder={tr("auth.022")}
              required
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field
                name="studentPhone"
                label={t.auth.studentPhone}
                icon={<Phone className="w-4 h-4" />}
                placeholder="01147422177"
                dir="ltr"
                required
              />
              <Field
                name="parentPhone"
                label={t.auth.parentPhone}
                icon={<Phone className="w-4 h-4" />}
                placeholder="01147422177"
                dir="ltr"
                required
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field
                name="nationalId"
                label={t.auth.nationalId}
                icon={<IdCard className="w-4 h-4" />}
                placeholder={tr("auth.023")}
                dir="ltr"
                required
              />
              <Field
                name="schoolName"
                label={t.auth.schoolName}
                icon={<School className="w-4 h-4" />}
                placeholder={tr("auth.024")}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">{t.auth.schoolType} *</Label>
              <Select value={schoolType} onValueChange={setSchoolType}>
                <SelectTrigger className="h-11">
                  <SelectValue placeholder={tr("auth.025")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="LANGUAGE">{t.auth.schoolTypeLang} (Language)</SelectItem>
                  <SelectItem value="ARABIC">{t.auth.schoolTypeAr} (Arabic)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </>
        )}

        {mode === "register" && role === "PARENT" && (
          <>
            <Field
              name="name"
              label={t.auth.fullName}
              icon={<UserIcon className="w-4 h-4" />}
              placeholder={tr("auth.026")}
              required
            />
            <Field
              name="parentPhone"
              label={t.auth.parentPhone}
              icon={<Phone className="w-4 h-4" />}
              placeholder="01147422177"
              dir="ltr"
              required
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field
                name="studentNationalId"
                label={t.auth.studentNationalId}
                icon={<IdCard className="w-4 h-4" />}
                placeholder={tr("auth.023")}
                dir="ltr"
                required
              />
              <Field
                name="studentCode"
                label={t.auth.studentCode}
                icon={<Hash className="w-4 h-4" />}
                placeholder="CM-XXXXXX"
                dir="ltr"
                required
              />
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {tr("auth.028")}</p>
          </>
        )}

        {mode === "register" && role === "TEACHER" && (
          <>
            <Field
              name="name"
              label={t.auth.fullName}
              icon={<UserIcon className="w-4 h-4" />}
              placeholder={tr("auth.029")}
              required
            />
            {/* Teacher's own contact phone. Stored on User.phone (see the
                TEACHER/ADMIN branch of /api/auth/register). Label is the
                teacher's phone — NOT the student/parent phone strings. */}
            <Field
              name="phone"
              label={t.auth.phone}
              icon={<Phone className="w-4 h-4" />}
              placeholder="01xxxxxxxxx"
              dir="ltr"
            />
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {tr("auth.218")}</p>
          </>
        )}

        <Field
          name="email"
          type="email"
          label={t.auth.email}
          icon={<Mail className="w-4 h-4" />}
          placeholder="you@example.com"
          dir="ltr"
          required
        />
        {/* Phase 20 — a teacher APPLICATION carries no password: the applicant
            sets their own only after admin approval, via the activation link. */}
        {!(mode === "register" && role === "TEACHER") && (
          <PasswordField label={t.auth.password} />
        )}

        <Button
          type="submit"
          disabled={loading}
          className="w-full h-11 font-bold mt-2"
        >
          {loading ? (
            <span className="inline-flex items-center gap-2">
              <span className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />
              {t.auth.loading}
            </span>
          ) : mode === "login" ? (
            t.auth.enter
          ) : mode === "register" && role === "TEACHER" ? (
            tr("auth.219")
          ) : (
            t.auth.create
          )}
        </Button>
      </form>
    </>
  );
}

function TeacherActivationForm({ onDone }: { onDone: () => void }) {
  const tr = useT();
  const [loading, setLoading] = React.useState(false);
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");

  const token =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("teacherActivation") || ""
      : "";

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (password.length < 8) {
      toast.error(tr("api.204"));
      return;
    }
    if (password !== confirm) {
      toast.error(tr("auth.222"));
      return;
    }
    setLoading(true);
    try {
      const r = await fetch("/api/auth/teacher-activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await r.json();
      if (!r.ok) {
        toast.error(data.error || tr("auth.005"));
        return;
      }
      toast.success(tr("api.262"));
      onDone();
    } catch {
      toast.error(tr("auth.007"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs font-semibold">{tr("auth.224")}</Label>
        <PasswordInput
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          dir="ltr"
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs font-semibold">{tr("auth.225")}</Label>
        <PasswordInput
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="••••••••"
          dir="ltr"
        />
      </div>
      <Button type="submit" disabled={loading} className="w-full h-11 font-bold mt-2">
        {loading ? tr("auth.007") : tr("auth.223")}
      </Button>
    </form>
  );
}

function StudentCodeBanner({ code, onDismiss }: { code: string; onDismiss: () => void }) {
  const tr = useT();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success(tr("auth.030"));
    } catch {
      toast.error(tr("auth.031"));
    }
  };
  return (
    <div className="mb-4 rounded-xl border border-primary/30 bg-primary/5 p-4">
      <div className="flex items-center gap-2 text-sm font-bold text-primary">
        <CheckCircle2 className="w-4 h-4" />
        {tr("auth.032")}</div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <code className="text-xl font-black tracking-widest font-mono" dir="ltr">
          {code}
        </code>
        <Button type="button" size="sm" variant="outline" onClick={copy}>
          <Copy className="w-3.5 h-3.5 ms-1" />
          {tr("auth.033")}</Button>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        {tr("auth.034")}</p>
      <button onClick={onDismiss} className="mt-1 text-[11px] text-muted-foreground hover:text-foreground">
        {tr("auth.035")}</button>
    </div>
  );
}

function PasswordField({ label }: { label: string }) {
  const locale = useApp((s) => s.locale);
  const t = getStrings(locale);
  return (
    <div className="space-y-1.5">
      <Label htmlFor="password" className="text-xs font-semibold">
        {label}
      </Label>
      <div className="relative">
        <div className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none">
          <Lock className="w-4 h-4" />
        </div>
        <PasswordInput
          id="password"
          name="password"
          placeholder="••••••••"
          required
          showLabel={t.auth.showPassword}
          hideLabel={t.auth.hidePassword}
          className="h-11 pe-10"
        />
      </div>
    </div>
  );
}

function Field({
  name,
  label,
  icon,
  type = "text",
  placeholder,
  required,
  dir,
}: {
  name: string;
  label: string;
  icon: React.ReactNode;
  type?: string;
  placeholder?: string;
  required?: boolean;
  dir?: "ltr" | "rtl";
}) {
  if (type === "password") {
    return <PasswordField label={label} />;
  }
  return (
    <div className="space-y-1.5">
      <Label htmlFor={name} className="text-xs font-semibold">
        {label}
        {required ? " *" : ""}
      </Label>
      <div className="relative" dir={dir}>
        <div className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none">
          {icon}
        </div>
        <Input
          id={name}
          name={name}
          type={type}
          placeholder={placeholder}
          required={required}
          dir={dir}
          className="h-11 pe-10"
        />
      </div>
    </div>
  );
}

function AuthAside() {
  const tr = useT();
  return (
    <div className="hidden lg:flex items-center justify-center bg-gradient-to-br from-primary via-teal-500 to-amber-500 relative overflow-hidden p-10">
      <div className="absolute inset-0 bg-grid opacity-20" />
      <div className="absolute -top-20 -end-20 w-96 h-96 rounded-full bg-white/10 blur-3xl" />
      <div className="absolute -bottom-20 -start-20 w-96 h-96 rounded-full bg-white/10 blur-3xl" />

      <div className="relative text-white max-w-md">
        <Rocket className="w-10 h-10 mb-4" />
        <h2 className="text-3xl font-extrabold leading-tight">
          {tr("auth.036")}<br />
          {tr("auth.037")}</h2>
        <p className="mt-4 text-white/90 leading-relaxed">
          {tr("auth.038")}</p>

        <ul className="mt-8 space-y-3 text-sm">
          {[
            tr("auth.039"),
            "Live Classes + Recordings",
            tr("auth.040"),
            tr("auth.041"),
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
