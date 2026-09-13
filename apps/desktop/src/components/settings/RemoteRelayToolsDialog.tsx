import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteRelayToolDescriptor } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button, Input } from "../ui";
import { IconPlug, IconX } from "../icons";

type Props = {
  open: boolean;
  connectionId?: string;
  connectionName?: string;
  onClose: () => void;
};

export function RemoteRelayToolsDialog({
  open,
  connectionId,
  connectionName,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [tools, setTools] = useState<RemoteRelayToolDescriptor[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !connectionId) return;
    let canceled = false;
    setLoading(true);
    void api.remoteRelayCatalog(connectionId)
      .then((result) => {
        if (canceled) return;
        setTools(result.tools);
        setSelected(result.selected);
      })
      .catch((error) => {
        if (!canceled) showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [open, connectionId, showToast]);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return tools.filter((tool) =>
      !needle ||
      tool.name.toLocaleLowerCase().includes(needle) ||
      tool.description.toLocaleLowerCase().includes(needle) ||
      tool.source.toLocaleLowerCase().includes(needle));
  }, [tools, query]);

  if (!open) return null;

  const save = async () => {
    if (!connectionId) return;
    setSaving(true);
    try {
      await api.setRemoteRelayTools(connectionId, selected);
      onClose();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="settings-panel remote-relay-dialog" role="dialog" aria-modal="true" aria-labelledby="remote-relay-title">
        <header className="remote-project-header">
          <h2 id="remote-relay-title">{t("remote.relayTools")}</h2>
          <Button variant="secondary" disabled={saving} onClick={onClose}>
            <IconX size={14} />
            {t("common.cancel")}
          </Button>
        </header>
        {connectionName ? <p className="remote-relay-connection">{connectionName}</p> : null}
        <Input
          value={query}
          spellCheck={false}
          aria-label={t("remote.relaySearch")}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="remote-relay-list" role="list">
          {loading ? (
            <div className="remote-relay-empty">{t("common.loading")}</div>
          ) : visible.length === 0 ? (
            <div className="remote-relay-empty">{t("remote.relayEmpty")}</div>
          ) : visible.map((tool) => (
            <label key={tool.name} className="remote-relay-row" role="listitem">
              <span className="remote-relay-glyph" aria-hidden>
                <IconPlug size={14} />
              </span>
              <span className="remote-relay-copy">
                <strong>{tool.name}</strong>
                <span>{tool.description}</span>
                <code>{tool.source}</code>
              </span>
              <input
                type="checkbox"
                checked={selected.includes(tool.name)}
                onChange={(event) => setSelected((current) => event.target.checked
                  ? [...new Set([...current, tool.name])]
                  : current.filter((name) => name !== tool.name))}
              />
            </label>
          ))}
        </div>
        <footer className="remote-project-footer">
          <span>{t("remote.relaySelected", { count: selected.length })}</span>
          <Button variant="primary" disabled={loading || saving} onClick={() => void save()}>
            {saving ? t("common.loading") : t("common.save")}
          </Button>
        </footer>
      </section>
    </div>
  );
}
