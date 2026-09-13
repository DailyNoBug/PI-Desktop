import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { PiHostService } from "./pi-host.js";
import type { RpcProcess } from "./rpc-process.js";

type RecordedCall = { method: string; params: Record<string, unknown> };

function fakeProcesses() {
  const hostCalls: RecordedCall[] = [];
  const sidecarCalls: RecordedCall[] = [];
  const appendedMessages: Array<Record<string, unknown>> = [];
  const session = {
    id: "session-1",
    title: "Remote",
    projectPath: "/repo",
    mode: "agent",
    permissionMode: "ask",
    providerId: "provider-1",
    modelId: "model-1",
    thinkingLevel: "off",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  const host = {
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      hostCalls.push({ method, params });
      switch (method) {
        case "session.get":
          return { session } as T;
        case "settings.get":
          return { defaultPermissionMode: "ask" } as T;
        case "providers.list":
          return {
            providers: [{
              id: "provider-1",
              name: "Provider",
              authKind: "none",
              defaultModelId: "model-1",
              models: [],
            }],
          } as T;
        case "commandShells.list":
          return { effective: { id: "bash", dialect: "posix", available: true } } as T;
        case "skills.active":
        case "mcp.active":
          return {} as T;
        case "session.truncateFrom":
          return {
            revision: {
              rootUserId: "user-root",
              revisionCount: 2,
              activeRevision: 2,
            },
          } as T;
        case "session.beginTurn":
          return { turnId: "turn-1" } as T;
        case "session.appendMessage":
          appendedMessages.push(params.message as Record<string, unknown>);
          return {} as T;
        case "session.saveActiveRevision":
          return {
            saved: {
              root: {
                id: "user-root",
                role: "user",
                revisionRootId: "user-root",
                revisionCount: 2,
                activeRevision: 2,
              },
            },
          } as T;
        default:
          return {} as T;
      }
    },
  };
  const sidecar = {
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      sidecarCalls.push({ method, params });
      if (method === "agent.prompt") return { accepted: true, turnId: "turn-1" } as T;
      return {} as T;
    },
  };
  return { host, sidecar, hostCalls, sidecarCalls, appendedMessages };
}

describe("remote regenerate", () => {
  it("truncates, stamps, executes, and archives the branch on the remote Host", async () => {
    const { host, sidecar, hostCalls, sidecarCalls, appendedMessages } = fakeProcesses();
    const service = new PiHostService(
      host as unknown as RpcProcess,
      sidecar as unknown as RpcProcess,
      "/tmp",
    );
    const result = await (service as unknown as {
      prompt(request: Record<string, unknown>): Promise<{ turnId: string }>;
    }).prompt({
      sessionId: "session-1",
      content: "rewrite this",
      truncateFromMessageId: "assistant-old",
      messageId: "user-new",
      effectivePermissionMode: "ask",
      principal: { subject: "desktop", roles: ["owner"], pairedDevice: true },
    });
    expect(result).toEqual({ turnId: "turn-1" });
    expect(sidecarCalls.map((call) => call.method)).toEqual([
      "agent.abort",
      "agent.disposeSession",
      "agent.prompt",
    ]);
    expect(hostCalls).toContainEqual({
      method: "session.truncateFrom",
      params: { sessionId: "session-1", fromMessageId: "assistant-old" },
    });
    expect(appendedMessages[0]).toMatchObject({
      id: "user-new",
      revisionRootId: "user-root",
      revisionCount: 2,
      activeRevision: 2,
    });

    await (service as unknown as {
      handleAgentEvent(envelope: AgentEventEnvelope): Promise<void>;
    }).handleAgentEvent({
      sessionId: "session-1",
      turnId: "turn-1",
      ts: 1,
      event: { type: "agent_end" },
    } as AgentEventEnvelope);
    expect(hostCalls).toContainEqual({
      method: "session.saveActiveRevision",
      params: { sessionId: "session-1" },
    });
  });
});
