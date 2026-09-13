import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { IconX } from "../icons";
import { TooltipButton } from "../ui";

const MAX_OUTPUT_CHARACTERS = 256 * 1024;

function decodeRemoteOutput(value: string, decoder: TextDecoder): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return decoder.decode(bytes, { stream: true });
}

export function TerminalTab({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const terminalIdRef = useRef<string | null>(null);
  const closedRef = useRef(false);
  const outputRef = useRef<HTMLPreElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const meterRef = useRef<HTMLSpanElement | null>(null);
  const sizeRef = useRef<{ columns: number; rows: number } | null>(null);
  const decoderRef = useRef(new TextDecoder());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const snapshot = await api.openRemoteTerminal({ sessionId, columns: 80, rows: 24 });
        if (cancelled) {
          void api.closeRemoteTerminal({ sessionId, terminalId: snapshot.terminalId }).catch(() => undefined);
          return;
        }
        terminalIdRef.current = snapshot.terminalId;
        setTerminalId(snapshot.terminalId);
        setOutput((current) => decodeRemoteOutput(snapshot.replay, decoderRef.current) + current);
      } catch (nextError) {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    })();
    return () => {
      cancelled = true;
      const id = terminalIdRef.current;
      if (id && !closedRef.current) {
        void api.closeRemoteTerminal({ sessionId, terminalId: id }).catch(() => undefined);
      }
      terminalIdRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => api.onRemoteTerminalEvent((event) => {
    if (event.sessionId !== sessionId || event.terminalId !== terminalIdRef.current) return;
    if (event.kind === "output") {
      setOutput((current) => (current + decodeRemoteOutput(event.data, decoderRef.current)).slice(-MAX_OUTPUT_CHARACTERS));
      return;
    }
    if (event.status === "exit") {
      closedRef.current = true;
      setClosed(true);
    }
  }), [sessionId]);

  useEffect(() => {
    const element = outputRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [output]);

  useEffect(() => {
    const surface = surfaceRef.current;
    const meter = meterRef.current;
    if (!surface || !meter) return;
    const observer = new ResizeObserver(() => {
      const styles = getComputedStyle(meter);
      const columns = Math.max(2, Math.min(500, Math.floor(surface.clientWidth / parseFloat(styles.width))));
      const rows = Math.max(2, Math.min(300, Math.floor(surface.clientHeight / parseFloat(styles.lineHeight))));
      const previous = sizeRef.current;
      if (previous?.columns === columns && previous?.rows === rows) return;
      sizeRef.current = { columns, rows };
      const id = terminalIdRef.current;
      if (id) void api.resizeRemoteTerminal({ sessionId, terminalId: id, columns, rows }).catch(() => undefined);
    });
    observer.observe(surface);
    return () => observer.disconnect();
  }, [sessionId, terminalId]);

  const send = async (text: string) => {
    const id = terminalIdRef.current;
    if (!id || closedRef.current || !text) return;
    try {
      await api.writeRemoteTerminal({ sessionId, terminalId: id, text });
      setInput("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  };

  const close = async () => {
    const id = terminalIdRef.current;
    if (!id || closedRef.current) return;
    closedRef.current = true;
    setClosed(true);
    try {
      await api.closeRemoteTerminal({ sessionId, terminalId: id });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  };

  return (
    <div className="remote-terminal">
      <header className="remote-terminal-header">
        <span>{t("panel.tabs.terminal")}</span>
        {terminalId ? (
          <TooltipButton
            tooltip={t("common.close")}
            ariaLabel={t("common.close")}
            className="plugins-icon-btn"
            disabled={closed}
            onClick={() => void close()}
          >
            <IconX size={14} />
          </TooltipButton>
        ) : null}
      </header>
      <div className="remote-terminal-surface" ref={surfaceRef}>
        <span className="remote-terminal-meter" ref={meterRef}>M</span>
        <pre ref={outputRef} tabIndex={0}>{output}</pre>
      </div>
      {error ? <p className="remote-terminal-error">{error}</p> : null}
      {closed ? (
        <div className="remote-terminal-closed">{t("remote.terminalDisconnected")}</div>
      ) : (
        <form
          className="remote-terminal-input"
          onSubmit={(event) => {
            event.preventDefault();
            void send(`${input}\n`);
          }}
        >
          <input
            value={input}
            aria-label={t("remote.terminalInput")}
            spellCheck={false}
            autoComplete="off"
            disabled={!terminalId}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "c" && event.ctrlKey && !input) {
                event.preventDefault();
                void send("\u0003");
              }
            }}
          />
        </form>
      )}
    </div>
  );
}
