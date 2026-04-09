// SSE (Server-Sent Events) stream parser.
// Parses text/event-stream responses from the Foundry hosted agent
// into typed SSE frames.

import type { SSEFrame } from "./types";

/**
 * Parse an SSE stream (ReadableStream<Uint8Array>) into an async generator
 * of SSEFrame objects.
 *
 * Handles:
 * - `data:` lines (concatenated with newlines for multi-line data)
 * - `event:` lines (set the event name)
 * - Empty lines (frame boundary — yields the accumulated frame)
 * - Lines starting with `:` (comments — ignored)
 */
export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEFrame> {
  const reader = stream
    .pipeThrough(new TextDecoderStream() as ReadableWritablePair<string, Uint8Array>)
    .getReader();

  let buffer = "";
  let currentEvent: string | undefined;
  let dataLines: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += value;
      const lines = buffer.split("\n");
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line === "" || line === "\r") {
          // Empty line = frame boundary
          if (dataLines.length > 0) {
            yield {
              event: currentEvent,
              data: dataLines.join("\n"),
            };
          }
          currentEvent = undefined;
          dataLines = [];
          continue;
        }

        if (line.startsWith(":")) {
          // Comment line — ignore
          continue;
        }

        const colonIndex = line.indexOf(":");
        if (colonIndex === -1) continue;

        const field = line.slice(0, colonIndex);
        // Value starts after colon + optional space
        let fieldValue = line.slice(colonIndex + 1);
        if (fieldValue.startsWith(" ")) {
          fieldValue = fieldValue.slice(1);
        }
        // Remove trailing \r if present
        if (fieldValue.endsWith("\r")) {
          fieldValue = fieldValue.slice(0, -1);
        }

        if (field === "data") {
          dataLines.push(fieldValue);
        } else if (field === "event") {
          currentEvent = fieldValue;
        }
        // Ignore other fields (id, retry, etc.)
      }
    }

    // Flush any remaining data
    if (dataLines.length > 0) {
      yield {
        event: currentEvent,
        data: dataLines.join("\n"),
      };
    }
  } finally {
    reader.releaseLock();
  }
}
