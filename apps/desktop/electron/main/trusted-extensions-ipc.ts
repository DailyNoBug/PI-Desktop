/**
 * Electron IPC for trusted extensions (spec 07-plugins/16 §10.2).
 *
 * Kept out of `index.ts` so the registry, the picker, and the sidecar hop
 * are one readable unit. Every channel is on the IPC whitelist and none of
 * them is reachable from the MCP control plane.
 */
import { dialog, type BrowserWindow } from "electron";
import {
  ErrorCodes,
  IPC,
  type TrustedExtensionUiPromptResponse,
  type TrustedExtensionsListResult,
} from "@pi-desktop/shared";
import type { TrustedExtensionsRegistry } from "./trusted-extensions.js";

export type TrustedExtensionIpcDeps = {
  handle: (channel: string, fn: (...args: any[]) => Promise<any>) => void;
  registry: TrustedExtensionsRegistry;
  /** Window the native picker attaches to. */
  window: () => BrowserWindow | null;
  /** Project open in front of the user, or null on the empty home. */
  workspaceRoot: () => Promise<string | null>;
  /** Run a registered command in one session's sidecar Runner. */
  runCommand: (input: { sessionId: string; name: string; args: string }) => Promise<{ handled: boolean }>;
};

export function registerTrustedExtensionIpc(deps: TrustedExtensionIpcDeps): void {
  const { handle, registry } = deps;

  handle(IPC.invoke.extensionsList, async (): Promise<TrustedExtensionsListResult> => {
    return registry.list(await deps.workspaceRoot());
  });

  handle(
    IPC.invoke.extensionsSetEnabled,
    async (input: { id?: unknown; enabled?: unknown }) => {
      const id = String(input?.id ?? "").trim();
      if (!id) {
        throw Object.assign(new Error("extension id required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      const entry = registry.setEnabled(id, input?.enabled === true, await deps.workspaceRoot());
      return { entry };
    },
  );

  handle(IPC.invoke.extensionsRescan, async (): Promise<TrustedExtensionsListResult> => {
    return registry.rescan(await deps.workspaceRoot());
  });

  // Main opens the picker and owns the chosen path; the renderer never
  // supplies one (D344).
  handle(IPC.invoke.extensionsAddPath, async () => {
    const window = deps.window();
    const picked = await dialog.showOpenDialog(window ?? undefined!, {
      properties: ["openFile", "openDirectory"],
      filters: [{ name: "Extension", extensions: ["ts", "js", "mjs", "mts"] }],
    });
    const path = picked.canceled ? undefined : picked.filePaths[0];
    if (!path) return { canceled: true };
    return { canceled: false, ...registry.addPath(path) };
  });

  handle(IPC.invoke.extensionsRemove, async (input: { id?: unknown }) => {
    const id = String(input?.id ?? "").trim();
    if (!id) {
      throw Object.assign(new Error("extension id required"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    registry.remove(id);
    return { ok: true };
  });

  handle(
    IPC.invoke.extensionsCommandRun,
    async (input: { sessionId?: unknown; name?: unknown; args?: unknown }) => {
      const sessionId = String(input?.sessionId ?? "").trim();
      const name = String(input?.name ?? "").trim().replace(/^\//, "");
      if (!sessionId || !name) {
        throw Object.assign(new Error("session and command name required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      const result = await deps.runCommand({
        sessionId,
        name,
        args: typeof input?.args === "string" ? input.args : "",
      });
      if (!result.handled) {
        throw Object.assign(new Error(`command "/${name}" is not registered in this session`), {
          errorCode: ErrorCodes.NOT_FOUND,
        });
      }
      return { ok: true };
    },
  );

  handle(IPC.invoke.extensionsUiRespond, async (input: TrustedExtensionUiPromptResponse) => {
    const promptId = String(input?.promptId ?? "").trim();
    const value =
      typeof input?.value === "string" || typeof input?.value === "boolean"
        ? input.value
        : undefined;
    return { ok: registry.respond(promptId, value) };
  });
}
