// Session streaming runtime — bridges the remote Foundry hosted agent's
// SSE event stream to the HTTP streaming interface consumed by the client.
// Owns the per-session event pipeline (remote SSE → projected SessionEvent →
// streaming buffer → client listener), turn lifecycle, and the queued-message
// drain loop that sends follow-up prompts between turns.

import { invokeAgent } from "../remote/client";
import {
  adaptRemoteEvent,
  createEventAdapterState,
  getRemoteMetadataPatch,
  getRemoteStreamTerminal,
} from "../remote/eventAdapter";
import type { RemoteSdkEvent } from "../remote/types";
import { createSession, getAgentConfig } from "../state/sessionCache";
import { markSessionUnread, markSessionRead } from "../state/unread";
import {
  emitSessionRunning,
  emitSessionIdle,
  emitSessionTouched,
  updateSessionSummary,
} from "./broadcast";
import { applySessionEvent, createInitialSession } from "@/lib/session/sessionReducer";
import type { Attachment, QueuedMessage, SessionEvent } from "@/types";
import type { Session } from "@/lib/session/sessionReducer";
import { getSessionMetadataStore } from "../state/sessionStore";

export type SessionStreamConfig = {
  sessionId: string;
  prompt?: string;
  attachments?: Attachment[];
  model?: string;
  directory?: string;

  clientMessageId?: string;
  afterEventId?: number;
  startNew?: boolean;
};

type SessionStreamSubscriber = (event: SessionEvent | null) => void;

const MAX_BUFFER_EVENTS = 1500;

export class SessionStream {
  // ── Static registry ──────────────────────────────────────────────────

  private static readonly streams = new Map<string, SessionStream>();

  static get(sessionId: string): SessionStream | undefined {
    return SessionStream.streams.get(sessionId);
  }

  static getOrCreate(sessionId: string, initialModel?: string): SessionStream {
    const existing = SessionStream.streams.get(sessionId);
    if (existing) return existing;

    const stream = new SessionStream(sessionId);
    if (initialModel) {
      stream.#turnState.model = initialModel;
    }
    SessionStream.streams.set(sessionId, stream);
    return stream;
  }

  /** Full-close a stream by session ID. No-op if no stream exists. */
  static close(sessionId: string): void {
    SessionStream.streams.get(sessionId)?.close();
  }

  /** Remove a stream without emitting lifecycle events (for session deletion). */
  static remove(sessionId: string): void {
    SessionStream.streams.get(sessionId)?.detach();
  }

  static getRunningSessionIds(): string[] {
    return Array.from(SessionStream.streams.keys());
  }

  static isRunning(sessionId: string): boolean {
    return SessionStream.streams.has(sessionId);
  }

  // ── Instance fields ──────────────────────────────────────────────────

  readonly sessionId: string;

  // Event buffer
  #buffer: SessionEvent[] = [];
  #lastEventId: number | undefined;
  #announcedRunning = false;

  // Subscribers
  readonly #subscribers = new Set<SessionStreamSubscriber>();

  // Event adapter state
  #adapterState = createEventAdapterState();

  // Reducer state
  #turnState: Session;

  // Stream lifecycle
  #closed = false;

  // Event sequencing
  #nextEventId = 1;
  #currentTurnId: string | undefined;
  #isDrainingQueue = false;

  // Run ID for SQLite persistence (set by scheduler for automation runs)
  #runId: string | undefined;

  // ── Constructor ──────────────────────────────────────────────────────

  private constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.#turnState = createInitialSession();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /** Full shutdown: clear buffer + queue + unread + broadcast. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;

    this.#updateUnreadOnStreamEnd();
    this.#clearBuffer();
    this.#turnState.queuedMessages.length = 0;
    this.#broadcastToSubscribers(null);
    SessionStream.streams.delete(this.sessionId);
  }

  /** Abort the in-flight turn. For remote agents, just close the stream. */
  async abort(): Promise<void> {
    this.close();
  }

  /** Lightweight cleanup: remove from registry. */
  detach(): void {
    SessionStream.streams.delete(this.sessionId);
  }

  /** Mark a send failure: clear the buffer and update unread. */
  markSendFailure(): void {
    this.#updateUnreadOnStreamEnd();
    this.#clearBuffer();
  }

  // ── Model ───────────────────────────────────────────────────────────

  get model(): string | undefined {
    return this.#turnState.model;
  }

  /** Update the model for the next invocation. */
  setModel(model: string): void {
    if (model === this.#turnState.model) return;
    this.#turnState.model = model;
  }

  /** Set the run ID for SQLite event persistence (called by scheduler). */
  setRunId(runId: string): void {
    this.#runId = runId;
  }

  // ── Buffer ───────────────────────────────────────────────────────────

  #appendToBuffer(event: SessionEvent): void {
    if (event.eventId !== undefined) {
      this.#lastEventId = event.eventId;
    }

    this.#buffer.push(event);
    if (this.#buffer.length > MAX_BUFFER_EVENTS) {
      this.#buffer.splice(0, this.#buffer.length - MAX_BUFFER_EVENTS);
    }

    if (!this.#announcedRunning) {
      this.#announcedRunning = true;
      emitSessionRunning(this.sessionId);
    }
  }

  #clearBuffer(): void {
    if (this.#buffer.length === 0 && !this.#announcedRunning) return;

    this.#buffer.length = 0;
    this.#lastEventId = undefined;

    if (this.#announcedRunning) {
      this.#announcedRunning = false;
      emitSessionIdle(this.sessionId);
    }
  }

  getBufferSince(afterEventId?: number): SessionEvent[] {
    if (afterEventId === undefined) return this.#buffer;
    if (this.#buffer.length === 0) return [];

    return this.#buffer.filter(
      (event) => event.eventId === undefined || event.eventId > afterEventId,
    );
  }

  getTurnState(): Session {
    return this.#turnState;
  }

  getLastEventId(): number | undefined {
    return this.#lastEventId;
  }

  // ── Queue ────────────────────────────────────────────────────────────

  getQueuedMessages(): QueuedMessage[] {
    return this.#turnState.queuedMessages;
  }

  addQueuedMessage(message: Omit<QueuedMessage, "id"> & { id?: string }): QueuedMessage {
    const queued: QueuedMessage = {
      ...message,
      role: "user",
      id: message.id ?? crypto.randomUUID(),
    };

    this.#emit({
      type: "message_queued",
      queuedMessageId: queued.id,
      content: queued.content,
      attachments: queued.attachments,
    });

    return queued;
  }

  removeQueuedMessage(queuedMessageId: string): boolean {
    const index = this.#turnState.queuedMessages.findIndex((m) => m.id === queuedMessageId);
    if (index === -1) return false;

    this.#emit({
      type: "message_cancelled",
      queuedMessageId,
    });

    return true;
  }

  // ── Subscriber management ───────────────────────────────────────────

  subscribe(fn: SessionStreamSubscriber): () => void {
    this.#subscribers.add(fn);
    return () => {
      this.#subscribers.delete(fn);
      if (this.#isIdle()) this.detach();
    };
  }

  #broadcastToSubscribers(event: SessionEvent | null): void {
    for (const subscriber of this.#subscribers) {
      subscriber(event);
    }
  }

  #updateUnreadOnStreamEnd(): void {
    if (this.#subscribers.size > 0) {
      markSessionRead(this.sessionId);
    } else {
      markSessionUnread(this.sessionId);
    }
  }

  #isIdle(): boolean {
    return (
      this.#subscribers.size === 0 &&
      !this.#isDrainingQueue &&
      this.#turnState.queuedMessages.length === 0 &&
      this.#buffer.length === 0
    );
  }

  // ── Event pipeline ──────────────────────────────────────────────────

  /** Begin a new turn: reset state, emit the user message, prepare buffer. */
  startTurn(prompt: string, clientMessageId?: string): void {
    this.#resetForNewTurn(prompt);
    this.#emit({
      type: "user_message",
      content: prompt,
      clientMessageId,
    });
  }

  #emit(event: SessionEvent, sourceEventType?: string): void {
    const decorated = this.#decorateEvent(event, sourceEventType);

    this.#applyEvent(decorated);
    this.#broadcastToSubscribers(decorated);
  }

  #resetForNewTurn(summaryHint?: string): void {
    // Always clear the buffer — SQLite is the durable store for automation history.
    // Buffer is only for live streaming to connected subscribers.
    this.#buffer.length = 0;

    if (!this.#announcedRunning) {
      this.#announcedRunning = true;
      emitSessionRunning(this.sessionId);
    }
    emitSessionTouched(this.sessionId, { summary: summaryHint });

    // Persist summary to SQLite
    if (summaryHint) {
      getSessionMetadataStore()
        .then((store) => store.updateSummary(this.sessionId, summaryHint))
        .catch(() => {});
    }

    this.#currentTurnId = undefined;
    this.#adapterState = createEventAdapterState();

    const currentModel = this.#turnState.model;
    this.#turnState = createInitialSession();
    this.#turnState.model = currentModel;
    this.#turnState.status = "thinking";
  }

  #generateTurnId(): string {
    return `${this.sessionId}:turn:${Date.now().toString(36)}:${this.#nextEventId}`;
  }

  #decorateEvent(event: SessionEvent, sourceEventType?: string): SessionEvent {
    if (sourceEventType === "assistant.turn_start") {
      this.#currentTurnId = this.#generateTurnId();
    } else if (!this.#currentTurnId) {
      this.#currentTurnId = `${this.sessionId}:turn:bootstrap`;
    }
    const eventId = this.#nextEventId++;
    return { ...event, eventId, turnId: this.#currentTurnId };
  }

  #applyEvent(event: SessionEvent): void {
    this.#appendToBuffer(event);
    applySessionEvent(this.#turnState, event);
  }

  /**
   * Persist the completed run's messages to SQLite as consolidated events.
   * Called after invocation finishes but before the stream is closed/drained.
   * Writes clean user_message + assistant_message events (not raw deltas).
   *
   * For automation sessions (runId set by scheduler): events are scoped by runId
   * so multiple runs accumulate independently.
   * For regular sessions: uses a fixed runId and appends events with incrementing
   * indices so multi-turn conversations accumulate in a single run.
   */
  async #persistRunToSqlite(): Promise<void> {
    const isAutomation = this.#runId !== undefined;
    const runId = this.#runId ?? "chat";
    this.#runId = undefined; // Clear run context after capture

    // Deep-copy messages before async work so mutations don't affect us
    const messages = this.#turnState.messages.map((m) => ({ ...m }));
    if (messages.length === 0) return;

    try {
      const events: SessionEvent[] = messages.map((msg) =>
        msg.role === "user"
          ? { type: "user_message" as const, content: msg.content }
          : {
              type: "assistant_message" as const,
              content: msg.content,
              toolCalls: msg.toolCalls,
            },
      );

      const store = await getSessionMetadataStore();

      if (isAutomation) {
        // Automation: each run is stored independently (starting at index 0)
        await store.appendRunEvents(this.sessionId, runId, events);
      } else {
        // Regular session: append to existing run, continuing the event index
        await store.appendToRun(this.sessionId, runId, events);
      }
    } catch (err) {
      console.error(`[stream] ${this.sessionId} failed to persist run ${runId}:`, err);
    }
  }

  // ── Remote agent invocation ─────────────────────────────────────────

  /** Public entry point for fire-and-forget invocation from createSessionEventStream. */
  async invokeRemoteAgentPublic(prompt: string, model?: string): Promise<void> {
    return this.#invokeRemoteAgent(prompt, model);
  }

  /** Invoke the remote agent and process the SSE event stream. */
  async #invokeRemoteAgent(prompt: string, model?: string): Promise<void> {
    try {
      console.log(
        `[stream] ${this.sessionId} invoking agent, buffer=${this.#buffer.length}, closed=${this.#closed}`,
      );
      const config = getAgentConfig();
      const { events } = await invokeAgent(config, this.sessionId, {
        input: prompt,
        model: model || this.#turnState.model,
      });

      let eventCount = 0;
      for await (const remoteEvent of events) {
        if (this.#closed) break;
        eventCount++;
        this.#handleRemoteEvent(remoteEvent);
      }
      console.log(
        `[stream] ${this.sessionId} invocation done, ${eventCount} events received, buffer=${this.#buffer.length}`,
      );

      // Persist consolidated messages to SQLite before draining/closing
      await this.#persistRunToSqlite();

      // Stream ended — drain the queue or close (unless already closed by error terminal)
      if (!this.#closed) {
        this.#drainMessageQueue();
      }
    } catch (error) {
      console.error(`[stream] ${this.sessionId} invocation error:`, error);
      // Still persist whatever we have (user_message + partial response)
      await this.#persistRunToSqlite();
      this.close();
    }
  }

  #handleRemoteEvent(remoteEvent: RemoteSdkEvent): void {
    // Handle error events from the remote agent ({"type": "error", "message": "..."})
    if (remoteEvent.type === "error") {
      const raw = remoteEvent as Record<string, unknown>;
      const errorMessage =
        (raw.message as string) ??
        (remoteEvent.data?.message as string) ??
        "An error occurred on the remote agent.";
      this.#emit({
        type: "assistant_message",
        content: `⚠️ **Agent Error**: ${errorMessage}`,
      });
      this.close();
      return;
    }

    const metadataPatch = getRemoteMetadataPatch(remoteEvent);
    if (metadataPatch) {
      updateSessionSummary(this.sessionId, metadataPatch.summary, {
        replace: metadataPatch.replaceSummary,
      });
      // Also persist the summary locally
      getSessionMetadataStore()
        .then((store) =>
          store.updateSummary(this.sessionId, metadataPatch.summary, {
            replace: metadataPatch.replaceSummary,
          }),
        )
        .catch(console.error);
    }

    const streamTerminal = getRemoteStreamTerminal(remoteEvent);
    if (streamTerminal) {
      if (streamTerminal === "error") {
        this.close();
        return;
      }
      // "idle" terminal — handled by the invokeRemoteAgent caller
      return;
    }

    for (const sessionEvent of adaptRemoteEvent(remoteEvent, this.#adapterState)) {
      if (
        (sessionEvent.type === "delta" || sessionEvent.type === "reasoning") &&
        sessionEvent.content.length === 0
      ) {
        continue;
      }

      this.#emit(sessionEvent, remoteEvent.type);
    }
  }

  // ── Queue draining ──────────────────────────────────────────────────

  async #drainMessageQueue(): Promise<void> {
    if (this.#isDrainingQueue) return;
    this.#isDrainingQueue = true;

    try {
      const queuedMessage = this.#turnState.queuedMessages[0];
      if (!queuedMessage) {
        this.close();
        return;
      }

      this.#resetForNewTurn(queuedMessage.content);
      this.#currentTurnId = this.#generateTurnId();

      this.#emit({
        type: "message_dequeued",
        content: queuedMessage.content,
        queuedMessageId: queuedMessage.id,
      });

      const model = queuedMessage.model || this.#turnState.model;
      if (model && model !== this.#turnState.model) {
        this.#turnState.model = model;
      }

      await this.#invokeRemoteAgent(queuedMessage.content, model);
    } catch (err) {
      console.error(`[DRAIN] ${this.sessionId} error:`, err);
      this.close();
    } finally {
      this.#isDrainingQueue = false;
    }
  }
}

// ============================================================================
// Streaming Entry Point
// ============================================================================

function createAsyncQueue<T>() {
  const queue: (T | null)[] = [];
  let resolve: ((value: T | null) => void) | null = null;

  return {
    push(item: T | null) {
      if (resolve) {
        resolve(item);
        resolve = null;
      } else {
        queue.push(item);
      }
    },
    pull(): Promise<T | null> {
      if (queue.length > 0) {
        return Promise.resolve(queue.shift()!);
      }
      return new Promise((r) => {
        resolve = r;
      });
    },
  };
}

export async function* createSessionEventStream(
  options: SessionStreamConfig,
): AsyncGenerator<SessionEvent> {
  const shouldStartNew = Boolean(options.startNew && options.prompt);
  const hasPrompt = !!options.prompt;

  // Reconnect with no prompt and no active stream — nothing to do.
  if (!hasPrompt && !SessionStream.isRunning(options.sessionId)) {
    return;
  }

  // Auto-queue: if the session is already streaming and a new prompt arrives,
  // enqueue it instead of corrupting the in-flight turn.
  if (hasPrompt && !shouldStartNew && SessionStream.isRunning(options.sessionId)) {
    const stream = SessionStream.get(options.sessionId)!;
    stream.addQueuedMessage({
      role: "user",
      content: options.prompt!,
      attachments: options.attachments,
      model: options.model,
    });

    return;
  }

  if (shouldStartNew) {
    await createSession(options.sessionId, { model: options.model });
  }

  const stream = SessionStream.getOrCreate(options.sessionId, options.model);

  const { push, pull } = createAsyncQueue<SessionEvent>();
  const unsubscribe = stream.subscribe(push);

  try {
    if (hasPrompt) {
      // Send path: start a new turn and invoke the remote agent.
      stream.startTurn(options.prompt!, options.clientMessageId);

      if (options.model) {
        stream.setModel(options.model);
      }

      // Fire-and-forget the remote invocation — events flow through the subscriber
      stream.invokeRemoteAgentPublic(options.prompt!, options.model).catch((error) => {
        console.error(`[stream] ${options.sessionId} invocation error:`, error);
        stream.markSendFailure();
        stream.close();
      });
    } else {
      // Reconnect path: replay buffered events then wait for live events.
      for (const event of stream.getBufferSince(options.afterEventId)) {
        yield event;
      }
    }

    // Stream live events until the runtime signals completion (null).
    while (true) {
      const event = await pull();
      if (event === null) break;

      yield event;
    }
  } finally {
    unsubscribe();
  }
}
