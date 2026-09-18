/**
 * Settings destination for paired remote `pi-host` machines (R2b pairing UX,
 * ADR 0286 §Registry).
 *
 * List every host stored in `<dataDir>/remote-hosts.json`, show its live
 * connection state, and offer a compact form to pair a new one with a URL +
 * pairing token issued by the target `pi-host`. The renderer never sees a
 * device token — pairing exchange and encrypted persistence stay inside
 * Electron main.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteHostSummary } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Input, cx } from "../ui";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";

type PairForm = {
  url: string;
  pairingToken: string;
  label: string;
};

const EMPTY_FORM: PairForm = { url: "", pairingToken: "", label: "" };

export function RemoteHostsPage() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [hosts, setHosts] = useState<RemoteHostSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<PairForm>(EMPTY_FORM);
  const [pairing, setPairing] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api.listRemoteHosts();
      setHosts(result.hosts);
      setError(null);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const url = form.url.trim();
      const pairingToken = form.pairingToken.trim();
      const label = form.label.trim();
      if (!url || !pairingToken || !label) return;
      setPairing(true);
      try {
        const result = await api.pairRemoteHost({ url, pairingToken, label });
        showToast(t("settings.remoteHosts.pairSucceeded", { label: result.host.label }), {
          variant: "info",
        });
        setForm(EMPTY_FORM);
        await refresh();
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        showToast(t("settings.remoteHosts.pairFailed", { message }), { variant: "error" });
      } finally {
        setPairing(false);
      }
    },
    [form, refresh, showToast, t],
  );

  const remove = useCallback(
    async (host: RemoteHostSummary) => {
      setRemoving(host.hostKey);
      try {
        await api.removeRemoteHost(host.hostKey);
        showToast(t("settings.remoteHosts.removed", { label: host.label }), {
          variant: "info",
        });
        await refresh();
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        showToast(t("settings.remoteHosts.removeFailed", { message }), { variant: "error" });
      } finally {
        setRemoving(null);
      }
    },
    [refresh, showToast, t],
  );

  return (
    <div className="settings-stack">
      <SettingsCard title={t("settings.remoteHosts.listTitle")}>
        <div className="settings-row-copy" role="note">
          <div className="settings-row-desc">
            {t("settings.remoteHosts.overview")}
          </div>
        </div>
        {error ? (
          <SettingsRow title={t("settings.remoteHosts.listError")}>
            <span className="text-text-muted">{error}</span>
          </SettingsRow>
        ) : null}
        {hosts === null ? (
          <SettingsRow title={t("settings.remoteHosts.loading")}>
            <span aria-hidden="true">…</span>
          </SettingsRow>
        ) : hosts.length === 0 ? (
          <SettingsRow title={t("settings.remoteHosts.emptyTitle")}>
            <span className="text-text-muted">{t("settings.remoteHosts.emptyBody")}</span>
          </SettingsRow>
        ) : (
          hosts.map((host) => (
            <SettingsRow
              key={host.hostKey}
              title={host.label}
              description={
                <span className="font-mono text-xs-plus text-text-muted">{host.url}</span>
              }
            >
              <span
                className={cx(
                  "settings-remote-host-status",
                  host.connected ? "is-online" : "is-offline",
                )}
                role="status"
                aria-live="polite"
              >
                {host.connected
                  ? t("settings.remoteHosts.statusOnline")
                  : t("settings.remoteHosts.statusOffline")}
              </span>
              <button
                type="button"
                className="settings-button danger"
                disabled={removing === host.hostKey}
                onClick={() => void remove(host)}
              >
                {removing === host.hostKey
                  ? t("settings.remoteHosts.removing")
                  : t("settings.remoteHosts.remove")}
              </button>
            </SettingsRow>
          ))
        )}
      </SettingsCard>

      <SettingsCard title={t("settings.remoteHosts.pairTitle")}>
        <form onSubmit={submit} className="settings-remote-host-form">
          <SettingsRow
            title={t("settings.remoteHosts.fieldLabel")}
            description={t("settings.remoteHosts.fieldLabelDesc")}
          >
            <Input
              value={form.label}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, label: event.target.value }))
              }
              placeholder={t("settings.remoteHosts.fieldLabelPlaceholder")}
              aria-label={t("settings.remoteHosts.fieldLabel")}
              autoComplete="off"
              spellCheck={false}
              disabled={pairing}
            />
          </SettingsRow>
          <SettingsRow
            title={t("settings.remoteHosts.fieldUrl")}
            description={t("settings.remoteHosts.fieldUrlDesc")}
          >
            <Input
              value={form.url}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, url: event.target.value }))
              }
              placeholder="ws://127.0.0.1:9443/racp"
              aria-label={t("settings.remoteHosts.fieldUrl")}
              inputMode="url"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={pairing}
            />
          </SettingsRow>
          <SettingsRow
            title={t("settings.remoteHosts.fieldPairingToken")}
            description={t("settings.remoteHosts.fieldPairingTokenDesc")}
          >
            <Input
              value={form.pairingToken}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, pairingToken: event.target.value }))
              }
              placeholder="ppt1.…"
              aria-label={t("settings.remoteHosts.fieldPairingToken")}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              type="password"
              disabled={pairing}
            />
          </SettingsRow>
          <SettingsRow title={t("settings.remoteHosts.pairAction")}>
            <button
              type="submit"
              className="settings-button primary"
              disabled={
                pairing ||
                !form.url.trim() ||
                !form.pairingToken.trim() ||
                !form.label.trim()
              }
            >
              {pairing
                ? t("settings.remoteHosts.pairing")
                : t("settings.remoteHosts.pair")}
            </button>
          </SettingsRow>
        </form>
      </SettingsCard>
    </div>
  );
}
