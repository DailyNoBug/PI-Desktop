/**
 * Renderer-facing shape of one paired remote `pi-host`. The device token that
 * authenticates the connection stays inside Electron main — the renderer only
 * sees the routing key, label, URL, and last-known live-connection state so
 * the Settings row can render a status pill without a second round trip.
 *
 * Companion of `RemoteHostRecord` inside main (which additionally carries
 * `deviceToken`). See ADR 0286 §Registry and R2b pairing UX.
 */
export type RemoteHostSummary = {
  hostKey: string;
  label: string;
  url: string;
  connected: boolean;
};

/**
 * Input for `remoteHostPair`. The pairing token is single-use and expiring
 * (spec §3.4); the desktop uses it once on the upgrade to call
 * `connection/pair`, exchanges it for a durable device token, and stores that
 * token encrypted with the OS keychain via `safeStorage`.
 */
export type RemoteHostPairRequest = {
  /** `ws://` or `wss://` URL of the paired host's RACP endpoint. */
  url: string;
  /** `ppt1.` pairing token the host issued in its bootstrap output. */
  pairingToken: string;
  /** Human label; the host records it against the minted device. */
  label: string;
  /**
   * Optional stable routing key. Absent means the desktop mints one from the
   * URL host + label; a caller may supply its own to keep the id predictable.
   */
  hostKey?: string;
};

export type RemoteHostPairResult = {
  host: RemoteHostSummary;
};

export type RemoteHostRemoveRequest = {
  hostKey: string;
};
