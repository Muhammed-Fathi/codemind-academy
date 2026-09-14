"use client";

// CodeMind Academy — Phase 25 PR3: the shared payment-proof UI blocks.
//
// Used by BOTH student surfaces (the payment page in the enrollment flow and
// the student dashboard payment panel) so the proof rules are stated once:
//
//   * the transfer destination is READ per selected method from the brand
//     configuration (`paymentDestinationFor`) — never a shared constant, never
//     an invented number;
//   * the WhatsApp proof numbers are EXACTLY the two approved lines, and the
//     student is explicitly told to use ONE of them, not both;
//   * the prefilled message carries ONLY the five approved user-facing facts
//     (name, amount, method, reference, sender phone) — no `CM-XXXXXX` student
//     code and no internal id ever reaches a WhatsApp URL;
//   * there is NO screenshot upload anywhere: the image is attached manually
//     by the student inside WhatsApp, and the copy says so.
//
// Everything is presentational: no authorization, no state machine, no writes.

import { MessageCircle, Copy, CheckCircle2, Info, Image as ImageIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { useApp } from "@/lib/store";
import {
  buildPaymentProofMessage,
  PAYMENT_PROOF_WHATSAPP_NUMBERS,
  PAYMENT_REVIEW_WINDOW_HOURS,
  paymentDestinationFor,
  paymentMethodLabel,
  whatsappProofHref,
  type PaymentProofMessageFacts,
} from "@/lib/payment-ux";

/**
 * The transfer destination of the SELECTED method, read from configuration.
 * Renders an honest "not configured" line instead of borrowing another
 * method's number when the configuration has none.
 */
export function PaymentMethodDestination({
  method,
  className = "",
}: {
  method: string | null;
  className?: string;
}) {
  const t = useT();
  const destination = method ? paymentDestinationFor(method) : null;
  const label = method ? paymentMethodLabel(method) : "";

  const copy = async () => {
    if (!destination) return;
    try {
      await navigator.clipboard.writeText(destination.replace(/[^\d+]/g, ""));
      toast.success(t("pay.copied"));
    } catch {
      toast.error(t("pay.copyFailed"));
    }
  };

  return (
    <div
      className={`rounded-xl border border-border/60 bg-muted/30 p-3 ${className}`}
      data-testid="payment-destination"
    >
      <div className="text-[11px] font-semibold text-muted-foreground">
        {t("pay.destinationLabel")}
        {label ? ` — ${label}` : ""}
      </div>
      {destination ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <code
            dir="ltr"
            data-testid="payment-destination-value"
            className="text-lg font-black font-mono tracking-wide text-primary select-all"
          >
            {destination}
          </code>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={copy}
            aria-label={t("pay.copyNumber")}
            className="h-7 px-2 text-[11px]"
          >
            <Copy className="w-3.5 h-3.5 ms-1" />
            {t("pay.copyNumber")}
          </Button>
        </div>
      ) : (
        <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
          {t("pay.destinationMissing")}
        </p>
      )}
      {method === "INSTAPAY" && (
        <p className="mt-1.5 text-[11px] text-muted-foreground leading-relaxed">
          {t("pay.destinationInstapayHint")}
        </p>
      )}
      {method === "ETISALAT_CASH" && (
        <p className="mt-1.5 text-[11px] text-muted-foreground leading-relaxed">
          {t("pay.destinationEtisalatHint")}
        </p>
      )}
    </div>
  );
}

/**
 * The WhatsApp proof actions: one button per APPROVED number, a prefilled
 * (URL-encoded) message, and the ONE-number-only rule stated in words.
 *
 * `target="_blank"` + `rel="noopener noreferrer"`: a user-initiated external
 * link, never an integration. Nothing is sent automatically and no image is
 * attached by us — the student attaches the screenshot by hand.
 */
export function WhatsAppProofActions({
  facts,
  className = "",
}: {
  facts: PaymentProofMessageFacts;
  className?: string;
}) {
  const t = useT();
  // The student's own name from the session — a user-facing fact, never an id.
  const sessionName = useApp((s) => s.user?.name ?? "");
  const message = buildPaymentProofMessage(
    { ...facts, studentName: facts.studentName ?? sessionName },
    t
  );

  return (
    <div
      className={`rounded-xl border border-emerald-400/30 bg-emerald-400/5 p-3.5 ${className}`}
      data-testid="whatsapp-proof"
    >
      <div className="flex items-start gap-2">
        <MessageCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-bold">{t("pay.proofTitle")}</div>
          <p className="mt-1 text-[11px] text-muted-foreground leading-relaxed">
            {t("pay.proofBody")}
          </p>

          <div
            className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap"
            data-testid="whatsapp-proof-numbers"
          >
            {PAYMENT_PROOF_WHATSAPP_NUMBERS.map((number) => {
              const href = whatsappProofHref(number, message);
              if (!href) return null;
              return (
                <a
                  key={number}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="whatsapp-proof-link"
                  data-number={number}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs font-bold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20 transition-colors"
                >
                  <MessageCircle className="w-3.5 h-3.5" />
                  {t("pay.proofNumberLabel", { p1: number })}
                </a>
              );
            })}
          </div>

          <p
            className="mt-2 flex items-start gap-1.5 text-[11px] font-semibold text-amber-700 dark:text-amber-400"
            data-testid="whatsapp-one-number-only"
          >
            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{t("pay.oneNumberOnly")}</span>
          </p>
          <p className="mt-1 flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <ImageIcon className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{t("pay.manualAttachment")}</span>
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The five-step proof instruction card (transfer → screenshot → ONE WhatsApp
 * number → keep the reference → wait for review) + the honest review window.
 */
export function ProofInstructionCard({ className = "" }: { className?: string }) {
  const t = useT();
  const steps = [
    t("pay.stepTransfer"),
    t("pay.stepScreenshot"),
    t("pay.stepWhatsapp"),
    t("pay.stepReference"),
    t("pay.stepWait", { p1: PAYMENT_REVIEW_WINDOW_HOURS }),
  ];

  return (
    <div
      className={`rounded-2xl border border-border/60 bg-card p-4 ${className}`}
      data-testid="proof-instructions"
    >
      <div className="text-sm font-bold mb-2 flex items-center gap-1.5">
        <CheckCircle2 className="w-4 h-4 text-primary" />
        {t("pay.proofTitle")}
      </div>
      <ol className="space-y-2" data-testid="proof-instruction-steps">
        {steps.map((step, i) => (
          <li key={i} className="flex items-start gap-2 text-xs leading-relaxed">
            <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary/10 text-[10px] font-black text-primary tabular-nums">
              {i + 1}
            </span>
            <span className="text-muted-foreground">{step}</span>
          </li>
        ))}
      </ol>
      <p
        className="mt-3 rounded-lg bg-amber-400/10 px-2.5 py-2 text-[11px] font-semibold text-amber-700 dark:text-amber-400"
        data-testid="proof-one-number-only"
      >
        {t("pay.oneNumberOnly")}
      </p>
      <p
        className="mt-2 text-[11px] text-muted-foreground"
        data-testid="proof-review-time"
      >
        {t("pay.reviewTime", { p1: PAYMENT_REVIEW_WINDOW_HOURS })}
      </p>
    </div>
  );
}

/**
 * Pre-submission proof note: the two approved numbers as plain text plus the
 * ONE-number-only rule. The actionable (prefilled) links appear after the
 * request is submitted, when the real reference/amount exist.
 */
export function WhatsAppProofNumbersNote({ className = "" }: { className?: string }) {
  const t = useT();
  return (
    <div
      className={`rounded-2xl border border-emerald-400/30 bg-emerald-400/5 p-4 ${className}`}
      data-testid="proof-numbers-note"
    >
      <div className="text-sm font-bold mb-1.5 flex items-center gap-1.5">
        <MessageCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
        {t("pay.proofTitle")}
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">{t("pay.proofBody")}</p>
      <ul
        className="mt-2 space-y-1 text-sm font-bold font-mono text-emerald-700 dark:text-emerald-300"
        dir="ltr"
        data-testid="proof-numbers-list"
      >
        {PAYMENT_PROOF_WHATSAPP_NUMBERS.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] font-semibold text-amber-700 dark:text-amber-400">
        {t("pay.oneNumberOnly")}
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground">{t("pay.manualAttachment")}</p>
    </div>
  );
}

/** "Where do I find the reference?" — honest, app-agnostic wording. */
export function ReferenceHelp({ className = "" }: { className?: string }) {
  const t = useT();
  return (
    <div
      className={`rounded-2xl border border-border/60 bg-card p-4 ${className}`}
      data-testid="reference-help"
    >
      <div className="text-sm font-bold mb-1.5">{t("pay.findReferenceTitle")}</div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        {t("pay.findReferenceBody")}
      </p>
    </div>
  );
}


