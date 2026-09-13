import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { RemoteTerminalManager } from "./terminal.js";

describe("RemoteTerminalManager", () => {
  it("runs a PTY in the requested working directory and retains replay bytes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-host-terminal-"));
    const output: string[] = [];
    const changes: string[] = [];
    const manager = new RemoteTerminalManager(
      (event) => output.push(Buffer.from(event.data, "base64").toString("utf8")),
      (event) => changes.push(event.status),
    );
    const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
    const terminal = manager.open({
      sessionId: "session-terminal",
      cwd,
      shell,
      columns: 24,
      rows: 6,
    });
    const done = Promise.race([
      new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (!output.join("").includes("terminal-ok")) return;
          clearInterval(timer);
          resolve();
        }, 20);
      }),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("PTY produced no output")), 3_000),
      ),
    ]);
    manager.write(terminal.terminalId, {
      text:
        process.platform === "win32"
          ? "echo terminal-ok\r"
          : "printf terminal-ok; exit\n",
    });
    await done;
    manager.close(terminal.terminalId);
    expect(Buffer.from(manager.replay(terminal.terminalId), "base64").length)
      .toBeGreaterThan(0);
    expect(changes).toContain("open");
  });
});
