import assert from "node:assert/strict";
import test from "node:test";
import { decideMediaPermission } from "../electron/main/voice/voice-media-permission.ts";

const MAIN_ID = 7;

test("grants audio-only media capture for the main window", () => {
  assert.equal(
    decideMediaPermission({
      requestingWebContentsId: MAIN_ID,
      mainWebContentsId: MAIN_ID,
      permission: "media",
      mediaTypes: ["audio"],
    }),
    "allow",
  );
});

test("denies media capture from any other web contents", () => {
  assert.equal(
    decideMediaPermission({
      requestingWebContentsId: 99,
      mainWebContentsId: MAIN_ID,
      permission: "media",
      mediaTypes: ["audio"],
    }),
    "deny",
  );
});

test("denies when the main window identity is unknown", () => {
  assert.equal(
    decideMediaPermission({
      requestingWebContentsId: MAIN_ID,
      mainWebContentsId: null,
      permission: "media",
      mediaTypes: ["audio"],
    }),
    "deny",
  );
});

test("denies requests that also ask for camera or video", () => {
  assert.equal(
    decideMediaPermission({
      requestingWebContentsId: MAIN_ID,
      mainWebContentsId: MAIN_ID,
      permission: "media",
      mediaTypes: ["audio", "video"],
    }),
    "deny",
  );
  assert.equal(
    decideMediaPermission({
      requestingWebContentsId: MAIN_ID,
      mainWebContentsId: MAIN_ID,
      permission: "media",
      mediaTypes: ["video"],
    }),
    "deny",
  );
});

test("denies audio requests whose capture kinds are unspecified", () => {
  assert.equal(
    decideMediaPermission({
      requestingWebContentsId: MAIN_ID,
      mainWebContentsId: MAIN_ID,
      permission: "media",
    }),
    "deny",
  );
  assert.equal(
    decideMediaPermission({
      requestingWebContentsId: MAIN_ID,
      mainWebContentsId: MAIN_ID,
      permission: "media",
      mediaTypes: [],
    }),
    "deny",
  );
});

test("denies every non-media permission outright", () => {
  for (const permission of ["camera", "notifications", "clipboard-read", "geolocation"]) {
    assert.equal(
      decideMediaPermission({
        requestingWebContentsId: MAIN_ID,
        mainWebContentsId: MAIN_ID,
        permission,
        mediaTypes: ["audio"],
      }),
      "deny",
      permission,
    );
  }
});
