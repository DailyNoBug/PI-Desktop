import { describe, expect, it } from "vitest";
import { ErrorCodes } from "./errors.js";
import {
  isRemoteProjectPath,
  normalizeRemotePath,
  parseRemoteProjectUri,
  remoteProjectUri,
  validateRemoteConnectionInput,
} from "./remote.js";

describe("remote SSH contracts", () => {
  it("round-trips canonical remote project URIs", () => {
    const uri = remoteProjectUri({
      connectionKey: "gpu-a100",
      remotePath: "/home/dev/project/",
    });
    if (!uri) throw new Error("expected a canonical URI");
    expect(uri).toBe("ssh://gpu-a100/home/dev/project");
    expect(parseRemoteProjectUri(uri)).toEqual({
      connectionKey: "gpu-a100",
      remotePath: "/home/dev/project",
    });
    expect(isRemoteProjectPath(uri)).toBe(true);
    expect(isRemoteProjectPath("/home/dev/project")).toBe(false);
  });

  it("rejects paths and aliases that could escape the URI identity", () => {
    expect(normalizeRemotePath("../escape")).toBeNull();
    expect(normalizeRemotePath("relative")).toBeNull();
    expect(remoteProjectUri({ connectionKey: "bad alias", remotePath: "/tmp" })).toBeNull();
    expect(parseRemoteProjectUri("ssh://gpu-a100/home/dev/../../etc")).toBeNull();
  });

  it("validates managed and OpenSSH connection sources", () => {
    expect(validateRemoteConnectionInput({
      displayName: "GPU",
      source: "ssh-config",
      sshConfigAlias: "gpu",
      enabled: true,
    })).toEqual({ ok: true, value: expect.objectContaining({ sshConfigAlias: "gpu" }) });
    expect(validateRemoteConnectionInput({
      displayName: "GPU",
      source: "managed",
      hostname: "gpu.internal",
      user: "dev",
      port: 2222,
      enabled: true,
    }).ok).toBe(true);
    expect(validateRemoteConnectionInput({
      displayName: "GPU",
      source: "managed",
      enabled: true,
    }).ok).toBe(false);
  });

  it("registers the full SSH failure vocabulary", () => {
    for (const code of [
      ErrorCodes.SSH_NOT_AVAILABLE,
      ErrorCodes.SSH_AUTH_FAILED,
      ErrorCodes.REMOTE_CHECKSUM_MISMATCH,
      ErrorCodes.REMOTE_HOST_VERSION_INCOMPATIBLE,
      ErrorCodes.REMOTE_RECONNECT_EXHAUSTED,
    ]) {
      expect(code).toMatch(/^(SSH_|REMOTE_)/);
    }
  });
});
