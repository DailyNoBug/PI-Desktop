import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteConnectionView } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../ui";
import { IconPlus, IconServer } from "../icons";
import { RemoteConnectionDialog } from "./RemoteConnectionDialog";

function stateLabel(state: RemoteConnectionView["state"]): string {
  return `remote.state.${state}`;
}

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

  return (
    <div className="settings-stack">
      <section className="settings-card-block">
        <h3 className="settings-card-heading">{t("remote.connections")}</h3>
        <div className="settings-panel remote-connections">
          {connections === null ? (
            <div className="settings-empty">{t("common.loading")}</div>
          ) : sorted.length > 0 ? (
            <>
              <div className="remote-page-actions">
                <Button variant="primary" onClick={() => setAddOpen(true)}>
                  <IconPlus size={14} />
                  {t("remote.addConnection")}
                </Button>
              </div>
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
                      </span>
                      {connection.lastError ? (
                        <span className="remote-error">{connection.lastError.code}: {connection.lastError.message}</span>
                      ) : null}
                    </div>
                    {connection.state === "connected" ? (
                      <Button
                        variant="secondary"
                        disabled={busyId === connection.id}
                        onClick={() => void action(connection.id, () => api.disconnectRemote(connection.id))}
                      >
                        {t("remote.disconnect")}
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
                  </article>
                ))}
              </div>
            </>
          ) : (
            <div className="remote-empty-card">
              <span className="remote-empty-glyph" aria-hidden>
                <IconServer size={24} />
              </span>
              <p>{t("remote.connectRemoteDevice")}</p>
              <Button variant="primary" onClick={() => setAddOpen(true)}>
                <IconPlus size={14} />
                {t("remote.add")}
              </Button>
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
