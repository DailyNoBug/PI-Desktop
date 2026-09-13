export type PiDesktopDeepLink =
  | {
      kind: "add-ssh-connection";
      name: string;
      alias?: string;
      hostname?: string;
      user?: string;
      port?: number;
      identityFilePath?: string;
    }
  | {
      kind: "open-remote-project";
      connectionKey: string;
      remotePath: string;
    };

function text(url: URL, key: string, max = 200): string | undefined {
  const value = url.searchParams.get(key)?.trim();
  return value ? value.slice(0, max) : undefined;
}

export function parsePiDesktopDeepLink(input: string): PiDesktopDeepLink | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "pi-desktop:") return null;
  if (url.hostname === "connections" && url.pathname === "/ssh/add") {
    const alias = text(url, "alias", 80);
    const hostname = text(url, "hostname", 255);
    const portValue = text(url, "port", 5);
    const port = portValue === undefined ? undefined : Number(portValue);
    if ((!alias && !hostname) || alias?.includes(" ")) return null;
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      return null;
    }
    return {
      kind: "add-ssh-connection",
      name: text(url, "name", 80) ?? alias ?? hostname!,
      ...(alias ? { alias } : {}),
      ...(hostname ? { hostname } : {}),
      ...(text(url, "user", 80) ? { user: text(url, "user", 80) } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(text(url, "identityFile", 1024)
        ? { identityFilePath: text(url, "identityFile", 1024) }
        : {}),
    };
  }
  if (url.hostname === "projects" && url.pathname === "/remote/open") {
    const connectionKey = text(url, "connection", 255);
    const remotePath = text(url, "path", 4096);
    if (
      !remotePath ||
      !remotePath.startsWith("/") ||
      remotePath.includes("\0") ||
      remotePath.split("/").some((segment) => segment === "." || segment === "..")
    ) {
      return null;
    }
    if (!connectionKey || /\s/.test(connectionKey) || connectionKey === "*") {
      return null;
    }
    return { kind: "open-remote-project", connectionKey, remotePath };
  }
  return null;
}
