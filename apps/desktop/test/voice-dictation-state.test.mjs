import assert from "node:assert/strict";
import test from "node:test";
import { INITIAL_VOICE_SNAPSHOT, reduceVoiceSnapshot } from "../src/features/voice/voice-state.ts";
import {
  activeVoiceSession,
  claimVoiceSession,
  releaseVoiceSession,
  resetVoiceSessionRegistry,
  sameVoiceBinding,
} from "../src/features/voice/voice-singleton.ts";

const binding = { windowId: "w1", sessionId: "s1", composerId: "docked" };

test("full success path walks the explicit states", () => {
  let state = reduceVoiceSnapshot(INITIAL_VOICE_SNAPSHOT, {
    type: "permission-requested",
    binding,
  });
  assert.equal(state.state, "requesting-permission");
  assert.deepEqual(state.binding, binding);

  state = reduceVoiceSnapshot(state, { type: "recording-started", startedAt: 1000 });
  assert.equal(state.state, "recording");
  assert.equal(state.startedAt, 1000);

  state = reduceVoiceSnapshot(state, { type: "stop-requested" });
  assert.equal(state.state, "stopping");

  state = reduceVoiceSnapshot(state, { type: "audio-ready" });
  assert.equal(state.state, "transcribing");
  assert.equal(state.durationMs !== null, true);

  state = reduceVoiceSnapshot(state, { type: "transcription-succeeded" });
  assert.equal(state.state, "ready");

  state = reduceVoiceSnapshot(state, { type: "reset" });
  assert.deepEqual(state, INITIAL_VOICE_SNAPSHOT);
});

test("permission denial lands in error and reset recovers to idle", () => {
  let state = reduceVoiceSnapshot(INITIAL_VOICE_SNAPSHOT, {
    type: "permission-requested",
    binding,
  });
  state = reduceVoiceSnapshot(state, {
    type: "permission-denied",
    message: "denied by OS",
  });
  assert.equal(state.state, "error");
  assert.equal(state.errorCode, "VOICE_MIC_PERMISSION_DENIED");
  assert.deepEqual(
    reduceVoiceSnapshot(state, { type: "reset" }),
    INITIAL_VOICE_SNAPSHOT,
  );
});

test("cancel from recording returns to idle", () => {
  let state = reduceVoiceSnapshot(INITIAL_VOICE_SNAPSHOT, {
    type: "permission-requested",
    binding,
  });
  state = reduceVoiceSnapshot(state, { type: "recording-started", startedAt: 1 });
  state = reduceVoiceSnapshot(state, { type: "cancelled" });
  assert.deepEqual(state, INITIAL_VOICE_SNAPSHOT);
});

test("cancel during transcription returns to idle", () => {
  let state = reduceVoiceSnapshot(INITIAL_VOICE_SNAPSHOT, {
    type: "permission-requested",
    binding,
  });
  state = reduceVoiceSnapshot(state, { type: "recording-started", startedAt: 1 });
  state = reduceVoiceSnapshot(state, { type: "stop-requested" });
  state = reduceVoiceSnapshot(state, { type: "audio-ready" });
  state = reduceVoiceSnapshot(state, { type: "cancelled" });
  assert.deepEqual(state, INITIAL_VOICE_SNAPSHOT);
});

test("transcription failure is a structured error that resets cleanly", () => {
  let state = reduceVoiceSnapshot(INITIAL_VOICE_SNAPSHOT, {
    type: "permission-requested",
    binding,
  });
  state = reduceVoiceSnapshot(state, { type: "recording-started", startedAt: 1 });
  state = reduceVoiceSnapshot(state, { type: "stop-requested" });
  state = reduceVoiceSnapshot(state, { type: "audio-ready" });
  state = reduceVoiceSnapshot(state, {
    type: "transcription-failed",
    code: "PROVIDER_ERROR",
    message: "HTTP 500",
  });
  assert.equal(state.state, "error");
  assert.equal(state.errorCode, "PROVIDER_ERROR");
  assert.deepEqual(
    reduceVoiceSnapshot(state, { type: "reset" }),
    INITIAL_VOICE_SNAPSHOT,
  );
});

test("out-of-order actions are inert (no boolean conflicts)", () => {
  // audio-ready cannot fire before stop was requested
  let state = reduceVoiceSnapshot(INITIAL_VOICE_SNAPSHOT, {
    type: "permission-requested",
    binding,
  });
  state = reduceVoiceSnapshot(state, { type: "audio-ready" });
  assert.equal(state.state, "requesting-permission");
  // transcription-succeeded cannot fire while recording
  state = reduceVoiceSnapshot(state, { type: "recording-started", startedAt: 1 });
  state = reduceVoiceSnapshot(state, { type: "transcription-succeeded" });
  assert.equal(state.state, "recording");
  // stop cannot fire from idle
  assert.deepEqual(
    reduceVoiceSnapshot(INITIAL_VOICE_SNAPSHOT, { type: "stop-requested" }),
    INITIAL_VOICE_SNAPSHOT,
  );
});

test("a second start from error is allowed (retry after failure)", () => {
  let state = reduceVoiceSnapshot(INITIAL_VOICE_SNAPSHOT, {
    type: "permission-requested",
    binding,
  });
  state = reduceVoiceSnapshot(state, { type: "permission-denied", message: "no" });
  state = reduceVoiceSnapshot(state, {
    type: "permission-requested",
    binding,
  });
  assert.equal(state.state, "requesting-permission");
});

test("singleton allows exactly one active recording", () => {
  resetVoiceSessionRegistry();
  const other = { windowId: "w1", sessionId: "s2", composerId: "home" };
  assert.equal(claimVoiceSession(binding), true);
  assert.equal(claimVoiceSession(other), false);
  assert.deepEqual(activeVoiceSession(), binding);
  // only the owner may release
  releaseVoiceSession(other);
  assert.deepEqual(activeVoiceSession(), binding);
  releaseVoiceSession(binding);
  assert.equal(activeVoiceSession(), null);
  assert.equal(claimVoiceSession(other), true);
  resetVoiceSessionRegistry();
});

test("sameVoiceBinding compares the window/session/composer triple", () => {
  assert.equal(sameVoiceBinding(binding, { ...binding }), true);
  assert.equal(
    sameVoiceBinding(binding, { ...binding, sessionId: "s2" }),
    false,
  );
  assert.equal(
    sameVoiceBinding(binding, { ...binding, composerId: "home" }),
    false,
  );
});
