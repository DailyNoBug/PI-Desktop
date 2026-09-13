import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("pi-host packaging contract", () => {
  it("verifies the release checksum before extracting or starting", async () => {
    const script = await readFile(join(import.meta.dirname, "../../../scripts/pi-host-bootstrap.sh"), "utf8");
    const checksumIndex = script.indexOf("sha256sum -c -");
    const extractIndex = script.indexOf("tar -xzf");
    const startIndex = script.indexOf("pi-host.js");
    expect(checksumIndex).toBeGreaterThanOrEqual(0);
    expect(extractIndex).toBeGreaterThan(checksumIndex);
    expect(startIndex).toBeGreaterThan(extractIndex);
    expect(script).toContain("setsid");
    expect(script).not.toMatch(/\bsudo\b/);
    expect(script).not.toContain("StrictHostKeyChecking=no");
  });

  it("writes a SHA-256 sibling beside the tarball", async () => {
    const script = await readFile(join(import.meta.dirname, "../../../scripts/package-pi-host.mjs"), "utf8");
    expect(script).toContain("createHash(\"sha256\")");
    expect(script).toContain("node_modules/node-pty");
    expect(script).toContain("spawn-helper");
    expect(script).toContain("chmodSync(helper, 0o755)");
    expect(script).toMatch(/writeFileSync\([^\n]+\.sha256/);
    expect(script).toContain("\"x64\" && arch !== \"arm64\"");
  });

  it("loads and executes Skills from the remote Host", async () => {
    const [service, main] = await Promise.all([
      readFile(join(import.meta.dirname, "pi-host.ts"), "utf8"),
      readFile(join(import.meta.dirname, "main.ts"), "utf8"),
    ]);
    expect(service).toContain('"skills.active"');
    expect(service).toContain('"skills.read"');
    expect(service).toContain("pluginSkills:");
    expect(main).toContain('toolParams.toolName === "Skill"');
    expect(main).toContain('toolParams.mode === "plan"');
  });
});
