import type { Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type {
  AgentEventEnvelope,
  AgentPromptAttachment,
  RacpEventEnvelope,
  RacpInitializeParams,
  RacpInitializeResult,
  RacpRequestContext,
} from "@pi-desktop/shared";
import {
  RACP_DEFAULT_LIMITS,
  RACP_DEFAULT_POLICY,
  RACP_OPERATIONS,
  RACP_PROTOCOL_VERSION,
  RACP_WS_SUBPROTOCOL,
  protocolVersionsCompatible,
  rolesAllowOperation,
} from "@pi-desktop/shared";

import type { AgentHost } from "./agent-host.js";
import { racpError, RacpError } from "./errors.js";
import type { Principal } from "./ports.js";
import type { RacpRemoteProfile, RacpRelayTool } from "./racp-profile.js";

export type RacpAuthenticationResult = {
  principal: Principal;
  /** Issued once when the bearer token was the SSH pairing token. */
  deviceToken?: string;
};

export type RacpWsServerOptions = {
  server?: HttpServer;
  host?: string;
  port?: number;
  agentHost: AgentHost;
  profile: RacpRemoteProfile;
  authenticate: (bearerToken: string) => RacpAuthenticationResult | null;
  serverInfo: {
    name: string;
    version: string;
    hostProtocolVersion?: number;
    storageSchemaVersion?: number;
  };
  maxFrameBytes?: number;
};

type JsonRpcMessage =
  | { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: unknown; result?: unknown; error?: unknown }
  | Record<string, never>;

type ClientConnection = {
  socket: WebSocket;
  principal: Principal;
  deviceToken?: string;
  initialized: boolean;
  initializedNotified: boolean;
  connectionId: string;
  subscriptions: Map<string, () => void>;
};

function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (!header || !/^Bearer\s+/i.test(header)) return null;
  const token = header.replace(/^Bearer\s+/i, "").trim();
  return token.length >= 16 ? token : null;
}

function errorPayload(error: RacpError) {
  return {
    code: error.code,
    message: error.message,
    retriable: error.retriable,
    traceId: error.traceId,
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

function contextOf(value: unknown): RacpRequestContext {
  const raw = (value ?? {}) as Partial<RacpRequestContext>;
  const requestId = typeof raw.requestId === "string" && raw.requestId ? raw.requestId : randomUUID();
  return {
    requestId,
    ...(typeof raw.idempotencyKey === "string" && raw.idempotencyKey ? { idempotencyKey: raw.idempotencyKey } : {}),
    ...(typeof raw.expectedRevision === "number" ? { expectedRevision: raw.expectedRevision } : {}),
    ...(typeof raw.traceparent === "string" ? { traceparent: raw.traceparent } : {}),
  };
}

/**
 * The normative RACP v1 WebSocket binding. It is deliberately loopback-only:
 * the first product deployment is a pi-host reached through an SSH forward.
 */
export class RacpWsServer {
  address!: string;
  readonly ready: Promise<void>;
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<ClientConnection>();
  private readonly authenticatedRequests = new WeakMap<IncomingMessage, RacpAuthenticationResult>();
  private closed = false;

  constructor(private readonly options: RacpWsServerOptions) {
    this.wss = new WebSocketServer(
      options.server
        ? { server: options.server, path: "/v1/racp/ws", verifyClient: (info, callback) => this.verify(info, callback) }
        : {
            host: options.host ?? "127.0.0.1",
            port: options.port ?? 0,
            path: "/v1/racp/ws",
            verifyClient: (info, callback) => this.verify(info, callback),
          },
    );
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.wss.on("connection", this.handleConnection);
    const settle = () => {
      const address = this.wss.address();
      if (!address || typeof address === "string") {
        rejectReady(new Error("RACP listener did not bind a TCP port"));
        return;
      }
      this.address = `ws://127.0.0.1:${address.port}/v1/racp/ws`;
      resolveReady();
    };
    this.wss.once("listening", settle);
    this.wss.once("error", rejectReady);
    // When attached to an already-listening HTTP server, WebSocketServer may
    // have its address before this turn yields.
    queueMicrotask(() => {
      const address = this.wss.address();
      if (address && typeof address !== "string") settle();
    });
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get agentHost(): AgentHost {
    return this.options.agentHost;
  }

  async whenReady(): Promise<this> {
    await this.ready;
    return this;
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    for (const client of this.clients) this.tearDown(client, 1001, "Host shutdown");
    return new Promise((resolve, reject) => {
      this.wss.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private verify(info: { req: IncomingMessage }, callback: (result: boolean, code?: number, message?: string) => void): void {
    if (this.closed || !isLoopback(info.req)) {
      callback(false, 403, "RACP is loopback-only");
      return;
    }
    const token = bearerToken(info.req);
    const result = token ? this.options.authenticate(token) : null;
    if (!result) {
      callback(false, 401, "Invalid device token");
      return;
    }
    this.authenticatedRequests.set(info.req, result);
    const protocols = String(info.req.headers["sec-websocket-protocol"] ?? "").split(",").map((value) => value.trim());
    if (!protocols.includes(RACP_WS_SUBPROTOCOL)) {
      callback(false, 400, "Required WebSocket subprotocol missing");
      return;
    }
    callback(true);
  }

  private handleConnection = (socket: WebSocket, request: IncomingMessage): void => {
    const token = bearerToken(request);
    const authenticated = token ? this.authenticatedRequests.get(request) ?? this.options.authenticate(token) : null;
    if (!authenticated) {
      socket.close(4401, "Invalid device token");
      return;
    }
    const connectionId = `conn_${randomUUID()}`;
    const client: ClientConnection = {
      socket,
      principal: { ...authenticated.principal, connectionId },
      ...(authenticated.deviceToken ? { deviceToken: authenticated.deviceToken } : {}),
      initialized: false,
      initializedNotified: false,
      connectionId,
      subscriptions: new Map(),
    };
    this.clients.add(client);
    socket.on("message", (data, isBinary) => {
      void this.handleMessage(client, data, isBinary);
    });
    socket.on("close", () => this.tearDown(client, 1000, "client disconnected"));
    socket.on("error", () => this.tearDown(client, 1011, "connection error"));
  };

  private tearDown(client: ClientConnection, code: number, reason: string): void {
    if (!this.clients.delete(client)) return;
    for (const unsubscribe of client.subscriptions.values()) unsubscribe();
    client.subscriptions.clear();
    if (client.socket.readyState === WebSocket.OPEN) client.socket.close(code, reason);
  }

  private async handleMessage(client: ClientConnection, data: unknown, isBinary: boolean): Promise<void> {
    if (isBinary) {
      this.tearDown(client, 4400, "Binary RACP frames are unsupported");
      return;
    }
    const max = this.options.maxFrameBytes ?? this.options.agentHost.limits.maxFrameBytes;
    const size = typeof (data as { byteLength?: number }).byteLength === "number"
      ? (data as { byteLength: number }).byteLength
      : Buffer.byteLength(String(data));
    if (size > max) {
      this.tearDown(client, 4409, "Frame too large");
      return;
    }
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(String(data)) as JsonRpcMessage;
    } catch {
      this.tearDown(client, 4400, "Invalid JSON");
      return;
    }
    if (message.method === undefined) return;
    const id = message.id ?? null;
    if (id === null) {
      if (message.method === "notifications/initialized") client.initializedNotified = true;
      return;
    }
    try {
      const result = await this.dispatch(client, message.method, (message.params ?? {}) as Record<string, unknown>);
      this.reply(client, { jsonrpc: "2.0", ...(id === null ? {} : { id }), result });
    } catch (error) {
      const racp = error instanceof RacpError
        ? error
        : racpError("INTERNAL", error instanceof Error ? error.message : String(error));
      if (id !== null) {
        this.reply(client, { jsonrpc: "2.0", id, error: errorPayload(racp) });
      }
    }
  }

  private reply(client: ClientConnection, payload: unknown): void {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    client.socket.send(JSON.stringify(payload));
  }

  private requireInitialized(client: ClientConnection): void {
    if (!client.initialized || !client.initializedNotified) {
      throw racpError("UNAUTHORIZED", "connection initialization is not complete");
    }
  }

  private requireOperation(client: ClientConnection, method: string): void {
    const operation = RACP_OPERATIONS[method as keyof typeof RACP_OPERATIONS];
    if (!operation) throw racpError("METHOD_NOT_FOUND", `unknown operation ${method}`);
    if (!rolesAllowOperation(client.principal.roles, method as keyof typeof RACP_OPERATIONS)) {
      throw racpError("FORBIDDEN", `principal lacks the role for ${method}`);
    }
  }

  private async dispatch(client: ClientConnection, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "connection/initialize") return this.initialize(client, params);
    this.requireInitialized(client);
    if (method === "connection/ping") return { serverTime: new Date().toISOString() };
    if (method === "host/list") throw racpError("METHOD_NOT_FOUND", "a direct Host has one Host: itself");
    this.requireOperation(client, method);

    switch (method) {
      case "project/list":
        return { projects: await this.options.profile.listProjects() };
      case "session/list":
        return { sessions: await this.options.profile.listSessions() };
      case "session/create": {
        const session = await this.options.profile.createSession(params);
        return { session };
      }
      case "session/configure":
        return { session: await this.options.profile.configureSession(params) };
      case "session/fork":
        return { session: await this.options.profile.forkSession(params) };
      case "session/rename":
        return { session: await this.options.profile.renameSession(params) };
      case "session/delete":
        await this.options.profile.deleteSession(params);
        return { ok: true };
      case "session/compact":
        return this.options.profile.compactSession(params);
      case "session/get": {
        const sessionId = requiredString(params.sessionId, "sessionId");
        const attached = await this.options.agentHost.attach(client.principal, { sessionId, includeSnapshot: false });
        return { session: attached.session };
      }
      case "session/attach":
        return this.options.agentHost.attach(client.principal, {
          sessionId: requiredString(params.sessionId, "sessionId"),
          ...(params.role === "viewer" || params.role === "controller" || params.role === "approver" || params.role === "owner"
            ? { role: params.role }
            : {}),
          ...(isCursor(params.after) ? { after: params.after } : {}),
          includeSnapshot: params.includeSnapshot !== false,
        });
      case "session/history":
        return this.options.agentHost.history(client.principal, {
          sessionId: requiredString(params.sessionId, "sessionId"),
          ...(typeof params.beforeItemId === "string" ? { beforeItemId: params.beforeItemId } : {}),
          ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
        });
      case "events/subscribe":
        return this.subscribe(client, params);
      case "events/unsubscribe":
        return { ok: this.unsubscribe(client, requiredString(params.subscriptionId, "subscriptionId")) };
      case "events/ack":
        this.options.agentHost.ack(
          requiredString(params.subscriptionId, "subscriptionId"),
          requiredNumber(params.sequence, "sequence"),
        );
        return { ok: true };
      case "turn/start":
        return this.options.agentHost.startTurn(client.principal, {
          sessionId: requiredString(params.sessionId, "sessionId"),
          ...(typeof params.idempotencyKey === "string" ? { idempotencyKey: params.idempotencyKey } : {}),
          ...(params.admission === "queue" || params.admission === "reject_if_busy" ? { admission: params.admission } : {}),
          input: requiredInput(params.input),
          context: contextOf(params.context),
        });
      case "turn/get":
        return { turn: this.options.agentHost.getTurn(requiredString(params.turnId, "turnId")) };
      case "turn/stop":
        return { turn: await this.options.agentHost.stopTurn(client.principal, requiredString(params.turnId, "turnId")) };
      case "turn/interrupt":
        return { turn: await this.options.agentHost.interruptTurn(client.principal, requiredString(params.turnId, "turnId")) };
      case "turn/cancel":
        return { turn: await this.options.agentHost.cancelTurn(client.principal, requiredString(params.turnId, "turnId")) };
      case "turn/prioritize":
        return { turn: await this.options.agentHost.prioritizeTurn(client.principal, requiredString(params.turnId, "turnId")) };
      case "approval/respond":
        return this.options.agentHost.respondApproval(client.principal, {
          approvalId: requiredString(params.approvalId, "approvalId"),
          decision: requiredString(params.decision, "decision") as never,
          ...(params.permissionMode === "ask" || params.permissionMode === "accept-edits" || params.permissionMode === "auto"
            ? { permissionMode: params.permissionMode }
            : {}),
          context: contextOf(params.context),
        });
      case "input/respond":
        return this.options.agentHost.respondInput(client.principal, {
          inputId: requiredString(params.inputId, "inputId"),
          answers: Array.isArray(params.answers) ? params.answers : [],
          context: contextOf(params.context),
        });
      case "tools/advertise": {
        if (!this.options.profile.advertiseTools) throw racpError("UNSUPPORTED", "tool relay is unavailable");
        return this.options.profile.advertiseTools(Array.isArray(params.tools) ? (params.tools as RacpRelayTool[]) : []);
      }
      case "workspace/browse":
        return this.options.profile.browseWorkspace(params);
      case "workspace/list":
        return this.options.profile.listWorkspace(params);
      case "workspace/read":
        return this.options.profile.readWorkspace(params);
      case "workspace/diff":
        return this.options.profile.diffWorkspace(params);
      case "terminal/open":
      case "terminal/input":
      case "terminal/resize":
      case "terminal/close": {
        const terminal = this.options.profile;
        if (method === "terminal/open" && terminal.openTerminal) return terminal.openTerminal(params);
        if (method === "terminal/input" && terminal.writeTerminal) return terminal.writeTerminal(params);
        if (method === "terminal/resize" && terminal.resizeTerminal) return terminal.resizeTerminal(params);
        if (method === "terminal/close" && terminal.closeTerminal) return terminal.closeTerminal(params);
        throw racpError("UNSUPPORTED", "terminals are unavailable on this Host");
      }
      default:
        throw racpError("METHOD_NOT_FOUND", `operation ${method} is not exposed by this binding`);
    }
  }

  private initialize(client: ClientConnection, params: Record<string, unknown>): RacpInitializeResult {
    if (client.initialized) throw racpError("CONFLICT", "connection is already initialized");
    const input = params as Partial<RacpInitializeParams>;
    const requested = input.protocolVersion ?? RACP_PROTOCOL_VERSION;
    if (!protocolVersionsCompatible(RACP_PROTOCOL_VERSION, requested)) {
      throw racpError("PROTOCOL_MISMATCH", `RACP ${requested} is incompatible with ${RACP_PROTOCOL_VERSION}`);
    }
    client.initialized = true;
    return {
      protocolVersion: RACP_PROTOCOL_VERSION,
      server: this.options.serverInfo,
      connectionId: client.connectionId,
      principal: {
        subject: client.principal.subject,
        roles: [...client.principal.roles],
      },
      capabilities: {
        eventReplay: true,
        snapshot: true,
        approvals: true,
        inputRequests: true,
        attachments: false,
        serverRequests: true,
        turnQueue: true,
        hostEvents: true,
        history: true,
        remoteHostProfile: true,
        toolRelay: this.options.profile.advertiseTools !== undefined,
        terminal: this.options.profile.openTerminal !== undefined,
        notifications: false,
        bindings: ["RACP-WS"],
      },
      limits: this.options.agentHost.limits,
      policy: this.options.agentHost.policy,
      ...(client.deviceToken ? { deviceToken: client.deviceToken } : {}),
    };
  }

  private subscribe(client: ClientConnection, params: Record<string, unknown>): unknown {
    const scope = params.scope === "host" ? "host" : "session";
    const result = this.options.agentHost.subscribe(
      client.principal,
      {
        scope,
        ...(scope === "session" ? { sessionId: requiredString(params.sessionId, "sessionId") } : {}),
        ...(isCursor(params.after) ? { after: params.after } : {}),
      },
      {
        deliver: (event: RacpEventEnvelope) => {
          this.reply(client, { jsonrpc: "2.0", method: "session/event", params: event });
        },
        close: (error) => {
          this.reply(client, {
            jsonrpc: "2.0",
            method: "session/event",
            params: { kind: "resync.required", error: errorPayload(error) },
          });
        },
      },
    );
    const unsubscribe = () => {
      this.options.agentHost.unsubscribe(result.subscriptionId, scope === "session" ? params.sessionId as string : undefined);
      client.subscriptions.delete(result.subscriptionId);
    };
    client.subscriptions.set(result.subscriptionId, unsubscribe);
    return result;
  }

  private unsubscribe(client: ClientConnection, subscriptionId: string): boolean {
    const unsubscribe = client.subscriptions.get(subscriptionId);
    if (!unsubscribe) return this.options.agentHost.unsubscribe(subscriptionId);
    unsubscribe();
    return true;
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw racpError("INVALID_ARGUMENT", `${field} is required`);
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw racpError("INVALID_ARGUMENT", `${field} must be a non-negative integer`);
  }
  return value;
}

function requiredInput(value: unknown): { text: string; attachments?: AgentPromptAttachment[] } {
  const raw = (value ?? {}) as { text?: unknown; attachments?: unknown };
  if (typeof raw.text !== "string") throw racpError("INVALID_ARGUMENT", "input.text is required");
  return {
    text: raw.text,
    ...(Array.isArray(raw.attachments) ? { attachments: raw.attachments as AgentPromptAttachment[] } : {}),
  };
}

function isCursor(value: unknown): value is { epoch: string; sequence: number } {
  return (
    Boolean(value) &&
    typeof (value as { epoch?: unknown }).epoch === "string" &&
    typeof (value as { sequence?: unknown }).sequence === "number"
  );
}
