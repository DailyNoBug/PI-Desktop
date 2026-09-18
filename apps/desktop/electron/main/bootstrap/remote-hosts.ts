/**
 * Boot every paired remote host. Reads the persisted registry, builds a
 * `RemoteHostConnection` per record, opens them, and returns a disposer that
 * `bootstrap/shutdown.ts` calls on quit. An empty registry (the default
 * install with no user pairing) is a full no-op: nothing runs, the router
 * has no remote backends, and every renderer call keeps hitting the local
 * handler byte-for-byte.
 *
 * The transport factory is injected. Production wires it to
 * `wsClientTransport` from `@pi-desktop/racp` (loopback for local dev, `-L`
 * tunnel target for Stage 4's SSH bootstrap); tests wire the in-memory
 * `MemoryLink` so this boot layer exercises the real `RacpClient` state
 * machine without a socket.
 */
import { wsClientTransport } from "@pi-desktop/racp";
import type { BackendRouter } from "../remote/backend-router.js";
import {
  createRacpRemoteHostClient,
  type RacpRemoteHostClient,
} from "../remote/racp-remote-host-client.js";
import {
  createRemoteHostConnection,
  type RemoteHostConnection,
} from "../remote/remote-host-connection.js";
import {
  createRemoteHostRegistry,
  type EncryptionPort,
  type RemoteHostRecord,
  type RemoteHostRegistry,
} from "../remote/remote-host-registry.js";

export type RemoteHostAdapterFactory = (record: RemoteHostRecord) => RacpRemoteHostClient;

export type BootRemoteHostsOptions = {
  dataDir: string;
  encryption: EncryptionPort;
  router: BackendRouter;
  emit: (channel: string, payload: unknown) => void;
  /** `connection/initialize` identity forwarded to every paired host. */
  clientInfo: { name: string; version: string };
  /** Optional override; the default uses the real `wsClientTransport`. */
  buildAdapter?: RemoteHostAdapterFactory;
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
};

/** Renderer-facing summary of one paired host (no secret material). */
export type RemoteHostSummary = {
  hostKey: string;
  label: string;
  url: string;
  connected: boolean;
};

export interface RemoteHostsBoot {
  /** Read registry, connect every host, register their sessions. Returns
   * the number of hosts that finished `open()` without throwing. */
  open(): Promise<number>;
  /** Close every open connection. Idempotent; safe to call before `open`. */
  closeAll(): Promise<void>;
  /** Every paired host with its live connection state; safe from the renderer. */
  list(): Promise<RemoteHostSummary[]>;
  /** Persist a paired record, then open one live connection for it. */
  addHost(record: RemoteHostRecord): Promise<RemoteHostSummary>;
  /** Close and unregister the host, then remove it from the registry. */
  removeHost(hostKey: string): Promise<void>;
  /** The underlying registry, exposed for pairing flows that write directly. */
  readonly registry: RemoteHostRegistry;
};

/**
 * Single-slot registry so `bootstrap/shutdown.ts` can wait on the same boot
 * `startup.ts` created without expanding `index.ts` past its 1500-LOC ceiling.
 * The shutdown handler reads this on `before-quit` — never earlier — so the
 * ordering is: register the ref during startup, close during shutdown.
 */
let activeRemoteHostsBoot: RemoteHostsBoot | null = null;

export function setActiveRemoteHostsBoot(boot: RemoteHostsBoot | null): void {
  activeRemoteHostsBoot = boot;
}

export function getActiveRemoteHostsBoot(): RemoteHostsBoot | null {
  return activeRemoteHostsBoot;
}

type OpenHost = {
  hostKey: string;
  adapter: RacpRemoteHostClient;
  connection: RemoteHostConnection;
};

export function createRemoteHostsBoot(
  options: BootRemoteHostsOptions,
): RemoteHostsBoot {
  const log = options.log ?? (() => undefined);
  const buildAdapter: RemoteHostAdapterFactory =
    options.buildAdapter ??
    ((record) =>
      createRacpRemoteHostClient({
        transport: wsClientTransport({ url: record.url, token: record.deviceToken }),
        clientInfo: options.clientInfo,
        log: (level, message, data) => log(level, message, data),
      }));

  const registry = createRemoteHostRegistry({
    dataDir: options.dataDir,
    encryption: options.encryption,
    log: (level, message, data) => log(level, message, data),
  });

  const opened: OpenHost[] = [];

  /** Bring one record online: build adapter, connect, register the router
   * backends. Failure is thrown so the caller can decide (boot logs & skips;
   * a live pair-then-add refuses to persist a token that cannot be used). */
  const openHost = async (record: RemoteHostRecord): Promise<OpenHost> => {
    const adapter = buildAdapter(record);
    await adapter.connect();
    const connection = createRemoteHostConnection({
      hostKey: record.hostKey,
      client: adapter.client,
      router: options.router,
      emit: options.emit,
      log: (level, message, data) => log(level, message, data),
    });
    try {
      await connection.open();
    } catch (error) {
      // A connection that failed to open leaves the adapter live; close it
      // before re-throwing so the ws socket does not leak.
      await adapter.close().catch(() => undefined);
      throw error;
    }
    return { hostKey: record.hostKey, adapter, connection };
  };

  const closeHost = async (host: OpenHost): Promise<void> => {
    try {
      await host.connection.close();
    } catch (error) {
      log("warn", `remote host ${host.hostKey} connection close threw`, {
        error: String(error),
      });
    }
    try {
      await host.adapter.close();
    } catch (error) {
      log("warn", `remote host ${host.hostKey} adapter close threw`, {
        error: String(error),
      });
    }
  };

  const isConnected = (hostKey: string): boolean =>
    opened.some((host) => host.hostKey === hostKey);

  return {
    registry,
    async open() {
      let records: RemoteHostRecord[];
      try {
        records = await registry.list();
      } catch (error) {
        log("error", "remote host registry read failed; skipping remote boot", {
          error: String(error),
        });
        return 0;
      }
      if (records.length === 0) return 0;

      let successes = 0;
      // Sequential connects: an early host's failure is logged and skipped
      // rather than aborting the rest. Parallelism buys nothing when each
      // host serves its own set of sessions.
      for (const record of records) {
        try {
          const host = await openHost(record);
          opened.push(host);
          successes += 1;
        } catch (error) {
          log("warn", `remote host ${record.hostKey} failed to open; leaving it disconnected`, {
            error: String(error),
          });
        }
      }
      return successes;
    },
    async closeAll() {
      // Snapshot and clear first so a re-entrant close finds nothing to do.
      const hosts = opened.splice(0, opened.length);
      await Promise.allSettled(hosts.map((host) => closeHost(host)));
    },
    async list() {
      const records = await registry.list();
      return records.map((record) => ({
        hostKey: record.hostKey,
        label: record.label,
        url: record.url,
        connected: isConnected(record.hostKey),
      }));
    },
    async addHost(record) {
      // Persist before opening so a crash between the two leaves a record the
      // next boot can retry; a failed open is surfaced but the row stays.
      await registry.upsert(record);
      // Replace any prior live connection under the same hostKey (a re-pair
      // rotates the device token but the routing key stays stable).
      const existing = opened.findIndex((host) => host.hostKey === record.hostKey);
      if (existing >= 0) {
        const [prior] = opened.splice(existing, 1);
        if (prior) await closeHost(prior);
      }
      try {
        const host = await openHost(record);
        opened.push(host);
        return { hostKey: record.hostKey, label: record.label, url: record.url, connected: true };
      } catch (error) {
        log("warn", `remote host ${record.hostKey} paired but failed to open`, {
          error: String(error),
        });
        return { hostKey: record.hostKey, label: record.label, url: record.url, connected: false };
      }
    },
    async removeHost(hostKey) {
      const index = opened.findIndex((host) => host.hostKey === hostKey);
      if (index >= 0) {
        const [host] = opened.splice(index, 1);
        if (host) await closeHost(host);
      }
      await registry.remove(hostKey);
    },
  };
}
