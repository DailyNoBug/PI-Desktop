# ADR 0297: Local voice plugin replaces cloud speech

- Status: Accepted for implementation
- Date: 2026-09-18
- Decision: D451
- Related: [ADR 0296](0296-voice-dictation-phase-1.md) ·
  [ADR 0281](0281-host-speech-capability.md) ·
  [03-runtime/20-speech](../spec/03-runtime/20-speech.md) ·
  [03-runtime/01-ipc-protocol](../spec/03-runtime/01-ipc-protocol.md) ·
  [05-security/01-security](../spec/05-security/01-security.md)

Supersedes D439 / ADR 0296 (the cloud STT data path) and the builtin cloud
protocols and bindings of ADR 0281.

## Context

Phase 1 dictation (ADR 0296) sent each clip to an OpenAI-compatible cloud
transcription endpoint configured in `AppSettings.voice`, with the API key
stored under the `voice/stt` secret ref and resolved in Electron main for every
call. That means dictation needed a paid third-party account, leaked audio to
that provider by default, and stopped working offline. The host speech
capability of ADR 0281 added `AppSettings.speech` provider bindings, builtin
`openai_audio` / `openai_chat_audio` protocols, TTS, and
`pi-desktop/speech/*` IPC — but the UI never used the TTS bindings, so the
surface carried settings, secrets handling, and error codes for a path with one
real consumer: batch dictation.

The goal is fully local voice: press the microphone, speak, get a transcript,
with no endpoint, no key, and no egress while transcribing.

## Decision

1. **Bundled first-party plugin.** Dictation is served by `pi.local-voice`, a
   first-party plugin bundled under `apps/desktop/resources/plugins/`,
   enabled on startup and disableable like any plugin. It registers the speech
   adapter protocol `pi.local_voice` via `pi.speech.registerAdapter`
   (`speech.adapter.register`), so the host-side adapter registry — not a
   sidecar — owns routing.
2. **Local inference.** The plugin runs Whisper ONNX models with
   `@huggingface/transformers` (int8-quantized; catalog: `Xenova/whisper-tiny`,
   `-base`, `-small`). Weights are downloaded ahead of time into the plugin's
   own data directory, from the HF domains its manifest declares
   (`huggingface.co`, `*.huggingface.co`, `*.hf.co`, `*.xethub.hf.co`), using
   the plugin's own downloader that re-checks every redirect hop against
   `manifest.net.domains`. Transcription sets
   `transformers.env.allowRemoteModels = false`: zero network I/O on the
   transcription path, and no API key exists anywhere on it.
3. **Renderer capture.** The composer captures mono 16-bit PCM at 16 kHz via
   AudioWorklet (ScriptProcessor fallback), resampled and concatenated
   renderer-side, and sends it through the unchanged frozen voice IPC
   (`pi-desktop/voice/*`, mime `audio/pcm;rate=16000`).
4. **Plugin management rpc.** Model management (list, download with progress,
   switch, delete) is exposed by a new host API `pi.rpc.register` /
   `pi.rpc.unregister` plus the renderer IPC channel `pi-desktop/plugin/rpc`
   (`IPC.invoke.pluginRpc`), gated by the new medium-risk `plugin.rpc`
   permission. One handler per plugin receives `(method, params)` and must
   return JSON-serializable values; the host routes, budgets, and serializes.
   The Settings Voice card talks to the plugin through it.
5. **Cloud speech removed.** `AppSettings.speech` bindings, the cloud TTS
   settings surface, `speech-service.ts`, `speech-ipc.ts`, the builtin speech
   protocols, the agent-runtime `speech`/`voice` STT modules, and the
   `SPEECH_NOT_CONFIGURED` / `SPEECH_INPUT_TOO_LARGE` error codes are deleted.
   Legacy `voice.stt` values and speech settings in existing profiles are
   ignored.

## Consequences

- Dictation works offline once a model is downloaded. Model weights are the
  only network touchpoint, and only from the manifest-declared HF domains.
- The `speech.handle` call budget rises from the generic 60 s to 120 s so a
  local Whisper pass over the longest allowed clip (120 s recording cap) fits
  in one call.
- `transformers.js` defaults multilingual models to English transcription, so
  the `language` setting is forwarded as a hint and mapped from the BCP-47 tag
  to its 2-letter base language; without a hint the model auto-detects.
- `onnxruntime` and the plugin's `node_modules` are vendored into the bundled
  plugin directory at build time by
  `apps/desktop/scripts/install-local-voice-deps.mjs` (`pnpm install:plugin-deps`),
  so packaged builds do not resolve native modules at runtime.
- Residual risks: model downloads are enforced in-process by plugin code
  reading its own manifest, not by the broker, so a future plugin bug (not a
  host bug) could widen its own egress; and Whisper tiny/base quality for
  Chinese is modest — `whisper-small` is the better default there.
- Old profiles are tolerated: unknown legacy settings are ignored, and the
  removed channels answer `NOT_FOUND` from the registrar instead of a silent
  hole. E2E-269 is rewritten around the local inference journey.

## Compatibility

- `AppSettings.voice` narrows to `{ language?, autoSend? }`; unknown members of
  an existing profile are dropped by normalization, and stored legacy
  `voice.stt` secrets simply become orphans no code reads.
- Removed `pi-desktop/speech/*` channels return `NOT_FOUND`; the frozen
  `pi-desktop/voice/*` payload keeps its shape (mime now
  `audio/pcm;rate=16000`).
- E2E-269 is rewritten as the local voice dictation scenario
  (`node --test apps/desktop/test/local-voice-inference.test.mjs`).
