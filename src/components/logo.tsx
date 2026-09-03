"use client";

import * as React from "react";

type LogoProps = {
  size?: number;
  withWordmark?: boolean;
  className?: string;
};

export function CodeMindLogo({
  size = 36,
  withWordmark = false,
  className = "",
}: LogoProps) {
  return (
    <div className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark size={size} />
      {withWordmark && (
        <div className="flex flex-col leading-none">
          <span className="font-extrabold text-lg tracking-tight">
            CodeMind
          </span>
          <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Academy
          </span>
        </div>
      )}
    </div>
  );
}

export function LogoMark({ size = 36 }: { size?: number }) {
  const id = React.useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="CodeMind Academy logo"
    >
      <defs>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="48" y2="48">
          <stop offset="0%" stopColor="#10b981" />
          <stop offset="55%" stopColor="#14b8a6" />
          <stop offset="100%" stopColor="#f59e0b" />
        </linearGradient>
        <linearGradient id={`${id}-g2`} x1="0" y1="0" x2="48" y2="48">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0.5" />
        </linearGradient>
      </defs>
      {/* Rounded square base */}
      <rect x="2" y="2" width="44" height="44" rx="12" fill={`url(#${id}-g)`} />
      {/* Code chevron */}
      <path
        d="M18 16 L11 24 L18 32"
        stroke={`url(#${id}-g2)`}
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M30 16 L37 24 L30 32"
        stroke={`url(#${id}-g2)`}
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* Neural node (AI dot) */}
      <circle cx="24" cy="24" r="3.2" fill="#ffffff" />
      <circle cx="24" cy="14" r="1.6" fill="#ffffff" opacity="0.7" />
      <circle cx="24" cy="34" r="1.6" fill="#ffffff" opacity="0.7" />
      <path
        d="M24 14 L24 24 L24 34"
        stroke="#ffffff"
        strokeOpacity="0.45"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
