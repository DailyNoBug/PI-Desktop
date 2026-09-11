/**
 * Placement for the work-panel add menu.
 *
 * The switcher is rendered at document.body level so it cannot participate in
 * the panel's header/body layout. These viewport coordinates keep the menu
 * anchored to the trigger while leaving the panel content flow untouched.
 * Native plugin surfaces are avoided because WebContentsViews composite above
 * renderer content and cannot be covered by this menu.
 */

export const WORK_PANEL_MENU_MARGIN = 8;
export const WORK_PANEL_MENU_GAP = 4;

export type WorkPanelMenuPlacement = {
  top: number;
  left: number;
};

export type WorkPanelMenuRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

function intersects(
  placement: WorkPanelMenuPlacement,
  menu: { width: number; height: number },
  rect: WorkPanelMenuRect,
): boolean {
  return (
    placement.left < rect.right &&
    placement.left + menu.width > rect.left &&
    placement.top < rect.bottom &&
    placement.top + menu.height > rect.top
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, value), max);
}

export function placeWorkPanelMenu({
  trigger,
  menu,
  viewport,
  avoid,
  margin = WORK_PANEL_MENU_MARGIN,
  gap = WORK_PANEL_MENU_GAP,
}: {
  trigger: { left: number; top: number; bottom: number };
  menu: { width: number; height: number };
  viewport: { width: number; height: number };
  /** A native plugin surface that a renderer menu cannot paint above. */
  avoid?: WorkPanelMenuRect;
  margin?: number;
  gap?: number;
}): WorkPanelMenuPlacement {
  const maxLeft = Math.max(margin, viewport.width - menu.width - margin);
  const left = clamp(trigger.left, margin, maxLeft);
  const below = trigger.bottom + gap;
  const above = trigger.top - menu.height - gap;
  const maxTop = Math.max(margin, viewport.height - menu.height - margin);
  const top =
    below <= maxTop
      ? Math.max(margin, below)
      : above >= margin
        ? above
        : Math.min(below, maxTop);

  const placement = { top, left };
  if (!avoid || !intersects(placement, menu, avoid)) return placement;

  // WebContentsViews composite above renderer content. When the active work
  // panel is a native plugin view, move the menu beside that surface instead
  // of shortening its bounds below the menu. The latter looks like the
  // plugin body was pushed down every time the menu opens.
  const leftOfSurface = {
    top,
    left: clamp(avoid.left - menu.width - gap, margin, maxLeft),
  };
  if (!intersects(leftOfSurface, menu, avoid)) return leftOfSurface;

  const rightOfSurface = {
    top,
    left: clamp(avoid.right + gap, margin, maxLeft),
  };
  if (!intersects(rightOfSurface, menu, avoid)) return rightOfSurface;

  const aboveSurface = {
    top: clamp(avoid.top - menu.height - gap, margin, maxTop),
    left,
  };
  if (!intersects(aboveSurface, menu, avoid)) return aboveSurface;

  // There is no non-overlapping viewport position (for example a native
  // surface fills almost the entire window). Keep the normal anchored result
  // rather than returning an invalid coordinate.
  return placement;
}
