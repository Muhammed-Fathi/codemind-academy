"use client";

// ============================================================
// CodeMind Academy — Forgot / reset password flow (client UI)
//
// Two steps in one component:
//   1. REQUEST — user gives an email or mobile number and a delivery channel.
//      The API ALWAYS answers the same way, so this UI must never imply that
//      an account does or does not exist. We show a neutral "if the account
//      exists…" confirmation in every case.
//   2. CONFIRM — user pastes the emailed link token or the 6-digit SMS code
//      and chooses a new password. On success every existing session of that
//      account is revoked server-side, so the user logs in fresh.
// ============================================================

import * as React from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Mail, MessageSquare, ArrowRight, CheckCircle2, Eye, EyeOff } from "lucide-react";

export function ForgotPasswordForm({ onBackToLogin }: { onBackToLogin: () => void }) {
  const tr = useT();

  const [step, setStep] = React.useState<"request" | "confirm">("request");
  const [identifier, setIdentifier] = React.useState("");
  const [channel, setChannel] = React.useState<"EMAIL" | "SMS">("EMAIL");
  const [sent, setSent] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  const [token, setToken] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);

  // Pre-fill the token when the user arrives from an emailed reset link.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const t = new URLSearchParams(window.location.search).get("token");
    if (t) {
      setToken(t);
      setStep("confirm");
    }
  }, []);

  const submitRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifier.trim()) {
      toast.error(tr("api.200"));
      return;
    }
    setLoading(true);
    try {
      const r = await fetch("/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: identifier.trim(), channel }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || tr("auth.005"));
      // Deliberately neutral: never confirm whether the account exists.
      setSent(true);
      setStep("confirm");
      toast.success(tr("auth.215"));
    } catch (err: any) {
      toast.error(err.message || tr("auth.007"));
    } finally {
      setLoading(false);
    }
  };

  const submitConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) {
      toast.error(tr("api.203"));
      return;
    }
    if (password.length < 8) {
      toast.error(tr("api.204"));
      return;
    }
    if (password !== confirmPassword) {
      toast.error(tr("auth.212"));
      return;
    }
    setLoading(true);
    try {
      const r = await fetch("/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: token.trim(),
          password,
          identifier: identifier.trim() || undefined,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || tr("auth.005"));
      toast.success(tr("auth.211"));
      onBackToLogin();
    } catch (err: any) {
      toast.error(err.message || tr("auth.007"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-4"
    >
      {sent && (
        <div className="flex items-start gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs">
          <CheckCircle2 className="mt-0.5 w-4 h-4 shrink-0 text-emerald-600" />
          <p className="text-muted-foreground">{tr("auth.215")}</p>
        </div>
      )}

      {step === "request" ? (
        <form onSubmit={submitRequest} className="space-y-4">
          <p className="text-sm text-muted-foreground">{tr("auth.202")}</p>

          <div>
            <Label htmlFor="fp-identifier" className="text-xs font-semibold">
              {tr("auth.203")}
            </Label>
            <Input
              id="fp-identifier"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              autoComplete="username"
              dir="ltr"
              className="mt-1"
            />
          </div>

          <div>
            <Label className="text-xs font-semibold">{tr("auth.204")}</Label>
            <div className="mt-1 grid grid-cols-2 gap-2">
              {(
                [
                  { value: "EMAIL", labelKey: "auth.205", Icon: Mail },
                  { value: "SMS", labelKey: "auth.206", Icon: MessageSquare },
                ] as const
              ).map(({ value, labelKey, Icon }) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={channel === value}
                  onClick={() => setChannel(value)}
                  className={`inline-flex items-center justify-center gap-2 rounded-xl border p-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                    channel === value
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border/60 text-muted-foreground hover:bg-muted/50"
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  {tr(labelKey)}
                </button>
              ))}
            </div>
          </div>

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? (
              <Loader2 className="w-4 h-4 me-2 animate-spin" />
            ) : (
              <ArrowRight className="w-4 h-4 me-2 rtl:rotate-180" />
            )}
            {tr("auth.207")}
          </Button>

          <button
            type="button"
            onClick={() => setStep("confirm")}
            className="w-full text-center text-xs text-primary hover:underline"
          >
            {tr("auth.213")}
          </button>
        </form>
      ) : (
        <form onSubmit={submitConfirm} className="space-y-4">
          <div>
            <Label htmlFor="fp-token" className="text-xs font-semibold">
              {tr("auth.208")}
            </Label>
            <Input
              id="fp-token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              dir="ltr"
              autoComplete="one-time-code"
              className="mt-1"
            />
          </div>

          <div>
            <Label htmlFor="fp-password" className="text-xs font-semibold">
              {tr("auth.209")}
            </Label>
            <div className="field-with-icon mt-1">
              <Input
                id="fp-password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={tr("auth.209")}
                className="field-icon text-muted-foreground hover:text-foreground"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div>
            <Label htmlFor="fp-password2" className="text-xs font-semibold">
              {tr("auth.210")}
            </Label>
            <Input
              id="fp-password2"
              type={showPassword ? "text" : "password"}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              className="mt-1"
            />
          </div>

          <Button type="submit" className="w-full" disabled={loading}>
            {loading && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
            {tr("auth.211")}
          </Button>

          <button
            type="button"
            onClick={() => setStep("request")}
            className="w-full text-center text-xs text-primary hover:underline"
          >
            {tr("auth.207")}
          </button>
        </form>
      )}

      <button
        type="button"
        onClick={onBackToLogin}
        className="w-full text-center text-sm text-muted-foreground hover:text-foreground"
      >
        {tr("auth.214")}
      </button>
    </motion.div>
  );
}
