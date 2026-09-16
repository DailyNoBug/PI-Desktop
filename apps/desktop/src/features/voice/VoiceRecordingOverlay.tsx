/**
 * Inline dictation status strip above the composer input: live timer while
 * recording, progress while transcribing, and a dismissible error row. The
 * overlay is rendered only while a dictation is active or has just failed —
 * it never blocks the composer.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { VoiceDictationSnapshot } from "@pi-desktop/shared";
import { voiceErrorI18nKey } from "./voice-errors";

export type VoiceRecordingOverlayProps = {
  snapshot: VoiceDictationSnapshot;
  onCancel: () => void;
  onDismiss: () => void;
};

function formatSeconds(elapsedMs: number): string {
  const seconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function VoiceRecordingOverlay({
  snapshot,
  onCancel,
  onDismiss,
}: VoiceRecordingOverlayProps) {
  const { t } = useTranslation();
  const [elapsedMs, setElapsedMs] = useState(0);
  const recording = snapshot.state === "recording";
  useEffect(() => {
    if (!recording || snapshot.startedAt === null) return;
    const tick = () => setElapsedMs(Date.now() - (snapshot.startedAt ?? Date.now()));
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [recording, snapshot.startedAt]);

  if (snapshot.state === "idle" || snapshot.state === "ready") return null;
  if (snapshot.state === "requesting-permission") {
    return (
      <div className="composer-voice-status" role="status" data-voice-state={snapshot.state}>
        {t("chat.voice.starting")}
      </div>
    );
  }
  if (recording || snapshot.state === "stopping") {
    return (
      <div className="composer-voice-status is-recording" role="status" data-voice-state={snapshot.state}>
        <span className="composer-voice-dot" aria-hidden="true" />
        <span>
          {t("chat.voice.recording", { elapsed: formatSeconds(elapsedMs) })}
        </span>
        <button
          type="button"
          className="composer-voice-cancel"
          onClick={onCancel}
        >
          {t("chat.voice.cancelDictation")}
        </button>
      </div>
    );
  }
  if (snapshot.state === "transcribing") {
    return (
      <div className="composer-voice-status" role="status" data-voice-state={snapshot.state}>
        <span className="tool-spinner" aria-hidden="true" />
        <span>{t("chat.voice.transcribing")}</span>
        <button
          type="button"
          className="composer-voice-cancel"
          onClick={onCancel}
        >
          {t("chat.voice.cancelDictation")}
        </button>
      </div>
    );
  }
  return (
    <div className="composer-voice-status is-error" role="alert" data-voice-state={snapshot.state}>
      <span>{t(voiceErrorI18nKey(snapshot.errorCode))}</span>
      <button
        type="button"
        className="composer-voice-cancel"
        onClick={onDismiss}
      >
        {t("chat.voice.dismiss")}
      </button>
    </div>
  );
}
