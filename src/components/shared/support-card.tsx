"use client";

// CodeMind Academy — shared "محتاج مساعدة؟" support card.
//
// Post-launch redesign: the old card showed a single generic phone line and
// one WhatsApp button. Users must not be silently routed to the wrong person,
// so the card now presents BOTH support contacts — each with a clear role,
// name, a clickable `tel:` line and its OWN WhatsApp action. People and
// numbers come from the single source of truth in src/lib/brand.ts
// (SUPPORT_CONTACTS / SUPPORT_PEOPLE) — never hardcoded here.
//
// Rendered inside the dashboard sidebar for every role, so it must stay
// compact, RTL-clean (English names/numbers are pinned LTR) and responsive.

import * as React from "react";
import { useT } from "@/lib/i18n";
import { SUPPORT_PEOPLE, telLink, whatsappLink } from "@/lib/brand";
import {
  HeartHandshake,
  Headset,
  GraduationCap,
  MessageCircle,
  Phone,
} from "lucide-react";

const ROLE_ICON = {
  technical: Headset,
  teacher: GraduationCap,
} as const;

const ROLE_LABEL_KEY = {
  technical: "shell.039",
  teacher: "shell.040",
} as const;

export function SupportCard({ className }: { className?: string }) {
  const tr = useT();

  return (
    <div
      data-testid="support-card"
      className={`rounded-xl bg-gradient-to-br from-primary/10 to-amber-400/10 p-3.5 border border-primary/10 overflow-hidden ${className || ""}`}
    >
      <div className="flex items-center gap-2 mb-1.5 min-w-0">
        <HeartHandshake className="w-4 h-4 text-primary shrink-0" />
        <div className="text-xs font-bold truncate">{tr("shell.016")}</div>
      </div>
      <p className="text-[11px] text-muted-foreground mb-3 leading-relaxed break-words">
        {tr("shell.017")}
      </p>

      <div className="space-y-2.5">
        {SUPPORT_PEOPLE.map((person) => {
          const Icon = ROLE_ICON[person.id as keyof typeof ROLE_ICON] ?? Headset;
          const labelKey =
            ROLE_LABEL_KEY[person.id as keyof typeof ROLE_LABEL_KEY] ??
            "shell.038";
          return (
            <div
              key={person.id}
              className="rounded-lg bg-card/90 border border-border/60 p-2.5"
            >
              <div className="flex items-center gap-1.5 text-[10px] font-bold text-primary mb-1">
                <Icon className="w-3 h-3 shrink-0" />
                <span className="truncate">{tr(labelKey)}</span>
              </div>
              {/* English name inside the Arabic UI — pinned LTR, right-aligned
                  start edge so it reads cleanly in RTL. */}
              <div
                className="text-[11px] font-bold text-foreground truncate"
                dir="ltr"
              >
                {person.name}
              </div>
              <div className="flex items-center justify-between gap-2 mt-2">
                <a
                  href={telLink(person.phoneDisplay)}
                  dir="ltr"
                  className="inline-flex items-center gap-1 text-[11px] font-black text-foreground hover:text-primary transition-colors"
                >
                  <Phone className="w-3 h-3 shrink-0 opacity-70" />
                  {person.phoneDisplay}
                </a>
                <a
                  href={whatsappLink(person.phoneIntl, tr("shell.018"))}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-primary text-primary-foreground text-[10px] font-bold hover:opacity-90 transition-opacity shrink-0"
                >
                  <MessageCircle className="w-3 h-3 shrink-0" />
                  {tr("shell.042")}
                </a>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
