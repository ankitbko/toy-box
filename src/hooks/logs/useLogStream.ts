import { useState, useEffect, useRef, useCallback } from "react";
import { connectLogStream, type LogEntry } from "@/functions/remote/logStream";

const MAX_LOG_LINES = 1000;

export function useLogStream(sessionId: string | null, enabled: boolean) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const clear = useCallback(() => setLogs([]), []);

  useEffect(() => {
    if (!sessionId || !enabled) {
      setIsConnected(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setIsConnected(true);
    setLogs([]);

    (async () => {
      try {
        const raw = await connectLogStream({
          data: { sessionId },
          signal: controller.signal,
        });
        const stream = raw as unknown as ReadableStream<Uint8Array>;
        const reader = stream
          .pipeThrough(new TextDecoderStream() as ReadableWritablePair<string, Uint8Array>)
          .getReader();
        let buffer = "";

        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += value;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          const newEntries: LogEntry[] = [];
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              newEntries.push(JSON.parse(line));
            } catch {
              // Skip malformed lines
            }
          }

          if (newEntries.length > 0) {
            setLogs((prev) => {
              const combined = [...prev, ...newEntries];
              return combined.length > MAX_LOG_LINES
                ? combined.slice(combined.length - MAX_LOG_LINES)
                : combined;
            });
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        console.error("Log stream error:", error);
      } finally {
        setIsConnected(false);
      }
    })();

    return () => {
      controller.abort();
      abortRef.current = null;
    };
  }, [sessionId, enabled]);

  return { logs, isConnected, clear };
}
