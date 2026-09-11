/**
 * Placement for the work-panel add menu.
 *
 * The add menu is rendered at document.body level so it cannot participate in
 * the panel's header/body layout. These viewport coordinates keep the menu
 * anchored to the trigger while leaving the panel content flow untouched.
 * When a panel boundary is supplied, horizontal placement stays inside that
 * dock instead of leaking into the conversation column.
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, value), max);
}

export function placeWorkPanelMenu({
  trigger,
  menu,
  viewport,
  boundary,
  margin = WORK_PANEL_MENU_MARGIN,
  gap = WORK_PANEL_MENU_GAP,
}: {
  trigger: { left: number; top: number; bottom: number };
  menu: { width: number; height: number };
  viewport: { width: number; height: number };
  /** The horizontal bounds of the dock that owns the trigger. */
  boundary?: Pick<WorkPanelMenuRect, "left" | "right">;
  margin?: number;
  gap?: number;
}): WorkPanelMenuPlacement {
  const minLeft = boundary ? boundary.left + margin : margin;
  const maxLeft = boundary
    ? Math.max(minLeft, boundary.right - menu.width - margin)
    : Math.max(margin, viewport.width - menu.width - margin);
  const left = clamp(trigger.left, minLeft, maxLeft);
  const below = trigger.bottom + gap;
  const above = trigger.top - menu.height - gap;
  const maxTop = Math.max(margin, viewport.height - menu.height - margin);
  const top =
    below <= maxTop
      ? Math.max(margin, below)
      : above >= margin
        ? above
        : Math.min(below, maxTop);

  return { top, left };
}
