/**
 * RACP-WS-backed {@link RemoteHostClient}: adapts the single-callback
 * `RacpClient.onEvent` seam into the multi-listener `subscribe()` shape
 * `RemoteHostConnection` consumes. This is the only file in
 * `electron/main/remote/` that speaks the `@pi-desktop/racp` protocol
 * package; everything above it is transport-agnostic.
 *
 * Ownership stays inside Electron Main. The transport factory is injected —
 * production wires it to {@link wsClientTransport} against a paired host, and
 * tests wire it to the in-memory `MemoryLink` from
 * `packages/racp/src/test-harness.ts` so the adapter exercises the real
 * `RacpClient` state machine without a socket.
 */
import { RacpClient, type ClientTransportFactory, type RacpClientState } from "@pi-desktop/racp";
import type { RacpEventEnvelope } from "@pi-desktop/shared";
import type { RemoteHostClient } from "./remote-host-connection.js";

export type RacpRemoteHostClientOptions = {
  transport: ClientTransportFactory;
  /** Identity sent in `connection/initialize`; the host records it as the device label. */
  clientInfo: { name: string; version: string };
  /** Deadline for a single request; the RACP default of 15s is used when omitted. */
  requestTimeoutMs?: number;
  /** Reconnect policy; the RACP client stays disconnected when omitted. */
  reconnect?: {
    enabled: boolean;
    baseDelayMs?: number;
    maxDelayMs?: number;
    maxAttempts?: number;
  };
  /** Optional structured log; defaults to a no-op. */
  log?: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;
};

export type RacpRemoteHostClient = {
  /** The multi-listener {@link RemoteHostClient} the connection module consumes. */
  readonly client: RemoteHostClient;
  /** Underlying RACP client state, for boot diagnostics and the future host card. */
  readonly state: () => RacpClientState;
  /** Open the transport and initialize the RACP session. */
  connect(): Promise<void>;
  /** Close the transport; safe to call before {@link connect} and after failure. */
  close(): Promise<void>;
};

/**
 * The adapter multiplexes {@link RacpClient.onEvent} — a single-slot callback
 * — into the `subscribe()` API {@link RemoteHostConnection} expects. Fan-out
 * is intentional: Stage 5 (terminal) and Stage 3b (resync watchdog) will
 * attach their own listeners on the same client.
 */
export function createRacpRemoteHostClient(
  options: RacpRemoteHostClientOptions,
): RacpRemoteHostClient {
  const listeners = new Set<(envelope: RacpEventEnvelope) => void>();
  const racp = new RacpClient({
    transport: options.transport,
    client: options.clientInfo,
    onEvent: (envelope) => {
      for (const listener of listeners) {
        try {
          listener(envelope);
        } catch (error) {
          options.log?.("warn", "remote event listener threw", { error: String(error) });
        }
      }
    },
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    ...(options.reconnect ? { reconnect: options.reconnect } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  const client: RemoteHostClient = {
    request: (method, params) => racp.request(method, params),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    client,
    state: () => racp.state,
    async connect() {
      await racp.connect();
    },
    async close() {
      await racp.close();
    },
  };
}
