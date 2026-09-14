import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteConnectionState, RemoteConnectionView } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../ui";
import { IconPlus, IconServer, IconTrash } from "../icons";
import { RemoteConnectionDialog } from "./RemoteConnectionDialog";

function stateLabel(state: RemoteConnectionView["state"]): string {
  return `remote.state.${state}`;
}

/** Stages with an attempt in flight; the row offers cancel instead of connect. */
const CONNECTING_STATES = new Set<RemoteConnectionState>([
  "resolving",
  "connecting",
  "authenticating",
  "bootstrapping",
  "starting_host",
  "forwarding",
  "handshaking",
  "reconnecting",
]);

export function ConnectionsSection() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [connections, setConnections] = useState<RemoteConnectionView[] | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    const remote = await api.listRemoteConnections();
    setConnections(remote.connections);
  };

  useEffect(() => {
    void load().catch(() => setConnections([]));
    return api.onRemoteChanged(() => {
      void load().catch(() => undefined);
    });
  }, []);

  const sorted = useMemo(
    () => (connections ?? []).slice().sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [connections],
  );

  const action = async (id: string, operation: () => Promise<unknown>) => {
    setBusyId(id);
    try {
      await operation();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const removeConnection = (connection: RemoteConnectionView) => {
    if (!window.confirm(t("remote.removeConfirm", { name: connection.displayName }))) return;
    void action(connection.id, () => api.removeRemoteConnection(connection.id));
  };

  return (
    <div className="settings-stack">
      <section className="settings-card-block">
        <div className="remote-heading-row">
          <h2 className="remote-section-heading">{t("remote.connectRemoteDevice")}</h2>
          <Button variant="primary" onClick={() => setAddOpen(true)}>
            <IconPlus size={14} />
            {t("remote.addConnection")}
          </Button>
        </div>
        <div className="settings-panel remote-connections">
          {connections === null ? (
            <div className="settings-empty">{t("common.loading")}</div>
          ) : sorted.length > 0 ? (
            <div className="remote-connection-list" role="list">
              {sorted.map((connection) => (
                <article className="remote-connection-row" role="listitem" key={connection.id}>
                  <span className="remote-connection-glyph" aria-hidden>
                    <IconServer size={15} />
                  </span>
                  <div className="remote-connection-copy">
                    <strong>{connection.displayName}</strong>
                    <span>
                      {connection.sshConfigAlias ??
                        [connection.user, connection.hostname].filter(Boolean).join("@")}
                      {connection.port && connection.port !== 22 ? `:${connection.port}` : ""}
                    </span>
                    <span>
                      {t(connection.source === "ssh-config" ? "remote.sourceConfig" : "remote.sourceManaged")}
                      {" · "}
                      {t(stateLabel(connection.state))}
                      {connection.reconnectAttempt ? ` · ${t("remote.attempt", { count: connection.reconnectAttempt })}` : ""}
                      {connection.sshOnly ? ` · ${t("remote.sshOnly")}` : ""}
                    </span>
                    {connection.lastError ? (
                      <span className="remote-error">{connection.lastError.code}: {connection.lastError.message}</span>
                    ) : null}
                  </div>
                  <div className="remote-connection-actions">
                    {connection.state === "connected" ? (
                      <Button
                        variant="secondary"
                        disabled={busyId === connection.id}
                        onClick={() => void action(connection.id, () => api.disconnectRemote(connection.id))}
                      >
                        {t("remote.disconnect")}
                      </Button>
                    ) : CONNECTING_STATES.has(connection.state) ? (
                      <Button
                        variant="secondary"
                        onClick={() => void action(connection.id, () => api.disconnectRemote(connection.id))}
                      >
                        {t("remote.cancelConnect")}
                      </Button>
                    ) : (
                      <Button
                        variant="primary"
                        disabled={busyId === connection.id}
                        onClick={() => void action(connection.id, () => api.connectRemote(connection.id))}
                      >
                        {t("remote.connect")}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      className="remote-connection-remove"
                      aria-label={t("remote.remove")}
                      title={t("remote.remove")}
                      onClick={() => removeConnection(connection)}
                    >
                      <IconTrash size={14} />
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="remote-empty-card">
              <span className="remote-empty-glyph" aria-hidden>
                <IconServer size={24} />
              </span>
              <p>{t("remote.noConnections")}</p>
            </div>
          )}
        </div>
      </section>

      <RemoteConnectionDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSaved={() => load()}
      />
    </div>
  );
}
