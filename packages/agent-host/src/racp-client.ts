import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { RacpEventEnvelope, RacpInitializeParams, RacpInitializeResult } from "@pi-desktop/shared";
import { RACP_WS_SUBPROTOCOL } from "@pi-desktop/shared";

import { racpError, RacpError } from "./errors.js";

export type RacpClientEvent = RacpEventEnvelope | { kind: "resync.required"; error: unknown };
export type RacpClientRequest = {
  id: string;
  method: string;
  params: unknown;
};

export type RacpClientOptions = {
  url: string;
  token: string;
  clientInfo: { name: string; version: string };
  heartbeatMs?: number;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class RacpWsClient {
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private listeners = new Set<(event: RacpClientEvent) => void>();
  private requestListeners = new Set<(request: RacpClientRequest) => Promise<unknown>>();
  private closeListeners = new Set<(error?: Error) => void>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private currentToken: string;
  initializeResult: RacpInitializeResult | null = null;

  constructor(private readonly options: RacpClientOptions) {
    this.currentToken = options.token;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  get deviceToken(): string | undefined {
    return this.initializeResult?.deviceToken;
  }

  onEvent(listener: (event: RacpClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onRequest(listener: (request: RacpClientRequest) => Promise<unknown>): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async connect(): Promise<RacpInitializeResult> {
    await this.disconnect();
    const socket = new WebSocket(this.options.url, RACP_WS_SUBPROTOCOL, {
      headers: { authorization: `Bearer ${this.currentToken}` },
    });
    this.socket = socket;
    const opened = await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => reject(error);
      socket.once("open", () => {
        socket.off("error", fail);
        resolve();
      });
      socket.once("error", fail);
    });
    socket.on("message", (data, isBinary) => this.handleMessage(data, isBinary));
    socket.on("close", () => this.handleClose());
    socket.on("error", () => undefined);
    const params: RacpInitializeParams = {
      protocolVersion: "1.0",
      client: this.options.clientInfo,
      bindings: ["RACP-WS"],
      capabilities: {
        eventReplay: true,
        approvals: true,
        inputRequests: true,
        attachments: false,
        turnQueue: true,
        hostEvents: true,
        history: true,
        toolRelay: true,
        terminal: true,
      },
    };
    try {
      this.initializeResult = (await this.request("connection/initialize", params)) as RacpInitializeResult;
      socket.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
      if (this.initializeResult.deviceToken) this.currentToken = this.initializeResult.deviceToken;
      this.startHeartbeat();
      return this.initializeResult;
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw racpError("AGENT_UNAVAILABLE", "RACP connection is unavailable", { retriable: true });
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(racpError("TIMEOUT", `RACP ${method} timed out`, { retriable: true }));
      }, 15_000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.stopHeartbeat();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(racpError("AGENT_UNAVAILABLE", "RACP connection closed", { retriable: true }));
    }
    this.pending.clear();
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once("close", resolve);
      socket.close(1000, "client disconnect");
      setTimeout(resolve, 1_000).unref();
    });
  }

  private handleMessage(data: unknown, isBinary: boolean): void {
    if (isBinary) return;
    let message: {
      id?: string;
      result?: unknown;
      error?: { code?: string; message?: string; retriable?: boolean; details?: unknown };
      method?: string;
      params?: unknown;
    };
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message.method === "session/event") {
      for (const listener of this.listeners) listener(message.params as RacpClientEvent);
      return;
    }
    const requestId = message.id;
    if (message.method !== undefined && typeof requestId === "string") {
      void (async () => {
        const request = {
          id: requestId,
          method: String(message.method),
          params: message.params ?? {},
        };
        try {
          const listener = [...this.requestListeners][0];
          if (!listener) throw racpError("METHOD_NOT_FOUND", `RACP server request ${request.method} is unsupported`);
          const result = await listener(request);
          this.reply({ jsonrpc: "2.0", id: requestId, result });
        } catch (error) {
          const racp = error instanceof RacpError
            ? error
            : racpError("INTERNAL", error instanceof Error ? error.message : String(error));
          this.reply({
            jsonrpc: "2.0",
            id: requestId,
            error: {
              code: racp.code,
              message: racp.message,
              retriable: racp.retriable,
              ...(racp.details === undefined ? {} : { details: racp.details }),
            },
          });
        }
      })();
      return;
    }
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const error = racpError(
        message.error.code ?? "INTERNAL",
        message.error.message ?? "RACP request failed",
        message.error.details === undefined ? {} : { details: message.error.details },
      );
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
  }

  private handleClose(): void {
    this.stopHeartbeat();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(racpError("AGENT_UNAVAILABLE", "RACP connection closed", { retriable: true }));
    }
    this.pending.clear();
    this.socket = null;
    for (const listener of this.closeListeners) listener();
  }

  private reply(payload: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
  }

  private startHeartbeat(): void {
    const interval = this.options.heartbeatMs ?? 30_000;
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this.connected) void this.request("connection/ping").catch(() => undefined);
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
}
