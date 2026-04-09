// Type definitions for the Foundry hosted agent remote API.
// These types define the contracts for invocations, session management,
// and SSE event streaming.

// ============================================================================
// Configuration
// ============================================================================

export type HostedAgentConfig = {
  /** Base agent URL, e.g. https://{account}.services.ai.azure.com/api/projects/{project}/agents/{agentName} */
  agentBaseUrl: string;
  /** API version query parameter */
  apiVersion: string;
};

// ============================================================================
// Auth
// ============================================================================

export type AuthToken = {
  accessToken: string;
  expiresOn: Date;
};

// ============================================================================
// Invocation Protocol
// ============================================================================

export type InvocationRequest = {
  input: string;
  model?: string;
};

export type ListModelsRequest = {
  action: "list_models";
};

export type InvocationBody = InvocationRequest | ListModelsRequest;

export type InvocationDonePayload = {
  invocation_id: string;
  session_id: string;
};

// ============================================================================
// SSE Events
// ============================================================================

/** A parsed SSE frame from the remote agent's text/event-stream response */
export type SSEFrame = {
  /** Optional event name (e.g. "done"). Undefined for regular data frames. */
  event?: string;
  /** The raw data string (typically JSON) */
  data: string;
};

/** A typed SDK event received from the remote agent via SSE */
export type RemoteSdkEvent = {
  type: string;
  timestamp?: string;
  data?: Record<string, unknown>;
};

// ============================================================================
// Platform Session API
// ============================================================================

export type SessionResource = {
  agent_session_id: string;
  status: string;
  created_at: number;
  last_accessed_at: number;
  expires_at: number;
};

export type SessionListResult = {
  data: SessionResource[];
  pagination_token: string | null;
};

export type CreateSessionRequest = {
  agent_session_id?: string;
  version_indicator?: {
    type: string;
    agent_version: string;
  };
};

// ============================================================================
// Model Info (replaces SDK ModelInfo)
// ============================================================================

export type ModelInfo = {
  id: string;
  name: string;
  // Add more fields as needed when the hosted agent returns model details
};
