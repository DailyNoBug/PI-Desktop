/**
 * Voice dictation settings card (Phase 1, batch STT).
 *
 * Non-secret fields (endpoint, model, language, auto-send) persist through
 * the normal settings path; the API key goes straight into the host secret
 * store through the generic secrets channel and is never stored in
 * AppSettings, rendered back, or logged. The mic button appears in the
 * composer only once endpoint + model are configured.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, VoiceSettings } from "@pi-desktop/shared";
import { isAllowedVoiceBaseUrl } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button, Input, cx } from "../../components/ui";
import { SettingsCard, SettingsRow } from "./primitives";

export function VoiceSettingsSection({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const voice = settings.voice ?? {};
  const [baseUrlDraft, setBaseUrlDraft] = useState(voice.sttBaseUrl ?? "");
  const [modelDraft, setModelDraft] = useState(voice.sttModel ?? "");
  const [languageDraft, setLanguageDraft] = useState(voice.language ?? "");
  const [baseUrlError, setBaseUrlError] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);

  useEffect(() => {
    setBaseUrlDraft(voice.sttBaseUrl ?? "");
    setModelDraft(voice.sttModel ?? "");
    setLanguageDraft(voice.language ?? "");
    // `voice` is a fresh object on every settings refresh; the drafts follow
    // trusted state so a rejected write visibly snaps back.
  }, [voice.sttBaseUrl, voice.sttModel, voice.language]);

  useEffect(() => {
    let cancelled = false;
    api
      .hasVoiceSttKey()
      .then((result) => {
        if (!cancelled) setHasKey(result.has === true);
      })
      .catch(() => {
        if (!cancelled) setHasKey(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveVoice = async (patch: Partial<VoiceSettings>) => {
    await saveSettings({ voice: { ...voice, ...patch } });
  };

  const commitBaseUrl = async () => {
    const next = baseUrlDraft.trim();
    if (next === (voice.sttBaseUrl ?? "")) {
      setBaseUrlError(false);
      return;
    }
    if (next && !isAllowedVoiceBaseUrl(next)) {
      setBaseUrlError(true);
      return;
    }
    setBaseUrlError(false);
    await saveVoice({ sttBaseUrl: next || undefined });
  };

  const commitModel = async () => {
    const next = modelDraft.trim();
    if (next === (voice.sttModel ?? "")) return;
    await saveVoice({ sttModel: next || undefined });
  };

  const commitLanguage = async () => {
    const next = languageDraft.trim();
    if (next === (voice.language ?? "")) return;
    await saveVoice({ language: next || undefined });
  };

  const commitKey = async () => {
    const next = keyDraft.trim();
    setKeyDraft("");
    if (!next) return;
    setKeyBusy(true);
    try {
      await api.setVoiceSttKey(next);
      setHasKey(true);
    } finally {
      setKeyBusy(false);
    }
  };

  const clearKey = async () => {
    setKeyBusy(true);
    try {
      await api.clearVoiceSttKey();
      setHasKey(false);
    } finally {
      setKeyBusy(false);
    }
  };

  return (
    <div className="settings-stack">
      <SettingsCard title={t("settings.voiceTitle")}>
        <SettingsRow title={t("settings.voiceBaseUrl")}>
          <Input
            type="url"
            value={baseUrlDraft}
            placeholder="https://api.openai.com/v1"
            aria-label={t("settings.voiceBaseUrl")}
            aria-invalid={baseUrlError}
            onChange={(event) => setBaseUrlDraft(event.target.value)}
            onBlur={() => void commitBaseUrl()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
        </SettingsRow>
        <SettingsRow title={t("settings.voiceModel")}>
          <Input
            type="text"
            value={modelDraft}
            placeholder="whisper-1"
            aria-label={t("settings.voiceModel")}
            onChange={(event) => setModelDraft(event.target.value)}
            onBlur={() => void commitModel()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
        </SettingsRow>
        <SettingsRow title={t("settings.voiceApiKey")}>
          <div className="flex items-center gap-2">
            <Input
              type="password"
              value={keyDraft}
              placeholder={hasKey ? t("settings.apiKeyKeepHint") : "sk-…"}
              aria-label={t("settings.voiceApiKey")}
              disabled={keyBusy}
              onChange={(event) => setKeyDraft(event.target.value)}
              onBlur={() => void commitKey()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
            />
            {hasKey ? (
              <Button
                variant="secondary"
                disabled={keyBusy}
                onClick={() => void clearKey()}
              >
                {t("settings.remove")}
              </Button>
            ) : null}
          </div>
        </SettingsRow>
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
