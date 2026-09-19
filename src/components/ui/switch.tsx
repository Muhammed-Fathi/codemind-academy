"use client"

import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

/**
 * Shared Switch (Radix Switch) — used by the Parent/Teacher/Student
 * notification preferences (via `PreferenceRow`) and by the Admin
 * plan / group forms. There is no per-surface copy of this control.
 *
 * GEOMETRY CONTRACT — the knob can never leave the track:
 *   track : 20 × 36 px (`h-5 w-9`) with a 2px transparent border,
 *           so the padding box is 16 × 32 px
 *   knob  : 16 × 16 px (`size-4`), inset 2px from the padding-box edge
 *           on every side (`start-0.5` → `calc(100% - 1.125rem)` when ON,
 *           i.e. 32 − 16 − 2 = 14px of travel inside the track)
 *
 * ROOT CAUSE of the "knob detached from the pill" report: the previous
 * version placed the knob with the LOGICAL flex start and then moved it
 * with the PHYSICAL `translate-x` positive transform. Under the app's
 * `dir="rtl"` document the flex start is the RIGHT edge, so the checked
 * transform pushed the knob a further ~14px to the right — visually
 * outside the control. This is the same logical/physical mix that broke
 * the dialogs (see src/components/ui/dialog.tsx). The knob now travels on
 * `inset-inline-start` only, which is writing-mode agnostic, so it slides
 * inward in both LTR and RTL.
 *
 * The knob is `bg-white` in BOTH themes: the old
 * `dark:data-[state=checked]:bg-primary-foreground` resolved to
 * `--primary-foreground` = oklch(0.16 …) in dark mode, i.e. a near-black
 * circle sitting on the green track.
 */
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        // Track — neutral gray when OFF, emerald when ON, with a visible
        // focus ring and disabled state.
        "peer relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent p-0 shadow-xs transition-colors duration-200 outline-none",
        "data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
        "hover:data-[state=checked]:bg-primary/90 hover:data-[state=unchecked]:bg-muted-foreground/25",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          // Knob — always a light disc, positioned with logical insets so it
          // stays inside the track in RTL as well as LTR.
          "pointer-events-none absolute top-1/2 start-0.5 block size-4 rounded-full bg-white shadow-sm ring-1 ring-black/10 -translate-y-1/2",
          "transition-[inset-inline-start] duration-200 ease-out",
          "data-[state=checked]:start-[calc(100%-1.125rem)]"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
