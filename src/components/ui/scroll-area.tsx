"use client"

import * as React from "react"
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"

import { cn } from "@/lib/utils"

/**
 * CodeMind Academy — the shared scroll area.
 *
 * IMPORTANT — WHERE A HEIGHT BOUND BELONGS (Manual-QA fix, final round)
 * ====================================================================
 * Radix renders this structure:
 *
 *   Root       `position: relative; overflow: hidden`   ← DOM props land here
 *     Viewport `width: 100%; height: 100%` + inline `overflow-y: scroll`
 *     Scrollbar (absolute)
 *
 * The Viewport's `height: 100%` resolves against the Root's height. The Root's
 * height is `auto` unless something gives it a DEFINITE height, and a
 * percentage height against an `auto` parent computes to `auto` — so the
 * Viewport ends up as tall as its content. Bounding only the Root (`max-h-…`
 * passed through `className`) therefore does NOT create a scroll container: it
 * merely CLIPS the viewport with `overflow: hidden`. The list looks cut off,
 * no scrollbar appears, and the rows below the fold are unreachable — the exact
 * production symptom this prop exists to prevent.
 *
 * A `max-height` ON THE VIEWPORT does bound it (a capped box whose content
 * overflows is scrollable), so the height utilities belong in
 * `viewportClassName`:
 *
 *   <ScrollArea viewportClassName="max-h-[min(52dvh,calc(100dvh-22rem))] overscroll-contain">
 *
 * `className` stays for Root-level layout concerns (`min-h-0`, margins…).
 * Keep the two in sync when a bound is needed: the bound scrolls, the Root
 * only clips.
 */
function ScrollArea({
  className,
  viewportClassName,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  /**
   * Classes applied to the Radix VIEWPORT — the element that actually scrolls.
   * Put the height bound (`max-h-…`) and `overscroll-contain` here.
   */
  viewportClassName?: string
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className={cn(
          "focus-visible:ring-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1",
          viewportClassName
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollBar orientation="horizontal" />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none",
        orientation === "vertical" &&
          "h-full w-2.5 border-e border-e-transparent",
        orientation === "horizontal" &&
          "h-2.5 flex-col border-t border-t-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="bg-border relative flex-1 rounded-full"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
