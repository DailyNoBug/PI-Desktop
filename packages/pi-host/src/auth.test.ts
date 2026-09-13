import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HostAuthentication } from "./auth.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  directories.length = 0;
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-host-auth-"));
  directories.push(directory);
  return directory;
}

describe("HostAuthentication", () => {
  it("issues one owner device token and spends the pairing token", async () => {
    const directory = await temporaryDirectory();
    const auth = HostAuthentication.create(directory);
    const pairing = auth.pairing;
    expect(pairing?.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);

    const paired = auth.authenticate(pairing!.token);
    if (!paired?.deviceToken) throw new Error("pairing did not issue a device token");
    expect(paired?.principal.roles).toEqual(["owner"]);
    expect(paired?.deviceToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(auth.authenticate(pairing!.token)).toBeNull();
    expect(auth.authenticate(paired.deviceToken)?.principal.subject).toBe("desktop");

    const stored = (await readFile(join(directory, "device.token"), "utf8")).trim();
    expect(stored).toBe(paired.deviceToken);
  });

  it("loads an existing device token and can revoke it", async () => {
    const directory = await temporaryDirectory();
    const first = HostAuthentication.create(directory);
    const pairing = first.pairing!;
    const issued = first.authenticate(pairing.token)!.deviceToken!;

    const second = HostAuthentication.create(directory);
    expect(second.pairing).not.toBeNull();
    expect(second.authenticate(issued)?.principal.pairedDevice).toBe(true);
    expect(second.revokeDevice()).toBe(true);
    expect(second.authenticate(issued)).toBeNull();
    expect(second.revokeDevice()).toBe(false);
  });
});
