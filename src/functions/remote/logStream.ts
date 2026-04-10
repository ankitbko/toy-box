import { createServerFn } from "@tanstack/react-start";
import { RawStream } from "@tanstack/router-core";
import { zodValidator } from "@tanstack/zod-adapter";
import { z } from "zod";
import { getAuthToken } from "./auth";
import { getAgentConfig, hasAgentConfig } from "../state/sessionCache";
import { parseSSEStream } from "./sseParser";

export type LogEntry = {
  timestamp: string;
  stream: "stderr" | "stdout" | "status";
  message: string;
};

const encoder = new TextEncoder();

function encodeLogEntry(entry: LogEntry): Uint8Array {
  return encoder.encode(JSON.stringify(entry) + "\n");
}

function emptyStream(): RawStream {
  return new RawStream(
    new ReadableStream({
      start(c) {
        c.close();
      },
    }),
    { hint: "text" },
  );
}

export const connectLogStream = createServerFn({ method: "POST" })
  .inputValidator(zodValidator(z.object({ sessionId: z.string() })))
  .handler(async ({ data }) => {
    if (!hasAgentConfig()) {
      return emptyStream();
    }

    const config = getAgentConfig();
    const token = await getAuthToken();

    const url = new URL(`${config.agentBaseUrl}/sessions/${data.sessionId}:logstream`);
    url.searchParams.set("api-version", config.apiVersion);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Foundry-Features": "HostedAgents=V1Preview",
      },
    });

    if (!response.ok || !response.body) {
      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        console.error(`[remote] Log stream failed (${response.status}): ${errorText}`);
      }
      return emptyStream();
    }

    // Parse SSE and re-encode as NDJSON
    const sseBody = response.body;
    const outputStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const frame of parseSSEStream(sseBody)) {
            if (frame.event !== "log" && frame.event !== undefined) continue;
            try {
              const parsed = JSON.parse(frame.data);
              const entry: LogEntry = {
                timestamp: parsed.timestamp ?? new Date().toISOString(),
                stream: parsed.stream ?? "stdout",
                message: parsed.message ?? "",
              };
              controller.enqueue(encodeLogEntry(entry));
            } catch {
              // Skip malformed data
            }
          }
        } catch {
          // Stream ended or errored
        } finally {
          controller.close();
        }
      },
    });

    return new RawStream(outputStream, { hint: "text" });
  });
