/**
 * Local voice dictation settings card (ADR: local voice plugin).
 *
 * Dictation runs on the bundled `pi.local-voice` plugin with an on-device
 * Whisper model: this card manages models (download with progress, switch,
 * delete) over the plugin rpc and keeps the dictation preferences
 * (language hint, auto-send) in AppSettings. No endpoint or API key exists on
 * this path; the mic button appears in the composer only when the plugin is
 * enabled and a model is ready.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, VoiceSettings } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button, Input, cx } from "../../components/ui";
import { SettingsCard, SettingsRow } from "./primitives";

const LOCAL_VOICE_PLUGIN_ID = "pi.local-voice";

type LocalVoiceModel = {
  id: string;
  label: string;
  repoId: string;
  sizeApproxMB?: number;
  installed: boolean;
  active: boolean;
};

type LocalVoiceDownload = {
  state: "running" | "error";
  error?: string;
  received?: number;
  total?: number;
};

type LocalVoiceStatus = {
  ready: boolean;
  activeModel: string | null;
  engineAvailable: boolean;
  models: Array<{ id: string; installed: boolean; active: boolean }>;
  downloads: Record<string, LocalVoiceDownload>;
};

type LocalVoiceCatalog = {
  models: Array<LocalVoiceModel>;
};

async function callLocalVoice<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  const response = await api.pluginRpc(LOCAL_VOICE_PLUGIN_ID, method, params);
  return response.result as T;
}

export function VoiceSettingsSection({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const voice = settings.voice ?? {};
  const [languageDraft, setLanguageDraft] = useState(voice.language ?? "");
  const [status, setStatus] = useState<LocalVoiceStatus | null>(null);
  const [catalog, setCatalog] = useState<LocalVoiceCatalog | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setLanguageDraft(voice.language ?? "");
    // `voice` is a fresh object on every settings refresh; the draft follows
    // trusted state so a rejected write visibly snaps back.
  }, [voice.language]);

  const refresh = useCallback(async () => {
    try {
      const next = await callLocalVoice<LocalVoiceStatus>("status");
      setStatus(next);
      setAvailable(true);
      setActionError(null);
      return next;
    } catch {
      setAvailable(false);
      setStatus(null);
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const initial = async () => {
      const next = await refresh();
      if (!cancelled && next) {
        try {
          setCatalog(await callLocalVoice<LocalVoiceCatalog>("models.list"));
        } catch {
          if (!cancelled) setCatalog(null);
        }
      }
    };
    void initial();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const downloadsRunning = Object.values(status?.downloads ?? {}).some(
    (download) => download.state === "running",
  );
  useEffect(() => {
    if (!downloadsRunning) {
      if (pollRef.current !== null) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current === null) {
      pollRef.current = setInterval(() => void refresh(), 700);
    }
    return () => {
      if (pollRef.current !== null) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [downloadsRunning, refresh]);

  const runAction = async (method: string, params?: Record<string, unknown>) => {
    setBusyAction(true);
    setActionError(null);
    try {
      await callLocalVoice(method, params);
      await refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(false);
    }
  };

  const saveVoice = async (patch: Partial<VoiceSettings>) => {
    await saveSettings({ voice: { ...voice, ...patch } });
  };

  const commitLanguage = async () => {
    const next = languageDraft.trim();
    if (next === (voice.language ?? "")) return;
    await saveVoice({ language: next || undefined });
  };

  const modelRows: Array<LocalVoiceModel & { download?: LocalVoiceDownload }> =
    (catalog?.models ?? []).map((model) => ({
      ...model,
      installed: status?.models.find((entry) => entry.id === model.id)?.installed ?? false,
      active: status?.models.find((entry) => entry.id === model.id)?.active ?? false,
      download: status?.downloads[model.id],
    }));

  return (
    <div className="settings-stack">
      <SettingsCard title={t("settings.voiceTitle")}>
        <p className="settings-row-desc settings-speech-lead">
          {t("settings.voiceLocalDesc")}
        </p>
        {available === false ? (
          <p className="settings-row-desc" role="note">
            {t("settings.voicePluginDisabled")}
          </p>
        ) : null}
        {available === true && status && !status.engineAvailable ? (
          <p className="settings-row-desc" role="note">
            {t("settings.voiceEngineMissing")}
          </p>
        ) : null}
        {actionError ? (
          <p className="settings-row-desc" role="alert">
            {t("settings.voiceActionFailed", { message: actionError })}
          </p>
        ) : null}
        {modelRows.map((model) => {
          const download = model.download;
          const running = download?.state === "running";
          const percent =
            running && download?.total
              ? Math.min(100, Math.round(((download.received ?? 0) / download.total) * 100))
              : null;
          return (
            <SettingsRow
              key={model.id}
              title={model.label}
              description={
                model.sizeApproxMB
                  ? t("settings.voiceModelSize", { size: model.sizeApproxMB })
                  : model.repoId
              }
            >
              <div className="flex items-center gap-2">
                {model.active ? (
                  <span className="settings-voice-state">{t("settings.voiceModelActive")}</span>
                ) : null}
                {!model.installed && !running ? (
                  <Button
                    variant="secondary"
                    disabled={busyAction}
                    onClick={() => void runAction("models.download", { id: model.id })}
                  >
                    {t("settings.voiceModelDownload")}
                  </Button>
                ) : null}
                {model.installed && !model.active ? (
                  <Button
                    variant="secondary"
                    disabled={busyAction}
                    onClick={() => void runAction("models.setActive", { id: model.id })}
                  >
                    {t("settings.voiceModelSetActive")}
                  </Button>
                ) : null}
                {model.installed && !model.active ? (
                  <Button
                    variant="secondary"
                    disabled={busyAction}
                    onClick={() => void runAction("models.remove", { id: model.id })}
                  >
                    {t("settings.voiceModelRemove")}
                  </Button>
                ) : null}
              </div>
              {running ? (
                <div
                  className="settings-voice-progress"
                  role="progressbar"
                  aria-label={t("settings.voiceDownloading")}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent ?? undefined}
                >
                  <div
                    className={cx("settings-voice-progress-fill")}
                    style={{ width: `${percent ?? 0}%` }}
                  />
                  <span className="settings-voice-progress-label">
                    {percent !== null
                      ? `${percent}%`
                      : t("settings.voiceDownloading")}
                  </span>
                </div>
              ) : null}
              {download?.state === "error" ? (
                <span className="settings-row-desc" role="alert">
                  {t("settings.voiceDownloadFailed", { message: download.error ?? "" })}
                </span>
              ) : null}
            </SettingsRow>
          );
        })}
        <SettingsRow title={t("settings.voiceLanguage")}>
          <Input
            type="text"
            value={languageDraft}
            placeholder="en / zh-CN / …"
            aria-label={t("settings.voiceLanguage")}
            onChange={(event) => setLanguageDraft(event.target.value)}
            onBlur={() => void commitLanguage()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
        </SettingsRow>
        <SettingsRow title={t("settings.voiceAutoSend")}>
          <button
            type="button"
            className={cx("settings-toggle", voice.autoSend === true && "on")}
            role="switch"
            aria-checked={voice.autoSend === true}
            aria-label={t("settings.voiceAutoSend")}
            onClick={() => void saveVoice({ autoSend: !(voice.autoSend === true) })}
          >
            <span className="settings-toggle-thumb" />
          </button>
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}
