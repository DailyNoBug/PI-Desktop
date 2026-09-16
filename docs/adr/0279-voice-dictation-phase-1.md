# ADR 0279: Voice Dictation, Phase 1 (Batch Transcription)

- Status: Accepted for implementation
- Date: 2026-09-17
- Decision: D439
- Related: `03-runtime/01-ipc-protocol.md`, `03-runtime/14-secrets-storage.md`,
  `05-security/01-security.md`, `04-ux/06-settings-ia.md`,
  `06-delivery/04-e2e-test-plan.md` (E2E-269)

## Context

Users want Codex-Desktop-style voice input: press the microphone, speak, and
find the transcript in the composer, editable and submittable through the one
existing `agent/prompt` path. Real-time streaming STT, TTS, and a
conversational voice agent were explicitly out of scope for the first phase;
reliable batch dictation is the deliverable, but the design must leave room
for later voice control without re-architecting.

## Decision

1. **Data path.** Renderer `getUserMedia({audio:true})` + `MediaRecorder`
   (WebM/Opus preferred) → preload-whitelisted IPC (`pi-desktop/voice/*`) →
   Electron main voice IPC (runtime validation, trusted config, secret
   resolution) → the existing Node agent sidecar (`voice.transcribe`) → an
   OpenAI-compatible transcription endpoint → transcript back to the composer
   cursor. No new process, no Rust changes: STT is a network call that belongs
   to the agent runtime layer, exactly where provider traffic already lives.
2. **Independent voice provider.** The agent-runtime gains a
   `VoiceTranscriptionProvider` abstraction plus one OpenAI-compatible
   adapter (`POST {baseUrl}/audio/transcriptions`). It is independent of the
   coding-model provider system: the agent may run on any vendor while
   dictation uses OpenAI, Groq Whisper, or a local Whisper server.
3. **Trusted configuration only.** Endpoint and model live in
   `AppSettings.voice` (validated; plain `http://` is allowed only on
   loopback). The API key is stored under the secret-ref `voice/stt` in the
   host secret store — written through the existing generic secrets channel,
   read back only by Electron main via `secrets.getForRuntime` — and handed to
   the sidecar per call, the same trust shape as `agent.prompt` receiving
   `provider.apiKey`. The renderer can never choose an endpoint or see a key.
4. **Explicit state machine, one active recording.** The composer hook drives
   `idle → requesting-permission → recording → stopping → transcribing →
   ready | error` with cancel/error paths that always return to `idle`. A
   renderer-process singleton binds the active recording to a
   window/session/composer triple, so two composers cannot record at once.
   Captured audio is memory-only; limits (120 s, 20 MiB) are enforced by the
   recorder timer, the IPC validation, and the sidecar.
5. **Microphone policy.** The default session's permission handlers allow
   `media` only for the main window's webContents and only when every
   requested capture kind is `audio`; camera/video and every other frame
   (plugin partitions and work-panel views keep their deny-all handlers) are
   refused.
6. **Phase-1 scope locks.** No TTS, no voice agent, no realtime streaming, no
   intent LLM, and no auto-send by default — `AppSettings.voice.autoSend`
   exists (default off) so a later phase can activate it without a settings
   migration. The transcript is composer text; sending it flows through the
   unchanged `agent/prompt` chain and its permission system.

## Consequences

Dictation needs no protocol or storage-schema version bump: the voice IPC
domain is additive, `AppSettings.voice` is an optional JSON field in the
existing settings blob, and the secret uses the existing kv-backed secret
store. A later voice-control phase can reuse the same channel (routing a final
utterance to `agent/prompt`, `agent/steer`, the turn queue, or `agent/stop`)
without changing the capture, permission, or provider design decided here.
