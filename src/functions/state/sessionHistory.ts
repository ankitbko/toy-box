// In-memory session message history with per-run tracking.
//
// Stores completed session messages on globalThis so they survive Vite
// HMR reloads. Also writes to SQLite in the background for durability
// across server restarts.
//
// Each session can have multiple "runs" (e.g. automation reruns).
// Messages from all runs are preserved and can be replayed with
// separator markers between runs.

import type { Message, SessionEvent } from "@/types";
import { applySessionEvent, createInitialSession, type Session } from "@/lib/session/sessionReducer";

// ============================================================================
// Types
// ============================================================================

export type RunRecord = {
  runId: string;
  messages: Message[];
  model?: string;
  timestamp: string; // ISO timestamp of when the run completed
};

type SessionHistory = {
  runs: RunRecord[];
  /** Current live run state (set on stream close, cleared when written to runs) */
  lastCompletedState?: Session;
};

// ============================================================================
// Global storage (survives Vite HMR)
// ============================================================================

const HISTORY_KEY = "__toybox_sessionHistory";

function getHistoryMap(): Map<string, SessionHistory> {
  const g = globalThis as Record<string, unknown>;
  if (!g[HISTORY_KEY]) {
    g[HISTORY_KEY] = new Map<string, SessionHistory>();
  }
  return g[HISTORY_KEY] as Map<string, SessionHistory>;
}

function getOrCreateHistory(sessionId: string): SessionHistory {
  const map = getHistoryMap();
  let history = map.get(sessionId);
  if (!history) {
    history = { runs: [] };
    map.set(sessionId, history);
  }
  return history;
}

// ============================================================================
// Public API
// ============================================================================

/** Record a completed run's messages into the session history. */
export function recordCompletedRun(
  sessionId: string,
  runId: string,
  state: Session,
): void {
  const history = getOrCreateHistory(sessionId);

  // Store the completed state for immediate querySession access
  history.lastCompletedState = state;

  // Add as a run record
  history.runs.push({
    runId,
    messages: [...state.messages],
    model: state.model,
    timestamp: new Date().toISOString(),
  });

  // Also persist to SQLite in the background
  void persistRunToSqlite(sessionId, runId, state).catch((err) => {
    console.error(`[sessionHistory] Failed to persist run ${runId}:`, err);
  });
}

/** Get the last completed state for immediate reads (before SQLite writes finish). */
export function getLastCompletedState(sessionId: string): Session | undefined {
  return getHistoryMap().get(sessionId)?.lastCompletedState;
}

/** Get all run records for a session (in-memory). */
export function getRunHistory(sessionId: string): RunRecord[] {
  return getHistoryMap().get(sessionId)?.runs ?? [];
}

/** Get all messages across all runs, with separator messages between runs. */
export function getAllMessagesWithSeparators(sessionId: string): Message[] {
  const runs = getRunHistory(sessionId);
  if (runs.length === 0) return [];

  const allMessages: Message[] = [];
  for (let i = 0; i < runs.length; i++) {
    if (i > 0) {
      allMessages.push({
        role: "assistant",
        content: `---\n\n**Run ${i} completed** — *${formatTimestamp(runs[i - 1].timestamp)}*\n\n---`,
      });
    }
    allMessages.push(...runs[i].messages);
  }
  return allMessages;
}

/** Clear all history for a session (on session delete). */
export function clearSessionHistory(sessionId: string): void {
  getHistoryMap().delete(sessionId);
}

/** Load history from SQLite on startup (for durability across restarts). */
export async function loadHistoryFromSqlite(sessionId: string): Promise<void> {
  try {
    const { getSessionMetadataStore } = await import("./sessionStore");
    const store = await getSessionMetadataStore();
    const runs = await store.loadEvents(sessionId);

    if (runs.length === 0) return;

    const history = getOrCreateHistory(sessionId);
    // Only load if we don't already have in-memory data
    if (history.runs.length > 0) return;

    for (const run of runs) {
      const state = createInitialSession();
      for (const event of run.events) {
        applySessionEvent(state, event);
      }
      if (state.messages.length > 0) {
        history.runs.push({
          runId: run.runId,
          messages: [...state.messages],
          model: state.model,
          timestamp: new Date().toISOString(),
        });
      }
    }
  } catch {
    // SQLite not available yet — will populate on next run
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

async function persistRunToSqlite(
  sessionId: string,
  runId: string,
  state: Session,
): Promise<void> {
  const { getSessionMetadataStore } = await import("./sessionStore");
  const store = await getSessionMetadataStore();

  // Reconstruct events from messages to persist
  // We store the messages directly as synthetic events for simplicity
  let eventIndex = 0;
  for (const message of state.messages) {
    const event: SessionEvent =
      message.role === "user"
        ? { type: "user_message", content: message.content }
        : { type: "assistant_message", content: message.content, toolCalls: message.toolCalls };
    await store.appendEvent(sessionId, runId, eventIndex++, event);
  }
}
