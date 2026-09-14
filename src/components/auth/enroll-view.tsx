"use client";

// CodeMind Academy — ENROLLMENT / PAYMENT EXPERIENCE (Phase 25 PR3).
//
// WHAT THIS FILE OWNS
//   The student-facing payment journey: pick course → pick group → pick plan →
//   the FINAL PAYMENT PAGE (two-column on desktop, stacked on mobile) → the
//   submitted / under-review state with the manual WhatsApp proof actions.
//
// THE PHASE 25 CONTRACT THIS UI MUST NEVER CONTRADICT
//   A submitted payment is a REQUEST under review — never an active
//   subscription. The server (`POST /api/enroll`) answers with the scenario it
//   recorded (`NEW_REQUEST` / `RENEWAL` / `LEGACY_GRANDFATHERED`) plus a
//   truthful entitlement snapshot, and this UI renders exactly that:
//     * NEW_REQUEST           → "request under review" + course content opens
//                               AFTER approval (never "account activated");
//     * RENEWAL               → the current subscription stays ACTIVE while the
//                               request is reviewed (end date shown);
//     * LEGACY_GRANDFATHERED  → the request is under review and the student's
//                               current course keeps working (the internal
//                               "grandfathered" term is never shown).
//
// REAL DATA ONLY: the summary renders the ACTUAL selected course / group /
// plan / duration / price / discount / final amount / method from the loaded
// catalog and the coupon API. There are no hardcoded course or group names and
// no assumed default price.
//
// NO SCREENSHOT UPLOAD: there is no file input, no attachment API and no R2
// upload here. The proof screenshot is sent manually by the student through
// WhatsApp (see src/components/shared/payment-proof.tsx).

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  CreditCard,
  Users,
  BookOpen,
  Trophy,
  Loader2,
  ShieldCheck,
  Wallet,
  Ticket,
  AlertTriangle,
  Clock,
  XCircle,
  Rocket,
  ArrowRight,
} from "lucide-react";
import { toast } from "sonner";

import { useApp } from "@/lib/store";
import { useT, pickAuto, fmtDateTime, useLocale } from "@/lib/i18n";
import { isValidEgyptianPhone } from "@/lib/registration";
import { CodeMindLogo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  PaymentMethodDestination,
  ProofInstructionCard,
  ReferenceHelp,
  WhatsAppProofActions,
  WhatsAppProofNumbersNote,
} from "@/components/shared/payment-proof";
import {
  formatPaymentAmount,
  isLaunchPaymentMethod,
  paymentMethodAvailable,
  paymentMethodLabel,
} from "@/lib/payment-ux";

type Step = 0 | 1 | 2 | 3;

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

type MethodOption = {
  key: string;
  color: string;
  desc: string;
  /** Visible-but-disabled (the API refuses it: `api.266`). */
  disabled?: boolean;
};

/** Launch methods, in display order. Vodafone Cash stays visible but disabled. */
const METHODS: MethodOption[] = [
  { key: "INSTAPAY", color: "from-rose-500 to-pink-500", desc: "auth.042" },
  { key: "ETISALAT_CASH", color: "from-emerald-500 to-teal-500", desc: "auth.044" },
  { key: "VODAFONE_CASH", color: "from-red-500 to-rose-500", desc: "auth.043", disabled: true },
];

type EntitlementSnapshot = {
  state?: string;
  accessAllowed?: boolean;
  grandfathered?: boolean;
  groupName?: string | null;
  endDate?: string | null;
  plan?: { name?: string; nameAr?: string | null } | null;
} | null;

/** What the server recorded for the submission we just made. */
type SubmissionResult = {
  scenario: "NEW_REQUEST" | "RENEWAL" | "LEGACY_GRANDFATHERED";
  payment: { id: string; status: string };
  entitlement: EntitlementSnapshot;
  submittedAt: Date;
  /** The request exactly as the student entered/selected it (real data). */
  request: {
    courseName: string;
    groupName: string;
    planName: string;
    method: string;
    amount: number;
    originalPrice: number;
    discount: number;
    reference: string;
    senderPhone: string;
  };
};

type CouponResult = {
  valid?: boolean;
  error?: string;
  discount?: number;
  finalPrice?: number;
  originalPrice?: number;
  coupon?: { code: string } | null;
} | null;

/** The student's own payment read contract (GET /api/students/me/payments). */
type PaymentRow = {
  id: string;
  status: string;
  amount: number;
  method: string;
  reference: string | null;
  senderPhone: string | null;
  rejectionReason: string | null;
  reviewedAt: string | null;
  createdAt: string;
  requestedPlan: { id: string; name: string; nameAr: string | null } | null;
  requestedGroup: { id: string; name: string; isActive: boolean } | null;
};

type PaymentsRead = {
  latestPending: PaymentRow | null;
  latestRejected: PaymentRow | null;
  entitlement: EntitlementSnapshot;
};

export function EnrollView() {
  const t = useT();
  const locale = useLocale();
  const setView = useApp((s) => s.setView);

  const [step, setStep] = React.useState<Step>(0);

  // ---- catalog (lifted so the payment page can render REAL selections) ----
  const [courses, setCourses] = React.useState<Course[]>([]);
  const [groups, setGroups] = React.useState<Group[]>([]);
  const [plans, setPlans] = React.useState<Plan[]>([]);
  const [catalogLoading, setCatalogLoading] = React.useState(true);

  const [courseId, setCourseId] = React.useState<string | null>(null);
  const [groupId, setGroupId] = React.useState<string | null>(null);
  const [planId, setPlanId] = React.useState<string | null>(null);

  // ---- payment request fields (the PR2a-required submission contract) ----
  const [method, setMethod] = React.useState<string | null>(null);
  const [reference, setReference] = React.useState("");
  const [senderPhone, setSenderPhone] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [errors, setErrors] = React.useState<{
    method?: string;
    senderPhone?: string;
    reference?: string;
  }>({});

  // ---- coupon (existing behaviour, unchanged rules) ----
  const [couponCode, setCouponCode] = React.useState("");
  const [couponResult, setCouponResult] = React.useState<CouponResult>(null);
  const [validatingCoupon, setValidatingCoupon] = React.useState(false);

  // ---- the student's own request state (pending / rejected) ----
  const [existing, setExisting] = React.useState<PaymentsRead | null>(null);
  const [submission, setSubmission] = React.useState<SubmissionResult | null>(null);

  // Load the catalog + the student's current request state once.
  React.useEffect(() => {
    let alive = true;
    Promise.all([
      // `catalog=1`: the enroll flow legitimately shows courses the student is
      // not enrolled in yet. The default (non-catalog) response is restricted
      // to the student's own enrolled course.
      fetch("/api/courses?catalog=1").then((r) => r.json()),
      fetch("/api/subscription-plans").then((r) => r.json()),
      fetch("/api/students/me/payments")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ])
      .then(([c, p, mine]) => {
        if (!alive) return;
        setCourses(c?.courses || []);
        setPlans(p?.plans || []);
        if (mine) setExisting(mine);
      })
      .finally(() => {
        if (alive) setCatalogLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Groups belong to the selected course. Changing the course invalidates the
  // loaded list and the current pick — done during render (React's documented
  // "adjust state when a prop changes" pattern) so no cascading effect writes.
  const [groupsCourseId, setGroupsCourseId] = React.useState<string | null>(null);
  if (courseId !== groupsCourseId) {
    setGroupsCourseId(courseId);
    setGroups([]);
    setGroupId(null);
  }
  React.useEffect(() => {
    if (!courseId) return;
    let alive = true;
    fetch(`/api/groups?courseId=${encodeURIComponent(courseId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (alive) setGroups(d.groups || []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [courseId]);

  // ---- REAL selected objects (no hardcoded display values) ----
  const course = React.useMemo(
    () => courses.find((c) => c.id === courseId) ?? null,
    [courses, courseId]
  );
  const group = React.useMemo(
    () => groups.find((g) => g.id === groupId) ?? null,
    [groups, groupId]
  );
  const plan = React.useMemo(
    () => plans.find((p) => p.id === planId) ?? null,
    [plans, planId]
  );

  const originalPrice = plan?.price ?? 0;
  const discount =
    couponResult?.valid && Number.isFinite(Number(couponResult.discount))
      ? Number(couponResult.discount)
      : 0;
  const finalAmount =
    couponResult?.valid && Number.isFinite(Number(couponResult.finalPrice))
      ? Number(couponResult.finalPrice)
      : Math.max(0, originalPrice - discount);

  const validateCoupon = async () => {
    if (!couponCode.trim() || !plan) return;
    setValidatingCoupon(true);
    try {
      const r = await fetch("/api/coupons/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: couponCode, originalPrice: plan.price }),
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

  /**
   * Client-side convenience validation ONLY — the server re-validates every
   * field (`validateEnrollmentSubmission`) and stays the authority. The phone
   * rule is the SAME shared helper the API uses, so the feedback cannot
   * contradict the server.
   */
  const validateForm = (): boolean => {
    const next: typeof errors = {};
    if (!method || !isLaunchPaymentMethod(method)) next.method = t("pay.needMethod");
    // Defense in depth: the selector already disables destination-less methods,
    // but if `method` somehow holds one (config changed while the page was
    // open, restored state, a future method added to the enum) the request is
    // refused HERE, before `/api/enroll` is ever called. A student must never
    // be able to submit a transfer for a method with no trusted destination.
    else if (!paymentMethodAvailable(method)) next.method = t("pay.methodUnavailable");
    if (!senderPhone.trim() || !isValidEgyptianPhone(senderPhone.trim()))
      next.senderPhone = senderPhone.trim()
        ? t("pay.senderPhoneInvalid")
        : t("pay.needSenderPhone");
    const ref = reference.trim();
    if (ref.length < 3 || ref.length > 64)
      next.reference = ref ? t("pay.referenceInvalid") : t("pay.needReference");
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async () => {
    if (submitting) return; // double-click guard
    if (!validateForm()) return;
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
          reference: reference.trim(),
          senderPhone: senderPhone.trim(),
          couponCode: couponResult?.valid ? couponCode.trim().toUpperCase() : undefined,
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        // Server-localized message; never a raw DB error (PR2a/PR2b contract).
        toast.error(data.error || t("auth.055"));
        return;
      }
      setSubmission({
        scenario: data.scenario,
        payment: data.payment,
        entitlement: data.entitlement ?? null,
        submittedAt: new Date(),
        request: {
          courseName: course ? pickAuto(course.nameAr, course.name) : "",
          groupName: group?.name ?? "",
          planName: plan ? pickAuto(plan.nameAr, plan.name) : "",
          method: method ?? "",
          amount: finalAmount,
          originalPrice,
          discount,
          reference: reference.trim(),
          senderPhone: senderPhone.trim(),
        },
      });
      // The request is under review — NOT approved. No success toast that
      // could read as "paid/activated".
      toast.info(t("pay.pendingTitle"));
      setStep(3);
    } catch {
      toast.error(t("auth.057"));
    } finally {
      setSubmitting(false);
    }
  };

  const steps = [
    { n: 1, label: t("auth.047"), icon: BookOpen },
    { n: 2, label: t("auth.048"), icon: Users },
    { n: 3, label: t("auth.049"), icon: Trophy },
    { n: 4, label: t("auth.050"), icon: CreditCard },
  ];

  // ---------------------------------------------------------------------
  // SUBMITTED / UNDER REVIEW — replaces the wizard entirely.
  // ---------------------------------------------------------------------
  if (submission) {
    return (
      <SubmittedView
        submission={submission}
        locale={locale}
        onDashboard={() => setView("student-dashboard")}
      />
    );
  }

  return (
    <div className="flex-1 flex items-start sm:items-center justify-center p-4 sm:p-10">
      <div className="w-full max-w-5xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <button
            onClick={() => setView("student-dashboard")}
            className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <ChevronRight className="w-4 h-4" />
            {t("auth.052")}
          </button>
          <CodeMindLogo size={32} />
        </div>

        <div className="mb-6">
          <h1 className="text-2xl font-extrabold">{t("auth.053")}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t("auth.054")}</p>
        </div>

        {/* A pending / rejected request the student already has */}
        <ExistingRequestBanner existing={existing} />

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
                    {done ? <CheckCircle2 className="w-5 h-5" /> : <s.icon className="w-5 h-5" />}
                  </div>
                  <div className="text-[10px] sm:text-xs font-medium text-center">{s.label}</div>
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
          {step === 0 && (
            <StepCard key="course">
              <CoursePicker value={courseId} onChange={(id) => { setCourseId(id); setStep(1); }} loading={catalogLoading} courses={courses} />
            </StepCard>
          )}

          {step === 1 && (
            <StepCard key="group">
              <GroupPicker value={groupId} onChange={setGroupId} groups={groups} loading={catalogLoading} />
              <NavRow onBack={() => setStep(0)} onNext={() => groupId && setStep(2)} disabled={!groupId} />
            </StepCard>
          )}

          {step === 2 && (
            <StepCard key="plan">
              <PlanPicker value={planId} onChange={setPlanId} plans={plans} loading={catalogLoading} />
              <NavRow onBack={() => setStep(1)} onNext={() => planId && setStep(3)} disabled={!planId} />
            </StepCard>
          )}

          {step === 3 && (
            <StepCard key="pay">
              <PaymentPage
                course={course}
                group={group}
                plan={plan}
                originalPrice={originalPrice}
                discount={discount}
                finalAmount={finalAmount}
                couponCode={couponCode}
                setCouponCode={setCouponCode}
                couponResult={couponResult}
                validateCoupon={validateCoupon}
                validatingCoupon={validatingCoupon}
                method={method}
                setMethod={(m) => { setMethod(m); setErrors((e) => ({ ...e, method: undefined })); }}
                senderPhone={senderPhone}
                setSenderPhone={(v) => { setSenderPhone(v); setErrors((e) => ({ ...e, senderPhone: undefined })); }}
                reference={reference}
                setReference={(v) => { setReference(v); setErrors((e) => ({ ...e, reference: undefined })); }}
                errors={errors}
                submitting={submitting}
                onSubmit={submit}
                onBack={() => setStep(2)}
              />
            </StepCard>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/* =========================================================================
 * PAYMENT PAGE — desktop two-column, mobile stacked
 * ========================================================================= */

function PaymentPage({
  course,
  group,
  plan,
  originalPrice,
  discount,
  finalAmount,
  couponCode,
  setCouponCode,
  couponResult,
  validateCoupon,
  validatingCoupon,
  method,
  setMethod,
  senderPhone,
  setSenderPhone,
  reference,
  setReference,
  errors,
  submitting,
  onSubmit,
  onBack,
}: {
  course: Course | null;
  group: Group | null;
  plan: Plan | null;
  originalPrice: number;
  discount: number;
  finalAmount: number;
  couponCode: string;
  setCouponCode: (s: string) => void;
  couponResult: CouponResult;
  validateCoupon: () => void;
  validatingCoupon: boolean;
  method: string | null;
  setMethod: (m: string) => void;
  senderPhone: string;
  setSenderPhone: (s: string) => void;
  reference: string;
  setReference: (s: string) => void;
  errors: { method?: string; senderPhone?: string; reference?: string };
  submitting: boolean;
  onSubmit: () => void;
  onBack: () => void;
}) {
  const t = useT();

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] items-start">
      {/* ------------------------- MAIN COLUMN ------------------------- */}
      <div className="space-y-4 min-w-0">
        <div>
          <h2 className="text-lg font-bold mb-1">{t("pay.paymentPageTitle")}</h2>
          <p className="text-sm text-muted-foreground">{t("pay.paymentPageHint")}</p>
        </div>

        {/* Order summary — REAL selected data only */}
        <Card className="glass border-0 shadow-sm" data-testid="order-summary">
          <CardContent className="p-5 space-y-2.5 text-sm">
            <div className="text-xs font-bold text-muted-foreground mb-1">
              {t("pay.summaryTitle")}
            </div>
            <Row label={t("auth.047")} value={course ? pickAuto(course.nameAr, course.name) : t("pay.notSelectedYet")} />
            <Row label={t("auth.048")} value={group?.name ?? t("pay.notSelectedYet")} />
            {group?.schedule && <Row label={t("pay.scheduleLabel")} value={group.schedule} muted />}
            <Row label={t("auth.049")} value={plan ? pickAuto(plan.nameAr, plan.name) : t("pay.notSelectedYet")} />
            {plan && (
              <Row
                label={t("pay.durationLabel")}
                value={t("pay.monthsCount", { p1: plan.durationMonths })}
                muted
              />
            )}

            <div className="pt-2.5 border-t border-border/60 space-y-2">
              <Row
                label={t("pay.originalPrice")}
                value={`${formatPaymentAmount(originalPrice)} ${t("pay.egp")}`}
              />
              {discount > 0 && (
                <Row
                  label={t("pay.couponDiscount", { p1: couponResult?.coupon?.code ?? couponCode })}
                  value={`-${formatPaymentAmount(discount)} ${t("pay.egp")}`}
                  tone="success"
                />
              )}
              <div className="flex items-center justify-between pt-1">
                <span className="text-sm font-bold">{t("pay.finalAmount")}</span>
                <span className="text-2xl font-extrabold text-gradient tabular-nums" data-testid="final-amount">
                  {formatPaymentAmount(finalAmount)}{" "}
                  <span className="text-sm">{t("pay.egp")}</span>
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Coupon */}
        <div className="rounded-xl bg-gradient-to-br from-amber-400/5 to-emerald-400/5 border border-amber-400/20 p-4">
          <Label htmlFor="coupon" className="text-xs font-semibold flex items-center gap-1.5">
            <Ticket className="w-3.5 h-3.5 text-amber-500" />
            {t("auth.076")}
          </Label>
          <div className="flex items-center gap-2 mt-1.5">
            <Input
              id="coupon"
              value={couponCode}
              onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
              placeholder={t("auth.077")}
              className="font-mono uppercase"
            />
            <Button
              type="button"
              variant="outline"
              onClick={validateCoupon}
              disabled={!couponCode.trim() || !plan || validatingCoupon}
              className="shrink-0"
            >
              {validatingCoupon ? <Loader2 className="w-4 h-4 animate-spin" /> : t("auth.078")}
            </Button>
          </div>
          {couponResult && (
            <p
              className={`mt-2 rounded-lg p-2.5 text-xs flex items-start gap-2 ${
                couponResult.valid
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  : "bg-destructive/10 text-destructive"
              }`}
              role="status"
            >
              {couponResult.valid ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              )}
              <span>
                {couponResult.valid
                  ? `${t("auth.079")} ${formatPaymentAmount(couponResult.discount)} ${t("auth.080")} ${formatPaymentAmount(couponResult.finalPrice)} ${t("pay.egp")}`
                  : couponResult.error || t("auth.081")}
              </span>
            </p>
          )}
        </div>

        {/* Method */}
        <div>
          <div className="text-sm font-bold mb-2">{t("pay.methodTitle")}</div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {METHODS.map((m) => {
              // Disabled when the launch does not offer the method at all
              // (Vodafone Cash — "coming soon") OR when no transfer
              // destination is configured for it. Both go through the shared
              // `paymentMethodAvailable` rule so the selector and the form
              // validation can never disagree.
              const comingSoon = m.disabled === true;
              const available = paymentMethodAvailable(m.key);
              const disabled = comingSoon || !available;
              const selected = method === m.key && !disabled;
              return (
                <button
                  key={m.key}
                  type="button"
                  disabled={disabled}
                  aria-pressed={selected}
                  aria-disabled={disabled}
                  onClick={() => !disabled && setMethod(m.key)}
                  className={`relative text-center rounded-2xl p-4 border-2 transition-all overflow-hidden ${
                    disabled
                      ? "border-border bg-muted/40 opacity-60 grayscale cursor-not-allowed"
                      : selected
                        ? "border-primary bg-primary/5 shadow-sm"
                        : "border-border hover:border-primary/40"
                  }`}
                >
                  {disabled && (
                    <Badge className="absolute top-2 start-2 bg-amber-500 hover:bg-amber-500 text-white text-[10px]">
                      {/* Vodafone Cash is a known "coming soon" method; a launch
                          method with no configured destination is simply
                          unavailable — never offered as a transfer target. */}
                      {comingSoon ? t("pay.methodComingSoon") : t("pay.methodUnavailable")}
                    </Badge>
                  )}
                  <div
                    className={`w-12 h-12 mx-auto rounded-xl bg-gradient-to-br ${m.color} flex items-center justify-center text-white mb-2`}
                  >
                    <Wallet className="w-5 h-5" />
                  </div>
                  <div className="text-sm font-bold" dir="ltr">
                    {paymentMethodLabel(m.key)}
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-1">{t(m.desc)}</div>
                </button>
              );
            })}
          </div>
          {errors.method && <FieldError id="method-error">{errors.method}</FieldError>}
        </div>

        {/* Destination of the SELECTED method (read from configuration) */}
        {method && <PaymentMethodDestination method={method} />}

        {/* Sender phone */}
        <div className="rounded-xl bg-muted/40 border border-border/60 p-4 space-y-3">
          <div>
            <Label htmlFor="sender-phone" className="text-xs font-semibold">
              {t("auth.226")}
            </Label>
            <Input
              id="sender-phone"
              data-testid="sender-phone-input"
              value={senderPhone}
              onChange={(e) => setSenderPhone(e.target.value)}
              placeholder={t("pay.senderPhoneExample")}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              dir="ltr"
              aria-invalid={!!errors.senderPhone}
              aria-describedby={errors.senderPhone ? "sender-phone-error" : "sender-phone-help"}
              className="mt-1.5 font-mono"
            />
            <p id="sender-phone-help" className="mt-1.5 text-[11px] text-muted-foreground">
              {t("pay.senderPhoneHint")}
            </p>
            {errors.senderPhone && <FieldError id="sender-phone-error">{errors.senderPhone}</FieldError>}
          </div>

          {/* Transaction reference */}
          <div>
            <Label htmlFor="ref" className="text-xs font-semibold block">
              {t("pay.referenceLabel")}
            </Label>
            <Input
              id="ref"
              data-testid="reference-input"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={t("auth.082")}
              dir="ltr"
              aria-invalid={!!errors.reference}
              aria-describedby={errors.reference ? "reference-error" : "reference-help"}
              className="mt-1.5 font-mono"
            />
            <p id="reference-help" className="mt-1.5 text-[11px] text-muted-foreground leading-relaxed">
              {t("pay.referenceHint")}
            </p>
            {errors.reference && <FieldError id="reference-error">{errors.reference}</FieldError>}
          </div>

          <div className="pt-3 border-t border-border/60 flex items-start gap-2 text-xs">
            <ShieldCheck className="w-4 h-4 text-primary shrink-0 mt-0.5" />
            <span className="text-muted-foreground">{t("pay.instructionsIntro")}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="ghost" onClick={onBack} disabled={submitting}>
            <ChevronRight className="w-4 h-4 ms-1" />
            {t("auth.058")}
          </Button>
          <Button
            type="button"
            onClick={onSubmit}
            disabled={submitting}
            className="font-bold"
            data-testid="submit-payment-request"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 ms-2 animate-spin" />
                {t("auth.099")}
              </>
            ) : (
              <>
                <Rocket className="w-4 h-4 ms-2" />
                {t("pay.submitAction")}
              </>
            )}
          </Button>
        </div>
      </div>

      {/* -------------------------- SIDE CARD -------------------------- */}
      <aside className="space-y-4 min-w-0 lg:sticky lg:top-4">
        <ProofInstructionCard />
        <ReferenceHelp />
        <WhatsAppProofNumbersNote />
      </aside>
    </div>
  );
}

/* =========================================================================
 * SUBMITTED / UNDER REVIEW (never rendered as "approved")
 * ========================================================================= */

function SubmittedView({
  submission,
  locale,
  onDashboard,
}: {
  submission: SubmissionResult;
  locale: "ar" | "en";
  onDashboard: () => void;
}) {
  const t = useT();
  const { scenario, entitlement, request } = submission;

  // Truthful, server-derived context (never re-derived client-side):
  //   RENEWAL              → the current subscription stays ACTIVE;
  //   LEGACY_GRANDFATHERED → current access keeps working (no internal term);
  //   NEW_REQUEST          → content opens AFTER approval.
  const currentEndsAt =
    entitlement?.endDate ? fmtDateTime(new Date(entitlement.endDate), locale) : null;
  const keepsCurrentAccess =
    scenario === "RENEWAL" || scenario === "LEGACY_GRANDFATHERED";

  return (
    <div className="flex-1 flex items-start sm:items-center justify-center p-4 sm:p-10">
      <div className="w-full max-w-3xl space-y-4">
        {/* Status header — a REQUEST under review, not a success state */}
        <div
          className="rounded-2xl border border-sky-400/40 bg-sky-400/10 p-5"
          data-testid="pending-state"
          role="status"
        >
          <div className="flex items-start gap-3">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-sky-400/20 text-sky-700 dark:text-sky-300">
              <Clock className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-extrabold" data-testid="pending-title">
                {t("pay.pendingTitle")}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
                {scenario === "RENEWAL" && t("pay.pendingRenewal")}
                {scenario === "LEGACY_GRANDFATHERED" && t("pay.pendingAccessStillOn")}
                {scenario === "NEW_REQUEST" && t("pay.pendingNewStudent")}
              </p>
              {keepsCurrentAccess && currentEndsAt && (
                <p
                  className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-primary/10 px-2.5 py-1.5 text-xs font-semibold text-primary"
                  data-testid="current-end-date"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {t("pay.pendingCurrentEndsAt", { p1: currentEndsAt })}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Request summary — exactly what was submitted */}
        <Card className="glass border-0 shadow-sm">
          <CardContent className="p-5 space-y-2.5 text-sm">
            <div className="text-xs font-bold text-muted-foreground mb-1">
              {t("pay.summaryTitle")}
            </div>
            <Row label={t("auth.047")} value={request.courseName || "—"} />
            <Row label={t("auth.048")} value={request.groupName || "—"} />
            <Row label={t("auth.049")} value={request.planName || "—"} />
            <Row
              label={t("pay.methodTitle")}
              value={paymentMethodLabel(request.method) || "—"}
            />
            <Row
              label={t("pay.finalAmount")}
              value={`${formatPaymentAmount(request.amount)} ${t("pay.egp")}`}
              strong
            />
            {request.discount > 0 && (
              <Row
                label={t("pay.couponDiscountGeneric")}
                value={`-${formatPaymentAmount(request.discount)} ${t("pay.egp")}`}
                tone="success"
              />
            )}
            <Row label={t("auth.226")} value={request.senderPhone || "—"} ltr />
            <Row label={t("pay.referenceLabel")} value={request.reference || "—"} ltr />
            <Row
              label={t("pay.submittedLabel")}
              value={fmtDateTime(submission.submittedAt, locale)}
              muted
            />
          </CardContent>
        </Card>

        {/* Manual WhatsApp proof — the ONLY proof channel at launch */}
        <WhatsAppProofActions
          facts={{
            amount: request.amount,
            method: request.method,
            reference: request.reference,
            senderPhone: request.senderPhone,
          }}
        />
        <ProofInstructionCard />

        <div className="flex justify-end">
          <Button type="button" onClick={onDashboard} className="font-bold">
            <ArrowRight className="w-4 h-4 ms-2" />
            {t("auth.052")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
 * Existing request banner (pending / rejected) — honest context on entry
 * ========================================================================= */

function ExistingRequestBanner({ existing }: { existing: PaymentsRead | null }) {
  const t = useT();
  if (!existing) return null;

  if (existing.latestPending) {
    const p = existing.latestPending;
    return (
      <div
        className="mb-5 rounded-xl border border-sky-400/40 bg-sky-400/10 p-3.5 flex items-start gap-2"
        role="status"
        data-testid="existing-pending-banner"
      >
        <Clock className="w-4 h-4 text-sky-600 dark:text-sky-300 shrink-0 mt-0.5" />
        <div className="text-xs leading-relaxed">
          <div className="font-bold">{t("pay.pendingExistingBanner")}</div>
          <div className="text-muted-foreground mt-0.5">
            {paymentMethodLabel(p.method)} · {formatPaymentAmount(p.amount)} {t("pay.egp")}
            {p.reference ? ` · ${p.reference}` : ""}
          </div>
        </div>
      </div>
    );
  }

  if (existing.latestRejected) {
    const p = existing.latestRejected;
    const keepsAccess = existing.entitlement?.accessAllowed === true;
    return (
      <div
        className="mb-5 rounded-xl border border-destructive/40 bg-destructive/5 p-3.5 flex items-start gap-2"
        role="status"
        data-testid="existing-rejected-banner"
      >
        <XCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
        <div className="text-xs leading-relaxed min-w-0">
          <div className="font-bold">{t("pay.rejectedTitle")}</div>
          {p.rejectionReason && (
            <div className="text-muted-foreground mt-0.5">
              <span className="font-semibold">{t("pay.rejectedReasonLabel")}: </span>
              <span data-testid="rejected-reason">{p.rejectionReason}</span>
            </div>
          )}
          <div className="text-muted-foreground mt-0.5">{t("pay.rejectedRetry")}</div>
          {keepsAccess && (
            <div className="mt-1 font-semibold text-primary" data-testid="rejected-access-kept">
              {t("pay.rejectedEntitlementKept")}
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}

/* =========================================================================
 * Step shell + pickers (presentational; data comes from the parent)
 * ========================================================================= */

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
      <Button type="button" variant="ghost" onClick={onBack}>
        <ChevronRight className="w-4 h-4 ms-1" />
        {t("auth.058")}
      </Button>
      <Button
        type="button"
        onClick={onNext}
        disabled={disabled}
        className="font-bold"
        data-testid="nav-next"
      >
        {t("auth.059")}
        <ChevronLeft className="w-4 h-4 me-1" />
      </Button>
    </div>
  );
}

function CoursePicker({
  value,
  onChange,
  courses,
  loading,
}: {
  value: string | null;
  onChange: (id: string) => void;
  courses: Course[];
  loading: boolean;
}) {
  const t = useT();
  if (loading) return <SkeletonGrid />;
  return (
    <div>
      <h2 className="text-lg font-bold mb-1">{t("auth.060")}</h2>
      <p className="text-sm text-muted-foreground mb-5">{t("auth.061")}</p>
      {courses.length === 0 ? (
        <EmptyHint text={t("auth.064")} />
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          {courses.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onChange(c.id)}
              aria-pressed={value === c.id}
              className={`text-end rounded-2xl p-5 border-2 transition-all ${
                value === c.id
                  ? "border-primary bg-primary/5 shadow-md"
                  : "border-border bg-card hover:border-primary/40"
              }`}
            >
              <div className="w-12 h-12 rounded-xl mb-3" style={{ background: c.color }} />
              <div className="font-bold">{pickAuto(c.nameAr, c.name)}</div>
              <div className="text-xs text-muted-foreground mt-1">{c.name}</div>
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">{c.description}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function GroupPicker({
  value,
  onChange,
  groups,
  loading,
}: {
  value: string | null;
  onChange: (id: string) => void;
  groups: Group[];
  loading: boolean;
}) {
  const t = useT();
  if (loading) return <SkeletonGrid />;
  return (
    <div>
      <h2 className="text-lg font-bold mb-1">{t("auth.062")}</h2>
      <p className="text-sm text-muted-foreground mb-5">{t("auth.063")}</p>
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
                type="button"
                disabled={full}
                aria-pressed={value === g.id}
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
                  {t("auth.066")}
                  {g.schedule}
                </div>
                <div className="mt-3 flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">
                    {filled} / {g.capacity} {t("auth.067")}
                  </span>
                  <div className="w-24 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-primary" style={{ width: `${(filled / g.capacity) * 100}%` }} />
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

function PlanPicker({
  value,
  onChange,
  plans,
  loading,
}: {
  value: string | null;
  onChange: (id: string) => void;
  plans: Plan[];
  loading: boolean;
}) {
  const t = useT();
  if (loading) return <SkeletonGrid />;
  return (
    <div>
      <h2 className="text-lg font-bold mb-1">{t("auth.068")}</h2>
      <p className="text-sm text-muted-foreground mb-5">{t("auth.069")}</p>
      <div className="grid sm:grid-cols-2 gap-4">
        {plans.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(p.id)}
            aria-pressed={value === p.id}
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
              <span className="text-3xl font-extrabold tabular-nums">{formatPaymentAmount(p.price)}</span>
              <span className="text-sm text-muted-foreground mb-1">{t("pay.egp")}</span>
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {t("pay.planDuration", { p1: p.durationMonths })}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* =========================================================================
 * Small presentational helpers
 * ========================================================================= */

function Row({
  label,
  value,
  muted,
  strong,
  tone,
  ltr,
}: {
  label: string;
  value: string;
  muted?: boolean;
  strong?: boolean;
  tone?: "success";
  ltr?: boolean;
}) {
  if (!label) return null;
  return (
    <div className="flex items-center justify-between gap-3">
      <span className={`text-muted-foreground ${muted ? "text-xs" : ""}`}>{label}</span>
      <span
        dir={ltr ? "ltr" : undefined}
        className={`${strong ? "font-extrabold" : "font-semibold"} ${
          tone === "success" ? "text-emerald-600 dark:text-emerald-400" : ""
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function FieldError({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p
      id={id}
      role="alert"
      className="mt-1.5 flex items-start gap-1.5 text-xs font-semibold text-destructive"
    >
      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span>{children}</span>
    </p>
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
