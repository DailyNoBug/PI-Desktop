/**
 * First-party SSH exec tool for local agent sessions, covering remote SSH
 * connections degraded to pure SSH. host-core only routes `plugin_`/`mcp_`
 * tool names to the desktop runner (host-core tools::is_desktop_dispatched),
 * so the reserved name keeps the prefix and is intercepted by the desktop
 * runner before the plugin catalog. The schema carries no credential
 * material; values are applied only inside Main during execution.
 */
export const REMOTE_SSH_TOOL_NAME = "plugin_desktop_ssh";

export const remoteSshTool = {
  name: REMOTE_SSH_TOOL_NAME,
  description:
    "Run shell commands on remote servers reached by this desktop's SSH connections. " +
    "Credentials are applied by the desktop and never appear in inputs or outputs. " +
    'Use {"action":"list"} to see connected servers, then {"action":"exec"} with a ' +
    "connection name from the list.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "exec"],
        description: "list connected servers, or exec a command on one of them",
      },
      connection: {
        type: "string",
        description: "connection name exactly as returned by action:list (required for exec)",
      },
      command: {
        type: "string",
        description: "shell command to run on the remote server (required for exec)",
      },
      timeoutMs: {
        type: "number",
        description: "maximum runtime in milliseconds, 5000-300000; default 60000",
      },
    },
    required: ["action"],
  },
  risk: "medium" as const,
  // Listing is read-only; exec is an arbitrary remote command and needs
  // agent mode (ADR 0211).
  planSafeActions: ["list"] as readonly string[],
};
