/**
 * Composer microphone button for voice dictation. Pure presentation: the
 * state machine lives in `useVoiceDictation`, and the button only reflects
 * the snapshot (recording / transcribing / error) and routes clicks.
 */
import { useTranslation } from "react-i18next";
import { IconMic, IconStop } from "../../components/icons";
import { TooltipButton } from "../../components/ui";
import type { VoiceDictationSnapshot } from "@pi-desktop/shared";

export type VoiceDictationButtonProps = {
  snapshot: VoiceDictationSnapshot;
  busy: boolean;
  /** Rendered only when the trusted STT provider is configured. */
  enabled: boolean;
  disabled?: boolean;
  onToggle: () => void;
};

export function VoiceDictationButton({
  snapshot,
  busy,
  enabled,
  disabled = false,
  onToggle,
}: VoiceDictationButtonProps) {
  const { t } = useTranslation();
  if (!enabled) return null;
  const recording = snapshot.state === "recording" || snapshot.state === "stopping";
  const transcribing = snapshot.state === "transcribing";
  const label = recording
    ? t("chat.voice.stopDictation")
    : transcribing
      ? t("chat.voice.transcribing")
      : snapshot.state === "requesting-permission"
        ? t("chat.voice.starting")
        : t("chat.voice.startDictation");
  return (
    <TooltipButton
      type="button"
      className={`icon-btn icon-btn-square composer-voice-btn${recording ? " is-recording" : ""}`}
      data-voice-state={snapshot.state}
      tooltip={label}
      ariaLabel={label}
      aria-busy={transcribing}
      disabled={disabled || snapshot.state === "requesting-permission"}
      onClick={onToggle}
    >
      {recording ? (
        <IconStop size={14} aria-hidden="true" />
      ) : transcribing ? (
        <span className="tool-spinner" aria-hidden="true" />
      ) : (
        <IconMic size={15} aria-hidden="true" />
      )}
    </TooltipButton>
  );
}
