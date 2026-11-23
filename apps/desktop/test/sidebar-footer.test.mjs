import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const sidebarSource =
  (await readFile(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8")) +
  (await readFile(new URL("../src/components/SidebarNavigation.tsx", import.meta.url), "utf8"));
const footerSource = sidebarSource.slice(sidebarSource.indexOf("export function SidebarFooter"));
const usageSource = await readFile(
  new URL("../src/components/TokenUsageSummary.tsx", import.meta.url),
  "utf8",
);
const globalStyles = await loadStyles();
const zhLocale = await readFile(
  new URL("../../../packages/i18n/src/locales/zh-CN/index.ts", import.meta.url),
  "utf8",
);
const enLocale = await readFile(
  new URL("../../../packages/i18n/src/locales/en/index.ts", import.meta.url),
  "utf8",
);

test("the sidebar footer is an action bar, not a fabricated identity", () => {
  // The app has no accounts; an avatar with a name implied one that never existed.
  assert.doesNotMatch(sidebarSource, /footer-profile/);
  assert.doesNotMatch(sidebarSource, /profile-menu/);
  assert.doesNotMatch(sidebarSource, /sidebar-profile-menu/);
  assert.doesNotMatch(sidebarSource, /IconUser/);
  assert.doesNotMatch(globalStyles, /\.footer-profile/);
  assert.doesNotMatch(globalStyles, /\.profile-menu/);
  for (const locale of [zhLocale, enLocale]) {
    assert.doesNotMatch(locale, /localProfile:/);
    assert.doesNotMatch(locale, /openProfileMenu:/);
  }
});

test("footer keeps Settings, the version chip, and the fork's token usage summary", () => {
  // Upstream's slim destinations plus the fork's token usage row (ADR 0348).
  assert.deepEqual(
    [...footerSource.matchAll(/data-nav="([^"]+)"/g)].map((match) => match[1]),
    ["settings", "build"],
  );
  // Settings is a labelled entry that opens the Settings dialog.
  assert.match(footerSource, /className=\{cx\("footer-settings", settingsOpen && "active"\)\}/);
  assert.match(footerSource, /aria-haspopup="dialog"/);
  assert.match(footerSource, /onClick=\{\(\) => openSettings\(\)\}/);
  assert.match(footerSource, /t\("nav\.settings"\)/);
  // The fork's token usage summary sits between Settings and the build chip.
  const settingsIndex = footerSource.indexOf('data-nav="settings"');
  const usageIndex = footerSource.indexOf("<TokenUsageSummary onBeforeOpen=");
  const buildIndex = footerSource.indexOf('data-nav="build"');
  assert.ok(settingsIndex >= 0);
  assert.ok(usageIndex > settingsIndex);
  assert.ok(buildIndex < 0 || buildIndex > usageIndex);
  assert.match(usageSource, /className=\{`footer-action \$\{open \? "active" : ""\}`\}/);
  assert.match(usageSource, /tooltip=\{t\("tokenUsage\.title"\)\}/);
  assert.match(usageSource, /ariaLabel=\{t\("tokenUsage\.title"\)\}/);
  // The notification entry is gone from the sidebar (upstream issue #2431).
  assert.doesNotMatch(sidebarSource, /NotificationCenter/);
  // Logs live in Settings → About; the footer stays down to daily controls.
  assert.doesNotMatch(sidebarSource, /openLogs/);
});

test("footer stays flat and labeled for pointer and assistive tech users", () => {
  assert.doesNotMatch(sidebarSource, /data-nav="theme"/);
  // The token usage action is icon-only, so it needs a label.
  const action = usageSource.slice(
    usageSource.indexOf("<TooltipButton"),
    usageSource.indexOf("</TooltipButton>"),
  );
  const attrs = action.slice(0, action.indexOf(">"));
  assert.match(attrs, /tooltip=/);
  assert.match(attrs, /ariaLabel=/);
});
