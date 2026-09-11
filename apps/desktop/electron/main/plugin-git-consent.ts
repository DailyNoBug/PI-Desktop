import { type BrowserWindow, type MessageBoxOptions, dialog } from "electron";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import type { PluginGitConsentRequest } from "./plugin-runtime";

/**
 * Native consent for destructive or branch-switching Git operations. The
 * operation facts come from the host broker, not from plugin-authored text.
 */
export function gitConsentDialogOptions(
  request: PluginGitConsentRequest,
  locale: string,
): MessageBoxOptions {
  const strings = catalogs[resolveLocale(locale)].pluginGitConsent;
  const message =
    request.operation === "discard"
      ? strings.discardMessage
      : request.operation === "switch"
        ? strings.switchMessage
        : strings.createMessage;
  const branch = request.branch ?? "";
  return {
    type: "warning",
    message: message
      .replace("{name}", request.pluginName)
      .replace("{count}", String(Math.max(0, request.pathCount ?? 0)))
      .replace("{branch}", branch),
    detail: strings[request.operation]
      .replace("{count}", String(Math.max(0, request.pathCount ?? 0)))
      .replace("{branch}", branch),
    buttons: [strings.deny, strings.allowOnce],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

/** Anything other than the explicit Allow button refuses the operation. */
export function gitConsentGrantedFromResponse(response: number): boolean {
  return response === 1;
}

export function createGitConsentService(deps: {
  getWindow: () => BrowserWindow | null;
  getLocale: () => string;
}): (request: PluginGitConsentRequest) => Promise<boolean> {
  return async (request) => {
    const options = gitConsentDialogOptions(request, deps.getLocale());
    const window = deps.getWindow();
    const result =
      window && !window.isDestroyed()
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options);
    return gitConsentGrantedFromResponse(result.response);
  };
}
