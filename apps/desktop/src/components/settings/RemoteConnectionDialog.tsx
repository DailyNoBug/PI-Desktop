import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteConnectionAuthMethod, RemoteConnectionInput } from "@pi-desktop/shared";
import { parseSshHostTarget } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button, Input, cx } from "../ui";
import { IconFolderOpen, IconServer, IconX } from "../icons";

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
};

export function RemoteConnectionDialog({ open, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [mode, setMode] = useState<"discover" | "manual">("discover");
  const [aliases, setAliases] = useState<string[] | null>(null);
  const [selectedAlias, setSelectedAlias] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [target, setTarget] = useState("");
  const [port, setPort] = useState("");
  const [authMethod, setAuthMethod] = useState<RemoteConnectionAuthMethod>("agent");
  const [identityFilePath, setIdentityFilePath] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode("discover");
    setAliases(null);
    setSelectedAlias(null);
    setDisplayName("");
    setTarget("");
    setPort("");
    setAuthMethod("agent");
    setIdentityFilePath("");
    setPassword("");
    void api.discoverRemoteSshHosts()
      .then((result) => setAliases(result.aliases))
      .catch((error) => {
        setAliases([]);
        showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
      });
  }, [open, showToast]);

  const selectIdentityFile = async () => {
    const path = await api.selectRemoteIdentityFile();
    if (path) setIdentityFilePath(path);
  };

  const save = async () => {
    setSaving(true);
    try {
      let input: RemoteConnectionInput;
      if (mode === "discover") {
        if (!selectedAlias) return;
        input = {
          displayName: selectedAlias,
          source: "ssh-config",
          sshConfigAlias: selectedAlias,
          enabled: true,
        };
      } else {
        const parsed = parseSshHostTarget(target);
        if (!parsed) return;
        const parsedPort = port.trim() ? Number(port) : undefined;
        input = {
          displayName: displayName.trim() || parsed.hostname,
          source: "managed",
          hostname: parsed.hostname,
          ...(parsed.user ? { user: parsed.user } : {}),
          ...(parsedPort !== undefined ? { port: parsedPort } : {}),
          authMethod,
          ...(authMethod === "identity" && identityFilePath ? { identityFilePath } : {}),
          ...(authMethod === "password" && password ? { password } : {}),
          enabled: true,
        };
      }
      await api.addRemoteConnection(input);
      await onSaved();
      onClose();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const manualReady = Boolean(parseSshHostTarget(target)) &&
    (authMethod !== "identity" || identityFilePath.trim()) &&
    (authMethod !== "password" || password);

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="settings-panel remote-connection-dialog" role="dialog" aria-modal="true" aria-labelledby="remote-connection-title">
        <header className="remote-project-header">
          <h2 id="remote-connection-title">{t("remote.addConnection")}</h2>
          <Button variant="secondary" disabled={saving} onClick={onClose} aria-label={t("common.close")}>
            <IconX size={14} />
          </Button>
        </header>

        {mode === "discover" ? (
          <>
            <div className="remote-discovered-list" role="radiogroup" aria-label={t("remote.sourceConfig")}>
              {aliases === null ? (
                <div className="remote-discovered-empty">{t("common.loading")}</div>
              ) : aliases.length === 0 ? (
                <div className="remote-discovered-empty">{t("remote.noConnections")}</div>
              ) : aliases.map((alias) => (
                <button
                  key={alias}
                  type="button"
                  role="radio"
                  aria-checked={selectedAlias === alias}
                  className={cx("remote-discovered-row", selectedAlias === alias && "selected")}
                  onClick={() => setSelectedAlias(alias)}
                >
                  <span className="remote-discovered-glyph" aria-hidden><IconServer size={15} /></span>
                  <span className="remote-discovered-copy">
                    <strong>{alias}</strong>
                    <span>{t("remote.sourceConfig")}</span>
                  </span>
                  <span className="remote-discovered-check" aria-hidden />
                </button>
              ))}
            </div>
            <footer className="remote-connection-footer">
              <Button variant="secondary" onClick={() => setMode("manual")}>
                {t("remote.manualAdd")}
              </Button>
              <Button variant="primary" disabled={!selectedAlias || saving} onClick={() => void save()}>
                {t("remote.add")}
              </Button>
            </footer>
          </>
        ) : (
          <>
            <div className="remote-manual-form">
              <label>
                <span>{t("remote.name")}</span>
                <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
              </label>
              <label>
                <span>{t("remote.hostname")}</span>
                <Input
                  value={target}
                  placeholder={t("remote.hostPlaceholder")}
                  aria-required
                  onChange={(event) => setTarget(event.target.value)}
                />
              </label>
              <label>
                <span>{t("remote.port")}</span>
                <Input type="number" min={1} max={65535} value={port} onChange={(event) => setPort(event.target.value)} />
              </label>
              <div className="remote-auth-field">
                <span className="remote-auth-label">{t("remote.authentication")}</span>
                <div className="settings-segment remote-auth-segment" role="radiogroup" aria-label={t("remote.authentication")}>
                  {(["agent", "password", "identity"] as const).map((method) => (
                    <button
                      key={method}
                      type="button"
                      role="radio"
                      aria-checked={authMethod === method}
                      className={cx("settings-segment-item", authMethod === method && "active")}
                      onClick={() => {
                        setPassword((current) => method === "password" ? current : "");
                        setAuthMethod(method);
                        if (method !== "identity") setIdentityFilePath("");
                      }}
                    >
                      {t(`remote.auth.${method}`)}
                    </button>
                  ))}
                </div>
                {authMethod === "password" ? (
                  <label>
                    <span>{t("remote.password")}</span>
                    <Input
                      type="password"
                      value={password}
                      autoComplete="new-password"
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </label>
                ) : null}
                {authMethod === "identity" ? (
                  <label>
                    <span>{t("remote.identityFile")}</span>
                    <span className="remote-identity-row">
                      <Input value={identityFilePath} aria-required onChange={(event) => setIdentityFilePath(event.target.value)} />
                      <Button variant="secondary" onClick={() => void selectIdentityFile().catch(() => undefined)}>
                        <IconFolderOpen size={14} />
                        {t("remote.chooseFile")}
                      </Button>
                    </span>
                  </label>
                ) : null}
              </div>
            </div>
            <footer className="remote-connection-footer">
              <Button variant="secondary" onClick={() => setMode("discover")}>
                {t("remote.discoverAdd")}
              </Button>
              <Button variant="primary" disabled={!manualReady || saving} onClick={() => void save()}>
                {t("common.save")}
              </Button>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
