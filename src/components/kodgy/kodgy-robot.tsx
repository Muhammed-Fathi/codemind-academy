"use client";

// CodeMind Academy — Kodgy robot visual (Phase 10)
//
// Code-first SVG robot: everything (body, antenna, energy ring, flame
// tongues, embers, glow) is drawn in markup + CSS animations — no image
// assets, no graphics framework. The flame/energy layer continuously
// appears, grows, shrinks, fades, disappears and reappears; the whole
// robot idles with a gentle float. `prefers-reduced-motion` neutralizes
// all of this in CSS (see globals.css) while keeping Kodgy visible.

import * as React from "react";
import { cn } from "@/lib/utils";

export interface KodgyRobotProps {
  /** Rendered width in px (height is slightly larger: 1.0625 × width). */
  size?: number;
  open?: boolean;
  dragging?: boolean;
  className?: string;
}

export function KodgyRobot({
  size = 96,
  open = false,
  dragging = false,
  className,
}: KodgyRobotProps) {
  return (
    <svg
      // viewBox top is negative so the tallest flame tongue (y=-2) is never
      // clipped; aspect is shared with src/lib/kodgy/position.ts.
      viewBox="0 -14 160 184"
      width={size}
      height={size * (184 / 160)}
      className={cn("kodgy-robot", className)}
      aria-hidden="true"
      focusable="false"
      role="presentation"
    >
      <defs>
        <radialGradient id="kodgyAura" cx="50%" cy="45%" r="60%">
          <stop offset="0%" stopColor="#10b981" stopOpacity="0.9" />
          <stop offset="55%" stopColor="#059669" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#059669" stopOpacity="0.05" />
        </radialGradient>
        <radialGradient id="kodgyFlameCore" cx="50%" cy="75%" r="65%">
          <stop offset="0%" stopColor="var(--kodgy-flame-hot)" />
          <stop offset="40%" stopColor="var(--kodgy-flame-mid)" />
          <stop offset="100%" stopColor="var(--kodgy-flame-cool)" stopOpacity="0.4" />
        </radialGradient>
        <linearGradient id="kodgyBody" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--kodgy-body-high)" />
          <stop offset="100%" stopColor="var(--kodgy-body-low)" />
        </linearGradient>
        <linearGradient id="kodgyVisor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--kodgy-visor-high)" />
          <stop offset="100%" stopColor="var(--kodgy-visor-low)" />
        </linearGradient>
        <filter id="kodgyGlow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* ---------------- energy / flame layer (behind robot) ---------------- */}
      <g className="kodgy-flame-layer">
        {/* soft aura */}
        <ellipse
          className="kodgy-aura"
          cx="80"
          cy="98"
          rx="74"
          ry="84"
          fill="url(#kodgyAura)"
        />
        {/* inner hot core (always bright, breathes) */}
        <path
          className="kodgy-flame-core"
          d="M80 130 C64 100 64 50 80 26 C96 50 96 100 80 130 Z"
          fill="var(--kodgy-flame-hot)"
          opacity="0.7"
          filter="url(#kodgyGlow)"
        />
        {/* main flame tongue: appears → grows → shrinks → fades → reappears */}
        <g className="kodgy-flame-tongue kodgy-flame-center" style={{ animationDelay: "0s" }}>
          <path
            d="M80 130 C50 92 50 30 80 -2 C110 30 110 92 80 130 Z"
            fill="url(#kodgyFlameCore)"
            opacity="1"
            filter="url(#kodgyGlow)"
          />
        </g>
        <g className="kodgy-flame-tongue kodgy-flame-left" style={{ animationDelay: "0.4s" }}>
          <path
            d="M46 120 C14 90 12 46 36 14 C40 42 54 46 56 30 C72 76 62 112 46 120 Z"
            fill="url(#kodgyFlameCore)"
            opacity="0.95"
          />
        </g>
        <g className="kodgy-flame-tongue kodgy-flame-right" style={{ animationDelay: "0.8s" }}>
          <path
            d="M114 120 C146 90 148 46 124 14 C120 42 106 46 104 30 C88 76 98 112 114 120 Z"
            fill="url(#kodgyFlameCore)"
            opacity="0.95"
          />
        </g>
        {/* secondary slim tongues for a richer burst */}
        <g className="kodgy-flame-tongue kodgy-flame-slim-l" style={{ animationDelay: "1.3s" }}>
          <path
            d="M60 126 C48 102 48 52 60 22 C70 52 72 102 60 126 Z"
            fill="var(--kodgy-flame-mid)"
            opacity="0.85"
          />
        </g>
        <g className="kodgy-flame-tongue kodgy-flame-slim-r" style={{ animationDelay: "0.5s" }}>
          <path
            d="M100 126 C112 102 112 52 100 22 C90 52 88 102 100 126 Z"
            fill="var(--kodgy-flame-mid)"
            opacity="0.85"
          />
        </g>
        {/* flame petals around the energy ring (clockwise burst) */}
        {[
          -90, -54, -18, 18, 54, 90, 126, 162, 198, 234, 270, 306,
        ].map((deg, i) => (
          <g key={deg} transform={`rotate(${deg} 80 94)`}>
            <g
              className="kodgy-flame-tongue kodgy-flame-petal"
              style={{ animationDelay: `${(i % 6) * 0.55}s` }}
            >
              <path
                d="M80 20 C71 34 71 46 80 52 C89 46 89 34 80 20 Z"
                fill="url(#kodgyFlameCore)"
                opacity="0.85"
              />
            </g>
          </g>
        ))}
        {/* ring spikes around the energy field */}
        <g className="kodgy-flame-tongue kodgy-flame-spike kodgy-flame-spike-a">
          <path
            d="M80 14 L90 34 L70 34 Z"
            fill="#4ade80"
            opacity="0.8"
            filter="url(#kodgyGlow)"
          />
        </g>
        <g
          className="kodgy-flame-tongue kodgy-flame-spike kodgy-flame-spike-b"
          style={{ animationDelay: "1.1s" }}
        >
          <path d="M22 70 L44 80 L24 92 Z" fill="#34d399" opacity="0.85" />
        </g>
        <g
          className="kodgy-flame-tongue kodgy-flame-spike kodgy-flame-spike-c"
          style={{ animationDelay: "0.6s" }}
        >
          <path d="M138 70 L116 80 L136 92 Z" fill="#34d399" opacity="0.85" />
        </g>

        {/* glowing halo — the reference's signature energy ring */}
        <circle
          className="kodgy-ring-halo"
          cx="80"
          cy="94"
          r="66"
          fill="none"
          stroke="var(--kodgy-flame-mid)"
          strokeWidth="11"
          opacity="0.3"
          filter="url(#kodgyGlow)"
        />
        {/* spinning energy ring */}
        <circle
          className="kodgy-ring-glow"
          cx="80"
          cy="94"
          r="62"
          fill="none"
          stroke="#34d399"
          strokeWidth="8"
          opacity="0.5"
          filter="url(#kodgyGlow)"
        />
        <circle
          className="kodgy-ring"
          cx="80"
          cy="94"
          r="62"
          fill="none"
          stroke="var(--kodgy-ring)"
          strokeWidth="4.5"
          strokeDasharray="12 14"
          strokeLinecap="round"
          opacity="0.95"
        />

        {/* rising embers */}
        <circle className="kodgy-ember kodgy-ember-1" cx="52" cy="66" r="2.6" fill="#a7f3d0" />
        <circle className="kodgy-ember kodgy-ember-2" cx="108" cy="58" r="2.2" fill="#6ee7b7" />
        <circle className="kodgy-ember kodgy-ember-3" cx="80" cy="40" r="2.4" fill="#a7f3d0" />
      </g>

      {/* ------------------------------ robot ------------------------------ */}
      <g className={cn("kodgy-robot-figure", open && "is-open", dragging && "is-dragging")}>
        {/* antenna */}
        <line
          x1="80"
          y1="54"
          x2="80"
          y2="32"
          stroke="var(--kodgy-stroke)"
          strokeWidth="3.5"
          strokeLinecap="round"
        />
        <circle
          className="kodgy-antenna-tip"
          cx="80"
          cy="26"
          r="5.5"
          fill="#fbbf24"
          filter="url(#kodgyGlow)"
        />

        {/* ears */}
        <rect x="30" y="70" width="13" height="24" rx="6.5" fill="var(--kodgy-ear)" stroke="var(--kodgy-stroke)" strokeWidth="2" />
        <rect x="117" y="70" width="13" height="24" rx="6.5" fill="var(--kodgy-ear)" stroke="var(--kodgy-stroke)" strokeWidth="2" />

        {/* head */}
        <rect
          x="40"
          y="50"
          width="80"
          height="66"
          rx="26"
          fill="url(#kodgyBody)"
          stroke="var(--kodgy-stroke)"
          strokeWidth="3"
        />
        {/* face visor */}
        <rect
          x="51"
          y="61"
          width="58"
          height="44"
          rx="18"
          fill="url(#kodgyVisor)"
          stroke="var(--kodgy-stroke)"
          strokeWidth="2"
          opacity="0.96"
        />
        {/* eyes */}
        <ellipse cx="69" cy="78" rx="4.4" ry="7.4" fill="var(--kodgy-eye)" filter="url(#kodgyGlow)" />
        <ellipse cx="91" cy="78" rx="4.4" ry="7.4" fill="var(--kodgy-eye)" filter="url(#kodgyGlow)" />
        <circle cx="70.6" cy="75.4" r="1.4" fill="#ffffff" opacity="0.9" />
        <circle cx="92.6" cy="75.4" r="1.4" fill="#ffffff" opacity="0.9" />
        {/* smile */}
        <path
          d="M71 91 Q80 100 89 91"
          fill="none"
          stroke="var(--kodgy-mouth)"
          strokeWidth="3"
          strokeLinecap="round"
        />
        {/* cheeks */}
        <circle cx="60" cy="88" r="3.4" fill="#fbbf24" opacity="0.45" />
        <circle cx="100" cy="88" r="3.4" fill="#fbbf24" opacity="0.45" />

        {/* body */}
        <rect
          x="56"
          y="118"
          width="48"
          height="28"
          rx="12"
          fill="url(#kodgyBody)"
          stroke="var(--kodgy-stroke)"
          strokeWidth="3"
        />
        <circle className="kodgy-chest" cx="80" cy="130" r="5" fill="#34d399" filter="url(#kodgyGlow)" />

        {/* arms */}
        <rect x="45" y="120" width="9" height="20" rx="4.5" fill="var(--kodgy-ear)" stroke="var(--kodgy-stroke)" strokeWidth="2" />
        <rect x="106" y="120" width="9" height="20" rx="4.5" fill="var(--kodgy-ear)" stroke="var(--kodgy-stroke)" strokeWidth="2" />

        {/* legs */}
        <rect x="66" y="146" width="11" height="14" rx="5" fill="var(--kodgy-ear)" stroke="var(--kodgy-stroke)" strokeWidth="2" />
        <rect x="83" y="146" width="11" height="14" rx="5" fill="var(--kodgy-ear)" stroke="var(--kodgy-stroke)" strokeWidth="2" />

        {/* ground shadow */}
        <ellipse cx="80" cy="164" rx="26" ry="5" fill="#000000" opacity="0.16" />
      </g>
    </svg>
  );
}
