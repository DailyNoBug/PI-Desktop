/**
 * Re-export shim: the file-backed device credential store moved to
 * `@pi-desktop/host-runtime` so the desktop bridge and this app share one
 * implementation. The app keeps importing from this module.
 */
export { FileCredentialStore, loadOrCreateHostId } from "@pi-desktop/host-runtime";
