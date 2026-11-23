/**
 * Re-export shim: the shared RACP host-operations implementation moved to
 * `@pi-desktop/host-runtime` so the desktop bridge and this app share one
 * implementation. The app keeps importing from this module and layers the
 * pi-host-only workspace tool/file catalogs on top of the shared base.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { RacpError } from "@pi-desktop/agent-host";
import { createHostOperations as createSharedHostOperations, type HostOperationsDeps } from "@pi-desktop/host-runtime";
import type { RacpHostOperations } from "@pi-desktop/racp";

import { createWorkspaceFiles } from "./workspace-files.js";
import { createWorkspacePluginFiles } from "./plugin-workspace-files.js";
import { createWorkspaceTools } from "./workspace-tools.js";

export {
  createProjectCatalog,
  createSessionCatalog,
  createWorkspaceAccess,
  type HostOperationsDeps,
} from "@pi-desktop/host-runtime";

export function createHostOperations(deps: HostOperationsDeps): Omit<RacpHostOperations, "terminal"> {
  return {
    ...createSharedHostOperations(deps),
    workspaceTools: createWorkspaceTools(deps.getHost),
    workspaceFiles: createWorkspaceFiles(),
    workspacePluginFiles: createWorkspacePluginFiles({
      browseRoot: deps.browseRoot ?? homedir(),
      protectedPaths: [deps.dataDir ?? join(homedir(), ".pi-desktop")],
      isRegisteredRoot: async (root) => {
        const host = deps.getHost();
        if (!host) throw new RacpError("AGENT_UNAVAILABLE", "host-core is not running", { retriable: true });
        const result = await host
          .call<{ projects: Array<{ path: string }> }>("projects.list", {})
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            throw new RacpError("INTERNAL", message);
          });
        return (result.projects ?? []).some((project) => project.path === root);
      },
    }),
  };
}
