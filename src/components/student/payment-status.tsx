"use client";

// CodeMind Academy — Phase 25 PR3: the student payment STATUS panel.
//
// Rendered on the student dashboard. It keeps the two halves of the Phase 25
// model visually separate, exactly as the server reports them:
//
//   ENTITLEMENT (primary)  — what the student can access right now, from
//                            `/api/students/me/dashboard` (`subscription.*`,
//                            labelled by the central policy in
//                            src/lib/subscription-entitlement.ts);
//   REQUEST (secondary)    — the latest pending / rejected payment request
//                            (`paymentRequests.*`).
//
// Consequences this component is built to guarantee:
//   * a PENDING request is never rendered as an active subscription;
//   * an ACTIVE renewal under review still reads as ACTIVE, with the pending
//     request shown underneath it (access is uninterrupted);
//   * legacy students with course access but no Subscription row never see
//     "no subscription / no access" — they see their current course, and the
//     internal "grandfathered" term is never exposed;
//   * a rejection shows the admin's reason, and never claims existing access
//     was removed;
//   * after approval the entitlement card is the headline — a stale pending
//     banner never stays on top.
//
// Read-only: no writes, no decision logic, no authorization.

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  CreditCard,
  History,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLocale, useT, fmtDateTime } from "@/lib/i18n";
import {
  formatPaymentAmount,
  paymentMethodLabel,
  paymentStatusTone,
} from "@/lib/payment-ux";
import { ProofInstructionCard, WhatsAppProofActions } from "@/components/shared/payment-proof";

/** The `subscription` block of GET /api/students/me/dashboard (PR2a). */
export type StudentEntitlementView = {
  status: "ACTIVE" | "EXPIRING" | "EXPIRED" | "PENDING" | "NONE";
  endDate: string | null;
  daysToExpiry: number;
  planName: string | null;
  rawStatus?: string | null;
  accessAllowed?: boolean;
  grandfathered?: boolean;
  hasSubscription?: boolean;
};

/** A payment REQUEST row (student read contract). */
export type StudentPaymentRequestView = {
  id: string;
  amount: number;
  method: string;
  reference: string | null;
  senderPhone?: string | null;
  requestedPlan: { id: string; name: string; nameAr: string | null } | null;
  requestedGroup: { id: string; name: string; isActive: boolean } | null;
  createdAt: string;
  reviewedAt?: string | null;
  rejectionReason?: string | null;
  duplicateReference?: boolean;
};

type HistoryRow = StudentPaymentRequestView & { status: string };

/**
 * The dashboard payment panel: entitlement first, then the pending/rejected
 * request, then a compact request history.
 */
export function StudentPaymentPanel({
  subscription,
  pending,
  rejected,
  groupName,
  courseName,
  onNewRequest,
}: {
  subscription: StudentEntitlementView;
  pending: StudentPaymentRequestView | null;
  rejected: StudentPaymentRequestView | null;
  groupName: string | null;
  courseName: string | null;
  onNewRequest: () => void;
}) {
  const t = useT();
  const locale = useLocale();

  const accessAllowed = subscription.accessAllowed === true;
  const grandfathered = subscription.grandfathered === true;
  const liveEntitlement =
    subscription.status === "ACTIVE" ||
    subscription.status === "EXPIRING" ||
    // Legacy access without a Subscription row: real, current course access.
    (accessAllowed && grandfathered);

  return (
    <div className="space-y-4" data-testid="student-payment-panel">
      {/* ---- 1. ENTITLEMENT (always primary) ---- */}
      <EntitlementCard
        subscription={subscription}
        groupName={groupName}
        courseName={courseName}
        locale={locale}
        onNewRequest={onNewRequest}
      />

      {/* ---- 2. PENDING request (never styled as an approval) ---- */}
      {pending && (
        <Card className="border-sky-400/40 bg-sky-400/5" data-testid="panel-pending">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2" role="status">
              <Clock className="w-4 h-4 text-sky-600 dark:text-sky-300" />
              {t("pay.pendingTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground leading-relaxed">
              {accessAllowed && grandfathered && t("pay.pendingAccessStillOn")}
              {accessAllowed && !grandfathered && t("pay.pendingRenewal")}
              {!accessAllowed && t("pay.pendingNewStudent")}
            </p>
            {accessAllowed && subscription.endDate && (
              <p className="text-xs font-semibold text-primary" data-testid="panel-pending-end-date">
                {t("pay.pendingCurrentEndsAt", {
                  p1: fmtDateTime(new Date(subscription.endDate), locale),
                })}
              </p>
            )}

            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs" data-testid="panel-pending-summary">
              <Field label={t("pay.methodTitle")} value={paymentMethodLabel(pending.method)} />
              <Field
                label={t("pay.finalAmount")}
                value={`${formatPaymentAmount(pending.amount)} ${t("pay.egp")}`}
              />
              {pending.senderPhone && (
                <Field label={t("auth.226")} value={pending.senderPhone} ltr />
              )}
              {pending.reference && (
                <Field label={t("pay.referenceLabel")} value={pending.reference} ltr />
              )}
              {pending.requestedPlan && (
                <Field
                  label={t("pay.requestedPlan")}
                  value={locale === "en" ? pending.requestedPlan.name : pending.requestedPlan.nameAr || pending.requestedPlan.name}
                />
              )}
              {pending.requestedGroup && (
                <Field label={t("pay.requestedGroup")} value={pending.requestedGroup.name} />
              )}
              <Field
                label={t("pay.submittedLabel")}
                value={fmtDateTime(new Date(pending.createdAt), locale)}
              />
            </dl>

            {/* Manual WhatsApp proof — one number only, screenshot by hand */}
            <WhatsAppProofActions
              facts={{
                amount: pending.amount,
                method: pending.method,
                reference: pending.reference,
                senderPhone: pending.senderPhone,
              }}
            />
            <ProofInstructionCard />
          </CardContent>
        </Card>
      )}

      {/* ---- 3. REJECTED request (with the admin's reason) ---- */}
      {!pending && rejected && (
        <Card className="border-destructive/40 bg-destructive/5" data-testid="panel-rejected">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2" role="status">
              <XCircle className="w-4 h-4 text-destructive" />
              {t("pay.rejectedTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {rejected.rejectionReason && (
              <div className="rounded-lg border border-destructive/30 bg-background/60 p-3">
                <div className="text-[11px] font-semibold text-muted-foreground">
                  {t("pay.rejectedReasonLabel")}
                </div>
                <p className="mt-1 text-sm" data-testid="panel-rejected-reason">
                  {rejected.rejectionReason}
                </p>
              </div>
            )}
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
              <Field label={t("pay.methodTitle")} value={paymentMethodLabel(rejected.method)} />
              <Field
                label={t("pay.finalAmount")}
                value={`${formatPaymentAmount(rejected.amount)} ${t("pay.egp")}`}
              />
              {rejected.reference && (
                <Field label={t("pay.referenceLabel")} value={rejected.reference} ltr />
              )}
              {rejected.reviewedAt && (
                <Field
                  label={t("pay.reviewedAtLabel")}
                  value={fmtDateTime(new Date(rejected.reviewedAt), locale)}
                />
              )}
            </dl>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t("pay.rejectedRetry")}
            </p>
            {accessAllowed && liveEntitlement && (
              <p className="text-xs font-semibold text-primary" data-testid="panel-rejected-access-kept">
                {t("pay.rejectedEntitlementKept")}
              </p>
            )}
            {/* Retry = a NEW request through the normal submission flow. The
                rejected payment is never mutated or reused. */}
            <Button size="sm" onClick={onNewRequest} data-testid="panel-retry">
              <CreditCard className="w-4 h-4 ms-1.5" />
              {t("pay.openNewRequest")}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ---- 4. Request history (lightweight, student-friendly) ---- */}
      <PaymentHistoryList />
    </div>
  );
}

/* ========================================================================= */

function EntitlementCard({
  subscription,
  groupName,
  courseName,
  locale,
  onNewRequest,
}: {
  subscription: StudentEntitlementView;
  groupName: string | null;
  courseName: string | null;
  locale: "ar" | "en";
  onNewRequest: () => void;
}) {
  const t = useT();
  const accessAllowed = subscription.accessAllowed === true;
  const grandfathered = subscription.grandfathered === true;
  const hasRow = subscription.hasSubscription !== false;
  const live =
    subscription.status === "ACTIVE" ||
    subscription.status === "EXPIRING" ||
    (accessAllowed && grandfathered);

  const title = live
    ? t("pay.confirmedTitle")
    : subscription.status === "EXPIRED"
      ? t("pay.noSubscriptionYet")
      : t("pay.currentEntitlement");

  return (
    <Card data-testid="panel-entitlement">
      <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base flex items-center gap-2">
          {live ? (
            <CheckCircle2 className="w-4 h-4 text-primary" />
          ) : (
            <AlertTriangle className="w-4 h-4 text-amber-500" />
          )}
          {title}
        </CardTitle>
        {live ? (
          <Badge className="border-primary/30 bg-primary/10 text-primary hover:bg-primary/10">
            {t("pay.statusApproved")}
          </Badge>
        ) : (
          <Badge variant="outline">{t("pay.entitlementInactive")}</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          {subscription.planName && (
            <Field label={t("auth.049")} value={subscription.planName} />
          )}
          {groupName && <Field label={t("auth.048")} value={groupName} />}
          {courseName && <Field label={t("auth.047")} value={courseName} />}
          {subscription.endDate && (
            <Field
              label={t("pay.activeEndLabel")}
              value={fmtDateTime(new Date(subscription.endDate), locale)}
            />
          )}
          {subscription.status === "EXPIRING" && (
            <Field
              label={t("pay.activeStatusLabel")}
              value={`${subscription.daysToExpiry}`}
            />
          )}
        </dl>

        {!live && !groupName && (
          <>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t("pay.activateMeaning")}
            </p>
            <Button size="sm" onClick={onNewRequest} data-testid="panel-subscribe">
              <CreditCard className="w-4 h-4 ms-1.5" />
              {t("pay.openNewRequest")}
            </Button>
          </>
        )}
        {!live && groupName && (
          // Legacy access without a Subscription row: the course is current and
          // reachable — never "no subscription / no access".
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t("pay.pendingAccessStillOn")}
          </p>
        )}
        {live && !hasRow && (
          <p className="text-xs text-muted-foreground">{t("pay.pendingAccessStillOn")}</p>
        )}
      </CardContent>
    </Card>
  );
}

/* ========================================================================= */

/**
 * Compact request history from GET /api/students/me/payments. Understandable,
 * not an admin ledger: status, method, amount, reference, dates and — where
 * applicable — the rejection reason. No reviewer identity, no internal notes.
 */
function PaymentHistoryList() {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = React.useState(false);
  const [rows, setRows] = React.useState<HistoryRow[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (!open || rows !== null) return;
    let alive = true;
    fetch("/api/students/me/payments")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("err"))))
      .then((d) => {
        if (alive) setRows(Array.isArray(d?.payments) ? d.payments : []);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [open, rows]);

  return (
    <Card data-testid="panel-history">
      <CardHeader className="pb-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="w-full text-start flex items-center justify-between gap-2"
        >
          <CardTitle className="text-base flex items-center gap-2">
            <History className="w-4 h-4 text-muted-foreground" />
            {t("pay.historyTitle")}
          </CardTitle>
          <span className="text-xs text-muted-foreground">{open ? "−" : "+"}</span>
        </button>
      </CardHeader>
      {open && (
        <CardContent>
          {failed ? (
            <p className="text-xs text-muted-foreground">{t("pay.historyLoadFailed")}</p>
          ) : rows === null ? (
            <div className="skeleton-shimmer h-10 rounded-lg" />
          ) : rows.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("pay.historyEmpty")}</p>
          ) : (
            <ul className="space-y-2" data-testid="panel-history-list">
              {rows.map((r) => {
                const tone = paymentStatusTone(r.status);
                return (
                  <li
                    key={r.id}
                    className="rounded-lg border border-border/60 p-3 text-xs space-y-1"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-bold">
                        {paymentMethodLabel(r.method)} · {formatPaymentAmount(r.amount)}{" "}
                        {t("pay.egp")}
                      </span>
                      <span className="flex items-center gap-1.5">
                        {r.duplicateReference && (
                          <Badge variant="outline" className="border-amber-400/50 text-amber-600">
                            {t("pay.duplicateReferenceWarning")}
                          </Badge>
                        )}
                        <Badge
                          variant="outline"
                          className={
                            tone.tone === "approved"
                              ? "border-primary/40 text-primary"
                              : tone.tone === "rejected"
                                ? "border-destructive/40 text-destructive"
                                : tone.tone === "pending"
                                  ? "border-sky-400/50 text-sky-600 dark:text-sky-300"
                                  : ""
                          }
                        >
                          {t(tone.key)}
                        </Badge>
                      </span>
                    </div>
                    <div className="text-muted-foreground flex flex-wrap gap-x-3">
                      <span>
                        {t("pay.submittedLabel")}: {fmtDateTime(new Date(r.createdAt), locale)}
                      </span>
                      {r.reference && (
                        <span dir="ltr">
                          {t("pay.referenceLabel")}: {r.reference}
                        </span>
                      )}
                    </div>
                    {r.rejectionReason && (
                      <div className="text-destructive/90">
                        {t("pay.rejectedReasonLabel")}: {r.rejectionReason}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function Field({ label, value, ltr }: { label: string; value: string; ltr?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd dir={ltr ? "ltr" : undefined} className="mt-0.5 font-semibold truncate">
        {value || "—"}
      </dd>
    </div>
  );
}
