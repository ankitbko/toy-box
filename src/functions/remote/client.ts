// HTTP client for the Foundry hosted agent invocations endpoint.
// Sends user messages and returns an SSE stream of SDK events.

import { getAuthToken } from "./auth";
import { parseSSEStream } from "./sseParser";
import type {
  HostedAgentConfig,
  InvocationBody,
  InvocationDonePayload,
  RemoteSdkEvent,
} from "./types";

export type InvocationResult = {
  /** Async iterator of SDK events from the remote agent */
  events: AsyncGenerator<RemoteSdkEvent>;
  /** Promise that resolves with the done payload when the stream completes */
  done: Promise<InvocationDonePayload | undefined>;
};

/**
 * Invoke the remote hosted agent with a message.
 * Returns an async generator of SDK events and a promise for the completion payload.
 */
export async function invokeAgent(
  config: HostedAgentConfig,
  sessionId: string,
  body: InvocationBody,
): Promise<InvocationResult> {
  const token = await getAuthToken();

  const url = new URL(`${config.agentBaseUrl}/endpoint/protocols/invocations`);
  url.searchParams.set("api-version", config.apiVersion);
  url.searchParams.set("agent_session_id", sessionId);

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Foundry-Features": "HostedAgents=V1Preview",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const message = `Invocation failed (${response.status}): ${errorText}`;
    console.error(`[remote] ${message}`);
    throw new Error(message);
  }

  if (!response.body) {
    throw new Error("Invocation response has no body");
  }

  let resolveDone: (payload: InvocationDonePayload | undefined) => void;
  const donePromise = new Promise<InvocationDonePayload | undefined>((resolve) => {
    resolveDone = resolve;
  });

  const responseBody = response.body;

  async function* iterateEvents(): AsyncGenerator<RemoteSdkEvent> {
    try {
      for await (const frame of parseSSEStream(responseBody)) {
        if (frame.event === "done") {
          try {
            resolveDone(JSON.parse(frame.data));
          } catch {
            resolveDone(undefined);
          }
          return;
        }

        try {
          const parsed = JSON.parse(frame.data) as RemoteSdkEvent;
          yield parsed;
        } catch {
          // Skip malformed event data
          console.warn("[remote] Skipping malformed SSE data:", frame.data);
        }
      }
    } finally {
      resolveDone(undefined);
    }
  }

  return {
    events: iterateEvents(),
    done: donePromise,
  };
}

/**
 * Retrieve the response header value for the session ID from a response.
 * The platform sets x-agent-session-id on invocation responses.
 */
export function getSessionIdFromHeaders(headers: Headers): string | undefined {
  return headers.get("x-agent-session-id") ?? undefined;
}
