#!/usr/bin/env node
/**
 * Install the runtime dependency of the bundled pi.local-voice plugin
 * (resources/plugins/pi.local-voice): @huggingface/transformers for on-device
 * Whisper inference.
 *
 * Runs `npm install --omit=dev` inside the plugin directory with a hard 300s
 * budget and exits 0 only when node_modules/@huggingface/transformers exists
 * afterwards. Idempotent: when the package already resolves from the plugin
 * directory, nothing is installed and the script exits 0 immediately.
 *
 * Paths are resolved from this file's location so the script works from any
 * cwd (repo root, apps/desktop, or an IDE task runner).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "../resources/plugins/pi.local-voice");
const transformersDir = path.join(
  pluginDir,
  "node_modules",
  "@huggingface",
  "transformers",
);
const INSTALL_TIMEOUT_MS = 300_000;

if (!existsSync(path.join(pluginDir, "package.json"))) {
  console.error(`[install-local-voice-deps] plugin package.json not found: ${pluginDir}`);
  process.exit(1);
}

// Resolve from the plugin's package.json so the check matches what require()
// inside the plugin process would find.
const pluginRequire = createRequire(path.join(pluginDir, "package.json"));
try {
  pluginRequire.resolve("@huggingface/transformers");
  console.log("[install-local-voice-deps] @huggingface/transformers already installed — skipping");
  process.exit(0);
} catch {
  // Not installed yet: fall through to npm install.
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(
  npmCommand,
  ["install", "--omit=dev", "--no-audit", "--no-fund"],
  {
    cwd: pluginDir,
    stdio: "inherit",
    timeout: INSTALL_TIMEOUT_MS,
  },
);

if (result.error) {
  if (result.error.code === "ETIMEDOUT") {
    console.error(
      `[install-local-voice-deps] npm install exceeded ${INSTALL_TIMEOUT_MS / 1000}s — rerun this script to resume`,
    );
  } else {
    console.error(`[install-local-voice-deps] failed to run npm: ${result.error.message}`);
  }
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`[install-local-voice-deps] npm install exited with ${result.status}`);
  process.exit(result.status ?? 1);
}

// The exit contract is the artifact, not npm's status: a postinstall that
// lies would otherwise green-light a broken plugin.
if (!existsSync(transformersDir)) {
  console.error(
    `[install-local-voice-deps] node_modules/@huggingface/transformers missing after install: ${transformersDir}`,
  );
  process.exit(1);
}

console.log("[install-local-voice-deps] @huggingface/transformers installed");
