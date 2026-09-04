"use client";
import { useT , pickAuto } from "@/lib/i18n";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useApp, homeViewForRole } from "@/lib/store";
import { CodeMindLogo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { brand, whatsappLink } from "@/lib/brand";
import {
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  CreditCard,
  Users,
  BookOpen,
  Trophy,
  Rocket,
  Loader2,
  ShieldCheck,
  Wallet,
  Ticket,
  AlertTriangle,
} from "lucide-react";

type Step = 0 | 1 | 2 | 3 | 4;

type Course = {
  id: string;
  name: string;
  nameAr: string;
  description: string;
  color: string;
};

type Group = {
  id: string;
  name: string;
  capacity: number;
  schedule: string;
  _count?: { students: number };
};

type Plan = {
  id: string;
  name: string;
  nameAr: string;
  durationMonths: number;
  price: number;
  isPromo: boolean;
  description?: string | null;
};

const METHODS = [
  {
    key: "INSTAPAY",
    label: "InstaPay",
    color: "from-rose-500 to-pink-500",
    desc: "auth.042",
    number: brand.payments.instapay,
    disabled: false,
  },
  {
    key: "VODAFONE_CASH",
    label: "Vodafone Cash",
    color: "from-red-500 to-rose-500",
    desc: "auth.043",
    number: null,
    disabled: true,
  },
  {
    key: "ETISALAT_CASH",
    label: "e& Cash",
    color: "from-emerald-500 to-teal-500",
    desc: "auth.044",
    number: brand.payments.eCash,
    disabled: false,
  },
];

export function EnrollView() {
  const t = useT();
  const user = useApp((s) => s.user);
  const setView = useApp((s) => s.setView);
  const [step, setStep] = React.useState<Step>(0);

  const [courseId, setCourseId] = React.useState<string | null>(null);
  const [groupId, setGroupId] = React.useState<string | null>(null);
  const [planId, setPlanId] = React.useState<string | null>(null);
  const [method, setMethod] = React.useState<string | null>(null);
  const [reference, setReference] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [couponCode, setCouponCode] = React.useState("");
  const [couponResult, setCouponResult] = React.useState<any>(null);
  const [validatingCoupon, setValidatingCoupon] = React.useState(false);

  const validateCoupon = async () => {
    if (!couponCode.trim() || !planId) return;
    setValidatingCoupon(true);
    try {
      const plan = await fetch(`/api/subscription-plans`).then((r) => r.json());
      const selectedPlan = plan.plans?.find((p: any) => p.id === planId);
      const originalPrice = selectedPlan?.price || 200;
      const r = await fetch("/api/coupons/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: couponCode, originalPrice }),
      });
      const d = await r.json();
      if (!r.ok) {
        setCouponResult({ valid: false, error: d.error });
      } else {
        setCouponResult(d);
        toast.success(t("auth.045", { p1: d.discount }));
      }
    } catch {
      setCouponResult({ valid: false, error: t("auth.046") });
    } finally {
      setValidatingCoupon(false);
    }
  };

  const steps = [
    { n: 1, label: t("auth.047"), icon: BookOpen },
    { n: 2, label: t("auth.048"), icon: Users },
    { n: 3, label: t("auth.049"), icon: Trophy },
    { n: 4, label: t("auth.050"), icon: CreditCard },
    { n: 5, label: t("auth.051"), icon: ShieldCheck },
  ];

  return (
    <div className="flex-1 flex items-center justify-center p-6 sm:p-10">
      <div className="w-full max-w-3xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <button
            onClick={() => setView("student-dashboard")}
            className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <ChevronRight className="w-4 h-4" />
            {t("auth.052")}</button>
          <CodeMindLogo size={32} />
        </div>

        <div className="mb-8">
          <h1 className="text-2xl font-extrabold">{t("auth.053")}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t("auth.054")}</p>
        </div>

        {/* Stepper */}
        <div className="mb-8 flex items-center justify-between">
          {steps.map((s, i) => {
            const done = step > i;
            const active = step === i;
            return (
              <React.Fragment key={s.n}>
                <div className="flex flex-col items-center gap-2">
                  <div
                    className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${
                      done
                        ? "bg-primary text-primary-foreground"
                        : active
                        ? "bg-primary/15 text-primary ring-2 ring-primary/30"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {done ? (
                      <CheckCircle2 className="w-5 h-5" />
                    ) : (
                      <s.icon className="w-5 h-5" />
                    )}
                  </div>
                  <div className="text-[10px] sm:text-xs font-medium text-center">
                    {s.label}
                  </div>
                </div>
                {i < steps.length - 1 && (
                  <div
                    className={`flex-1 h-0.5 mx-2 rounded-full transition-all ${
                      step > i ? "bg-primary" : "bg-muted"
                    }`}
                  />
                )}
              </React.Fragment>
            );
          })}
        </div>

        <AnimatePresence mode="wait">
          {/* Step 1: course */}
          {step === 0 && (
            <StepCard key="course">
              <CoursePicker
                value={courseId}
                onChange={(id) => {
                  setCourseId(id);
                  setStep(1);
                }}
              />
            </StepCard>
          )}

          {/* Step 2: group */}
          {step === 1 && (
            <StepCard key="group">
              <GroupPicker
                courseId={courseId!}
                value={groupId}
                onChange={setGroupId}
              />
              <NavRow
                onBack={() => setStep(0)}
                onNext={() => groupId && setStep(2)}
                disabled={!groupId}
              />
            </StepCard>
          )}

          {/* Step 3: plan */}
          {step === 2 && (
            <StepCard key="plan">
              <PlanPicker value={planId} onChange={setPlanId} />
              <NavRow
                onBack={() => setStep(1)}
                onNext={() => planId && setStep(3)}
                disabled={!planId}
              />
            </StepCard>
          )}

          {/* Step 4: payment */}
          {step === 3 && (
            <StepCard key="pay">
              <PaymentPicker
                method={method}
                setMethod={setMethod}
                reference={reference}
                setReference={setReference}
                couponCode={couponCode}
                setCouponCode={setCouponCode}
                couponResult={couponResult}
                validateCoupon={validateCoupon}
                validatingCoupon={validatingCoupon}
              />
              <NavRow
                onBack={() => setStep(2)}
                onNext={() => method && setStep(4)}
                disabled={!method}
              />
            </StepCard>
          )}

          {/* Step 5: confirmation */}
          {step === 4 && (
            <StepCard key="confirm">
              <ConfirmCard
                courseId={courseId}
                groupId={groupId}
                planId={planId}
                method={method}
                reference={reference}
                submitting={submitting}
                couponResult={couponResult}
                onSubmit={async () => {
                  setSubmitting(true);
                  try {
                    const r = await fetch("/api/enroll", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        courseId,
                        groupId,
                        planId,
                        method,
                        reference,
                        couponCode: couponResult?.valid ? couponCode : undefined,
                      }),
                    });
                    const data = await r.json();
                    if (!r.ok) {
                      toast.error(data.error || t("auth.055"));
                      return;
                    }
                    toast.success(t("auth.056"));
                    setView("student-dashboard");
                  } catch {
                    toast.error(t("auth.057"));
                  } finally {
                    setSubmitting(false);
                  }
                }}
                onBack={() => setStep(3)}
              />
            </StepCard>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function StepCard({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.3 }}
    >
      {children}
    </motion.div>
  );
}

function NavRow({
  onBack,
  onNext,
  disabled,
}: {
  onBack: () => void;
  onNext: () => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <div className="mt-6 flex items-center justify-between">
      <Button variant="ghost" onClick={onBack}>
        <ChevronRight className="w-4 h-4 ms-1" />
        {t("auth.058")}</Button>
      <Button onClick={onNext} disabled={disabled} className="font-bold">
        {t("auth.059")}<ChevronLeft className="w-4 h-4 me-1" />
      </Button>
    </div>
  );
}

/* ------------------------------- COURSE PICKER ----------------------------- */
function CoursePicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (id: string) => void;
}) {
  const t = useT();
  const [courses, setCourses] = React.useState<Course[]>([]);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    fetch("/api/courses")
      .then((r) => r.json())
      .then((d) => setCourses(d.courses || []))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <SkeletonGrid />;

  return (
    <div>
      <h2 className="text-lg font-bold mb-1">{t("auth.060")}</h2>
      <p className="text-sm text-muted-foreground mb-5">
        {t("auth.061")}</p>
      <div className="grid sm:grid-cols-2 gap-4">
        {courses.map((c) => (
          <button
            key={c.id}
            onClick={() => onChange(c.id)}
            className={`text-end rounded-2xl p-5 border-2 transition-all ${
              value === c.id
                ? "border-primary bg-primary/5 shadow-md"
                : "border-border bg-card hover:border-primary/40"
            }`}
          >
            <div
              className="w-12 h-12 rounded-xl mb-3"
              style={{ background: c.color }}
            />
            <div className="font-bold">{pickAuto(c.nameAr, c.name)}</div>
            <div className="text-xs text-muted-foreground mt-1">{c.name}</div>
            <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
              {c.description}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------- GROUP PICKER ------------------------------ */
function GroupPicker({
  courseId,
  value,
  onChange,
}: {
  courseId: string;
  value: string | null;
  onChange: (id: string) => void;
}) {
  const t = useT();
  const [groups, setGroups] = React.useState<Group[]>([]);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    fetch(`/api/groups?courseId=${encodeURIComponent(courseId)}`)
      .then((r) => r.json())
      .then((d) => setGroups(d.groups || []))
      .finally(() => setLoading(false));
  }, [courseId]);

  if (loading) return <SkeletonGrid />;

  return (
    <div>
      <h2 className="text-lg font-bold mb-1">{t("auth.062")}</h2>
      <p className="text-sm text-muted-foreground mb-5">
        {t("auth.063")}</p>
      {groups.length === 0 ? (
        <EmptyHint text={t("auth.064")} />
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          {groups.map((g) => {
            const filled = g._count?.students ?? 0;
            const full = filled >= g.capacity;
            return (
              <button
                key={g.id}
                disabled={full}
                onClick={() => onChange(g.id)}
                className={`text-end rounded-2xl p-5 border-2 transition-all ${
                  full
                    ? "border-border opacity-50 cursor-not-allowed"
                    : value === g.id
                    ? "border-primary bg-primary/5 shadow-md"
                    : "border-border bg-card hover:border-primary/40"
                }`}
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="font-bold">{g.name}</div>
                  {full && <Badge variant="destructive">{t("auth.065")}</Badge>}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t("auth.066")}{g.schedule}
                </div>
                <div className="mt-3 flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">
                    {filled} / {g.capacity} {t("auth.067")}</span>
                  <div className="w-24 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary"
                      style={{ width: `${(filled / g.capacity) * 100}%` }}
                    />
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------- PLAN PICKER ------------------------------ */
function PlanPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (id: string) => void;
}) {
  const t = useT();
  const [plans, setPlans] = React.useState<Plan[]>([]);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    fetch("/api/subscription-plans")
      .then((r) => r.json())
      .then((d) => setPlans(d.plans || []))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <SkeletonGrid />;

  return (
    <div>
      <h2 className="text-lg font-bold mb-1">{t("auth.068")}</h2>
      <p className="text-sm text-muted-foreground mb-5">
        {t("auth.069")}</p>
      <div className="grid sm:grid-cols-2 gap-4">
        {plans.map((p) => (
          <button
            key={p.id}
            onClick={() => onChange(p.id)}
            className={`text-end rounded-2xl p-5 border-2 transition-all relative ${
              value === p.id
                ? "border-primary bg-primary/5 shadow-md"
                : "border-border bg-card hover:border-primary/40"
            }`}
          >
            {p.isPromo && (
              <Badge className="absolute top-3 end-3 bg-amber-500 text-white hover:bg-amber-500 shadow-md">
                <Trophy className="w-3 h-3 ms-1" />
                Limited
              </Badge>
            )}
            <div className="font-bold">{pickAuto(p.nameAr, p.name)}</div>
            <div className="text-xs text-muted-foreground">{p.name}</div>
            <div className="mt-3 flex items-end gap-1">
              <span className="text-3xl font-extrabold">{p.price}</span>
              <span className="text-sm text-muted-foreground mb-1">EGP</span>
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {t("auth.070")}{p.durationMonths} {t("auth.071")}{p.durationMonths > 1 ? t("auth.072") : ""}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------ PAYMENT PICKER ---------------------------- */
function PaymentPicker({
  method,
  setMethod,
  reference,
  setReference,
  couponCode,
  setCouponCode,
  couponResult,
  validateCoupon,
  validatingCoupon,
}: {
  method: string | null;
  setMethod: (m: string) => void;
  reference: string;
  setReference: (s: string) => void;
  couponCode: string;
  setCouponCode: (s: string) => void;
  couponResult: any;
  validateCoupon: () => void;
  validatingCoupon: boolean;
}) {
  const t = useT();
  const [whatsappNum, setWhatsappNum] = React.useState(brand.whatsapp.subscription);
  React.useEffect(() => {
    fetch("/api/settings/public")
      .then((r) => r.json())
      .then((d) => {
        if (d.settings?.whatsapp_subscription)
          setWhatsappNum(d.settings.whatsapp_subscription);
      })
      .catch(() => {});
  }, []);

  return (
    <div>
      <h2 className="text-lg font-bold mb-1">{t("auth.073")}</h2>
      <p className="text-sm text-muted-foreground mb-5">
        {t("auth.074")}<strong dir="ltr">{brand.payments.instapay}</strong> {t("auth.075")}</p>

      {/* Coupon section */}
      <div className="rounded-xl bg-gradient-to-br from-amber-400/5 to-emerald-400/5 border border-amber-400/20 p-4 mb-5">
        <Label htmlFor="coupon" className="text-xs font-semibold flex items-center gap-1.5">
          <Ticket className="w-3.5 h-3.5 text-amber-500" />
          {t("auth.076")}</Label>
        <div className="flex items-center gap-2 mt-1.5">
          <Input
            id="coupon"
            value={couponCode}
            onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
            placeholder={t("auth.077")}
            className="font-mono uppercase"
          />
          <Button
            variant="outline"
            onClick={validateCoupon}
            disabled={!couponCode.trim() || validatingCoupon}
            className="shrink-0"
          >
            {validatingCoupon ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              t("auth.078")
            )}
          </Button>
        </div>
        {couponResult && (
          <motion.div
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            className={`mt-2 rounded-lg p-2.5 text-xs flex items-center gap-2 ${
              couponResult.valid
                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                : "bg-destructive/10 text-destructive"
            }`}
          >
            {couponResult.valid ? (
              <>
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>
                  {t("auth.079")}{couponResult.discount} {t("auth.080")}{" "}
                  <strong>{couponResult.finalPrice} EGP</strong>
                </span>
              </>
            ) : (
              <>
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{couponResult.error || t("auth.081")}</span>
              </>
            )}
          </motion.div>
        )}
      </div>

      <div className="grid sm:grid-cols-3 gap-3 mb-6">
        {METHODS.map((m) => {
          const disabled = (m as any).disabled;
          return (
            <button
              key={m.key}
              disabled={disabled}
              onClick={() => !disabled && setMethod(m.key)}
              className={`relative text-center rounded-2xl p-4 border-2 transition-all overflow-hidden ${
                disabled
                  ? "border-border bg-muted/40 opacity-60 grayscale cursor-not-allowed"
                  : method === m.key
                  ? "border-primary bg-primary/5 shadow-sm"
                  : "border-border hover:border-primary/40"
              }`}
            >
              {disabled && (
                <Badge className="absolute top-2 start-2 bg-amber-500 hover:bg-amber-500 text-white text-[10px]">
                  Coming Soon
                </Badge>
              )}
              <div
                className={`w-12 h-12 mx-auto rounded-xl bg-gradient-to-br ${m.color} flex items-center justify-center text-white mb-2`}
              >
                <Wallet className="w-5 h-5" />
              </div>
              <div className="text-sm font-bold">{m.label}</div>
              <div className="text-[10px] text-muted-foreground mt-1">
                {t(m.desc)}
              </div>
              {(m as any).number && (
                <div className="mt-1.5 text-[11px] font-bold font-mono" dir="ltr">
                  {(m as any).number}
                </div>
              )}
            </button>
          );
        })}
      </div>

      <div className="rounded-xl bg-muted/40 border border-border/60 p-4">
        <Label htmlFor="ref" className="text-xs font-semibold">
          Transaction Reference Number
        </Label>
        <Input
          id="ref"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder={t("auth.082")}
          className="mt-1.5"
        />
        <p className="text-[11px] text-muted-foreground mt-2">
          {t("auth.083")}</p>
        <div className="mt-3 pt-3 border-t border-border/60 flex items-center gap-2 text-xs">
          <ShieldCheck className="w-4 h-4 text-primary" />
          {t("auth.084")}</div>
        <a
          href={whatsappLink(whatsappNum, t("auth.085"))}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center text-xs text-primary hover:underline"
        >
          {t("auth.086")}</a>
      </div>
    </div>
  );
}

/* ------------------------------- CONFIRM CARD ----------------------------- */
function ConfirmCard({
  courseId,
  groupId,
  planId,
  method,
  reference,
  submitting,
  couponResult,
  onSubmit,
  onBack,
}: {
  courseId: string | null;
  groupId: string | null;
  planId: string | null;
  method: string | null;
  reference: string;
  submitting: boolean;
  couponResult: any;
  onSubmit: () => void;
  onBack: () => void;
}) {
  const t = useT();
  const hasCoupon = couponResult?.valid;
  return (
    <div>
      <h2 className="text-lg font-bold mb-1">{t("auth.087")}</h2>
      <p className="text-sm text-muted-foreground mb-5">
        {t("auth.088")}</p>

      <Card className="glass border-0 shadow-sm mb-5">
        <CardContent className="p-5 space-y-3 text-sm">
          <Row label={t("auth.047")} value="Programming & AI" />
          <Row label={t("auth.048")} value="Group A" />
          <Row
            label={t("auth.091")}
            value={
              method === "INSTAPAY"
                ? `InstaPay (${brand.payments.instapay})`
                : method === "ETISALAT_CASH"
                ? `e& Cash (${brand.payments.eCash})`
                : method || "-"
            }
          />
          <Row label="Reference" value={reference || "—"} />
          {hasCoupon && (
            <Row
              label={t("auth.092", { p1: couponResult.coupon.code })}
              value={`-${couponResult.discount} EGP`}
            />
          )}
          <div className="pt-3 border-t border-border/60 flex items-center justify-between">
            <span className="text-muted-foreground">
              {hasCoupon ? t("auth.093") : t("auth.094")}
            </span>
            <span className="text-2xl font-extrabold text-gradient">
              {hasCoupon ? couponResult.finalPrice : brand.defaultPrice} EGP
            </span>
          </div>
          {hasCoupon && (
            <div className="text-xs text-muted-foreground line-through">
              {t("auth.095")}{couponResult.originalPrice} EGP
            </div>
          )}
        </CardContent>
      </Card>

      <div className="rounded-xl bg-amber-400/10 border border-amber-400/30 p-4 text-sm mb-5">
        <div className="flex items-start gap-2">
          <ShieldCheck className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <div className="font-bold text-amber-700 dark:text-amber-400">
              {t("auth.096")}</div>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              {t("auth.097")}</p>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={onBack} disabled={submitting}>
          <ChevronRight className="w-4 h-4 ms-1" />
          {t("auth.058")}</Button>
        <Button onClick={onSubmit} disabled={submitting} className="font-bold">
          {submitting ? (
            <>
              <Loader2 className="w-4 h-4 ms-2 animate-spin" />
              {t("auth.099")}</>
          ) : (
            <>
              <Rocket className="w-4 h-4 ms-2" />
              {t("auth.100")}</>
          )}
        </Button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid sm:grid-cols-2 gap-4">
      {[0, 1].map((i) => (
        <div key={i} className="skeleton-shimmer h-32 rounded-2xl" />
      ))}
    </div>
  );
}
