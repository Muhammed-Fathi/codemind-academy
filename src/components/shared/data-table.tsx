"use client";

// CodeMind Academy — Phase M1 — the shared DATA TABLE.
//
// WHY
//   The list views that need a table today hand-roll `<table>` markup, and the
//   hand-rolled ones get four things wrong in RTL/mobile use:
//     * no horizontal escape hatch — the widest column is clipped off-screen;
//     * no sticky header, so the column meaning is lost when a long list is
//       scrolled (the app's long lists are the norm: rosters, payments,
//       attendance);
//     * the loading and empty states are inlined in each view and drift;
//     * physical utilities (`text-left`, `border-r`) that do not mirror.
//
// WHAT THIS IS
//   Opt-in infrastructure for M2+: a typed column list, an overflow-safe
//   container, an optional sticky header, loading/empty placeholders and a
//   footer slot (pagination lives in the footer, not inside this component).
//
// WHAT THIS IS NOT (M1)
//   * It does NOT rewrite any existing table: nothing in `src/` imports it yet.
//     Adoption is a per-view decision in M2, where each view keeps its own
//     columns, its own server query and its own pagination.
//   * It does NOT own sorting, paging, selection or fetching state. Those
//     belong to the view (or a future table store), not to a layout primitive.
//   * It does NOT invent statuses or badges — cells render whatever the caller
//     returns (typically a `StatusBadge` or an `AcademicLevelBadge`).
//
// WHY RAW `<table>` ELEMENTS RATHER THAN `@/components/ui/table`
//   That component's scroll container is hard-coded (`relative w-full
//   overflow-x-auto`) and cannot take the height bound a sticky header needs,
//   nor the caller's container classes. The markup below therefore mirrors its
//   contract deliberately — the same `data-slot` names, the same
//   `text-start` cells, the same `overflow-x-auto` container — so a later
//   migration between the two is a no-op for tests that key on the DOM.
//
// RTL
//   Cells and headers use `text-start`/`text-end` (logical), the container
//   scrolls in the inline direction, and the RTL-aware `TableRow`/`TableHead`
//   equivalents use `border-b`. No `text-left` / `text-right` / `left-*` /
//   `right-*` anywhere in this file.

import * as React from "react";
import { cn } from "@/lib/utils";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/shared/async-state";

/** Column alignment, expressed logically (never `left`/`right`). */
export type DataTableAlign = "start" | "center" | "end";

export type DataTableColumn<T> = {
  /** Stable identity of the column (also the React key). */
  key: string;
  /** Header cell content (already localised). */
  header: React.ReactNode;
  /** Cell renderer for one row. */
  cell: (row: T, rowIndex: number) => React.ReactNode;
  align?: DataTableAlign;
  /** Extra classes for every cell of this column (e.g. `tabular-nums`). */
  className?: string;
  /** Extra classes for the header cell only. */
  headerClassName?: string;
  /**
   * `false` lets this column's cells wrap (the default is the house table's
   * single line, which is what keeps code/level/status rows readable).
   */
  nowrap?: boolean;
  /** Optional `col` width hint, e.g. `"12rem"`. */
  width?: string;
};

export type DataTableProps<T> = {
  columns: ReadonlyArray<DataTableColumn<T>>;
  rows: ReadonlyArray<T>;
  /** Stable key per row. Falls back to the row index (fine for page-sized lists). */
  getRowKey?: (row: T, rowIndex: number) => React.Key;
  /** `true` renders the shared loading block; a node renders it verbatim. */
  loading?: boolean | React.ReactNode;
  /**
   * The empty slot. `undefined`/`true` renders the shared empty block;
   * `false` renders the empty body with no message (the caller owns it);
   * a node renders verbatim.
   */
  empty?: boolean | React.ReactNode;
  /** `true` renders the shared error block with retry; a node renders verbatim. */
  error?: boolean | React.ReactNode;
  onRetry?: () => void;
  /** Optional caption above the table (also its accessible description). */
  caption?: React.ReactNode;
  /** Footer slot — pagination, totals, "showing N of M". */
  footer?: React.ReactNode;
  /**
   * Keeps the header visible while the container scrolls. Give the container a
   * bounded height (`containerClassName="max-h-[60dvh]"`); with an unbounded
   * container the page scrolls instead and there is nothing to stick to.
   */
  stickyHeader?: boolean;
  /** Compacts the vertical padding for dense admin tables. */
  dense?: boolean;
  /** Classes for the scrolling container (put the height bound here). */
  containerClassName?: string;
  /** Classes for the `<table>` element (e.g. `min-w-[52rem]`). */
  tableClassName?: string;
  className?: string;
  /** Rendered above the table (toolbar, search box, filter bar). */
  toolbar?: React.ReactNode;
  /** Rows become clickable when provided; the row also gets `cursor-pointer`. */
  onRowClick?: (row: T, rowIndex: number) => void;
};

const ALIGN_CLASS: Record<DataTableAlign, string> = {
  start: "text-start",
  center: "text-center",
  end: "text-end",
};

/** The house table's own cell typography, restated here (see the note above). */
const HEAD_CLASS =
  "text-foreground h-10 px-2 align-middle font-medium whitespace-nowrap";
const CELL_CLASS = "p-2 text-start align-middle whitespace-nowrap";

function isSlot(value: unknown): value is React.ReactNode {
  return value !== undefined && value !== null && value !== false;
}

/**
 * The shared table. Renders the toolbar, then the header, then exactly one of
 * loading / error / empty / rows, then the optional footer.
 */
export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  loading,
  empty,
  error,
  onRetry,
  caption,
  footer,
  stickyHeader = false,
  dense = false,
  containerClassName,
  tableClassName,
  className,
  toolbar,
  onRowClick,
}: DataTableProps<T>) {
  const pad = dense ? "py-1.5 px-2" : "py-2.5 px-3";
  const spanCell = (content: React.ReactNode, key: string) => (
    <tr key={key} className="border-b border-border">
      <td colSpan={columns.length} className={cn("p-0 text-start")}>
        {content}
      </td>
    </tr>
  );

  const showError = error === true || (isSlot(error) && typeof error !== "boolean");
  const showLoading = loading === true || (isSlot(loading) && typeof loading !== "boolean");
  const isEmpty = rows.length === 0 && !showError && !showLoading;
  const showEmpty = isEmpty && empty !== false;

  let body: React.ReactNode;
  if (showError) {
    body = spanCell(
      error === true ? <ErrorBlock onRetry={onRetry} /> : (error as React.ReactNode),
      "state-error"
    );
  } else if (showLoading) {
    body = spanCell(
      loading === true ? <LoadingBlock /> : (loading as React.ReactNode),
      "state-loading"
    );
  } else if (showEmpty) {
    body = spanCell(
      empty === true || empty === undefined ? <EmptyBlock /> : (empty as React.ReactNode),
      "state-empty"
    );
  } else {
    body = rows.map((row, i) => (
      <tr
        key={getRowKey ? getRowKey(row, i) : i}
        className={cn(
          "hover:bg-muted/50 border-b border-border transition-colors",
          onRowClick && "cursor-pointer"
        )}
        onClick={onRowClick ? () => onRowClick(row, i) : undefined}
      >
        {columns.map((c) => (
          <td
            key={c.key}
            className={cn(
              CELL_CLASS,
              pad,
              ALIGN_CLASS[c.align || "start"],
              c.nowrap === false && "whitespace-normal",
              c.className
            )}
          >
            {c.cell(row, i)}
          </td>
        ))}
      </tr>
    ));
  }

  return (
    <div className={cn("w-full", className)} data-data-table="">
      {toolbar}
      {caption ? (
        <p className="text-xs text-muted-foreground pb-2 text-start">{caption}</p>
      ) : null}
      <div
        data-slot="table-container"
        className={cn("relative w-full overflow-x-auto", containerClassName)}
      >
        <table
          data-slot="table"
          className={cn("w-full caption-bottom text-sm", tableClassName)}
        >
          <thead data-slot="table-header" className="[&_tr]:border-b">
            <tr className="border-b border-border">
              {columns.map((c) => (
                <th
                  key={c.key}
                  data-slot="table-head"
                  style={c.width ? { width: c.width } : undefined}
                  className={cn(
                    HEAD_CLASS,
                    pad,
                    ALIGN_CLASS[c.align || "start"],
                    stickyHeader && "sticky top-0 z-10 bg-background",
                    c.headerClassName
                  )}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody data-slot="table-body">{body}</tbody>
        </table>
      </div>
      {footer ? (
        <div
          className="flex flex-wrap items-center gap-2 pt-3 text-start"
          data-data-table-footer=""
        >
          {footer}
        </div>
      ) : null}
    </div>
  );
}
