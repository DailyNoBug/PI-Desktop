# ADR 0281: Host speech capability

- Status: Accepted for implementation (amended by [ADR 0291](0291-remove-speech-settings-ui.md))
- Date: 2026-09-17
- Related: [ADR 0257](0257-plugin-real-time-capabilities.md) ·
  [03-runtime/20-speech](../spec/03-runtime/20-speech.md)

> **Fork amendment (2026-09-18, superseded 2026-10):**
> [ADR 0355 — local voice plugin](0355-local-voice-plugin.md) removed the
> fork's cloud speech path — built-in OpenAI-compatible protocols,
> `AppSettings.speech` bindings, and `pi-desktop/speech/*` channels — and
> moved dictation onto the bundled `pi.local-voice` plugin over
> `pi-desktop/dictation/*`. The 2026-10 upstream sync re-adopted this ADR's
> host speech capability (and the live-voice stack) as separate surfaces;
> the inline "Removed by ADR 0355" notes below describe the fork-only
> window between the two syncs.

## Context

Chat, image generation, transcription, and speech synthesis are different jobs, yet
`@earendil-works/pi-ai` has no TTS/ASR surface and Whisper or MIMO TTS must not appear
in the chat model picker.

## Decision

1. The host owns a speech capability independent of chat:
   `transcribe(audio) → text` and `synthesize(text) → audio`.
2. Bindings live on optional `AppSettings.speech` (no schema bump). Each role
   names an existing provider, a model id, and an open protocol id.
   *Fork-only state per ADR 0355 (2026-09-18 to 2026-10); the 2026-10 sync restored this ADR's `AppSettings.speech` block.*
3. Built-in protocols: `openai_audio` (REST `/audio/transcriptions` and
   `/audio/speech`) and `openai_chat_audio` (chat completions `audio` field;
   MIMO `mimo-v2.5-tts`). New vendors add an adapter, not a new IPC channel.
   *Fork-only state per ADR 0355: between the 2026-09 and 2026-10 syncs the
   fork had no built-in speech protocols; the 2026-10 sync restored them.*
4. Plugins may register a protocol with `pi.speech.registerAdapter` under
   high-risk `speech.adapter.register`. Handles stay in the guest; HTTP plans
   are executed by the host with the bound provider's key and must stay on that
   origin. ~~Built-in protocol ids are reserved.~~ *(ADR 0355 briefly removed
   built-in ids in the fork; the 2026-10 sync restored this ADR's text.)*
5. v1 product entry is Settings → AI Voice plus Composer file transcription and
   draft speech. Audio bytes never enter the renderer (path in, scratch out).
   *Fork-only state per ADR 0355: the fork's Settings entry for dictation is
   the local-voice plugin card on the Model configuration tab, beside the
   upstream Voice destination restored by the 2026-10 sync.*6. Out of scope: microphone / `pi.audio` device backend, Realtime, agent
   `transcribe`/`speak` tools, audio as LLM content blocks, changing pi-ai.

## Consequences

- An unconfigured role fails `SPEECH_NOT_CONFIGURED`, and deleting the bound provider
  makes the binding fail `NOT_FOUND`.
- Unloading a plugin drops its protocols.
- Audio bytes never enter the renderer.
