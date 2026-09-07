"use client";

// ============================================================
// CodeMind Academy — Forgot / reset password flow (client UI)
//
// EMAIL ONLY. Phone numbers / SMS / OTP are NOT offered for password
// recovery — they remain registration/profile data only.
//
//   REQUEST — the user enters their email. The API ALWAYS answers with the
//   same neutral message, so this UI never implies whether an account exists.
//
//   CONFIRM — the user opens the emailed reset link (token is pre-filled
//   from ?token=) or pastes the token and chooses a new password. On success
//   every existing session of that account is revoked server-side.
// ============================================================

import * as React from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Mail, ArrowRight, CheckCircle2, Eye, EyeOff } from "lucide-react";

export function ForgotPasswordForm({ onBackToLogin }: { onBackToLogin: () => void }) {
  const tr = useT();

  // Pre-fill the token when the user arrives from an emailed reset link.
  const urlToken =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("token") || ""
      : "";
  const [step, setStep] = React.useState<"request" | "confirm">(() =>
    urlToken ? "confirm" : "request"
  );
  const [email, setEmail] = React.useState("");
  const [sent, setSent] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  const [token, setToken] = React.useState(urlToken);
  const [password, setPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);

  const submitRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      toast.error(tr("api.200"));
      return;
    }
    setLoading(true);
    try {
      const r = await fetch("/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || tr("auth.005"));
      // Deliberately neutral: never confirm whether the account exists.
      setSent(true);
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
            <Label htmlFor="fp-email" className="text-xs font-semibold">
              {tr("auth.203")}
            </Label>
            <div className="relative mt-1">
              <Mail className="absolute end-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
                id="fp-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                autoCapitalize="none"
                dir="ltr"
                className="h-11 pe-10"
                placeholder="you@example.com"
              />
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
            {tr("auth.217")}
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
