"use client";

// CodeMind Academy — Phase 25 PR3: the ADMIN payment review drawer.
//
// This is the operator's decision surface. It is deliberately a THIN client
// over the PR2b decision API:
//
//   * approve → POST /api/admin/payments/[id]/approve
//               body: {} — or { groupId } ONLY when the admin picked an
//               override. Nothing else is ever sent: no reviewer id, no
//               userId/studentId/subscriptionId, no status, no scenario. The
//               reviewer identity comes from the authenticated session and the
//               decision itself is the server's (capacity, stale guard, date
//               stacking and the atomic activation all live in
//               src/lib/payment-transitions.ts).
//   * reject  → POST /api/admin/payments/[id]/reject  body: { reason }
//               (required, ≤ 500 chars — validated with the same normalization
//               the server uses, then confirmed explicitly).
//
// DOMAIN ERRORS are mapped to clear Arabic/English copy + a recovery path
// (GROUP_REQUIRED/GROUP_FULL → choose another group and retry; STALE_PAYMENT /
// INVALID_TRANSITION / PAYMENT_NOT_FOUND / DB_CONFLICT → re-read the queue).
// A failed decision NEVER renders as success and never flips the row's status
// locally — the payment stays visibly PENDING until the server says otherwise.
//
// No raw database error is ever rendered: unknown codes fall back to a generic
// message (`paymentDecisionErrorKey`).

import * as React from "react";
import {
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  Clock,
  Info,
  Loader2,
  UserRound,
  Wallet,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fmtDateTime, useLocale, useT } from "@/lib/i18n";
import {
  formatPaymentAmount,
  normalizeRejectionReasonForUi,
  paymentDecisionErrorKey,
  paymentMethodLabel,
  PAYMENT_DECISION_GROUP_RECOVERY_CODES,
  PAYMENT_DECISION_REFRESH_CODES,
  REJECTION_REASON_MAX_LENGTH,
} from "@/lib/payment-ux";

/** One row of GET /api/admin/payments (PR3 projection). */
export type AdminPaymentRow = {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  userPhone: string | null;
  userRole: string;
  amount: number;
  method: string;
  status: string;
  reference: string | null;
  notes: string | null;
  createdAt: string;
  subscription: { id: string; status: string; plan: { nameAr: string | null } | null } | null;
  senderPhone: string | null;
  // NOTE: the intent IDS (`requested*Id`) are intentionally NOT part of this
  // row type — the UI displays the resolved plan/group objects only and never
  // sends an id back. Group choice goes through the ONE `groupId` override the
  // approval endpoint accepts; the server resolves everything else.
  requestedPlan: {
    id: string;
    name: string;
    nameAr: string | null;
    durationMonths: number;
    price: number;
    isActive: boolean;
  } | null;
  requestedGroup: {
    id: string;
    name: string;
    isActive: boolean;
    capacity: number;
    courseId: string | null;
    schedule: string | null;
    seatsUsed: number;
  } | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  duplicateReference: boolean;
  isLatestPending: boolean | null;
  studentContext: {
    id: string;
    parentPhone: string | null;
    groupId: string | null;
    groupName: string | null;
    courseId: string | null;
    currentPlanName: string | null;
    subscriptionStatus: string | null;
    hasSubscription: boolean;
    accessAllowed: boolean;
    grandfathered: boolean;
    state: string;
    startDate: string | null;
    endDate: string | null;
    daysToExpiry: number;
  } | null;
};

type GroupOption = {
  id: string;
  name: string;
  courseId: string;
  capacity: number;
  studentsCount: number;
  isActive: boolean;
};

export type PaymentDecisionOutcome =
  | { ok: true; action: "approve" | "reject" }
  | { ok: false; code: string; refresh: boolean };

export function PaymentReviewDrawer({
  payment,
  onClose,
  onDecided,
}: {
  payment: AdminPaymentRow | null;
  onClose: () => void;
  onDecided: (outcome: PaymentDecisionOutcome) => void;
}) {
  const t = useT();
  const locale = useLocale();

  const [groups, setGroups] = React.useState<GroupOption[]>([]);
  const [overrideGroupId, setOverrideGroupId] = React.useState<string>("");
  const [reason, setReason] = React.useState("");
  const [rejecting, setRejecting] = React.useState(false); // reason panel open
  const [busy, setBusy] = React.useState<"approve" | "reject" | null>(null);
  const [errorInfo, setErrorInfo] = React.useState<{ code: string; key: string } | null>(null);
  const [reasonError, setReasonError] = React.useState<string | null>(null);
  // Double-submit guard that survives a re-render (the button is also disabled).
  const inFlight = React.useRef(false);

  // Reset per PAYMENT (not per object identity): the parent re-reads the queue
  // after a decision, which hands us a fresh row object for the same id — the
  // admin's in-progress override/reason must survive that refresh. Done during
  // render (React's "adjust state when a prop changes" pattern).
  const paymentId = payment?.id ?? null;
  const [resetForId, setResetForId] = React.useState<string | null>(null);
  if (paymentId !== resetForId) {
    setResetForId(paymentId);
    setOverrideGroupId("");
    setReason("");
    setRejecting(false);
    setBusy(null);
    setErrorInfo(null);
    setReasonError(null);
    inFlight.current = false;
  }
  React.useEffect(() => {
    if (!paymentId) return;
    let alive = true;
    fetch("/api/admin/groups")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d?.groups) setGroups(d.groups);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [paymentId]);

  const context = payment?.studentContext ?? null;
  const pending = payment?.status === "PENDING";

  // Only groups that can legally be the target: the payment's requested
  // course, else the student's current course, else every active group (the
  // server validates the context and refuses a mismatch — the list here is a
  // convenience, never the authority).
  const scopeCourseId = payment?.requestedGroup?.courseId ?? context?.courseId ?? null;
  const groupOptions = React.useMemo(
    () =>
      groups
        .filter((g) => g.isActive)
        .filter((g) => (scopeCourseId ? g.courseId === scopeCourseId : true))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [groups, scopeCourseId]
  );

  const resolvedGroupName =
    (overrideGroupId && groupOptions.find((g) => g.id === overrideGroupId)?.name) ||
    payment?.requestedGroup?.name ||
    context?.groupName ||
    null;

  const runDecision = async (action: "approve" | "reject") => {
    if (!payment || inFlight.current) return;
    const body =
      action === "approve"
        ? // ONLY the optional group override is ever sent.
          overrideGroupId
          ? { groupId: overrideGroupId }
          : {}
        : { reason: normalizeRejectionReasonForUi(reason) ?? "" };

    inFlight.current = true;
    setBusy(action);
    setErrorInfo(null);
    try {
      const res = await fetch(`/api/admin/payments/${payment.id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = typeof payload?.code === "string" ? payload.code : "";
        setErrorInfo({ code, key: paymentDecisionErrorKey(code) });
        const refresh = PAYMENT_DECISION_REFRESH_CODES.includes(code);
        if (PAYMENT_DECISION_GROUP_RECOVERY_CODES.includes(code)) setRejecting(false);
        onDecided({ ok: false, code, refresh });
        return;
      }
      toast.success(action === "approve" ? t("pay.approveSuccess") : t("pay.rejectedToast"));
      onDecided({ ok: true, action });
      onClose();
    } catch {
      setErrorInfo({ code: "", key: "pay.errorGeneric" });
      onDecided({ ok: false, code: "", refresh: false });
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  const submitRejection = () => {
    const normalized = normalizeRejectionReasonForUi(reason);
    if (!normalized) {
      setReasonError(t("pay.rejectReasonRequired"));
      return;
    }
    if (normalized.length > REJECTION_REASON_MAX_LENGTH) {
      setReasonError(t("pay.rejectReasonTooLong", { p1: REJECTION_REASON_MAX_LENGTH }));
      return;
    }
    setReasonError(null);
    void runDecision("reject");
  };

  return (
    <Drawer
      open={!!payment}
      onOpenChange={(v) => !v && onClose()}
      direction={locale === "ar" ? "left" : "right"}
    >
      <DrawerContent className="w-full sm:max-w-lg ms-auto h-full max-h-screen flex flex-col">
        {payment && (
          <>
            <DrawerHeader className="shrink-0 border-b border-border/60 pb-3">
              <DrawerTitle className="text-lg font-bold flex items-center gap-2">
                {t("pay.reviewTitle")}
                <StatusBadge status={payment.status} />
              </DrawerTitle>
              <DrawerDescription className="text-xs">
                {payment.userName} · {payment.userEmail}
              </DrawerDescription>
            </DrawerHeader>

            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 min-h-0">
              {/* ---- warnings first: they change how the admin reads the rest ---- */}
              {payment.isLatestPending === false && (
                <Warning tone="amber" testId="warning-stale">
                  {t("pay.errorStale")}
                </Warning>
              )}
              {payment.duplicateReference && (
                <Warning tone="amber" testId="warning-duplicate">
                  {t("pay.duplicateReferenceWarning")}
                </Warning>
              )}

              {/* ---- STUDENT ---- */}
              <Section icon={UserRound} title={t("pay.reviewStudent")}>
                <Field label={t("pay.reviewStudent")} value={payment.userName} />
                <Field label={t("pay.registeredEmail")} value={payment.userEmail} ltr />
                <Field
                  label={t("pay.registeredPhone")}
                  value={payment.userPhone || "—"}
                  ltr
                />
                <Field label={t("pay.currentGroup")} value={context?.groupName || t("pay.noGroupYet")} />
                <Field label={t("pay.currentPlan")} value={context?.currentPlanName || "—"} />
                <Field
                  label={t("pay.currentEnd")}
                  value={context?.endDate ? fmtDateTime(new Date(context.endDate), locale) : "—"}
                />
                <div className="col-span-2">
                  <Badge
                    variant="outline"
                    className={
                      context?.accessAllowed
                        ? "border-primary/40 text-primary"
                        : "border-border text-muted-foreground"
                    }
                    data-testid="drawer-entitlement"
                  >
                    {context?.accessAllowed ? t("pay.entitlementActive") : t("pay.entitlementInactive")}
                  </Badge>
                </div>
              </Section>

              {/* ---- PAYMENT REQUEST ---- */}
              <Section icon={Wallet} title={t("pay.reviewPayment")}>
                <Field label={t("pay.methodTitle")} value={paymentMethodLabel(payment.method)} />
                <Field
                  label={t("pay.colAmount")}
                  value={`${formatPaymentAmount(payment.amount)} ${t("pay.egp")}`}
                />
                <Field label={t("pay.colSenderPhone")} value={payment.senderPhone || "—"} ltr />
                <Field label={t("pay.colReference")} value={payment.reference || "—"} ltr />
                <Field
                  label={t("pay.colDate")}
                  value={fmtDateTime(new Date(payment.createdAt), locale)}
                />
                <Field
                  label={t("pay.requestedPlan")}
                  value={
                    payment.requestedPlan
                      ? `${locale === "en" ? payment.requestedPlan.name : payment.requestedPlan.nameAr || payment.requestedPlan.name} · ${t("pay.monthsCount", { p1: payment.requestedPlan.durationMonths })}`
                      : "—"
                  }
                />
                <Field
                  label={t("pay.requestedGroup")}
                  value={
                    payment.requestedGroup
                      ? `${payment.requestedGroup.name}${
                          payment.requestedGroup.isActive ? "" : ` (${t("pay.methodUnavailable")})`
                        }`
                      : "—"
                  }
                />
                {payment.notes && <Field label={t("pay.couponDiscountGeneric")} value={payment.notes} />}
                {payment.rejectionReason && (
                  <Field label={t("pay.rejectedReasonLabel")} value={payment.rejectionReason} />
                )}
                {payment.reviewedAt && (
                  <Field
                    label={t("pay.reviewedAtLabel")}
                    value={fmtDateTime(new Date(payment.reviewedAt), locale)}
                  />
                )}
              </Section>

              {/* ---- DECISION CONTEXT ---- */}
              <Section icon={BadgeCheck} title={t("pay.reviewContext")}>
                <div className="col-span-2 text-xs leading-relaxed text-muted-foreground">
                  {context?.accessAllowed && !context.grandfathered && t("pay.decisionRenewal")}
                  {context?.accessAllowed && context.grandfathered && t("pay.decisionExistingAccess")}
                  {!context?.accessAllowed && t("pay.decisionNewActivation")}
                </div>
                <Field label={t("pay.groupOverride")} value={resolvedGroupName || "—"} />
                <Field
                  label={t("pay.activeEndLabel")}
                  value={context?.endDate ? fmtDateTime(new Date(context.endDate), locale) : "—"}
                />
              </Section>

              {/* ---- DECISION ---- */}
              {pending ? (
                <div className="rounded-xl border border-border/60 p-3 space-y-3">
                  <div>
                    <Label htmlFor="group-override" className="text-xs font-semibold">
                      {t("pay.groupOverride")}
                    </Label>
                    <Select
                      value={overrideGroupId}
                      onValueChange={(v) => setOverrideGroupId(v === "__none__" ? "" : v)}
                    >
                      <SelectTrigger id="group-override" className="mt-1.5 w-full">
                        <SelectValue placeholder={t("pay.selectGroupPlaceholder")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">{t("pay.groupOverrideHint")}</SelectItem>
                        {groupOptions.map((g) => (
                          <SelectItem key={g.id} value={g.id}>
                            {g.name} — {t("pay.groupSeats", { p1: g.studentsCount, p2: g.capacity })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="mt-1.5 text-[11px] text-muted-foreground">
                      {groupOptions.length === 0 ? t("pay.noGroupOptions") : t("pay.capacityHint")}
                    </p>
                  </div>

                  {errorInfo && (
                    <div
                      role="alert"
                      data-testid="decision-error"
                      data-code={errorInfo.code}
                      className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs space-y-1.5"
                    >
                      <p className="flex items-start gap-1.5 font-semibold text-destructive">
                        <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span>{t(errorInfo.key)}</span>
                      </p>
                      <p className="text-muted-foreground">{t("pay.stillPendingNote")}</p>
                    </div>
                  )}

                  {!rejecting ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        onClick={() => void runDecision("approve")}
                        disabled={busy !== null}
                        className="flex-1 bg-emerald-600 hover:bg-emerald-600/90"
                        data-testid="approve-button"
                      >
                        {busy === "approve" ? (
                          <Loader2 className="w-4 h-4 ms-2 animate-spin" />
                        ) : (
                          <CheckCircle2 className="w-4 h-4 ms-2" />
                        )}
                        {busy === "approve" ? t("pay.approving") : t("pay.approveAction")}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setRejecting(true);
                          setErrorInfo(null);
                        }}
                        disabled={busy !== null}
                        className="flex-1 border-destructive/40 text-destructive hover:bg-destructive/5"
                        data-testid="reject-button"
                      >
                        <XCircle className="w-4 h-4 ms-2" />
                        {t("pay.rejectAction")}
                      </Button>
                    </div>
                  ) : (
                    <div
                      className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-2"
                      data-testid="reject-panel"
                    >
                      <div className="text-xs font-bold text-destructive">{t("pay.rejectTitle")}</div>
                      <Label htmlFor="reject-reason" className="text-xs font-semibold">
                        {t("pay.rejectReasonLabel")}
                      </Label>
                      <Textarea
                        id="reject-reason"
                        value={reason}
                        onChange={(e) => {
                          setReason(e.target.value);
                          if (reasonError) setReasonError(null);
                        }}
                        rows={3}
                        maxLength={REJECTION_REASON_MAX_LENGTH + 50}
                        aria-invalid={!!reasonError}
                        aria-describedby={reasonError ? "reject-reason-error" : "reject-reason-hint"}
                        data-testid="reject-reason-input"
                        className="bg-background"
                      />
                      <div className="flex items-center justify-between text-[11px]">
                        <span id="reject-reason-hint" className="text-muted-foreground">
                          {t("pay.rejectReasonHint")}
                        </span>
                        <span
                          className={`font-mono tabular-nums ${
                            reason.trim().length > REJECTION_REASON_MAX_LENGTH
                              ? "text-destructive"
                              : "text-muted-foreground"
                          }`}
                          data-testid="reject-reason-count"
                        >
                          {reason.trim().length}/{REJECTION_REASON_MAX_LENGTH}
                        </span>
                      </div>
                      {reasonError && (
                        <p
                          id="reject-reason-error"
                          role="alert"
                          className="text-xs font-semibold text-destructive"
                          data-testid="reject-reason-error"
                        >
                          {reasonError}
                        </p>
                      )}
                      <p className="text-[11px] text-muted-foreground">{t("pay.rejectConfirmHint")}</p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="destructive"
                          onClick={submitRejection}
                          disabled={busy !== null}
                          className="flex-1"
                          data-testid="reject-confirm-button"
                        >
                          {busy === "reject" ? (
                            <Loader2 className="w-4 h-4 ms-2 animate-spin" />
                          ) : (
                            <XCircle className="w-4 h-4 ms-2" />
                          )}
                          {t("pay.rejectConfirm")}
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setRejecting(false);
                            setReason("");
                            setReasonError(null);
                          }}
                          disabled={busy !== null}
                        >
                          {t("pay.rejectCancel")}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div
                  className="rounded-xl border border-border/60 p-3 flex items-start gap-2 text-xs text-muted-foreground"
                  data-testid="already-decided"
                >
                  <Info className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{t("pay.errorInvalidTransition")}</span>
                </div>
              )}
            </div>
          </>
        )}
      </DrawerContent>
    </Drawer>
  );
}

/* ========================================================================= */

function StatusBadge({ status }: { status: string }) {
  const t = useT();
  const s = String(status).toUpperCase();
  if (s === "PENDING")
    return (
      <Badge variant="outline" className="border-amber-400/50 text-amber-600 dark:text-amber-400">
        <Clock className="w-3 h-3" />
        {t("pay.statusPending")}
      </Badge>
    );
  if (s === "APPROVED")
    return (
      <Badge variant="outline" className="border-primary/40 text-primary">
        {t("pay.statusApproved")}
      </Badge>
    );
  if (s === "REJECTED")
    return (
      <Badge variant="outline" className="border-destructive/40 text-destructive">
        {t("pay.statusRejected")}
      </Badge>
    );
  return <Badge variant="outline">{String(status)}</Badge>;
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/60 p-3 space-y-2">
      <div className="text-xs font-bold flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5 text-muted-foreground" />
        {title}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">{children}</div>
    </div>
  );
}

function Field({ label, value, ltr }: { label: string; value: string; ltr?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div dir={ltr ? "ltr" : undefined} className="text-xs font-semibold truncate">
        {value || "—"}
      </div>
    </div>
  );
}

function Warning({
  tone,
  testId,
  children,
}: {
  tone: "amber";
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className={`rounded-lg border p-2.5 text-xs flex items-start gap-2 ${
        tone === "amber"
          ? "border-amber-400/40 bg-amber-400/10 text-amber-700 dark:text-amber-400"
          : "border-border bg-muted text-muted-foreground"
      }`}
      role="status"
    >
      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span>{children}</span>
    </div>
  );
}
