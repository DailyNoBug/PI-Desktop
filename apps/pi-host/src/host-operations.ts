/**
 * Re-export shim: the RACP host-operations implementation moved to
 * `@pi-desktop/host-runtime` so the desktop bridge and this app share one
 * implementation. The app keeps importing from this module.
 */
export {
  createHostOperations,
  createProjectCatalog,
  createSessionCatalog,
  createWorkspaceAccess,
  type HostOperationsDeps,
} from "@pi-desktop/host-runtime";
