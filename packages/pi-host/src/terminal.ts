import { randomUUID } from "node:crypto";
import { spawn, type IPty } from "node-pty";

export type TerminalSnapshot = {
  terminalId: string;
  replay: string;
};

type TerminalRecord = {
  id: string;
  sessionId: string;
  process: IPty;
  replay: Buffer;
  exited: boolean;
};

const MAX_REPLAY_BYTES = 128 * 1024;

function appendReplay(current: Buffer, chunk: Buffer): Buffer {
  const next = Buffer.concat([current, chunk]);
  return next.length > MAX_REPLAY_BYTES
    ? next.subarray(next.length - MAX_REPLAY_BYTES)
    : next;
}

/** Remote PTYs owned by pi-host; Desktop receives only RACP output events. */
export class RemoteTerminalManager {
  private readonly terminals = new Map<string, TerminalRecord>();

  constructor(
    private readonly onOutput: (event: {
      terminalId: string;
      sessionId: string;
      data: string;
    }) => void,
    private readonly onChanged: (event: {
      terminalId: string;
      sessionId: string;
      status: "open" | "exit";
      exitCode?: number;
    }) => void,
  ) {}

  open(input: {
    sessionId: string;
    cwd: string;
    shell: string;
    columns?: number;
    rows?: number;
  }): TerminalSnapshot {
    const openCount = [...this.terminals.values()].filter(
      (terminal) => terminal.sessionId === input.sessionId && !terminal.exited,
    ).length;
    if (openCount >= 2) {
      throw Object.assign(new Error("the session already has two open terminals"), {
        errorCode: "LIMIT_EXCEEDED",
      });
    }
    const id = `term_${randomUUID()}`;
    const ptyProcess = spawn(input.shell, [], {
      name: "xterm-256color",
      cols: Math.max(2, Math.min(500, input.columns ?? 80)),
      rows: Math.max(2, Math.min(300, input.rows ?? 24)),
      cwd: input.cwd,
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        LANG: process.env.LANG ?? "C.UTF-8",
        TERM: "xterm-256color",
      },
      encoding: "utf8",
    });
    const record: TerminalRecord = {
      id,
      sessionId: input.sessionId,
      process: ptyProcess,
      replay: Buffer.alloc(0),
      exited: false,
    };
    this.terminals.set(id, record);
    ptyProcess.onData((data) => {
      const bytes = Buffer.from(data, "utf8");
      record.replay = appendReplay(record.replay, bytes);
      this.onOutput({
        terminalId: id,
        sessionId: input.sessionId,
        data: bytes.toString("base64"),
      });
    });
    ptyProcess.onExit(({ exitCode }) => {
      record.exited = true;
      this.onChanged({
        terminalId: id,
        sessionId: input.sessionId,
        status: "exit",
        ...(exitCode !== undefined ? { exitCode } : {}),
      });
    });
    this.onChanged({
      terminalId: id,
      sessionId: input.sessionId,
      status: "open",
    });
    return { terminalId: id, replay: record.replay.toString("base64") };
  }

  write(terminalId: string, input: { data?: string; text?: string }): void {
    const terminal = this.require(terminalId);
    if (terminal.exited) {
      throw Object.assign(new Error("terminal has exited"), {
        errorCode: "REMOTE_HOST_UNAVAILABLE",
      });
    }
    if (typeof input.text === "string") terminal.process.write(input.text);
    else if (typeof input.data === "string") {
      terminal.process.write(Buffer.from(input.data, "base64").toString("utf8"));
    }
  }

  resize(terminalId: string, columns: number, rows: number): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.exited) return;
    terminal.process.resize(
      Math.max(2, Math.min(500, columns)),
      Math.max(2, Math.min(300, rows)),
    );
  }

  replay(terminalId: string): string {
    return this.require(terminalId).replay.toString("base64");
  }

  close(terminalId: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.exited) return;
    terminal.process.kill();
  }

  closeSession(sessionId: string): void {
    for (const terminal of this.terminals.values()) {
      if (terminal.sessionId === sessionId) terminal.process.kill();
    }
  }

  closeAll(): void {
    for (const terminal of this.terminals.values()) {
      if (!terminal.exited) terminal.process.kill();
    }
  }

  private require(terminalId: string): TerminalRecord {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw Object.assign(new Error(`terminal ${terminalId} is not open`), {
        errorCode: "NOT_FOUND",
      });
    }
    return terminal;
  }
}
