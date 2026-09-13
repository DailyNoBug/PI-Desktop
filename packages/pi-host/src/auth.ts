import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RacpAuthenticationResult } from "@pi-desktop/agent-host";

const DEVICE_TOKEN_FILE = "device.token";

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Owner credentials for a user-owned pi-host. Tokens never enter URLs. */
export class HostAuthentication {
  private constructor(
    private readonly runtimeDir: string,
    private deviceToken: string | null,
    private pairingToken: string | null,
    private readonly pairingExpiresAt: number,
  ) {}

  static create(runtimeDir: string, pairingTtlMs = 10 * 60_000): HostAuthentication {
    let deviceToken: string | null = null;
    const path = join(runtimeDir, DEVICE_TOKEN_FILE);
    if (existsSync(path)) {
      try {
        const value = readFileSync(path, "utf8").trim();
        if (value.length >= 32) deviceToken = value;
      } catch {
        deviceToken = null;
      }
    }
    return new HostAuthentication(
      runtimeDir,
      deviceToken,
      randomBytes(32).toString("base64url"),
      Date.now() + pairingTtlMs,
    );
  }

  get hasDevice(): boolean {
    return this.deviceToken !== null;
  }

  get pairing(): { token: string; expiresAt: string } | null {
    return this.pairingToken && Date.now() < this.pairingExpiresAt
      ? { token: this.pairingToken, expiresAt: new Date(this.pairingExpiresAt).toISOString() }
      : null;
  }

  authenticate(bearerToken: string): RacpAuthenticationResult | null {
    const principal = {
      subject: "desktop",
      roles: ["owner" as const],
      pairedDevice: true,
    };
    if (this.deviceToken && sameToken(bearerToken, this.deviceToken)) {
      return { principal };
    }
    if (
      this.pairingToken &&
      Date.now() < this.pairingExpiresAt &&
      sameToken(bearerToken, this.pairingToken)
    ) {
      const issued = randomBytes(32).toString("base64url");
      this.pairingToken = null;
      this.deviceToken = issued;
      writeFileSync(join(this.runtimeDir, DEVICE_TOKEN_FILE), `${issued}\n`, { mode: 0o600 });
      chmodSync(join(this.runtimeDir, DEVICE_TOKEN_FILE), 0o600);
      return { principal, deviceToken: issued };
    }
    return null;
  }

  revokeDevice(): boolean {
    if (!this.deviceToken) return false;
    this.deviceToken = null;
    writeFileSync(join(this.runtimeDir, DEVICE_TOKEN_FILE), "\n", { mode: 0o600 });
    return true;
  }
}
