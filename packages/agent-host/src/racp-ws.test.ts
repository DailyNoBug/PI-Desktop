import { afterEach, describe, expect, it } from "vitest";
import type { AgentEventEnvelope, RacpEventEnvelope } from "@pi-desktop/shared";

import { AgentHost } from "./agent-host.js";
import type { ApprovalPort } from "./approvals.js";
import { RacpWsClient } from "./racp-client.js";
import type { RacpRemoteProfile } from "./racp-profile.js";
import { RacpWsServer } from "./racp-ws.js";
import type { Principal, RuntimePort, SessionPort, SessionSummary } from "./ports.js";

const owner: Principal = { subject: "desktop", roles: ["owner"], pairedDevice: true };
const pairingToken = "pairing-token-0123456789abcdef";
let deviceToken = "";
let pairingSpent = false;

const runtime: RuntimePort = {
  async prompt() {
    return { turnId: "rt_1" };
  },
  async stop() {
    return { requested: true };
  },
  async abort() {},
  async respondInput() {},
};

const sessions: SessionPort = {
  async get(sessionId): Promise<SessionSummary | null> {
    return sessionId === "s1"
      ? {
          id: sessionId,
          title: "Remote",
          projectId: "proj",
          mode: "agent",
          permissionMode: "ask",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        }
      : null;
  },
  async history() {
    return { items: [], hasMore: false };
  },
};

const approvals: ApprovalPort = {
  async resolveTool() {},
  async resolveContract() {},
  async listPendingTools() {
    return [];
  },
};

const profile: RacpRemoteProfile = {
  async listProjects() {
    return [];
  },
  async listSessions() {
    return [];
  },
  async createSession() {
    throw new Error("unused");
  },
  async configureSession() {
    throw new Error("unused");
  },
  async forkSession() {
    throw new Error("unused");
  },
  async renameSession() {
    throw new Error("unused");
  },
  async deleteSession() {},
  async compactSession() {
    return { accepted: true };
  },
  async browseWorkspace() {
    throw new Error("unused");
  },
  async listWorkspace() {
    return { entries: [] };
  },
  async readWorkspace() {
    throw new Error("unused");
  },
  async diffWorkspace() {
    return { repo: false, clean: true, files: [] };
  },
  async listMcp() {
    return { servers: [], statuses: [] };
  },
  async upsertMcp() {
    throw new Error("unused");
  },
  async removeMcp() {
    return { ok: false };
  },
  async setMcpEnabled() {
    throw new Error("unused");
  },
  async setMcpScope() {
    throw new Error("unused");
  },
  async testMcp() {
    throw new Error("unused");
  },
  async listSkills() {
    return { skills: [] };
  },
  async createSkill() {
    throw new Error("unused");
  },
  async updateSkill() {
    throw new Error("unused");
  },
  async readSkill() {
    return { skill: null, body: null };
  },
  async removeSkill() {
    return { ok: false };
  },
  async setSkillEnabled() {
    throw new Error("unused");
  },
  async setSkillScope() {
    throw new Error("unused");
  },
  async saveRevision() {
    return { revision: null };
  },
  async listRevisions() {
    return { revisions: [] };
  },
  async activateRevision() {
    return { messages: [] };
  },
  async advertiseTools(tools) {
    return {
      accepted: tools.filter((tool) => !tool.requiresWorkspace),
      rejected: tools
        .filter((tool) => tool.requiresWorkspace)
        .map((tool) => ({ name: tool.name, reason: "workspace tools cannot be relayed" })),
    };
  },
  async openTerminal() {
    return { terminalId: "term_1", replay: Buffer.alloc(0).toString("base64") };
  },
  async writeTerminal(params) {
    if (params.terminalId !== "term_1") throw new Error("unknown terminal");
  },
  async resizeTerminal() {},
  async closeTerminal() {},
};

function createServer() {
  const agentHost = new AgentHost({ runtime, sessions, approvals });
  return new RacpWsServer({
    agentHost,
    profile,
    authenticate(token) {
      if (token === pairingToken && !pairingSpent) {
        pairingSpent = true;
        deviceToken = `device-${token}`;
        return { principal: owner, deviceToken };
      }
      return token === deviceToken ? { principal: owner } : null;
    },
    serverInfo: { name: "test-host", version: "0.0.0" },
  });
}

const openServers: RacpWsServer[] = [];
const openClients: RacpWsClient[] = [];

afterEach(async () => {
  await Promise.all(openClients.map((client) => client.disconnect()));
  await Promise.all(openServers.map((server) => server.close()));
  openClients.length = 0;
  openServers.length = 0;
});

describe("RACP WebSocket binding", () => {
  it("rejects an unauthenticated loopback connection", async () => {
    const server = createServer();
    openServers.push(server);
    await server.whenReady();
    const client = new RacpWsClient({
      url: server.address,
      token: "wrong-token-0123456789",
      clientInfo: { name: "test", version: "0" },
    });
    await expect(client.connect()).rejects.toThrow();
  });

  it("exchanges a pairing token, starts a turn, and streams durable events", async () => {
    const server = createServer();
    openServers.push(server);
    await server.whenReady();
    const client = new RacpWsClient({
      url: server.address,
      token: pairingToken,
      clientInfo: { name: "pi-desktop", version: "0.14.6" },
    });
    openClients.push(client);
    const initialized = await client.connect();
    expect(initialized.deviceToken).toMatch(/^device-/);

    const events: RacpEventEnvelope[] = [];
    const seen = new Promise<void>((resolve) => {
      void client.onEvent((event) => {
        if ("sequence" in event) {
          events.push(event);
          resolve();
        }
      });
    });
    await client.request("events/subscribe", { scope: "session", sessionId: "s1" });
    const started = await client.request<{ turn: { id: string; status: string } }>("turn/start", {
      sessionId: "s1",
      input: { text: "inspect remote project" },
      context: { requestId: "turn-1", idempotencyKey: "turn-key-1" },
    });
    expect(started.turn.status).toBe("running");
    server.agentHost.ingest({
      sessionId: "s1",
      turnId: started.turn.id,
      ts: Date.now(),
      event: { type: "agent_start" },
    });
    await seen;
    expect(events[0]?.kind).toBe("turn.started");
    expect(events[0]?.sessionId).toBe("s1");
    const cursor = { epoch: events[0]!.epoch, sequence: events[0]!.sequence! };
    await client.disconnect();
    const resumed = new RacpWsClient({
      url: server.address,
      token: initialized.deviceToken!,
      clientInfo: { name: "pi-desktop-resumed", version: "0.14.6" },
    });
    openClients.push(resumed);
    await resumed.connect();
    const nextSeen = new Promise<void>((resolve) => {
      void resumed.onEvent((event) => {
        if ("sequence" in event && event.sequence === cursor.sequence + 1) resolve();
      });
    });
    await resumed.request("events/subscribe", { scope: "session", sessionId: "s1", after: cursor });
    server.agentHost.ingest({
      sessionId: "s1",
      turnId: started.turn.id,
      ts: Date.now(),
      event: { type: "agent_end", messageIds: [] },
    });
    await nextSeen;
  });

  it("reuses the issued device token after pairing", async () => {
    const server = createServer();
    openServers.push(server);
    await server.whenReady();
    const second = new RacpWsClient({
      url: server.address,
      token: deviceToken,
      clientInfo: { name: "second", version: "0" },
    });
    openClients.push(second);
    await expect(second.connect()).resolves.toMatchObject({
      principal: { subject: "desktop", roles: ["owner"] },
    });
    const replayPairing = new RacpWsClient({
      url: server.address,
      token: pairingToken,
      clientInfo: { name: "replay", version: "0" },
    });
    await expect(replayPairing.connect()).rejects.toThrow();
  });

  it("exposes the remote terminal lifecycle", async () => {
    const server = createServer();
    openServers.push(server);
    await server.whenReady();
    const client = new RacpWsClient({
      url: server.address,
      token: deviceToken,
      clientInfo: { name: "terminal-client", version: "0" },
    });
    openClients.push(client);
    await client.connect();
    const opened = await client.request<{ terminalId: string }>("terminal/open", {
      sessionId: "s1",
      columns: 80,
      rows: 24,
    });
    expect(opened.terminalId).toBe("term_1");
    await expect(client.request("terminal/input", {
      terminalId: opened.terminalId,
      text: "pwd\n",
    })).resolves.toBeUndefined();
    await expect(client.request("terminal/resize", {
      terminalId: opened.terminalId,
      columns: 100,
      rows: 30,
    })).resolves.toBeUndefined();
    await expect(client.request("terminal/close", {
      terminalId: opened.terminalId,
    })).resolves.toBeUndefined();
  });

  it("relays a tool execution to the advertising client and fails it on disconnect", async () => {
    const server = createServer();
    openServers.push(server);
    await server.whenReady();
    const client = new RacpWsClient({
      url: server.address,
      token: deviceToken,
      clientInfo: { name: "relay-client", version: "0" },
    });
    openClients.push(client);
    await client.connect();
    let release!: (value: unknown) => void;
    const released = new Promise((resolve) => {
      release = resolve;
    });
    let sawRequest!: (value: void) => void;
    const requestSeen = new Promise<void>((resolve) => {
      sawRequest = resolve;
    });
    client.onRequest(async (request) => {
      sawRequest();
      await released;
      if (request.method !== "tool/execute") throw new Error(`unexpected request: ${request.method}`);
      return { echoed: (request.params as { args?: unknown }).args };
    });
    const advertised = await client.request<{ accepted: unknown[]; rejected: unknown[] }>(
      "tools/advertise",
      {
        tools: [{
          name: "mcp_local_search",
          description: "Search local documents",
          parameters: { type: "object" },
          source: "mcp:test",
          requiresWorkspace: false,
          risk: "medium",
        }],
      },
    );
    expect(advertised.accepted).toHaveLength(1);
    expect(server.relayTools().map((tool) => tool.name)).toEqual(["mcp_local_search"]);
    const execution = server.executeRelayTool({
      executionId: "exec_1",
      sessionId: "s1",
      toolCallId: "call_1",
      toolName: "mcp_local_search",
      args: { query: "release" },
    });
    await requestSeen;
    const outcome = expect(execution).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
    await client.disconnect();
    await outcome;
    release(undefined);
  });

  it("uses the relay tool timeout from the host execution", async () => {
    const server = createServer();
    openServers.push(server);
    await server.whenReady();
    const client = new RacpWsClient({
      url: server.address,
      token: deviceToken,
      clientInfo: { name: "relay-client", version: "0" },
    });
    openClients.push(client);
    await client.connect();
    client.onRequest(() => new Promise(() => undefined));
    await client.request("tools/advertise", {
      tools: [{
        name: "plugin_local_slow",
        description: "A slow local tool",
        source: "plugin:test",
        requiresWorkspace: false,
      }],
    });
    await expect(server.executeRelayTool({
      executionId: "exec_timeout",
      sessionId: "s1",
      toolName: "plugin_local_slow",
      timeoutMs: 10,
    })).rejects.toMatchObject({ code: "TOOL_TIMEOUT" });
  });
});
