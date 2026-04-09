import { useEffect, useRef } from "react";
import { Eraser, Radio } from "lucide-react";
import { useLogStream } from "@/hooks/logs/useLogStream";
import type { LogEntry } from "@/functions/remote/logStream";

interface LogPanelProps {
  sessionId: string | null;
  isOpen: boolean;
  onToggle: () => void;
}

function formatTime(timestamp: string): string {
  try {
    const d = new Date(timestamp);
    return d.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "??:??:??";
  }
}

function streamColor(stream: LogEntry["stream"]): string {
  switch (stream) {
    case "stderr":
      return "text-amber-400";
    case "status":
      return "text-blue-400";
    default:
      return "text-foreground/80";
  }
}

export function LogPanel({ sessionId, isOpen, onToggle }: LogPanelProps) {
  const { logs, isConnected, clear } = useLogStream(sessionId, isOpen);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // Auto-scroll when new logs arrive if user is at the bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs]);

  // Track whether user has scrolled up
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    stickToBottomRef.current = atBottom;
  };

  if (!isOpen) return null;

  return (
    <div className="h-full flex flex-col bg-neutral-950 text-neutral-200 overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-neutral-800 shrink-0">
        <div className="flex items-center gap-2 text-xs text-neutral-400">
          <button onClick={onToggle} className="hover:text-neutral-200 font-medium">
            Logs
          </button>
          <span
            className={`inline-flex items-center gap-1 ${isConnected ? "text-emerald-400" : "text-neutral-600"}`}
          >
            <Radio className="h-3 w-3" />
            {isConnected ? "Connected" : "Disconnected"}
          </span>
        </div>
        <button
          onClick={clear}
          className="text-neutral-500 hover:text-neutral-200 transition-colors"
          aria-label="Clear logs"
        >
          <Eraser className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Log content */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-hidden font-mono text-xs leading-relaxed px-3 py-1 select-text"
      >
        {logs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-neutral-600 text-xs">
            {sessionId ? "Waiting for logs…" : "No session selected"}
          </div>
        ) : (
          logs.map((entry, i) => (
            <div key={i} className={`whitespace-pre-wrap break-all ${streamColor(entry.stream)}`}>
              <span className="text-neutral-600">[{formatTime(entry.timestamp)}]</span>{" "}
              {entry.message}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
