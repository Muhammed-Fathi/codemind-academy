"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Props = Omit<React.ComponentProps<"input">, "type"> & {
  showLabel?: string;
  hideLabel?: string;
};

/**
 * Password input with a Show/Hide (eye icon) toggle.
 * Used on every login / registration / admin password field.
 */
export function PasswordInput({
  className,
  showLabel = "إظهار كلمة السر",
  hideLabel = "إخفاء كلمة السر",
  ...props
}: Props) {
  const [show, setShow] = React.useState(false);
  return (
    <div className="relative">
      <Input
        type={show ? "text" : "password"}
        className={cn("pl-10", className)}
        {...props}
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        aria-label={show ? hideLabel : showLabel}
        title={show ? hideLabel : showLabel}
        className="absolute left-2.5 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}
