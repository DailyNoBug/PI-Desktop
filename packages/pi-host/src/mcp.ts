import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { isActiveInProject, type McpServerRecord, type McpServerStatus } from "@pi-desktop/shared";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 100_000;
const MAX_TOOLS_PER_SERVER = 64;
const MAX_TOOL_PAGES = 8;
const MAX_STDIO_LINE_BYTES = 4 * 1024 * 1024;
const MAX_ACTIVE_SERVERS = 16;

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type RemoteMcpTool = {
  fullName: string;
  serverId: string;
  toolName: string;
  description: string;
  schema?: unknown;
};

function userMcpToolName(serverId: string, toolName: string): string {
  const safeServer = serverId.replace(/[^a-zA-Z0-9_]/g, "_");
  const safeTool = toolName.replace(/[^a-zA-Z0-9_]/g, "_");
  return `mcp_${safeServer}_${safeTool}`;
}

function mcpError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function processEnv(values: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { NODE_ENV: process.env.NODE_ENV ?? "production" };
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return { ...env, ...values };
}

function parseHttpResponse(body: string, contentType: string): JsonRpcMessage[] {
  if (!contentType.includes("text/event-stream")) {
    const parsed = JSON.parse(body) as JsonRpcMessage | JsonRpcMessage[];
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  const messages: JsonRpcMessage[] = [];
  for (const block of body.split(/\n\n/)) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (!data) continue;
    try {
      messages.push(JSON.parse(data) as JsonRpcMessage);
    } catch {
      // A partial event is not actionable; its request times out.
    }
  }
  return messages;
}

class RemoteMcpClient {
  private transport:
    | { send: (message: JsonRpcMessage, timeoutMs?: number) => Promise<void>; close: () => void }
    | null = null;
  private pending = new Map<number, Pending>();
  private tools: McpTool[] = [];
  private connecting?: Promise<McpTool[]>;
  private nextId = 1;

  constructor(private readonly record: McpServerRecord) {}

  getTools(): McpTool[] {
    return this.tools;
  }

  isConnected(): boolean {
    return this.transport !== null;
  }

  async connect(): Promise<McpTool[]> {
    if (this.transport) return this.tools;
    this.connecting ??= this.handshake().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async callTool(toolName: string, args: unknown): Promise<unknown> {
    await this.connect();
    const result = (await this.request(
      "tools/call",
      { name: toolName, arguments: args ?? {} },
      CALL_TIMEOUT_MS,
    )) as { isError?: boolean } | null;
    if (result && typeof result === "object" && result.isError) {
      throw mcpError("TOOL_FAILED", "remote MCP tool failed");
    }
    return result;
  }

  close(): void {
    const transport = this.transport;
    this.transport = null;
    this.tools = [];
    transport?.close();
    this.failPending(mcpError("UNAVAILABLE", "remote MCP session closed"));
  }

  private async handshake(): Promise<McpTool[]> {
    this.transport = this.createTransport(CONNECT_TIMEOUT_MS);
    try {
      await this.request(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "pi-host", version: "1" },
        },
        CONNECT_TIMEOUT_MS,
      );
      await this.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      this.tools = await this.listTools();
      return this.tools;
    } catch (error) {
      this.transport?.close();
      this.transport = null;
      this.tools = [];
      this.failPending(mcpError("UNAVAILABLE", error instanceof Error ? error.message : String(error)));
      throw error;
    }
  }

  private createTransport(timeoutMs: number): {
    send: (message: JsonRpcMessage, timeoutMs?: number) => Promise<void>;
    close: () => void;
  } {
    if (this.record.transport === "stdio") return this.createStdioTransport();
    return this.createHttpTransport(timeoutMs);
  }

  private createStdioTransport(): {
    send: (message: JsonRpcMessage, timeoutMs?: number) => Promise<void>;
    close: () => void;
  } {
    const command = this.record.command ?? "";
    if (!command || command.split("/").some((part) => part === "..") || (command.includes("/") && !isAbsolute(command))) {
      throw mcpError("INVALID_ARGUMENT", "remote MCP command must be a name or absolute path");
    }
    const child: ChildProcess = spawn(command, this.record.args ?? [], {
      cwd: homedir(),
      env: processEnv(this.record.env ?? {}),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let buffer = "";
    let closed = false;
    let lastStderr = "";

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_STDIO_LINE_BYTES) {
        buffer = "";
        child.kill();
        return;
      }
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          try {
            this.receive(JSON.parse(line) as JsonRpcMessage);
          } catch {
            // stdout logging must not tear down a valid MCP session.
          }
        }
        index = buffer.indexOf("\n");
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      lastStderr = (lastStderr + chunk).trimEnd().slice(0, 500);
    });
    child.on("error", (error) => {
      closed = true;
      this.transportFailed(error.message);
    });
    child.on("exit", (code) => {
      closed = true;
      this.transportFailed(`remote MCP server exited with code ${code ?? 0}${lastStderr ? `: ${lastStderr}` : ""}`);
    });

    return {
      send: async (message, _timeoutMs) => {
        if (closed || !child.stdin?.writable) throw mcpError("UNAVAILABLE", "remote MCP server is not running");
        child.stdin.write(`${JSON.stringify(message)}\n`);
      },
      close: () => {
        closed = true;
        child.kill();
      },
    };
  }

  private createHttpTransport(_connectTimeoutMs: number): {
    send: (message: JsonRpcMessage, timeoutMs?: number) => Promise<void>;
    close: () => void;
  } {
    let parsed: URL;
    try {
      parsed = new URL(this.record.url ?? "");
    } catch {
      throw mcpError("INVALID_ARGUMENT", "remote MCP URL is invalid");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw mcpError("INVALID_ARGUMENT", "remote MCP URL must use http or https");
    }
    let sessionId: string | undefined;
    let closed = false;
    return {
      send: async (message, timeoutMs = CALL_TIMEOUT_MS) => {
        if (closed) throw mcpError("UNAVAILABLE", "remote MCP session is closed");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs ?? CALL_TIMEOUT_MS);
        try {
          const response = await fetch(parsed, {
            method: "POST",
            headers: {
              ...(this.record.headers ?? {}),
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "mcp-protocol-version": MCP_PROTOCOL_VERSION,
              ...(sessionId ? { "mcp-session-id": sessionId } : {}),
            },
            body: JSON.stringify(message),
            signal: controller.signal,
          });
          const nextSession = response.headers.get("mcp-session-id");
          if (nextSession) sessionId = nextSession;
          if (!response.ok) throw mcpError("HTTP_ERROR", `remote MCP server returned ${response.status}`);
          const body = await response.text();
          if (body.trim()) {
            for (const entry of parseHttpResponse(body, response.headers.get("content-type") ?? "")) {
              this.receive(entry);
            }
          }
        } finally {
          clearTimeout(timer);
        }
      },
      close: () => {
        closed = true;
      },
    };
  }

  private async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = (await this.request(
        "tools/list",
        cursor ? { cursor } : {},
        CONNECT_TIMEOUT_MS,
      )) as { tools?: unknown; nextCursor?: unknown } | null;
      for (const raw of Array.isArray(result?.tools) ? result?.tools : []) {
        const entry = raw as { name?: unknown; description?: unknown; inputSchema?: unknown };
        if (typeof entry.name !== "string" || !entry.name.trim()) continue;
        tools.push({
          name: entry.name,
          ...(typeof entry.description === "string" ? { description: entry.description } : {}),
          ...(entry.inputSchema !== undefined ? { inputSchema: entry.inputSchema } : {}),
        });
        if (tools.length >= MAX_TOOLS_PER_SERVER) return tools;
      }
      const next = typeof result?.nextCursor === "string" ? result.nextCursor : "";
      if (!next || next === cursor) return tools;
      cursor = next;
    }
    return tools;
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const transport = this.transport;
    if (!transport) throw mcpError("UNAVAILABLE", "remote MCP server is not connected");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(mcpError("TIMEOUT", `remote MCP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void transport.send({ jsonrpc: "2.0", id, method, params }, timeoutMs).catch((error: Error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  private receive(message: JsonRpcMessage): void {
    if (message.id !== undefined && message.id !== null && message.method) {
      void this.transport?.send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "method not supported" },
      }).catch(() => undefined);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(mcpError("MCP_ERROR", message.error.message || `remote MCP error ${message.error.code ?? ""}`));
      return;
    }
    pending.resolve(message.result ?? null);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private transportFailed(reason: string): void {
    this.transport = null;
    this.tools = [];
    this.failPending(mcpError("UNAVAILABLE", reason));
  }
}

type Entry = {
  record: McpServerRecord;
  client: RemoteMcpClient;
  status: McpServerStatus;
  connecting?: Promise<McpTool[]>;
};

/** Owns user-configured MCP processes on the remote Host. */
export class RemoteMcpRuntime {
  private entries = new Map<string, Entry>();
  private records: McpServerRecord[] = [];

  setRecords(records: McpServerRecord[]): void {
    this.records = records.map((record) => ({ ...record }));
    const byId = new Map(this.records.map((record) => [record.id, record]));
    for (const [id, entry] of [...this.entries]) {
      const next = byId.get(id);
      if (!next || this.configurationChanged(entry.record, next)) {
        entry.client.close();
        this.entries.delete(id);
      } else {
        entry.record = next;
      }
    }
  }

  mergeRecords(records: McpServerRecord[]): void {
    const byId = new Map([...this.records, ...records].map((record) => [record.id, record]));
    this.setRecords([...byId.values()]);
  }

  listStatuses(): McpServerStatus[] {
    return this.records.map((record) => ({ ...this.statusFor(record.id) }));
  }

  statusFor(serverId: string): McpServerStatus {
    return this.entries.get(serverId)?.status ?? {
      serverId,
      state: "idle",
      toolCount: 0,
      updatedAt: Date.now(),
    };
  }

  async toolsForProject(projectPath: string | null | undefined): Promise<RemoteMcpTool[]> {
    const active = this.records.filter((record) => record.enabled && isActiveInProject(record, projectPath));
    const lists = await Promise.all(active.slice(0, MAX_ACTIVE_SERVERS).map((record) => this.connect(record)));
    const tools: RemoteMcpTool[] = [];
    active.slice(0, MAX_ACTIVE_SERVERS).forEach((record, index) => {
      for (const tool of lists[index]) {
        tools.push({
          fullName: userMcpToolName(record.id, tool.name),
          serverId: record.id,
          toolName: tool.name,
          description: tool.description ?? `${record.label} tool "${tool.name}" (MCP)`,
          ...(tool.inputSchema !== undefined ? { schema: tool.inputSchema } : {}),
        });
      }
    });
    return tools;
  }

  async callTool(fullName: string, args: unknown, projectPath: string | null | undefined): Promise<unknown> {
    const descriptor = (await this.toolsForProject(projectPath)).find((tool) => tool.fullName === fullName);
    if (!descriptor) throw mcpError("TOOL_NOT_FOUND", `unknown remote MCP tool: ${fullName}`);
    const entry = this.entries.get(descriptor.serverId);
    if (!entry?.client.isConnected()) throw mcpError("UNAVAILABLE", "remote MCP server is unavailable");
    return entry.client.callTool(descriptor.toolName, args);
  }

  async test(serverId: string): Promise<McpServerStatus> {
    const record = this.records.find((entry) => entry.id === serverId);
    if (!record) {
      return { serverId, state: "failed", toolCount: 0, message: "server not found", updatedAt: Date.now() };
    }
    this.entries.get(serverId)?.client.close();
    this.entries.delete(serverId);
    await this.connect(record);
    return this.statusFor(serverId);
  }

  disposeAll(): void {
    for (const entry of this.entries.values()) entry.client.close();
    this.entries.clear();
  }

  private async connect(record: McpServerRecord): Promise<McpTool[]> {
    const existing = this.entries.get(record.id);
    if (existing?.connecting) return existing.connecting;
    if (existing?.client.isConnected()) return existing.client.getTools();
    if (existing?.status.state === "failed") return [];
    const entry = existing ?? {
      record,
      client: new RemoteMcpClient(record),
      status: {
        serverId: record.id,
        state: "idle" as const,
        toolCount: 0,
        updatedAt: Date.now(),
      },
    };
    this.entries.set(record.id, entry);
    entry.connecting = this.handshake(record, entry).finally(() => {
      entry.connecting = undefined;
    });
    return entry.connecting;
  }

  private async handshake(record: McpServerRecord, entry: Entry): Promise<McpTool[]> {
    entry.status = { ...entry.status, state: "connecting", updatedAt: Date.now() };
    try {
      const tools = await entry.client.connect();
      if (this.entries.get(record.id) !== entry) {
        entry.client.close();
        return [];
      }
      entry.status = {
        serverId: record.id,
        state: "ready",
        toolCount: tools.length,
        toolNames: tools.map((tool) => tool.name),
        updatedAt: Date.now(),
      };
      return tools;
    } catch (error) {
      entry.status = {
        serverId: record.id,
        state: "failed",
        toolCount: 0,
        message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        updatedAt: Date.now(),
      };
      return [];
    }
  }

  private configurationChanged(before: McpServerRecord, after: McpServerRecord): boolean {
    return before.transport !== after.transport ||
      before.command !== after.command ||
      JSON.stringify(before.args ?? []) !== JSON.stringify(after.args ?? []) ||
      JSON.stringify(before.env ?? {}) !== JSON.stringify(after.env ?? {}) ||
      before.url !== after.url ||
      JSON.stringify(before.headers ?? {}) !== JSON.stringify(after.headers ?? {});
  }
}
