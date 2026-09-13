import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePiDesktopDeepLink } from "../electron/main/deep-link.ts";

test("deep links add SSH connections with bounded fields", () => {
  const link = parsePiDesktopDeepLink(
    "pi-desktop://connections/ssh/add?name=GPU&alias=gpu-server&user=dev&port=2222",
  );
  assert.deepEqual(link, {
    kind: "add-ssh-connection",
    name: "GPU",
    alias: "gpu-server",
    user: "dev",
    port: 2222,
  });
  assert.equal(parsePiDesktopDeepLink("pi-desktop://connections/ssh/add"), null);
  assert.equal(
    parsePiDesktopDeepLink("pi-desktop://connections/ssh/add?name=GPU&alias=bad%20alias"),
    null,
  );
});

test("remote project deep links require a safe connection and absolute path", () => {
  assert.deepEqual(
    parsePiDesktopDeepLink(
      "pi-desktop://projects/remote/open?connection=gpu-server&path=%2Fhome%2Fdev%2Fproject",
    ),
    {
      kind: "open-remote-project",
      connectionKey: "gpu-server",
      remotePath: "/home/dev/project",
    },
  );
  assert.equal(
    parsePiDesktopDeepLink("pi-desktop://projects/remote/open?connection=*&path=/tmp"),
    null,
  );
  assert.equal(
    parsePiDesktopDeepLink(
      "pi-desktop://projects/remote/open?connection=gpu&path=/home/../etc",
    ),
    null,
  );
  assert.equal(parsePiDesktopDeepLink("https://example.test"), null);
});
