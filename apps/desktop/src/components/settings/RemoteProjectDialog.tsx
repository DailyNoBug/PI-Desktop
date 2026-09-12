import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteConnectionView, RemoteDirectoryResult } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button, Input, Select, cx } from "../ui";
import { IconFileText, IconFolder, IconFolderOpen } from "../icons";

type Props = {
  open: boolean;
  initialConnectionId?: string;
  onClose: () => void;
};

export function RemoteProjectDialog({ open, initialConnectionId, onClose }: Props) {
  const { t } = useTranslation();
  const activateProject = useAppStore((state) => state.activateProject);
  const showToast = useAppStore((state) => state.showToast);
  const [connections, setConnections] = useState<RemoteConnectionView[]>([]);
  const [connectionId, setConnectionId] = useState(initialConnectionId ?? "");
  const [directory, setDirectory] = useState<RemoteDirectoryResult | null>(null);
  const [pathDraft, setPathDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !adding) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [open, adding, onClose]);

  useEffect(() => {
    if (!open) return;
    let canceled = false;
    void api.listRemoteConnections().then(({ connections: next }) => {
      if (canceled) return;
      setConnections(next);
      setConnectionId((current) => current || initialConnectionId || next[0]?.id || "");
    }).catch(() => undefined);
    return () => {
      canceled = true;
    };
  }, [open, initialConnectionId]);

  useEffect(() => {
    setConnectionId(initialConnectionId ?? "");
  }, [initialConnectionId]);

  const selected = useMemo(
    () => connections.find((connection) => connection.id === connectionId),
    [connections, connectionId],
  );

  const browse = async (targetPath?: string) => {
    if (!connectionId) return;
    setLoading(true);
    try {
      const result = await api.browseRemoteDirectory({
        connectionId,
        ...(targetPath ? { path: targetPath } : {}),
      });
      setDirectory(result);
      setPathDraft(result.path);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open || !connectionId || directory) return;
    void browse();
  }, [open, connectionId, directory]);

  const add = async () => {
    if (!connectionId || !pathDraft.trim()) return;
    setAdding(true);
    try {
      const result = await api.addRemoteProject({
        connectionId,
        remotePath: pathDraft.trim(),
      });
      await activateProject(result.workspace.path);
      onClose();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setAdding(false);
    }
  };

  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="settings-panel remote-project-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-project-title"
      >
        <header className="remote-project-header">
          <h2 id="remote-project-title">{t("remote.projectTitle")}</h2>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
        </header>

        <div className="remote-project-controls">
          <Select
            value={connectionId}
            aria-label={t("remote.connection")}
            onChange={(event) => {
              setConnectionId(event.target.value);
              setDirectory(null);
            }}
          >
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.displayName}
              </option>
            ))}
          </Select>
          <Button variant="secondary" disabled={!connectionId || loading} onClick={() => void browse(directory?.path)}>
            <IconFolderOpen size={14} />
            {loading ? t("common.loading") : t("remote.refresh")}
          </Button>
          <Button variant="secondary" disabled={!directory} onClick={() => void browse(directory?.homePath)}>
            <IconFolder size={14} />
            {t("remote.home")}
          </Button>
        </div>

        <Input
          value={pathDraft}
          aria-label={t("remote.path")}
          spellCheck={false}
          autoCapitalize="off"
          onChange={(event) => setPathDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void browse(pathDraft.trim() || undefined);
            }
          }}
        />

        <div className="remote-project-list" role="list">
          {(directory?.entries ?? []).map((entry) => (
            <button
              key={entry.name}
              type="button"
              role="listitem"
              className={cx("remote-project-entry", entry.kind === "file" && "is-file")}
              disabled={entry.kind !== "dir"}
              onClick={() => void browse(`${directory?.path ?? ""}/${entry.name}`)}
            >
              {entry.kind === "dir" ? <IconFolder size={14} /> : <IconFileText size={14} />}
              <span>{entry.name}</span>
            </button>
          ))}
          {directory && directory.entries.length === 0 ? (
            <div className="remote-project-empty">{t("remote.emptyDirectory")}</div>
          ) : null}
        </div>

        <footer className="remote-project-footer">
          <span>{directory?.isGitRepository ? t("remote.gitRepository") : ""}</span>
          <Button
            variant="primary"
            disabled={!selected || adding || !pathDraft.trim()}
            onClick={() => void add()}
          >
            {adding ? t("remote.openingProject") : t("remote.openProject")}
          </Button>
        </footer>
      </section>
    </div>
  );
}
