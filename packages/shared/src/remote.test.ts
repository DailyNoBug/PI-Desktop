import { describe, expect, it } from "vitest";
import { ErrorCodes } from "./errors.js";
import {
  isRemoteProjectPath,
  normalizeRemotePath,
  parseSshHostTarget,
  compareApplicationVersions,
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

  it("parses Codex-style SSH host targets", () => {
    expect(parseSshHostTarget("root@gpu.internal")).toEqual({
      user: "root",
      hostname: "gpu.internal",
    });
    expect(parseSshHostTarget("gpu.internal")).toEqual({ hostname: "gpu.internal" });
    expect(parseSshHostTarget("[::1]")).toEqual({ hostname: "[::1]" });
    expect(parseSshHostTarget("bad user@host")).toBeNull();
    expect(parseSshHostTarget("root@")).toBeNull();
    expect(parseSshHostTarget("@host")).toBeNull();
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

  it("validates explicit managed SSH authentication choices", () => {
    const password = validateRemoteConnectionInput({
      displayName: "GPU",
      source: "managed",
      hostname: "gpu.internal",
      authMethod: "password",
      password: "secret-value",
      enabled: true,
    });
    expect(password).toEqual({
      ok: true,
      value: expect.objectContaining({
        authMethod: "password",
        password: "secret-value",
      }),
    });

    expect(validateRemoteConnectionInput({
      displayName: "GPU",
      source: "managed",
      hostname: "gpu.internal",
      authMethod: "identity",
      enabled: true,
    }).ok).toBe(false);
    expect(validateRemoteConnectionInput({
      displayName: "GPU",
      source: "managed",
      hostname: "gpu.internal",
      authMethod: "identity",
      identityFilePath: "/Users/dev/.ssh/id_ed25519",
      enabled: true,
    }).ok).toBe(true);
    expect(validateRemoteConnectionInput({
      displayName: "GPU",
      source: "managed",
      hostname: "gpu.internal",
      identityFilePath: "/Users/dev/.ssh/id_ed25519",
      enabled: true,
    })).toEqual({
      ok: true,
      value: expect.objectContaining({ authMethod: "identity" }),
    });
    expect(validateRemoteConnectionInput({
      displayName: "GPU",
      source: "ssh-config",
      sshConfigAlias: "gpu",
      authMethod: "password",
      password: "secret-value",
      enabled: true,
    }).ok).toBe(false);
    expect(validateRemoteConnectionInput({
      displayName: "GPU",
      source: "managed",
      hostname: "gpu.internal",
      authMethod: "password",
      identityFilePath: "/Users/dev/.ssh/id_ed25519",
      password: "secret-value",
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

  it("orders application versions without treating every mismatch as older", () => {
    expect(compareApplicationVersions("0.14.6-rc.4", "0.14.6")).toBe(-1);
    expect(compareApplicationVersions("v0.15.0", "0.14.9")).toBe(1);
    expect(compareApplicationVersions("1.2.3-rc.2", "1.2.3-rc.10")).toBe(-1);
    expect(compareApplicationVersions("unknown", "unknown")).toBe(0);
  });
});
