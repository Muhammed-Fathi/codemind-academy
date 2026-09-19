"use client";

// CodeMind Academy — the SHARED searchable entity selector (Manual-QA fix,
// Finding 1).
//
// WHY THIS EXISTS
// ===============
// The Admin live-ops filters asked the operator to TYPE an internal id
// (`<Input placeholder="ID" />`) for both the teacher and the group. An admin
// cannot know a cuid by heart, never mind type it correctly, so the filter was
// effectively unusable: the screen showed a box that accepted text and matched
// nothing.
//
// BEHAVIOR CONTRACT
// =================
//  * The VALUE is the authoritative entity id (the API keeps receiving exactly
//    the same `groupId` / `teacherId` query parameters — the filtering
//    semantics did not change).
//  * The LABEL is human: the entity's own name, plus an optional hint
//    (course name, student count…) that is searchable but rendered small.
//  * Search is client-side over the authoritative list the admin API already
//    returns; a value can never be typed in by hand, so no client-supplied
//    string can widen the scope: the server still re-filters every request.
//  * Explicit loading / error (with retry) / empty states — never a silent box.
//  * "All" is a first-class choice (clears the filter) and the trigger always
//    shows what is currently applied.

import * as React from "react";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Check, ChevronsUpDown, X, AlertTriangle, RefreshCw } from "lucide-react";

export type EntityOption = {
  /** The authoritative id sent to the API. */
  value: string;
  /** The human-readable name shown (and searched). */
  label: string;
  /** Extra searchable text (e.g. the course name) — never shown as the label. */
  hint?: string;
  /** A short right-aligned note (e.g. "12 طالب"). */
  meta?: string;
};

export function EntitySelect({
  value,
  onChange,
  options,
  placeholder,
  searchPlaceholder,
  allLabel,
  emptyLabel,
  loading,
  error,
  onRetry,
  className,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  options: EntityOption[];
  /** Shown on the trigger when nothing is selected. */
  placeholder: string;
  searchPlaceholder: string;
  /** The "no filter" choice (clears the value). */
  allLabel: string;
  /** Shown when the authoritative list is empty. */
  emptyLabel: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  className?: string;
  disabled?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const selected = options.find((o) => o.value === value) || null;

  if (loading) {
    return <Skeleton className={`h-9 w-full ${className || ""}`} />;
  }

  if (error) {
    return (
      <div className={`space-y-1 ${className || ""}`}>
        <div className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
        {onRetry ? (
          <Button type="button" size="sm" variant="outline" onClick={onRetry} className="h-7 text-xs">
            <RefreshCw className="w-3 h-3 ms-1" />
            {t("notif.retry")}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={placeholder}
          disabled={disabled}
          className={`w-full justify-between font-normal ${className || ""}`}
        >
          <span className="truncate text-start">
            {selected ? (
              <>
                <span className="font-medium">{selected.label}</span>
                {selected.hint ? (
                  <span className="text-muted-foreground text-xs ms-1">· {selected.hint}</span>
                ) : null}
              </>
            ) : (
              <span className="text-muted-foreground">{value ? value : placeholder}</span>
            )}
          </span>
          <span className="flex items-center gap-1 shrink-0">
            {value ? (
              <span
                role="button"
                tabIndex={0}
                aria-label={t("live.filter.clear")}
                className="rounded-sm p-0.5 hover:bg-muted"
                onPointerDown={(e) => {
                  // Radix opens the popover on pointerdown: stop it here so
                  // clearing the filter never flashes the list open.
                  e.stopPropagation();
                  e.preventDefault();
                }}
                onClick={(e) => {
                  // Clear without opening the popover.
                  e.stopPropagation();
                  e.preventDefault();
                  onChange("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    e.preventDefault();
                    onChange("");
                  }
                }}
              >
                <X className="w-3 h-3" />
              </span>
            ) : null}
            <ChevronsUpDown className="w-3.5 h-3.5 opacity-50" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0 w-[--radix-popover-trigger-width]" align="start">
        <Command
          filter={(itemValue, search) => {
            // `itemValue` carries every searchable token (label + hint), so an
            // admin can type either the group or its course.
            const haystack = itemValue.toLowerCase();
            return haystack.includes(search.toLowerCase()) ? 1 : 0;
          }}
        >
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value={`${allLabel} __all__`}
                onSelect={() => {
                  onChange("");
                  setOpen(false);
                }}
              >
                <Check className={`w-4 h-4 me-2 ${value ? "opacity-0" : "opacity-100"}`} />
                {allLabel}
              </CommandItem>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={`${o.label} ${o.hint || ""} ${o.value}`}
                  onSelect={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                >
                  <Check className={`w-4 h-4 me-2 ${value === o.value ? "opacity-100" : "opacity-0"}`} />
                  <span className="truncate">{o.label}</span>
                  {o.hint ? (
                    <span className="text-xs text-muted-foreground ms-2 truncate">{o.hint}</span>
                  ) : null}
                  {o.meta ? <span className="ms-auto text-xs text-muted-foreground">{o.meta}</span> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
