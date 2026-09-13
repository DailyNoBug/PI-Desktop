import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProviderPublic, RemoteConnectionInput, RemoteConnectionView } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button, Input, Select, Textarea, TooltipButton, cx } from "../ui";
import { IconClipboard, IconDownload, IconFolderOpen, IconPencil, IconPlug, IconPlus, IconRefresh, IconServer, IconShield, IconX } from "../icons";
import { RemoteProjectDialog } from "./RemoteProjectDialog";
import { RemoteRelayToolsDialog } from "./RemoteRelayToolsDialog";

const emptyForm: RemoteConnectionInput = {
  displayName: "",
  source: "managed",
  hostname: "",
  user: "",
  port: 22,
  authMethod: "agent",
  identityFilePath: "",
  enabled: true,
};

function stateLabel(state: RemoteConnectionView["state"]): string {
  return `remote.state.${state}`;
}

export function ConnectionsSection() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [connections, setConnections] = useState<RemoteConnectionView[] | null>(null);
  const [providers, setProviders] = useState<ProviderPublic[]>([]);
  const [form, setForm] = useState<RemoteConnectionInput>(emptyForm);
  const [password, setPassword] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [providerByConnection, setProviderByConnection] = useState<Record<string, string>>({});
  const [projectConnectionId, setProjectConnectionId] = useState<string | undefined>();
  const [projectOpen, setProjectOpen] = useState(false);
  const [relayConnectionId, setRelayConnectionId] = useState<string | undefined>();
  const [relayOpen, setRelayOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");

  const load = async () => {
    const [remote, providerResult] = await Promise.all([
      api.listRemoteConnections(),
      api.listProviders().catch(() => ({ providers: [] as ProviderPublic[] })),
    ]);
    setConnections(remote.connections);
    setProviders(providerResult.providers.filter((provider) => provider.enabled));
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

  const submit = async () => {
    const requiresNewPassword = form.authMethod === "password" && !editingId;
    if (requiresNewPassword && !password) return;
    try {
      const input: RemoteConnectionInput = {
        ...form,
        ...(form.authMethod === "password" && password ? { password } : {}),
      };
      if (editingId) await api.updateRemoteConnection(editingId, input);
      else await api.addRemoteConnection(input);
      setForm(emptyForm);
      setPassword("");
      setEditingId(null);
      await load();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    }
  };

  const action = async (id: string, operation: () => Promise<unknown>, successMessage?: string) => {
    setBusyId(id);
    try {
      await operation();
      if (successMessage) showToast(successMessage, { variant: "success" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const edit = (connection: RemoteConnectionView) => {
    setEditingId(connection.id);
    setForm({
      displayName: connection.displayName,
      source: connection.source,
      ...(connection.sshConfigAlias ? { sshConfigAlias: connection.sshConfigAlias } : {}),
      ...(connection.hostname ? { hostname: connection.hostname } : {}),
      ...(connection.user ? { user: connection.user } : {}),
      ...(connection.port ? { port: connection.port } : {}),
      authMethod: connection.authMethod ?? (connection.identityFilePath ? "identity" : "agent"),
      ...(connection.identityFilePath ? { identityFilePath: connection.identityFilePath } : {}),
      enabled: connection.enabled,
    });
    setPassword("");
  };

  const selectIdentityFile = async () => {
    const path = await api.selectRemoteIdentityFile();
    if (path) setForm((current) => ({ ...current, identityFilePath: path }));
  };

  const copyDiagnostics = async (id: string) => {
    const diagnostics = await api.remoteDiagnostics(id);
    await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
  };

  const exportConnections = async () => {
    const result = await api.exportRemoteConnections();
    await navigator.clipboard.writeText(result.export);
    showToast(t("remote.connectionsCopied"), { variant: "success" });
  };

  const importConnections = async () => {
    if (!importText.trim()) return;
    const result = await api.importRemoteConnections(importText);
    setImportOpen(false);
    setImportText("");
    await load();
    showToast(t("remote.connectionsImported", result), { variant: "success" });
  };

  return (
    <div className="settings-stack">
      <section className="settings-card-block">
        <h3 className="settings-card-heading">{t("remote.connections")}</h3>
        <div className="settings-panel remote-connections">
          <div className="remote-toolbar">
            <Button variant="secondary" onClick={() => void api.refreshRemoteConnections().then(() => load()).catch(() => undefined)}>
              <IconRefresh size={14} />
              {t("remote.refresh")}
            </Button>
            <Button variant="secondary" onClick={() => void exportConnections().catch((error) => {
              showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
            })}>
              <IconDownload size={14} />
              {t("remote.export")}
            </Button>
            <Button variant="secondary" onClick={() => setImportOpen((open) => !open)}>
              <IconPlus size={14} />
              {t("remote.import")}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setProjectConnectionId(undefined);
                setProjectOpen(true);
              }}
            >
              <IconFolderOpen size={14} />
              {t("remote.openProject")}
            </Button>
          </div>

          {connections === null ? (
            <div className="settings-empty">{t("common.loading")}</div>
          ) : sorted.length === 0 ? (
            <div className="settings-empty">{t("remote.noConnections")}</div>
          ) : (
            <div className="remote-connection-list" role="list">
              {sorted.map((connection) => (
                <article className="remote-connection-row" role="listitem" key={connection.id}>
                  <span className="remote-connection-glyph" aria-hidden>
                    <IconServer size={15} />
                  </span>
                  <div className="remote-connection-copy">
                    <strong>{connection.displayName}</strong>
                    <span>
                      {connection.sshConfigAlias ?? [connection.user, connection.hostname].filter(Boolean).join("@")}
                      {connection.port && connection.port !== 22 ? `:${connection.port}` : ""}
                    </span>
                    <span>
                      {t(connection.source === "ssh-config" ? "remote.sourceConfig" : "remote.sourceManaged")}
                      {" · "}
                      {t(stateLabel(connection.state))}
                      {connection.reconnectAttempt ? ` · ${t("remote.attempt", { count: connection.reconnectAttempt })}` : ""}
                    </span>
                    {connection.host ? (
                      <span>{t("remote.hostVersion", { version: connection.host.hostVersion ?? "?" })}</span>
                    ) : null}
                    {connection.lastError ? (
                      <span className="remote-error">{connection.lastError.code}: {connection.lastError.message}</span>
                    ) : null}
                  </div>
                  <div className="remote-connection-actions">
                    <label className="remote-provider">
                      <span>{t("remote.providerDestination", { connection: connection.displayName })}</span>
                      <Select
                        className="remote-provider-select"
                        value={providerByConnection[connection.id] ?? providers[0]?.id ?? ""}
                        aria-label={t("remote.provider")}
                        onChange={(event) => setProviderByConnection((current) => ({
                          ...current,
                          [connection.id]: event.target.value,
                        }))}
                      >
                        {providers.map((provider) => (
                          <option key={provider.id} value={provider.id}>{provider.name}</option>
                        ))}
                      </Select>
                    </label>
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
                    <TooltipButton
                      tooltip={t("remote.test")}
                      ariaLabel={t("remote.test")}
                      className="icon-button"
                      disabled={busyId === connection.id}
                      onClick={() => void action(connection.id, () => api.testRemoteConnection(connection.id))}
                    >
                      <IconRefresh size={14} />
                    </TooltipButton>
                    <TooltipButton
                      tooltip={t("remote.upgradeHost")}
                      ariaLabel={t("remote.upgradeHost")}
                      className="icon-button"
                      disabled={busyId === connection.id}
                      onClick={() => void action(connection.id, () => api.upgradeRemoteHost(connection.id))}
                    >
                      <IconDownload size={14} />
                    </TooltipButton>
                    <TooltipButton
                      tooltip={t("remote.syncProvider")}
                      ariaLabel={t("remote.syncProvider")}
                      className="icon-button"
                      disabled={busyId === connection.id || providers.length === 0}
                      onClick={() => void action(connection.id, () => api.importRemoteProvider(
                        connection.id,
                        providerByConnection[connection.id] ?? providers[0]!.id,
                      ))}
                    >
                      <IconServer size={14} />
                    </TooltipButton>
                    <TooltipButton
                      tooltip={t("remote.deleteProvider")}
                      ariaLabel={t("remote.deleteProvider")}
                      className="icon-button danger"
                      disabled={busyId === connection.id || providers.length === 0}
                      onClick={() => void action(connection.id, () => api.deleteRemoteProvider(
                        connection.id,
                        providerByConnection[connection.id] ?? providers[0]!.id,
                      ))}
                    >
                      <IconX size={14} />
                    </TooltipButton>
                    <TooltipButton
                      tooltip={t("remote.copyDiagnostics")}
                      ariaLabel={t("remote.copyDiagnostics")}
                      className="icon-button"
                      onClick={() => void action(connection.id, () => copyDiagnostics(connection.id))}
                    >
                      <IconClipboard size={14} />
                    </TooltipButton>
                    <TooltipButton
                      tooltip={t("remote.openProject")}
                      ariaLabel={t("remote.openProject")}
                      className="icon-button"
                      onClick={() => {
                        setProjectConnectionId(connection.id);
                        setProjectOpen(true);
                      }}
                    >
                      <IconFolderOpen size={14} />
                    </TooltipButton>
                    <TooltipButton
                      tooltip={t("remote.relayTools")}
                      ariaLabel={t("remote.relayTools")}
                      className="icon-button"
                      onClick={() => {
                        setRelayConnectionId(connection.id);
                        setRelayOpen(true);
                      }}
                    >
                      <IconPlug size={14} />
                    </TooltipButton>
                    <TooltipButton
                      tooltip={t("remote.edit")}
                      ariaLabel={t("remote.edit")}
                      className="icon-button"
                      onClick={() => edit(connection)}
                    >
                      <IconPencil size={14} />
                    </TooltipButton>
                    <TooltipButton
                      tooltip={t("remote.revokeDevice")}
                      ariaLabel={t("remote.revokeDevice")}
                      className="icon-button danger"
                      disabled={busyId === connection.id}
                      onClick={() => void action(
                        connection.id,
                        () => api.revokeRemoteDevice(connection.id),
                        t("remote.deviceRevoked"),
                      )}
                    >
                      <IconShield size={14} />
                    </TooltipButton>
                    <TooltipButton
                      tooltip={t("remote.remove")}
                      ariaLabel={t("remote.remove")}
                      className="icon-button danger"
                      disabled={busyId === connection.id}
                      onClick={() => void action(connection.id, () => api.removeRemoteConnection(connection.id))}
                    >
                      <IconX size={14} />
                    </TooltipButton>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
        {importOpen ? (
          <div className="remote-import">
            <Textarea
              value={importText}
              placeholder={t("remote.importPlaceholder")}
              aria-label={t("remote.import")}
              onChange={(event) => setImportText(event.target.value)}
            />
            <div className="settings-panel-actions">
              <Button variant="primary" disabled={!importText.trim()} onClick={() => void importConnections().catch((error) => {
                showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
              })}>
                <IconPlus size={14} />
                {t("remote.import")}
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="settings-card-block">
        <h3 className="settings-card-heading">{editingId ? t("remote.editConnection") : t("remote.addConnection")}</h3>
        <div className="settings-panel remote-form">
          <div className="settings-segment" role="radiogroup" aria-label={t("remote.source")}>
            {(["ssh-config", "managed"] as const).map((source) => (
              <button
                key={source}
                type="button"
                role="radio"
                aria-checked={form.source === source}
                className={cx("settings-segment-item", form.source === source && "active")}
                onClick={() => setForm((current) => ({
                  ...current,
                  source,
                  ...(source === "ssh-config" ? { authMethod: "agent" as const, identityFilePath: "" } : {}),
                }))}
              >
                {t(source === "ssh-config" ? "remote.sourceConfig" : "remote.sourceManaged")}
              </button>
            ))}
          </div>
          <div className="remote-form-grid">
            <label>
              <span>{t("remote.name")}</span>
              <Input value={form.displayName} onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))} />
            </label>
            <label>
              <span>{t("remote.alias")}</span>
              <Input
                value={form.sshConfigAlias ?? ""}
                aria-required={form.source === "ssh-config"}
                onChange={(event) => setForm((current) => ({ ...current, sshConfigAlias: event.target.value }))}
              />
            </label>
            {form.source === "managed" ? (
              <>
                <label>
                  <span>{t("remote.hostname")}</span>
                  <Input value={form.hostname ?? ""} onChange={(event) => setForm((current) => ({ ...current, hostname: event.target.value }))} />
                </label>
                <label>
                  <span>{t("remote.user")}</span>
                  <Input value={form.user ?? ""} onChange={(event) => setForm((current) => ({ ...current, user: event.target.value }))} />
                </label>
                <label>
                  <span>{t("remote.port")}</span>
                  <Input type="number" min={1} max={65535} value={form.port ?? 22} onChange={(event) => setForm((current) => ({ ...current, port: Number(event.target.value) }))} />
                </label>
              </>
            ) : null}
          </div>
          {form.source === "managed" ? (
            <div className="remote-auth-field">
              <span className="remote-auth-label">{t("remote.authentication")}</span>
              <div className="settings-segment remote-auth-segment" role="radiogroup" aria-label={t("remote.authentication")}>
                {(["agent", "password", "identity"] as const).map((method) => (
                  <button
                    key={method}
                    type="button"
                    role="radio"
                    aria-checked={form.authMethod === method}
                    className={cx("settings-segment-item", form.authMethod === method && "active")}
                    onClick={() => {
                      setPassword((current) => method === "password" ? current : "");
                      setForm((current) => ({
                        ...current,
                        authMethod: method,
                        ...(method === "identity" ? {} : { identityFilePath: "" }),
                      }));
                    }}
                  >
                    {t(`remote.auth.${method}`)}
                  </button>
                ))}
              </div>
              {form.authMethod === "password" ? (
                <label>
                  <span>{t("remote.password")}</span>
                  <Input
                    type="password"
                    value={password}
                    autoComplete="new-password"
                    placeholder={editingId ? t("remote.savedPassword") : undefined}
                    aria-required={!editingId}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
              ) : null}
              {form.authMethod === "identity" ? (
                <label>
                  <span>{t("remote.identityFile")}</span>
                  <span className="remote-identity-row">
                    <Input
                      value={form.identityFilePath ?? ""}
                      aria-required
                      onChange={(event) => setForm((current) => ({ ...current, identityFilePath: event.target.value }))}
                    />
                    <Button variant="secondary" onClick={() => void selectIdentityFile().catch(() => undefined)}>
                      <IconFolderOpen size={14} />
                      {t("remote.chooseFile")}
                    </Button>
                  </span>
                </label>
              ) : null}
            </div>
          ) : null}
          <div className="settings-panel-actions">
            <Button
              variant="primary"
              disabled={
                !form.displayName.trim() ||
                (form.source === "ssh-config" ? !form.sshConfigAlias?.trim() : !form.hostname?.trim()) ||
                (form.source === "managed" && form.authMethod === "identity" && !form.identityFilePath?.trim()) ||
                (form.source === "managed" && form.authMethod === "password" && !editingId && !password)
              }
              onClick={() => void submit()}
            >
              <IconPlus size={14} />
              {editingId ? t("common.save") : t("remote.add")}
            </Button>
            {editingId ? (
              <Button variant="secondary" onClick={() => {
                setEditingId(null);
                setForm(emptyForm);
                setPassword("");
              }}>
                {t("common.cancel")}
              </Button>
            ) : null}
          </div>
        </div>
      </section>

      <RemoteProjectDialog
        open={projectOpen}
        initialConnectionId={projectConnectionId}
        onClose={() => setProjectOpen(false)}
      />
      <RemoteRelayToolsDialog
        open={relayOpen}
        connectionId={relayConnectionId}
        connectionName={connections?.find((connection) => connection.id === relayConnectionId)?.displayName}
        onClose={() => setRelayOpen(false)}
      />
    </div>
  );
}
