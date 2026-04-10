// HTTP client for Foundry platform session management APIs.
// Provides CRUD operations for platform-level sessions (microVM lifecycle).

import { getAuthToken } from "./auth";
import type {
  CreateSessionRequest,
  HostedAgentConfig,
  SessionListResult,
  SessionResource,
} from "./types";

const FOUNDRY_FEATURES_HEADER = "HostedAgents=V1Preview";

async function makeRequest<T>(
  config: HostedAgentConfig,
  path: string,
  options: {
    method: string;
    body?: unknown;
  },
): Promise<T> {
  const token = await getAuthToken();

  const url = new URL(`${config.agentBaseUrl}${path}`);
  url.searchParams.set("api-version", config.apiVersion);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Foundry-Features": FOUNDRY_FEATURES_HEADER,
  };

  const response = await fetch(url.toString(), {
    method: options.method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    const message = `Session API ${options.method} ${path} failed (${response.status}): ${errorText}`;
    console.error(`[remote] ${message}`);
    throw new Error(message);
  }

  // 204 No Content (e.g. delete when not found)
  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

/** List all sessions for the agent. Returns paginated results. */
export async function listSessions(
  config: HostedAgentConfig,
  options?: { limit?: number; paginationToken?: string; order?: "asc" | "desc" },
): Promise<SessionListResult> {
  const token = await getAuthToken();

  const url = new URL(`${config.agentBaseUrl}/endpoint/sessions`);
  url.searchParams.set("api-version", config.apiVersion);
  if (options?.limit) url.searchParams.set("limit", String(options.limit));
  if (options?.paginationToken) url.searchParams.set("pagination_token", options.paginationToken);
  if (options?.order) url.searchParams.set("order", options.order);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Foundry-Features": FOUNDRY_FEATURES_HEADER,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    const message = `Failed to list sessions (${response.status}): ${errorText}`;
    console.error(`[remote] ${message}`);
    throw new Error(message);
  }

  return response.json() as Promise<SessionListResult>;
}

/** Get a session by ID */
export async function getSession(
  config: HostedAgentConfig,
  sessionId: string,
): Promise<SessionResource | undefined> {
  try {
    return await makeRequest<SessionResource>(config, `/endpoint/sessions/${sessionId}`, {
      method: "GET",
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) {
      return undefined;
    }
    throw error;
  }
}

/** Create a new platform session. Returns the created session. */
export async function createPlatformSession(
  config: HostedAgentConfig,
  request?: CreateSessionRequest,
): Promise<SessionResource> {
  const body = {
    ...request,
    version_indicator: request?.version_indicator ?? {
      type: "version_ref",
      agent_version: "11",
    },
  };
  return makeRequest<SessionResource>(config, "/endpoint/sessions", {
    method: "POST",
    body,
  });
}

/** Delete a platform session by ID */
export async function deletePlatformSession(
  config: HostedAgentConfig,
  sessionId: string,
): Promise<void> {
  await makeRequest<SessionResource | undefined>(config, `/endpoint/sessions/${sessionId}`, {
    method: "DELETE",
  });
}

/** Generate a valid agent_session_id (8-128 alphanumeric + _ + -) */
export function generateSessionId(): string {
  // Generate a 16-character alphanumeric ID
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let id = "tb-"; // Prefix so Toy Box sessions are identifiable
  for (let i = 0; i < 13; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}
