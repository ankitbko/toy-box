// Session lifecycle orchestration for remote Foundry hosted agents.
//
// Platform sessions (microVMs) are managed via the Foundry session API.
// This module coordinates session creation, deletion, and cleanup across
// streaming buffers, unread state, attachments, and local metadata.

import { createPlatformSession, deletePlatformSession } from "../remote/sessionApi";
import type { HostedAgentConfig } from "../remote/types";
import { emitSessionUpsert, emitSessionDelete } from "../runtime/broadcast";
import { SessionStream } from "../runtime/stream";
import { deleteUnreadState } from "./unread";
import { cleanupSessionAttachments } from "./attachments";
import { getSessionMetadataStore } from "./sessionStore";

// ============================================================================
// Agent Configuration (on globalThis to survive Vite module reloads in dev)
// ============================================================================

const AGENT_CONFIG_KEY = "__toybox_agentConfig";

function getGlobal(): Record<string, unknown> {
  return globalThis as Record<string, unknown>;
}

export function getAgentConfig(): HostedAgentConfig {
  const config = getGlobal()[AGENT_CONFIG_KEY] as HostedAgentConfig | undefined;
  if (!config) {
    throw new Error("Agent config not set. Configure the hosted agent URL in settings.");
  }
  return config;
}

export function setAgentConfig(config: HostedAgentConfig): void {
  getGlobal()[AGENT_CONFIG_KEY] = config;
}

export function hasAgentConfig(): boolean {
  return getGlobal()[AGENT_CONFIG_KEY] !== undefined;
}

// ============================================================================
// Session Lifecycle
// ============================================================================

export type CreateSessionOptions = {
  model?: string;
  directory?: string;
};

/** Create a new platform session and emit an upsert event */
export async function createSession(
  sessionId: string,
  _options?: CreateSessionOptions,
): Promise<string> {
  const config = getAgentConfig();

  await createPlatformSession(config, { agent_session_id: sessionId });

  const now = new Date().toISOString();

  // Persist initial metadata locally (platform doesn't store summaries)
  const store = await getSessionMetadataStore();
  await store.upsert(sessionId, "");

  // Emit immediately so the session appears in the sidebar
  emitSessionUpsert({
    sessionId,
    startTime: now,
    modifiedTime: now,
    summary: "",
    isRemote: true,
  });

  return sessionId;
}

/** Delete a session (stream + unread + attachments + platform + local metadata + history) */
export async function deleteSession(sessionId: string): Promise<void> {
  SessionStream.remove(sessionId);
  deleteUnreadState(sessionId);
  await cleanupSessionAttachments(sessionId);

  // Delete from local metadata store
  const store = await getSessionMetadataStore();
  await store.delete(sessionId);

  // Delete from platform
  try {
    const config = getAgentConfig();
    await deletePlatformSession(config, sessionId);
  } catch (error) {
    console.error(`Failed to delete platform session ${sessionId}:`, error);
  }

  emitSessionDelete(sessionId);
}
