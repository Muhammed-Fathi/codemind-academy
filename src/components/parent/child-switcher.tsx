"use client";

// CodeMind Academy — Phase I: the Parent Child Switcher.
//
// One control, used by every Parent surface that is scoped to a child. Rules:
//
//   * It SWITCHES CONTEXT, it does not fetch academics: the selected id is
//     handed to the server with `?studentId=`, and the server re-verifies the
//     ParentStudentLink on every call. Nothing here trusts the id it holds —
//     a stale/unauthorized id simply comes back 404 and the view says so.
//   * It stays usable at normal laptop widths: the row scrolls horizontally
//     instead of wrapping into a wall of chips, and each chip keeps its avatar
//     + name + course on one line.
//   * The id is lifted into the shared app store so navigating to the weekly
//     report, analytics or the monthly report and back keeps the same child.

import * as React from "react";
import { useT } from "@/lib/i18n";
import { useApp } from "@/lib/store";
import { GraduationCap } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

export type SwitcherChild = {
  id: string;
  name: string;
  courseName: string | null;
  avatarUrl: string | null;
};

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "—"
  );
}

export function ChildSwitcher({
  items,
  value,
  onChange,
}: {
  /** Named `items`, not `children`: this is a data list, not React children. */
  items: SwitcherChild[];
  value: string | null;
  onChange: (studentId: string) => void;
}) {
  const t = useT();
  if (items.length <= 1) return null;

  return (
    <div
      role="tablist"
      aria-label={t("parent.switcher.label")}
      className="flex w-full gap-2 overflow-x-auto pb-1 -mb-1 snap-x"
      dir="rtl"
    >
      {items.map((child) => {
        const active = child.id === value;
        return (
          <button
            key={child.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(child.id)}
            className={[
              "snap-start shrink-0 flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors",
              "max-w-[15rem] text-start",
              active
                ? "border-primary bg-primary/10 text-primary font-semibold"
                : "border-border bg-card text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            ].join(" ")}
          >
            <Avatar className="h-6 w-6 shrink-0">
              {child.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- the dashboard renders remote avatars the same way
                <img src={child.avatarUrl} alt="" className="h-full w-full object-cover" />
              ) : null}
              <AvatarFallback className="text-[10px]">{initialsOf(child.name)}</AvatarFallback>
            </Avatar>
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate">{child.name}</span>
              {child.courseName ? (
                <span className="truncate text-[11px] font-normal opacity-70">
                  <GraduationCap className="inline h-3 w-3 ms-0.5 align-[-1px]" /> {child.courseName}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Read + write the retained selected-child id (session-scoped, never persisted). */
export function useSelectedChildId(available: Array<{ id: string }>): [string | null, (id: string) => void] {
  const stored = useApp((s) => s.parentChildId);
  const setStored = useApp((s) => s.setParentChildId);
  const availableIds = React.useMemo(() => available.map((c) => c.id), [available]);
  // A retained id that is no longer linked (unlinked elsewhere, or a different
  // account after logout) falls back to the first child — the server is still
  // the authority; this only keeps the UI from asking for a ghost.
  const effective = stored && availableIds.includes(stored) ? stored : (availableIds[0] ?? null);
  return [effective, setStored];
}
