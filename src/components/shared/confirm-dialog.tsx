"use client";

// CodeMind Academy — shared confirmation dialog for DESTRUCTIVE admin actions.
//
// Post-launch audit requirement: destructive operations (delete / archive /
// deactivate with consequences) must be protected by an explicit confirmation
// step that says WHAT will happen and WHY it may be refused. Native
// window.confirm() cannot carry that context or the brand styling, so every
// new destructive flow uses this AlertDialog-based component.
//
// The dialog is presentational only — authorization and the dependency guards
// live server-side; a refused action surfaces the server's localized message.

import * as React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2 } from "lucide-react";

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Short title, e.g. "حذف المجموعة". */
  title: string;
  /** What will happen + why it may be refused. */
  description: React.ReactNode;
  /** Label of the destructive/primary action, e.g. "حذف". */
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void | Promise<void>;
  busy?: boolean;
  /** Use the destructive style for irreversible actions (default true). */
  destructive?: boolean;
};

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  busy = false,
  destructive = true,
}: ConfirmDialogProps) {
  const [pending, setPending] = React.useState(false);

  const run = async () => {
    setPending(true);
    try {
      await onConfirm();
    } finally {
      setPending(false);
    }
  };

  const isBusy = busy || pending;

  return (
    <AlertDialog open={open} onOpenChange={(v) => !isBusy && onOpenChange(v)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription className="leading-relaxed">
            {description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isBusy}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            disabled={isBusy}
            onClick={(e) => {
              // We manage close ourselves after the async action settles.
              e.preventDefault();
              void run();
            }}
            className={
              destructive
                ? "bg-destructive text-white hover:bg-destructive/90"
                : undefined
            }
          >
            {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
