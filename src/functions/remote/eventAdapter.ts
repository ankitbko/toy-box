// Event adapter for remote hosted agent SSE events.
// Bridges remote SDK events (from the Python Copilot SDK) into the canonical
// SessionEvent format used by the Toy Box UI.
//
// The remote agent streams raw SDK events over SSE. These events have the same
// structure as the local TypeScript SDK events since both implement the Copilot
// protocol. This adapter reuses the existing projector functions.

import type { RemoteSdkEvent } from "./types";
import type { SdkSessionEvent } from "@/functions/sdk/extractors";
import {
  createProjectionState,
  projectSdkEvent,
  getSdkMetadataPatch,
  getSdkStreamTerminalDisposition,
  type ProjectionState,
  type SessionMetadataPatch,
  type SdkStreamTerminalDisposition,
} from "@/functions/sdk/projector";
import type { SessionEvent } from "@/types";

export type EventAdapterState = {
  projectionState: ProjectionState;
};

export function createEventAdapterState(): EventAdapterState {
  return {
    projectionState: createProjectionState(),
  };
}

/**
 * Convert a remote SDK event to the local SdkSessionEvent format.
 * The remote events from the Python SDK have the same structure as
 * the TypeScript SDK events.
 */
function toLocalSdkEvent(remoteEvent: RemoteSdkEvent): SdkSessionEvent {
  return {
    type: remoteEvent.type as SdkSessionEvent["type"],
    timestamp: remoteEvent.timestamp,
    data: remoteEvent.data,
  };
}

/**
 * Project a remote SDK event into zero or more canonical SessionEvents.
 * Reuses the existing projector logic.
 */
export function adaptRemoteEvent(
  remoteEvent: RemoteSdkEvent,
  state: EventAdapterState,
): SessionEvent[] {
  const sdkEvent = toLocalSdkEvent(remoteEvent);
  return projectSdkEvent(sdkEvent, {
    streaming: true,
    state: state.projectionState,
  });
}

/**
 * Check if a remote SDK event carries a metadata patch (session title, summary).
 */
export function getRemoteMetadataPatch(
  remoteEvent: RemoteSdkEvent,
): SessionMetadataPatch | undefined {
  return getSdkMetadataPatch(toLocalSdkEvent(remoteEvent));
}

/**
 * Check if a remote SDK event type signals the end of a turn.
 * Returns "idle" for normal completion, "error" for errors, undefined otherwise.
 */
export function getRemoteStreamTerminal(
  remoteEvent: RemoteSdkEvent,
): SdkStreamTerminalDisposition | undefined {
  return getSdkStreamTerminalDisposition(remoteEvent.type);
}
