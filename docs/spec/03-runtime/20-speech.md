# 20. Speech (local voice plugin) and host speech

> Source of truth: `packages/shared/src/voice.ts`,
> `apps/desktop/electron/main/ipc/dictation-ipc.ts`,
> `apps/desktop/electron/main/plugin-runtime.ts`,
> `apps/desktop/resources/plugins/pi.local-voice/`.
> ADR: [0329-local-voice-plugin](../../adr/0329-local-voice-plugin.md).

Dictation (speech-to-text for the composer) is a plugin capability in this
fork, not a host service. It enters through the frozen dictation IPC domain
(`pi-desktop/dictation/*`, renamed from the Phase 1 `pi-desktop/voice/*` when
the 2026-10 upstream sync introduced its own host voice stack) and runs on a
speech adapter registered by a plugin. The shipped implementation is the
bundled first-party plugin `pi.local-voice`, which transcribes locally on a
Whisper ONNX model (ADR 0329, superseding the Phase 1 cloud STT of ADR 0328).

The 2026-10 upstream sync additionally adopted the upstream host speech
capability (ASR/TTS via `speech-service.ts` and `AppSettings.speech`, ADR
[0281-host-speech-capability](../../adr/0281-host-speech-capability.md)) and
the app-owned realtime voice calls ([live-voice.md](live-voice.md)). Those are
separate surfaces: dictation never reads host speech settings and host speech
never touches the dictation channels.

## 1. IPC entry (frozen)

```
pi-desktop/dictation/capabilities → VoiceCapabilities (no secrets)
pi-desktop/dictation/transcribe
pi-desktop/dictation/cancel
```

All three channels accept only the main application window's sender (IPC spec
§13e). `capabilities` answers `{ configured, maxRecordingMs (120_000),
maxAudioBytes (20 MiB), preferredMimeType ("audio/pcm;rate=16000") }`;
`configured` is true only when the local-voice plugin is enabled, its adapter
is live, and a model is ready. `cancel` is the renderer-side acknowledgement:
local transcription is bounded by the adapter call budget, the renderer cancels
its own state machine, and a late transcript is discarded.

## 2. Dictation flow

```
renderer WebAudio capture (mono 16-bit PCM, 16 kHz)
  → preload IPC (pi-desktop/dictation/transcribe)
  → Electron main voice IPC (typebox envelope + binary validation)
  → PluginRuntime.runSpeechAdapter (protocol pi.local_voice)
  → plugin process speech.handle
  → { kind: "text", text } → composer draft at the cursor
```

Dictation audio is mono 16-bit little-endian PCM at 16 kHz
(`VOICE_PCM_SAMPLE_RATE`, mime `audio/pcm;rate=16000`); the recorder no longer
produces a compressed container. The `speech.handle` payload is
`{ audio (base64), mimeType: "audio/pcm;rate=16000", durationMs, language?,
role: "transcribe" }` and the reply must be `{ kind: "text", text }`. Audio is
memory-only — never written to disk, transcripts, or logs — and no transcript
is auto-sent through `agent/prompt`. Failures surface the structured `VOICE_*`
codes; a transcription failure never disturbs an agent runtime.

Speech adapter protocol ids match `^[a-z][a-z0-9._-]{0,63}$`
(`packages/shared/src/speech.ts`). Speech has no configured host state — an
absent adapter is the only unconfigured state — and no app surface reads a
speech binding: callers are the frozen voice IPC domain and plugin adapters
(ADR 0291, ADR 0329).

## 3. Bundled `pi.local-voice` plugin

First-party, bundled, and disableable like every plugin. Its manifest declares
permissions `["speech.adapter.register", "plugin.rpc"]` and `net.domains`
limited to `huggingface.co`, `*.huggingface.co`, `*.hf.co`, and
`*.xethub.hf.co`.

Model catalog (int8-quantized ONNX, Xenova repositories):

| id | repository | approx size |
|---|---|---|
| `whisper-tiny` | `Xenova/whisper-tiny` | 45 MB |
| `whisper-base` | `Xenova/whisper-base` | 85 MB |
| `whisper-small` | `Xenova/whisper-small` | 250 MB |

Models are downloaded ahead of time into the plugin's own data directory and
count as installed only when every required file is present. Downloads use the
plugin's own HF downloader, which enforces its manifest `net.domains` on every
redirect hop (manual redirects, per-hop host re-checks, https only), not just
the first URL. The active model is persisted in plugin state.

Model management rides the plugin management rpc: the plugin registers one
handler via `pi.rpc.register` and the renderer calls it through
`pi-desktop/plugin/rpc` (`IPC.invoke.pluginRpc`, gated by the `plugin.rpc`
permission) with the methods `status`, `models.list`, `models.download`,
`models.remove`, and `models.setActive`. The Settings card is
`apps/desktop/src/features/settings/VoiceSettingsSection.tsx`.

## 4. No network and no key on the transcription path

Transcription performs zero network I/O: the engine sets
`transformers.env.allowRemoteModels = false`, so weights load only from the
plugin's model directory and a missing model fails closed. No API key exists
on the path — the removed `voice/stt` secret ref and the cloud STT/TTS
settings are gone. Model weights are the only network touchpoint (the
manifest-declared HF domains above).

## 5. Plugin adapters

`pi.speech.registerAdapter({ protocol, label, roles, handle })` requires
`speech.adapter.register` (high risk). The handle stays in the plugin process.
The host stores metadata only and calls `speech.handle`. A handle may return
`{ kind: "text" }`, `{ kind: "audio", mimeType, data }`, or
`{ kind: "http", call }` for the host to execute with the bound key. HTTP URLs
must stay on the provider origin. There are no builtin protocol ids any more:
every protocol is plugin-registered, and `pi.local_voice` belongs to the
bundled local-voice plugin. Unload unregisters.

## 6. Limits

- Microphone capture is capped at 120 s per recording
  (`VOICE_MAX_RECORDING_MS`) and 20 MiB per payload (`VOICE_MAX_AUDIO_BYTES`),
  enforced by the recorder timer and IPC validation.
- The `speech.handle` call budget is 120 s (raised from the generic 60 s), so a
  local Whisper pass over the longest allowed clip fits inside one call.
- `SPEECH_PROTOCOL_UNSUPPORTED` is the adapter registry's answer for an unknown
  speech protocol.
- Settings exposes **no** cloud speech surface (ADR 0291): this fork has no
  `AppSettings.speech` bindings and no `speech/*` IPC, and the only Settings
  surface is the local-voice **Voice** card (ADR 0329). Whisper / TTS models
  must not appear in the chat model picker.
- v1 does not implement Realtime or agent tools; microphone capture is the
  dictation path above.
