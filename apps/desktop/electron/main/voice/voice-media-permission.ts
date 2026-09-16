/**
 * Electron media-permission policy for voice dictation (Phase 1).
 *
 * Only the main window's webContents may capture, and only audio: a request
 * from any other frame (plugin panel, work-panel browser view, an attached
 * renderer) is denied, and a request that also asks for camera/video is
 * denied wholesale rather than partially granted. Plugin panels and browser
 * views run on their own session partitions with deny-all handlers; this
 * policy covers the default session the main renderer lives on, so granting
 * microphone there cannot leak into an untrusted surface.
 */
import type { Session, WebContents } from "electron";

export type MediaPermissionRequest = {
  requestingWebContentsId: number;
  mainWebContentsId: number | null;
  permission: string;
  /** Electron reports the capture kinds for `media` requests, when known. */
  mediaTypes?: readonly string[];
};

export type MediaPermissionDecision = "allow" | "deny";

/** Pure decision core — unit-tested without Electron. */
export function decideMediaPermission(
  request: MediaPermissionRequest,
): MediaPermissionDecision {
  if (request.permission !== "media") return "deny";
  if (request.mainWebContentsId === null) return "deny";
  if (request.requestingWebContentsId !== request.mainWebContentsId) return "deny";
  const types = request.mediaTypes;
  // An unspecified capture request is not provably audio-only; deny it.
  if (!types || types.length === 0) return "deny";
  return types.every((type) => type === "audio") ? "allow" : "deny";
}

type PermissionCapableSession = Pick<
  Session,
  "setPermissionRequestHandler" | "setPermissionCheckHandler"
>;

/** Install the policy on the default session (replaces Chromium defaults). */
 /**
  * Install the policy on the default session (replaces Chromium defaults).
  * Electron's check handler reports a singular `mediaType`, so it is lifted
  * into the shared audio-only decision.
  */
 export function installVoiceMediaPermissionPolicy(
   session: PermissionCapableSession,
   getMainWindow: () => { webContents: WebContents } | null,
 ): void {
   const decideFor = (
     contents: { id: number } | null | undefined,
     permission: string,
     mediaTypes: readonly string[] | undefined,
   ) =>
     decideMediaPermission({
       requestingWebContentsId: contents?.id ?? -1,
       mainWebContentsId: getMainWindow()?.webContents?.id ?? null,
       permission,
       mediaTypes,
     });
   session.setPermissionRequestHandler((contents, permission, callback, details) => {
     const mediaTypes = (details as { mediaTypes?: readonly string[] } | undefined)?.mediaTypes;
     callback(decideFor(contents, permission, mediaTypes) === "allow");
   });
   session.setPermissionCheckHandler((contents, permission, _origin, details) => {
     const mediaType = (details as { mediaType?: string } | undefined)?.mediaType;
     return decideFor(contents, permission, mediaType ? [mediaType] : undefined) === "allow";
   });
 }
