#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const args = new Map(process.argv.slice(2).map((value, index, all) => (
  value.startsWith("--") ? [value.slice(2), all[index + 1]] : []
)).filter(([key]) => key));
const version = args.get("version") ?? JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;

function run(command, commandArgs, options = {}) {
  execFileSync(command, commandArgs, { stdio: "inherit", cwd: root, ...options });
}

async function readFile(path) {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}

if (process.platform !== "linux") {
  throw new Error("pi-host bundles are built on Linux");
}
const arch = args.get("arch") ?? process.arch;
if (arch !== "x64" && arch !== "arm64") throw new Error(`unsupported Linux architecture: ${arch}`);
if (process.arch !== arch) throw new Error(`native build required: runner ${process.arch}, requested ${arch}`);

const outputDir = join(root, "release", "pi-host");
rmSync(outputDir, { recursive: true, force: true });
const packageDir = join(outputDir, "package");
mkdirSync(packageDir, { recursive: true });

run("pnpm", ["--filter", "@pi-desktop/shared", "build"]);
run("pnpm", ["--filter", "@pi-desktop/agent-host", "build"]);
run("pnpm", ["--filter", "@pi-desktop/agent-runtime", "build"]);
run("pnpm", ["--filter", "@pi-desktop/pi-host", "build"]);
run("pnpm", ["--filter", "@pi-desktop/agent-runtime", "run", "bundle"]);
run("pnpm", ["--filter", "@pi-desktop/pi-host", "run", "bundle"]);
run("cargo", ["build", "--release", "--locked", "-p", "host-core"]);

copyFileSync(join(root, "packages/pi-host/dist-bundle/pi-host.js"), join(packageDir, "pi-host.js"));
const ptyPackageDir = join(packageDir, "node_modules", "node-pty");
cpSync(join(root, "packages/pi-host/node_modules/node-pty"), ptyPackageDir, {
  recursive: true,
  dereference: true,
});
copyFileSync(join(root, "packages/agent-runtime/dist-bundle/sidecar.js"), join(packageDir, "agent-runtime-sidecar.js.tmp"));
mkdirSync(join(packageDir, "agent-runtime"), { recursive: true });
copyFileSync(join(packageDir, "agent-runtime-sidecar.js.tmp"), join(packageDir, "agent-runtime", "sidecar.js"));
rmSync(join(packageDir, "agent-runtime-sidecar.js.tmp"), { force: true });
mkdirSync(join(packageDir, "host-core"), { recursive: true });
copyFileSync(join(root, "target/release/pi-desktop-host-core"), join(packageDir, "host-core", "pi-desktop-host-core"));
copyFileSync(process.execPath, join(packageDir, "node"));
chmodSync(join(packageDir, "host-core", "pi-desktop-host-core"), 0o755);
chmodSync(join(packageDir, "node"), 0o755);
chmodSync(join(packageDir, "pi-host.js"), 0o755);
for (const helper of [
  join(ptyPackageDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  join(ptyPackageDir, "build", "Release", "spawn-helper"),
]) {
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
writeFileSync(join(packageDir, "package.json"), `${JSON.stringify({
  name: "pi-host",
  version,
  os: "linux",
  arch,
}, null, 2)}\n`);

const tarName = `pi-host-${version}-linux-${arch}.tar.gz`;
run("tar", ["-czf", join(outputDir, tarName), "-C", packageDir, "."]);
const bytes = await import("node:fs/promises").then(({ readFile }) => readFile(join(outputDir, tarName)));
const checksum = createHash("sha256").update(bytes).digest("hex");
writeFileSync(join(outputDir, `${tarName}.sha256`), `${checksum}  ${tarName}\n`);
rmSync(packageDir, { recursive: true, force: true });

console.log(`${join(outputDir, tarName)}\n${join(outputDir, `${tarName}.sha256`)}`);
