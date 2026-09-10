import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = (relativePath) =>
  readFileSync(join(here, "../src", relativePath), "utf8");

function assertLocalizedIconTooltip(relativePath, key) {
  const contents = source(relativePath);
  const ariaLabel = `aria-label={t("${key}"`;
  const sharedAriaLabel = `ariaLabel={t("${key}"`;
  const title = `title={t("${key}"`;
  const sharedTooltip = `tooltip={t("${key}"`;
  const ariaIndex = Math.max(contents.indexOf(ariaLabel), contents.indexOf(sharedAriaLabel));
  const hoverIndex = Math.max(contents.indexOf(title), contents.indexOf(sharedTooltip));
  assert.ok(ariaIndex >= 0, `${relativePath} should expose ${key} as an accessible name`);
  assert.ok(
    Math.abs(hoverIndex - ariaIndex) < 220,
    `${relativePath} should expose ${key} on hover`,
  );
}

test("icon-only actions expose localized hover tooltips", () => {
  for (const [relativePath, key] of [
    ["components/ChatSurface.tsx", "errors.action.dismiss"],
    ["components/Toast.tsx", "toast.dismiss"],
    ["components/UpdateBanner.tsx", "updates.dismiss"],
    ["components/ProjectInstructionsDialog.tsx", "settings.cancel"],
    ["components/extensions/McpEditorSheet.tsx", "common.close"],
    ["components/settings/SkillEditorSheet.tsx", "common.close"],
    ["components/settings/SubagentEditorSheet.tsx", "common.close"],
    ["components/extensions/ScopeControl.tsx", "common.close"],
    ["components/settings/AgentCapabilityLayout.tsx", "settings.clearSearch"],
    ["components/Sidebar.tsx", "nav.sessionActions"],
    ["components/Sidebar.tsx", "project.openActions"],
    ["components/Sidebar.tsx", "nav.sortSessions"],
    ["pages/PullRequestsPage.tsx", "pulls.open"],
    ["components/workpanel/FilesTab.tsx", "panel.files.back"],
    ["components/workpanel/FilesTab.tsx", "panel.files.reveal"],
  ]) {
    assertLocalizedIconTooltip(relativePath, key);
  }
});
