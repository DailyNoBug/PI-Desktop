/**
 * Renderer IPC for the R2b pairing UX (ADR 0286 §Registry).
 *
 * Three channels sit between the renderer's Settings page and the remote-hosts
 * boot hook: `list` reports the currently paired hosts with their live status,
 * `pair` exchanges a `ppt1.` pairing token for a durable device token and
 * brings the connection online, and `remove` closes and forgets one host.
 *
 * The renderer never sees a device token: the pairing exchange, the encrypted
 * write to `<dataDir>/remote-hosts.json`, and every subsequent live connection
 * live inside Electron main. `list` is safe to expose to any renderer surface.
 */
import { wsClientTransport } from "@pi-desktop/racp";
import {
  ErrorCodes,
  IPC,
  type RemoteHostPairRequest,
  type RemoteHostPairResult,
  type RemoteHostRemoveRequest,
  type RemoteHostSummary,
} from "@pi-desktop/shared";
import { app } from "electron";
import {
  getActiveRemoteHostsBoot,
  type RemoteHostsBoot,
} from "../bootstrap/remote-hosts";
import { createRacpRemoteHostClient } from "../remote/racp-remote-host-client";
import type { IpcRegistrar } from "./types";

export type RegisterRemoteHostIpcOptions = {
  registrar: IpcRegistrar;
  /**
   * Optional overrides for tests. Production reads the boot singleton set by
   * `bootstrap/startup.ts` (so no new field flows through `index.ts`) and
   * derives `clientInfo` from Electron's app name/version.
   */
  getRemoteHostsBoot?: () => RemoteHostsBoot | null;
  clientInfo?: { name: string; version: string };
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
};

function requireBoot(boot: RemoteHostsBoot | null): RemoteHostsBoot {
  if (!boot) {
    throw Object.assign(new Error("remote hosts are not ready yet"), {
      errorCode: ErrorCodes.AGENT_UNAVAILABLE,
    });
  }
  return boot;
}

function trim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Derive a routing key from a URL and a label when the renderer did not
 * supply one. The URL's hostname keeps the key readable in logs; the label's
 * ASCII-safe slug disambiguates two hosts on the same machine (e.g., a WSL
 * and a native install of `pi-host` on `localhost`).
 */
function synthesizeHostKey(url: string, label: string): string {
  let hostname = "host";
  try {
    hostname = new URL(url).hostname || hostname;
  } catch {
    /* keep the fallback */
  }
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug ? `${hostname}-${slug}` : hostname;
}

export function registerRemoteHostIpc(options: RegisterRemoteHostIpcOptions): void {
  const { registrar } = options;
  const getRemoteHostsBoot = options.getRemoteHostsBoot ?? getActiveRemoteHostsBoot;
  const clientInfo =
    options.clientInfo ?? { name: app.getName(), version: app.getVersion() };
  const log = options.log ?? (() => undefined);

  registrar.handle(
    IPC.invoke.remoteHostList,
    async (): Promise<{ hosts: RemoteHostSummary[] }> => {
      const boot = requireBoot(getRemoteHostsBoot());
      return { hosts: await boot.list() };
    },
  );

  registrar.handle(
    IPC.invoke.remoteHostPair,
    async (request: RemoteHostPairRequest): Promise<RemoteHostPairResult> => {
      const boot = requireBoot(getRemoteHostsBoot());
      const url = trim(request?.url);
      const pairingToken = trim(request?.pairingToken);
      const label = trim(request?.label) || "desktop";
      if (!url || !pairingToken) {
        throw Object.assign(new Error("url and pairingToken are required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      const hostKey = trim(request?.hostKey) || synthesizeHostKey(url, label);
      if (hostKey.includes(":")) {
        throw Object.assign(new Error("hostKey must not contain ':'"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }

      // Pair on a throwaway connection whose transport authenticates with the
      // single-use pairing token; call `connection/pair` for the device token,
      // then close it. The durable connection reopens under the device token
      // via `boot.addHost` below.
      const pairing = createRacpRemoteHostClient({
        transport: wsClientTransport({ url, token: pairingToken }),
        clientInfo,
        log: (level, message, data) => log(level, message, data),
      });
      let deviceToken: string;
      try {
        await pairing.connect();
        const result = (await pairing.client.request("connection/pair", {
          deviceLabel: label,
        })) as { deviceToken?: unknown };
        if (typeof result?.deviceToken !== "string" || result.deviceToken.length === 0) {
          throw Object.assign(new Error("pi-host did not return a device token"), {
            errorCode: "PAIRING_FAILED",
          });
        }
        deviceToken = result.deviceToken;
      } finally {
        await pairing.close().catch(() => undefined);
      }

      const summary = await boot.addHost({ hostKey, label, url, deviceToken });
      return { host: summary };
    },
  );

  registrar.handle(
    IPC.invoke.remoteHostRemove,
    async (request: RemoteHostRemoveRequest): Promise<{ ok: true }> => {
      const boot = requireBoot(getRemoteHostsBoot());
      const hostKey = trim(request?.hostKey);
      if (!hostKey) {
        throw Object.assign(new Error("hostKey is required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      await boot.removeHost(hostKey);
      return { ok: true };
    },
  );
}
