// Auth token acquisition for Foundry hosted agent APIs.
// Uses Azure CLI (az account get-access-token) for simplicity.
// Caches tokens and refreshes before expiry.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AuthToken } from "./types";

const execFileAsync = promisify(execFile);

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry

let cachedToken: AuthToken | undefined;

/** Acquire a Bearer token for the Foundry hosted agent API.
 *  Caches the token and refreshes automatically when near expiry. */
export async function getAuthToken(): Promise<string> {
  if (cachedToken && !isTokenExpiringSoon(cachedToken)) {
    return cachedToken.accessToken;
  }

  cachedToken = await acquireToken();
  return cachedToken.accessToken;
}

function isTokenExpiringSoon(token: AuthToken): boolean {
  return token.expiresOn.getTime() - Date.now() < TOKEN_REFRESH_BUFFER_MS;
}

async function acquireToken(): Promise<AuthToken> {
  try {
    const { stdout } = await execFileAsync("az", [
      "account",
      "get-access-token",
      "--resource",
      "https://ai.azure.com/",
      "--output",
      "json",
    ]);

    const result = JSON.parse(stdout);

    return {
      accessToken: result.accessToken,
      expiresOn: new Date(result.expiresOn),
    };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to acquire auth token via az CLI. ` +
        `Make sure you are logged in with 'az login'. Error: ${message}`,
    );
  }
}

/** Clear the cached token (useful for testing or forced refresh) */
export function clearAuthTokenCache(): void {
  cachedToken = undefined;
}
