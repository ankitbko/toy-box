// Server function definitions for session management (remote hosted agent)
// These are the RPC boundary — safe to import from anywhere

import { createServerFn } from "@tanstack/react-start";
import { RawStream } from "@tanstack/router-core";
import { zodValidator } from "@tanstack/zod-adapter";
import { z } from "zod";
import { listSessions } from "./remote/sessionApi";
import { getAgentConfig, hasAgentConfig, deleteSession } from "./state/sessionCache";
import { getSessionMetadataStore } from "./state/sessionStore";
import { getUnreadSessionIds, markSessionRead } from "./state/unread";
import { SessionStream, createSessionEventStream } from "./runtime/stream";
import { applySessionEvent, createInitialSession } from "@/lib/session/sessionReducer";
import { isAutomationRunSession } from "@/lib/automation/sessionId";
import type {
  Message,
  ModelInfo,
  SessionEvent,
  SessionMetadata,
  SessionSkill,
  SessionSnapshot,
  SessionWorktree,
} from "@/types";
import { encodeSessionEvent } from "@/lib/session/streamCodec";

// ============================================================================
// Input Schemas (Zod)
// ============================================================================

const sessionInputSchema = z.object({
  sessionId: z.string(),
});

const streamInputSchema = z.object({
  sessionId: z.string(),
  prompt: z.string().optional(),
  clientMessageId: z.string().optional(),
  afterEventId: z.number().int().nonnegative().optional(),
  attachments: z
    .array(
      z.object({
        displayName: z.string(),
        mimeType: z.string(),
        base64: z.string().optional(),
      }),
    )
    .optional(),
  startNew: z.boolean().optional(),
  model: z.string().optional(),
  directory: z.string().optional(),
});

const enqueueInputSchema = z.object({
  sessionId: z.string(),
  content: z.string(),
  queuedMessageId: z.string().optional(),
  attachments: z
    .array(
      z.object({
        displayName: z.string(),
        mimeType: z.string(),
        base64: z.string().optional(),
      }),
    )
    .optional(),
});

const cancelQueuedInputSchema = z.object({
  sessionId: z.string(),
  queuedMessageId: z.string(),
});

const sessionsStateInputSchema = z
  .object({
    openSessionIds: z.array(z.string()).max(4).optional(),
  })
  .default({});

// ============================================================================
// Server Functions
// ============================================================================

export type SessionsState = {
  sessions: SessionMetadata[];
  streamingSessionIds: string[];
  unreadSessionIds: string[];
  worktrees: Record<string, SessionWorktree>;
};

/** Fetch list + streaming + unread state in a single round-trip */
export const getSessionsState = createServerFn({ method: "GET" })
  .inputValidator(zodValidator(sessionsStateInputSchema))
  .handler(async ({ data }): Promise<SessionsState> => {
    for (const sessionId of new Set(data.openSessionIds ?? [])) {
      markSessionRead(sessionId);
    }

    // If agent config is not set yet, return empty state gracefully
    if (!hasAgentConfig()) {
      return {
        sessions: [],
        streamingSessionIds: SessionStream.getRunningSessionIds(),
        unreadSessionIds: getUnreadSessionIds(),
        worktrees: {},
      };
    }

    const config = getAgentConfig();
    const [platformSessions, metadataStore] = await Promise.all([
      listSessions(config, { order: "desc" }),
      getSessionMetadataStore(),
    ]);

    // Map platform sessions to SessionMetadata, enriching with local summaries
    const localMetadata = await metadataStore.getByIds(
      platformSessions.data.map((s) => s.agent_session_id),
    );

    const sessions: SessionMetadata[] = platformSessions.data.map((ps) => {
      const local = localMetadata.get(ps.agent_session_id);
      return {
        sessionId: ps.agent_session_id,
        startTime: new Date(ps.created_at * 1000),
        modifiedTime: new Date(ps.last_accessed_at * 1000),
        summary: local?.summary ?? "",
        isRemote: true,
      };
    });

    return {
      sessions,
      streamingSessionIds: SessionStream.getRunningSessionIds(),
      unreadSessionIds: getUnreadSessionIds(),
      worktrees: {},
    };
  });

/** Mark a session as read */
export const markSessionAsRead = createServerFn({ method: "POST" })
  .inputValidator(zodValidator(sessionInputSchema))
  .handler(async ({ data }) => {
    markSessionRead(data.sessionId);
    return { success: true };
  });

/** Mark a session as unread */
export const markSessionAsUnread = createServerFn({ method: "POST" })
  .inputValidator(zodValidator(sessionInputSchema))
  .handler(async ({ data }) => {
    const { markSessionUnread } = await import("./state/unread");
    markSessionUnread(data.sessionId);
    return { success: true };
  });

/** List available models from the remote hosted agent */
export const listModels = createServerFn({ method: "GET" }).handler(
  async (): Promise<ModelInfo[]> => {
    if (!hasAgentConfig()) return [];
    try {
      const config = getAgentConfig();
      const { getAuthToken } = await import("./remote/auth");
      const token = await getAuthToken();

      const url = new URL(`${config.agentBaseUrl}/endpoint/protocols/invocations`);
      url.searchParams.set("api-version", config.apiVersion);

      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Foundry-Features": "HostedAgents=V1Preview",
        },
        body: JSON.stringify({ action: "list_models" }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.models && Array.isArray(data.models)) {
          return data.models as ModelInfo[];
        }
      }
    } catch (error) {
      console.error("Failed to list models from remote agent:", error);
    }
    return [];
  },
);

/** List user-invocable skills — not available for remote agents */
export const listSessionSkills = createServerFn({ method: "POST" })
  .inputValidator(zodValidator(sessionInputSchema))
  .handler(async (): Promise<SessionSkill[]> => {
    return [];
  });

/** Get session snapshot — combines all run history with live stream state */
export const querySession = createServerFn({ method: "POST" })
  .inputValidator(zodValidator(sessionInputSchema))
  .handler(async ({ data }): Promise<SessionSnapshot> => {
    // Load persisted run history from SQLite (grouped by run_id with separators)
    const store = await getSessionMetadataStore();
    const runs = await store.loadEvents(data.sessionId);
    const historyMessages = replayRunsToMessages(runs);

    // For automation sessions, SQLite is the sole source of truth (UI uses polling).
    // Don't merge with live stream to avoid duplicating the latest run's messages.
    const isAutomation = isAutomationRunSession(data.sessionId);
    if (isAutomation) {
      return {
        id: data.sessionId,
        messages: historyMessages,
        queuedMessages: [],
        status: "idle",
        reasoningContent: "",
      };
    }

    // Active stream — merge history with live turn state
    const stream = SessionStream.get(data.sessionId);
    if (stream) {
      const turnState = stream.getTurnState();
      // Add separator between history and live turn (if there's history)
      const separator: Message[] =
        historyMessages.length > 0 && turnState.messages.length > 0
          ? [{ role: "assistant", content: "---\n\n**Previous run ended**\n\n---" }]
          : [];

      return {
        id: data.sessionId,
        messages: [...historyMessages, ...separator, ...turnState.messages],
        queuedMessages: stream.getQueuedMessages(),
        model: turnState.model,
        todos: turnState.todos,
        lastSeenEventId: stream.getLastEventId(),
        status: turnState.status,
        reasoningContent: turnState.reasoningContent,
      };
    }

    // No active stream — return history only
    if (historyMessages.length > 0) {
      return {
        id: data.sessionId,
        messages: historyMessages,
        queuedMessages: [],
        status: "idle",
        reasoningContent: "",
      };
    }

    // No history, no stream — empty
    return {
      id: data.sessionId,
      messages: [],
      queuedMessages: [],
      status: "idle",
      reasoningContent: "",
    };
  });

/** Replay multiple runs into a single message list with separator messages between runs. */
function replayRunsToMessages(runs: { runId: string; events: SessionEvent[] }[]): Message[] {
  if (runs.length === 0) return [];

  const allMessages: Message[] = [];
  for (let i = 0; i < runs.length; i++) {
    if (i > 0) {
      allMessages.push({
        role: "assistant",
        content: "---\n\n**Previous run ended**\n\n---",
      });
    }
    const runState = createInitialSession();
    for (const event of runs[i].events) {
      applySessionEvent(runState, event);
    }
    allMessages.push(...runState.messages);
  }
  return allMessages;
}

function createEventByteStream(iterator: AsyncGenerator<SessionEvent>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(encodeSessionEvent(next.value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.(undefined);
    },
  });
}

export const connectSessionStream = createServerFn({ method: "POST" })
  .inputValidator(zodValidator(streamInputSchema))
  .handler(async ({ data }) => {
    const iterator = createSessionEventStream(data);
    return new RawStream(createEventByteStream(iterator), { hint: "text" });
  });

/** Enqueue a message to be sent after the current turn finishes. */
export const enqueueMessage = createServerFn({ method: "POST" })
  .inputValidator(zodValidator(enqueueInputSchema))
  .handler(async ({ data }) => {
    const stream = SessionStream.get(data.sessionId);
    if (!stream) return { success: false };

    stream.addQueuedMessage({
      id: data.queuedMessageId,
      role: "user",
      content: data.content,
      attachments: data.attachments,
    });
    return { success: true };
  });

/** Cancel a queued message by ID */
export const cancelQueuedMessage = createServerFn({ method: "POST" })
  .inputValidator(zodValidator(cancelQueuedInputSchema))
  .handler(async ({ data }) => {
    const stream = SessionStream.get(data.sessionId);
    const removed = stream?.removeQueuedMessage(data.queuedMessageId) ?? false;
    return { success: removed };
  });

/** Abort the currently processing message in a session. */
export const abortSession = createServerFn({ method: "POST" })
  .inputValidator(zodValidator(sessionInputSchema))
  .handler(async ({ data }) => {
    const stream = SessionStream.get(data.sessionId);
    if (stream) {
      await stream.abort();
    }
    return { success: true };
  });

/** Destroy a session and release resources */
export const destroySession = createServerFn({ method: "POST" })
  .inputValidator(zodValidator(sessionInputSchema))
  .handler(async ({ data }) => {
    SessionStream.close(data.sessionId);
    await deleteSession(data.sessionId);
    // Clean up persisted events
    const store = await getSessionMetadataStore();
    await store.delete(data.sessionId);
    return { success: true };
  });

/** Merge a worktree session — not available for remote agents */
export const mergeSessionWorktree = createServerFn({ method: "POST" })
  .inputValidator(zodValidator(sessionInputSchema))
  .handler(async () => ({ status: "no-worktree" as const }));

/** Apply a worktree session — not available for remote agents */
export const applySessionWorktree = createServerFn({ method: "POST" })
  .inputValidator(zodValidator(sessionInputSchema))
  .handler(async () => ({ status: "no-worktree" as const }));
