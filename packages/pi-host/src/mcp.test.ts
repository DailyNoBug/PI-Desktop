import { execPath } from "node:process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { McpServerRecord } from "@pi-desktop/shared";
import { RemoteMcpRuntime } from "./mcp.js";

const testServer = join(dirname(fileURLToPath(import.meta.url)), "mcp-test-server.cjs");

function server(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    id: "remote",
    label: "Remote test",
    transport: "stdio",
    command: execPath,
    args: [testServer],
    env: { PI_TEST_VALUE: "remote-host" },
    enabled: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("RemoteMcpRuntime", () => {
  it("discovers and executes tools on the remote process", async () => {
    const runtime = new RemoteMcpRuntime();
    runtime.setRecords([server()]);
    try {
      await expect(runtime.toolsForProject("/repo")).resolves.toHaveLength(1);
      const result = await runtime.callTool("mcp_remote_echo", { name: "value" }, "/repo") as {
        content?: Array<{ text?: string }>;
      };
      expect(result.content?.[0]?.text).toBe("value:remote-host");
      await expect(runtime.callTool("mcp_remote_echo", { name: "fail" }, "/repo"))
        .rejects.toMatchObject({ code: "TOOL_FAILED" });
      expect(runtime.statusFor("remote").state).toBe("ready");
    } finally {
      runtime.disposeAll();
    }
  });

  it("does not start a command that traverses paths", async () => {
    const runtime = new RemoteMcpRuntime();
    runtime.setRecords([server({ command: "../outside/mcp" })]);
    try {
      await expect(runtime.toolsForProject("/repo")).resolves.toEqual([]);
      expect(runtime.statusFor("remote").state).toBe("failed");
      expect(runtime.statusFor("remote").message).toContain("absolute path");
    } finally {
      runtime.disposeAll();
    }
  });
});
