import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { readAppSource, readStoreModule } from "./helpers/source-contracts.mjs";

const [appSource, projectSlice, sessionSlice, settingsImportSource] = await Promise.all([
  readAppSource(),
  readStoreModule("slices/project-slice.ts"),
  readStoreModule("slices/session-slice.ts"),
  readFile(new URL("../src/features/settings/import-page.tsx", import.meta.url), "utf8"),
]);

test("plugin session imports retain project restoration without a Settings session importer", () => {
  assert.match(projectSlice, /restoreProjects: \(paths\) =>/);
  assert.match(projectSlice, /projectIsArchived\(key, get\(\)\.projectMeta\)/);
  assert.match(sessionSlice, /refreshSessions: async \(options\) =>/);
  assert.match(sessionSlice, /projectPathsForNewSessions\(previousSessions, sessions\.sessions\)/);
  assert.match(sessionSlice, /get\(\)\.restoreProjects/);
  // Fork keeps the Settings import workbench (SessionImportPanel) beside the
  // plugin session-import API; upstream removed only its own Settings importer.
  assert.match(settingsImportSource, /SessionImportPanel/);
  assert.match(appSource, /event\.reason === "plugin\.session\.import"/);
  assert.match(appSource, /revealImportedProjects: true/);
});
