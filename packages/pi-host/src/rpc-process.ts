import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import {
  ErrorCodes,
  MAX_HOST_STDIN_LINE_BYTES,
  rpcTimeoutMs,
} from "@pi-desktop/shared";

export type ChildRpcRequest = {
  id: string | number;
  method: string;
  params: unknown;
};

export type RpcProcessOptions = {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  label: string;
  onStderr?: (text: string) => void;
  handleRequest?: (request: ChildRpcRequest) => Promise<unknown>;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

function rpcError(error: unknown): Error & { errorCode?: string; data?: unknown } {
  if (error instanceof Error) {
    const next = error as Error & { errorCode?: string; data?: unknown };
    if (!next.errorCode && (next as { code?: unknown }).code === "LIMIT_EXCEEDED") {
      next.errorCode = ErrorCodes.LIMIT_EXCEEDED;
    }
    return next;
  }
  return Object.assign(new Error(String(error)), { errorCode: ErrorCodes.INTERNAL });
}

/**
 * NDJSON JSON-RPC process transport used for both host-core and the agent
 * sidecar. It has no Electron dependency so the same code runs in pi-host.
 */
export class RpcProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private readonly notificationHandlers = new Set<(method: string, params: unknown) => void>();
  private readonly exitHandlers = new Set<() => void>();
  private readonly label: string;
  private readonly handleRequest?: (request: ChildRpcRequest) => Promise<unknown>;
  private closed = false;
  private disposed = false;
  private readline?: ReturnType<typeof createInterface>;

  constructor(private readonly options: RpcProcessOptions) {
    this.label = options.label;
    this.handleRequest = options.handleRequest;
    this.child = spawn(options.command, options.args ?? [], {
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (text: string) => options.onStderr?.(text));
    this.child.on("exit", () => this.closeTransport(new Error(`${options.label} exited`)));
    this.child.on("error", (error: Error) => this.closeTransport(error));
    const lineReader = createInterface({ input: this.child.stdout });
    this.readline = lineReader;
    lineReader.on("line", (line) => void this.onLine(line));
  }

  get available(): boolean {
    return !this.closed && this.child.exitCode === null && !this.child.killed;
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onExit(handler: () => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  async call<T = unknown>(method: string, params: unknown = {}, timeoutMs?: number): Promise<T> {
    if (!this.available) throw this.unavailable(`${this.label} is unavailable`);
    const id = randomUUID();
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    if (Buffer.byteLength(payload) > MAX_HOST_STDIN_LINE_BYTES) {
      throw Object.assign(new Error("request line exceeds 64 MiB"), {
        errorCode: ErrorCodes.LIMIT_EXCEEDED,
      });
    }
    const deadline = timeoutMs ?? rpcTimeoutMs(method, params);
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        finish();
      };
      timer = setTimeout(() => settle(() => reject(new Error(`${this.label} timeout: ${method}`))), deadline);
      this.pending.set(id, {
        resolve: (value) => settle(() => resolve(value as T)),
        reject: (error) => settle(() => reject(error)),
        timer,
      });
      this.child.stdin.write(payload, (error) => {
        if (!error) return;
        const failure = this.unavailable(`${this.label} write failed: ${error.message}`);
        settle(() => reject(failure));
        this.closeTransport(failure);
      });
    });
  }

  private async onLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let message: {
      id?: string | number | null;
      result?: unknown;
      error?: { message?: string; data?: { errorCode?: string } };
      method?: string;
      params?: unknown;
    };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && message.id !== null && ("result" in message || message.error)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      if (message.error) {
        const error = new Error(message.error.message ?? `${this.label} request failed`) as Error & {
          data?: unknown;
          errorCode?: string;
        };
        error.data = message.error.data;
        error.errorCode = message.error.data?.errorCode;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method === undefined || message.id === undefined || message.id === null) {
      for (const handler of this.notificationHandlers) handler(message.method ?? "", message.params ?? {});
      return;
    }
    const request = { id: message.id, method: message.method, params: message.params ?? {} };
    try {
      const result = this.handleRequest ? await this.handleRequest(request) : undefined;
      this.write({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      const next = rpcError(error);
      this.write({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32000,
          message: next.message,
          data: { errorCode: next.errorCode ?? ErrorCodes.INTERNAL },
        },
      });
    }
  }

  private write(value: unknown): void {
    if (this.child.stdin.destroyed || !this.child.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private unavailable(message: string): Error & { errorCode: string } {
    return Object.assign(new Error(message), { errorCode: ErrorCodes.HOST_UNAVAILABLE });
  }

  private closeTransport(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(this.unavailable(error.message));
    }
    this.pending.clear();
    this.notificationHandlers.clear();
    this.readline?.close();
    this.readline = undefined;
    for (const handler of this.exitHandlers) handler();
    this.exitHandlers.clear();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.end();
    this.closeTransport(new Error(`${this.label} disposed`));
    if (this.child.exitCode !== null || this.child.killed) return;
    const exited = await Promise.race([
      new Promise<void>((resolve) => this.child.once("exit", resolve)),
      new Promise<void>((resolve) => setTimeout(resolve, 3_000).unref?.()),
    ]);
    void exited;
    if (this.child.exitCode === null && !this.child.killed) this.child.kill("SIGKILL");
  }
}
