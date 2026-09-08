// CodeMind Academy — Kodgy positioning math (Phase 10)
//
// Pure, SSR-safe, dependency-free helpers for the floating assistant.
//
// Contract:
//   * The robot's horizontal position is measured from the LOCALE-DEFAULT
//     edge: Arabic → LEFT edge, English → RIGHT edge. Switching locale
//     therefore always re-anchors Kodgy to the product-required side
//     (Arabic LEFT, English RIGHT) without any hard-coded RTL assumptions.
//   * Positions are stored per-locale in localStorage by the component;
//     this module never touches storage or the DOM.
//   * Every position is clamped to the visible viewport so Kodgy can
//     never become permanently inaccessible.

export type KodgyLocale = "ar" | "en";
export type ScreenEdge = "left" | "right";

export interface Viewport {
  width: number;
  height: number;
}

/** Robot position: x = px from the locale-default edge, y = px from bottom. */
export interface KodgyPos {
  x: number;
  y: number;
}

export interface PanelGeometry {
  /** Horizontal placement of the panel relative to the screen. */
  left?: number;
  right?: number;
  /** Distance of the panel's bottom edge from viewport bottom (px). */
  bottom: number;
  /** Max usable panel height for the chosen placement (px). */
  maxHeight: number;
  /** Placement above or below the robot (above is preferred). */
  placement: "above" | "below";
  /** Which screen edge the panel hugs. */
  side: ScreenEdge;
}

export const KODGY_MARGIN = 8;
export const KODGY_PANEL_GAP = 14;
/** Robot SVG viewBox aspect (shared with kodgy-robot.tsx). */
export const KODGY_ROBOT_ASPECT = 184 / 160;

/** Rendered robot height in px for a given width. */
export function robotHeight(size: number): number {
  return size * KODGY_ROBOT_ASPECT;
}
export const KODGY_SIDE_PANEL_INSET = 12;
export const KODGY_MIN_PANEL_HEIGHT = 180;
export const KODGY_DESKTOP_ROBOT_SIZE = 96;
export const KODGY_MOBILE_ROBOT_SIZE = 72;
export const KODGY_MOBILE_BREAKPOINT = 640;

/** Locale-default edge: Arabic LEFT, English RIGHT (product requirement). */
export function defaultEdge(locale: KodgyLocale): ScreenEdge {
  return locale === "ar" ? "left" : "right";
}

/** Robot rendered size in px for a viewport width (responsive). */
export function robotSizeFor(vp: Viewport): number {
  return vp.width < KODGY_MOBILE_BREAKPOINT ? KODGY_MOBILE_ROBOT_SIZE : KODGY_DESKTOP_ROBOT_SIZE;
}

/** Default resting position per locale (16px from edge & bottom). */
export function defaultPos(locale: KodgyLocale): KodgyPos {
  return { x: 16, y: 16 };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), Math.max(min, max));
}

/** Clamp a position so the whole robot stays inside the viewport. */
export function clampPos(pos: KodgyPos, vp: Viewport, size: number): KodgyPos {
  const h = robotHeight(size);
  const maxX = Math.max(KODGY_MARGIN, vp.width - size - KODGY_MARGIN);
  const maxY = Math.max(KODGY_MARGIN, vp.height - h - KODGY_MARGIN);
  return {
    x: clamp(Number.isFinite(pos.x) ? pos.x : defaultPos("ar").x, KODGY_MARGIN, maxX),
    y: clamp(Number.isFinite(pos.y) ? pos.y : defaultPos("ar").y, KODGY_MARGIN, maxY),
  };
}

/**
 * Convert a pointer position (clientX/clientY of the robot's top-left)
 * into the locale-relative stored position.
 */
export function posFromPointer(
  pointerX: number,
  pointerY: number,
  vp: Viewport,
  size: number,
  locale: KodgyLocale
): KodgyPos {
  const h = robotHeight(size);
  const px = clamp(pointerX, 0, Math.max(0, vp.width - size));
  const py = clamp(pointerY, 0, Math.max(0, vp.height - h));
  const x = locale === "ar" ? px : vp.width - (px + size);
  const y = vp.height - (py + h);
  return clampPos({ x, y }, vp, size);
}

/** Absolute (left/top) box of the robot for the current locale & position. */
export function robotBox(
  pos: KodgyPos,
  vp: Viewport,
  size: number,
  locale: KodgyLocale
): { left: number; top: number } {
  const left = locale === "ar" ? pos.x : vp.width - pos.x - size;
  const top = vp.height - pos.y - robotHeight(size);
  return { left, top };
}

/**
 * Geometry for the chat panel anchored to the robot.
 * The panel hugs the same horizontal edge as the robot (follows drags),
 * opens ABOVE it when there is room, otherwise BELOW, and is always
 * clamped inside the viewport.
 *
 * @param desiredWidth  panel width in px
 * @param desiredHeight preferred panel height in px
 */
export function panelGeometry(
  pos: KodgyPos,
  vp: Viewport,
  locale: KodgyLocale,
  desiredWidth: number,
  desiredHeight: number
): PanelGeometry {
  const size = robotSizeFor(vp);
  const box = robotBox(pos, vp, size, locale);
  const center = box.left + size / 2;
  const side: ScreenEdge = center <= vp.width / 2 ? "left" : "right";
  const inset = KODGY_SIDE_PANEL_INSET;
  const maxW = Math.max(220, vp.width - inset * 2);

  // Horizontal: hug the edge on the robot's side, clamped to viewport.
  let left: number | undefined;
  let right: number | undefined;
  if (side === "left") {
    left = Math.max(inset, Math.min(box.left, vp.width - Math.min(desiredWidth, maxW) - inset));
  } else {
    right = Math.max(
      inset,
      Math.min(vp.width - box.left - size, vp.width - Math.min(desiredWidth, maxW) - inset)
    );
  }

  // Vertical: prefer above; below is a fallback when the robot is high.
  const gap = KODGY_PANEL_GAP;
  const aboveSpace = box.top - gap - inset;
  if (aboveSpace >= KODGY_MIN_PANEL_HEIGHT) {
    return {
      left,
      right,
      bottom: vp.height - box.top + gap,
      maxHeight: Math.min(desiredHeight, aboveSpace),
      placement: "above",
      side,
    };
  }
  // Below: the panel's TOP edge sits just under the robot and it grows
  // downward, so its bottom edge is `maxHeight` px under that top edge.
  const belowTop = box.top + robotHeight(size) + gap;
  const belowSpace = vp.height - belowTop - inset;
  const belowHeight = Math.max(KODGY_MIN_PANEL_HEIGHT, Math.min(desiredHeight, belowSpace));
  return {
    left,
    right,
    bottom: Math.max(KODGY_MARGIN, vp.height - belowTop - belowHeight),
    maxHeight: belowHeight,
    placement: "below",
    side,
  };
}
